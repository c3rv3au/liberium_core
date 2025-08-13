// services/storage/local-storage.js
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
				functions: new Map()
			};
			
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
				const dataFile = path.join(this.dbPath, "functions.json");
				const data = await fs.readFile(dataFile, "utf8");
				const functions = JSON.parse(data);
				
				for (const [name, func] of Object.entries(functions)) {
					this.storage.functions.set(name, func);
				}
				
				this.logger.info(`Loaded ${this.storage.functions.size} functions from disk`);
			} catch (err) {
				if (err.code !== "ENOENT") {
					this.logger.error("Error loading from disk:", err);
				}
			}
		},

		/**
		 * Sauvegarder sur disque
		 */
		async saveToDisk() {
			try {
				const dataFile = path.join(this.dbPath, "functions.json");
				const functions = Object.fromEntries(this.storage.functions);
				await fs.writeFile(dataFile, JSON.stringify(functions, null, 2));
			} catch (err) {
				this.logger.error("Error saving to disk:", err);
				throw err;
			}
		},

		/**
		 * Créer une fonction
		 */
		async create(functionData) {
			if (this.storage.functions.has(functionData.name)) {
				throw new Error(`Function '${functionData.name}' already exists`);
			}

			const func = {
				...functionData,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString()
			};

			this.storage.functions.set(functionData.name, func);
			await this.saveToDisk();
			
			return func;
		},

		/**
		 * Récupérer une fonction
		 */
		async get(name) {
			const func = this.storage.functions.get(name);
			if (!func) {
				throw new Error(`Function '${name}' not found`);
			}
			return func;
		},

		/**
		 * Mettre à jour une fonction
		 */
		async update(name, updates) {
			const existing = this.storage.functions.get(name);
			if (!existing) {
				throw new Error(`Function '${name}' not found`);
			}

			const updated = {
				...existing,
				...updates,
				updatedAt: new Date().toISOString()
			};

			this.storage.functions.set(name, updated);
			await this.saveToDisk();
			
			return updated;
		},

		/**
		 * Supprimer une fonction
		 */
		async delete(name) {
			if (!this.storage.functions.has(name)) {
				throw new Error(`Function '${name}' not found`);
			}

			this.storage.functions.delete(name);
			await this.saveToDisk();
			
			return { deleted: true };
		},

		/**
		 * Lister toutes les fonctions
		 */
		async list() {
			return Array.from(this.storage.functions.values());
		},

		/**
		 * Compter les fonctions
		 */
		async count() {
			return this.storage.functions.size;
		},

		/**
		 * Fermer le stockage
		 */
		async closeStorage() {
			await this.saveToDisk();
		}
	}
};