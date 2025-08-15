// services/storage/etcd-storage.js
"use strict";

const fs = require("fs").promises;
const path = require("path");

module.exports = {
	methods: {
		/**
		 * Initialiser le stockage
		 */
		async initializeStorage() {
			this.dbPath = path.resolve(this.settings.dbPath);
			await this.ensureDirectory(this.dbPath);
			
			this.storage = {
				data: new Map(),
				metadata: new Map(),
				changelog: []
			};
			
			this.lastSyncTime = Date.now();
			await this.loadFromDisk();
		},

		/**
		 * S'assurer que le répertoire existe
		 */
		async ensureDirectory(dir) {
			try {
				await fs.access(dir);
			} catch {
				await fs.mkdir(dir, { recursive: true });
			}
		},

		/**
		 * Charger les données depuis le disque
		 */
		async loadFromDisk() {
			try {
				await this.loadDataFile();
				await this.loadChangelogFile();
				
				this.logger.info(`Loaded ${this.storage.data.size} keys from disk`);
			} catch (err) {
				this.logger.error("Error loading from disk:", err);
				// En cas d'erreur, réinitialiser le stockage
				this.storage.data.clear();
				this.storage.metadata.clear();
				this.storage.changelog = [];
				await this.saveToDisk();
			}
		},

		/**
		 * Charger le fichier de données
		 */
		async loadDataFile() {
			const dataFile = path.join(this.dbPath, "data.json");
			
			try {
				const stats = await fs.stat(dataFile);
				if (stats.size === 0) {
					await this.saveDataFile();
					return;
				}

				const content = await fs.readFile(dataFile, "utf8");
				if (!content.trim()) {
					await this.saveDataFile();
					return;
				}

				const data = JSON.parse(content);
				
				// Charger les données et métadonnées
				if (data.entries) {
					for (const [key, entry] of Object.entries(data.entries)) {
						// Vérifier l'expiration
						if (entry.expiresAt && entry.expiresAt < Date.now()) {
							continue; // Ignorer les entrées expirées
						}
						
						this.storage.data.set(key, entry.value);
						this.storage.metadata.set(key, {
							createdAt: entry.createdAt,
							updatedAt: entry.updatedAt,
							version: entry.version || 1,
							expiresAt: entry.expiresAt
						});
					}
				}
			} catch (err) {
				if (err.code !== "ENOENT") {
					throw err;
				}
				// Fichier n'existe pas, le créer
				await this.saveDataFile();
			}
		},

		/**
		 * Charger le fichier de changelog
		 */
		async loadChangelogFile() {
			const changelogFile = path.join(this.dbPath, "changelog.json");
			
			try {
				const content = await fs.readFile(changelogFile, "utf8");
				if (content.trim()) {
					this.storage.changelog = JSON.parse(content);
					// Garder seulement les 1000 dernières entrées
					if (this.storage.changelog.length > 1000) {
						this.storage.changelog = this.storage.changelog.slice(-1000);
					}
				}
			} catch (err) {
				if (err.code !== "ENOENT") {
					this.logger.warn("Error loading changelog:", err.message);
				}
				this.storage.changelog = [];
			}
		},

		/**
		 * Sauvegarder sur disque
		 */
		async saveToDisk() {
			await Promise.all([
				this.saveDataFile(),
				this.saveChangelogFile()
			]);
		},

		/**
		 * Sauvegarder le fichier de données
		 */
		async saveDataFile() {
			const dataFile = path.join(this.dbPath, "data.json");
			const entries = {};
			
			for (const [key, value] of this.storage.data) {
				const metadata = this.storage.metadata.get(key) || {};
				entries[key] = {
					value,
					createdAt: metadata.createdAt,
					updatedAt: metadata.updatedAt,
					version: metadata.version || 1,
					expiresAt: metadata.expiresAt
				};
			}
			
			const data = {
				entries,
				lastSaved: Date.now()
			};
			
			await fs.writeFile(dataFile, JSON.stringify(data, null, 2));
		},

		/**
		 * Sauvegarder le fichier de changelog
		 */
		async saveChangelogFile() {
			const changelogFile = path.join(this.dbPath, "changelog.json");
			await fs.writeFile(changelogFile, JSON.stringify(this.storage.changelog, null, 2));
		},

		/**
		 * Définir une valeur
		 */
		async setValue(key, value, ttl) {
			const now = Date.now();
			const existing = this.storage.metadata.get(key);
			const version = existing ? existing.version + 1 : 1;
			
			const expiresAt = ttl ? now + (ttl * 1000) : null;
			
			this.storage.data.set(key, value);
			this.storage.metadata.set(key, {
				createdAt: existing ? existing.createdAt : now,
				updatedAt: now,
				version,
				expiresAt
			});
			
			// Ajouter au changelog
			this.addToChangelog({
				action: "set",
				key,
				value,
				timestamp: now,
				version,
				ttl
			});
			
			await this.saveToDisk();
			
			return {
				key,
				value,
				version,
				success: true
			};
		},

		/**
		 * Obtenir une valeur
		 */
		async getValue(key) {
			const value = this.storage.data.get(key);
			const metadata = this.storage.metadata.get(key);
			
			if (value === undefined) {
				return null;
			}
			
			// Vérifier l'expiration
			if (metadata && metadata.expiresAt && metadata.expiresAt < Date.now()) {
				await this.deleteKey(key);
				return null;
			}
			
			return {
				key,
				value,
				version: metadata ? metadata.version : 1,
				createdAt: metadata ? metadata.createdAt : null,
				updatedAt: metadata ? metadata.updatedAt : null,
				expiresAt: metadata ? metadata.expiresAt : null
			};
		},

		/**
		 * Obtenir les valeurs par préfixe
		 */
		async getByPrefix(prefix) {
			const results = [];
			
			for (const [key, value] of this.storage.data) {
				if (key.startsWith(prefix)) {
					const result = await this.getValue(key);
					if (result) {
						results.push(result);
					}
				}
			}
			
			return results;
		},

		/**
		 * Supprimer une clé
		 */
		async deleteKey(key) {
			const existed = this.storage.data.has(key);
			
			if (!existed) {
				return { key, deleted: false, reason: "Key not found" };
			}
			
			this.storage.data.delete(key);
			this.storage.metadata.delete(key);
			
			// Ajouter au changelog
			this.addToChangelog({
				action: "delete",
				key,
				timestamp: Date.now()
			});
			
			await this.saveToDisk();
			
			return { key, deleted: true };
		},

		/**
		 * Incrémenter une valeur
		 */
		async incrementValue(key, delta = 1) {
			const current = await this.getValue(key);
			let newValue = delta;
			
			if (current && current.value !== null) {
				if (typeof current.value !== "number") {
					throw new Error(`Cannot increment non-numeric value: ${typeof current.value}`);
				}
				newValue = current.value + delta;
			}
			
			return await this.setValue(key, newValue);
		},

		/**
		 * Comparer et échanger
		 */
		async compareAndSwapValue(key, expectedValue, newValue) {
			const current = await this.getValue(key);
			
			// Si la clé n'existe pas et on s'attend à null/undefined
			if (!current && (expectedValue === null || expectedValue === undefined)) {
				const result = await this.setValue(key, newValue);
				return { ...result, success: true, swapped: true };
			}
			
			// Si la clé existe et la valeur correspond
			if (current && current.value === expectedValue) {
				const result = await this.setValue(key, newValue);
				return { ...result, success: true, swapped: true };
			}
			
			// Sinon, échec
			return {
				key,
				success: false,
				swapped: false,
				currentValue: current ? current.value : null,
				expectedValue,
				newValue
			};
		},

		/**
		 * Obtenir toutes les clés
		 */
		async getAllKeys(pattern) {
			const keys = Array.from(this.storage.data.keys());
			
			if (!pattern) {
				return keys;
			}
			
			// Simple pattern matching avec wildcards
			const regex = new RegExp(pattern.replace(/\*/g, ".*"));
			return keys.filter(key => regex.test(key));
		},

		/**
		 * Obtenir les statistiques locales
		 */
		async getLocalStats() {
			// Nettoyer les clés expirées
			await this.cleanupExpiredKeys();
			
			return {
				keyCount: this.storage.data.size,
				changelogSize: this.storage.changelog.length,
				lastSyncTime: this.lastSyncTime,
				memoryUsage: {
					dataSize: this.calculateMapSize(this.storage.data),
					metadataSize: this.calculateMapSize(this.storage.metadata)
				}
			};
		},

		/**
		 * Calculer la taille approximative d'une Map
		 */
		calculateMapSize(map) {
			let size = 0;
			for (const [key, value] of map) {
				size += JSON.stringify({ key, value }).length;
			}
			return size;
		},

		/**
		 * Nettoyer les clés expirées
		 */
		async cleanupExpiredKeys() {
			const now = Date.now();
			const expiredKeys = [];
			
			for (const [key, metadata] of this.storage.metadata) {
				if (metadata.expiresAt && metadata.expiresAt < now) {
					expiredKeys.push(key);
				}
			}
			
			if (expiredKeys.length > 0) {
				for (const key of expiredKeys) {
					this.storage.data.delete(key);
					this.storage.metadata.delete(key);
				}
				
				this.logger.debug(`Cleaned up ${expiredKeys.length} expired keys`);
				await this.saveToDisk();
			}
		},

		/**
		 * Ajouter une entrée au changelog
		 */
		addToChangelog(entry) {
			this.storage.changelog.push(entry);
			
			// Garder seulement les 1000 dernières entrées
			if (this.storage.changelog.length > 1000) {
				this.storage.changelog = this.storage.changelog.slice(-1000);
			}
		},

		/**
		 * Obtenir les changements depuis un timestamp
		 */
		async getChangesSince(timestamp) {
			if (!timestamp) {
				// Retourner tous les changements récents
				return this.storage.changelog.slice(-100);
			}
			
			return this.storage.changelog.filter(change => change.timestamp > timestamp);
		},

		/**
		 * Appliquer des changements (pour la synchronisation)
		 */
		async applyChanges(changes) {
			for (const change of changes) {
				try {
					if (change.action === "set") {
						await this.setValue(change.key, change.value, change.ttl);
					} else if (change.action === "delete") {
						await this.deleteKey(change.key);
					}
				} catch (err) {
					this.logger.error(`Error applying change for key ${change.key}:`, err);
				}
			}
		},

		/**
		 * Fermer le stockage
		 */
		async closeStorage() {
			await this.saveToDisk();
		}
	}
};