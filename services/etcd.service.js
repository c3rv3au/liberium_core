// services/etcd.service.js
"use strict";

const { Service } = require("moleculer");
const EtcdStorage = require("./storage/etcd-storage");
const EtcdElection = require("./election/etcd-election");

module.exports = {
	name: "etcd",

	mixins: [EtcdStorage, EtcdElection],

	settings: {
		dbPath: "./data/etcd",
		electionTimeout: 3000,
		heartbeatInterval: 1500,
		syncInterval: 5000,
		maxRetries: 3
	},

	dependencies: [],

	actions: {
		/**
		 * Définir une valeur (écriture)
		 */
		set: {
			params: {
				key: "string",
				value: "any",
				ttl: { type: "number", optional: true }
			},
			async handler(ctx) {
				await this.ensureMaster();
				
				const { key, value, ttl } = ctx.params;
				const result = await this.setValue(key, value, ttl);
				
				// Répliquer aux slaves
				if (!ctx.meta.isReplication) {
					await this.replicateToSlaves("set", { 
						key, 
						value, 
						ttl,
						isReplication: true 
					});
				}
				
				return result;
			}
		},

		/**
		 * Obtenir une valeur (lecture)
		 */
		get: {
			params: {
				key: "string"
			},
			async handler(ctx) {
				return await this.getValue(ctx.params.key);
			}
		},

		/**
		 * Obtenir plusieurs valeurs avec un préfixe
		 */
		getPrefix: {
			params: {
				prefix: "string"
			},
			async handler(ctx) {
				return await this.getByPrefix(ctx.params.prefix);
			}
		},

		/**
		 * Supprimer une clé
		 */
		delete: {
			params: {
				key: "string"
			},
			async handler(ctx) {
				await this.ensureMaster();
				
				const result = await this.deleteKey(ctx.params.key);
				
				// Répliquer aux slaves
				if (!ctx.meta.isReplication) {
					await this.replicateToSlaves("delete", { 
						key: ctx.params.key,
						isReplication: true 
					});
				}
				
				return result;
			}
		},

		/**
		 * Incrémenter une valeur numérique
		 */
		increment: {
			params: {
				key: "string",
				delta: { type: "number", default: 1 }
			},
			async handler(ctx) {
				await this.ensureMaster();
				
				const { key, delta } = ctx.params;
				const result = await this.incrementValue(key, delta);
				
				// Répliquer aux slaves
				if (!ctx.meta.isReplication) {
					await this.replicateToSlaves("increment", { 
						key, 
						delta,
						isReplication: true 
					});
				}
				
				return result;
			}
		},

		/**
		 * Comparer et échanger (compare-and-swap)
		 */
		compareAndSwap: {
			params: {
				key: "string",
				expectedValue: "any",
				newValue: "any"
			},
			async handler(ctx) {
				await this.ensureMaster();
				
				const { key, expectedValue, newValue } = ctx.params;
				const result = await this.compareAndSwapValue(key, expectedValue, newValue);
				
				// Répliquer uniquement si l'opération a réussi
				if (result.success && !ctx.meta.isReplication) {
					await this.replicateToSlaves("set", { 
						key, 
						value: newValue,
						isReplication: true 
					});
				}
				
				return result;
			}
		},

		/**
		 * Lister toutes les clés
		 */
		keys: {
			params: {
				pattern: { type: "string", optional: true }
			},
			async handler(ctx) {
				return await this.getAllKeys(ctx.params.pattern);
			}
		},

		/**
		 * Obtenir les statistiques du cluster
		 */
		getStats: {
			async handler(ctx) {
				const localStats = await this.getLocalStats();
				
				return {
					nodeId: this.broker.nodeID,
					isMaster: this.isMaster,
					masterId: this.masterId,
					clusterSize: await this.getClusterSize(),
					...localStats
				};
			}
		},

		/**
		 * Obtenir la santé du service
		 */
		health: {
			async handler(ctx) {
				const stats = await this.getLocalStats();
				const clusterHealth = await this.checkClusterHealth();
				
				return {
					status: clusterHealth.healthy ? "healthy" : "degraded",
					nodeId: this.broker.nodeID,
					role: this.isMaster ? "master" : "slave",
					masterId: this.masterId,
					lastSync: this.lastSyncTime,
					uptime: process.uptime(),
					keyCount: stats.keyCount,
					memoryUsage: process.memoryUsage(),
					cluster: clusterHealth
				};
			}
		},

		/**
		 * Synchroniser avec le master (pour les slaves)
		 */
		sync: {
			params: {
				lastSyncTime: { type: "number", optional: true }
			},
			async handler(ctx) {
				if (this.isMaster) {
					// Le master retourne les changements depuis lastSyncTime
					return await this.getChangesSince(ctx.params.lastSyncTime);
				} else {
					// Les slaves ne peuvent pas fournir de sync
					throw new Error("Only master can provide sync data");
				}
			}
		}
	},

	events: {
		"$node.connected"(payload) {
			this.logger.info(`Node connected: ${payload.node.id}`);
			// Démarrer l'élection si on détecte un autre service etcd
			setTimeout(() => this.checkForEtcdPeers(), 1000);
		},

		"$node.disconnected"(payload) {
			this.logger.info(`Node disconnected: ${payload.node.id}`);
			if (payload.node.id === this.masterId) {
				this.logger.warn("Master node disconnected, triggering election");
				this.triggerElection();
			}
		},

		"etcd.masterElected"(payload) {
			if (payload.masterId !== this.broker.nodeID) {
				this.becomeSlave(payload.masterId);
			}
		},

		"etcd.heartbeat"(payload) {
			if (payload.masterId !== this.broker.nodeID) {
				this.masterId = payload.masterId;
				this.lastHeartbeat = payload.timestamp;
			}
		},

		"etcd.syncRequest"(payload) {
			// Gérer les demandes de synchronisation
			if (this.isMaster && payload.nodeId !== this.broker.nodeID) {
				this.handleSyncRequest(payload);
			}
		}
	},

	methods: {
		/**
		 * S'assurer que ce nœud est le master
		 */
		async ensureMaster() {
			if (!this.isMaster) {
				throw new Error("Only master node can perform write operations");
			}
		},

		/**
		 * Répliquer vers les slaves
		 */
		async replicateToSlaves(action, data) {
			const slaves = await this.getEtcdSlaves();
			
			if (slaves.length === 0) {
				this.logger.debug("No slave nodes available for replication");
				return;
			}

			const promises = slaves.map(slave => 
				this.broker.call(`etcd.${action}`, data, { 
					nodeID: slave.id,
					meta: { isReplication: true }
				}).catch(err => {
					this.logger.error(`Replication failed to ${slave.id}:`, err);
				})
			);

			await Promise.allSettled(promises);
			this.logger.debug(`Replicated action '${action}' to ${slaves.length} slaves`);
		},

		/**
		 * Obtenir les slaves etcd
		 */
		async getEtcdSlaves() {
			const nodes = await this.broker.registry.getNodeList({ onlyAvailable: true });
			return nodes.filter(node => 
				node.id !== this.broker.nodeID && 
				node.services && 
				Array.isArray(node.services) &&
				node.services.find(s => s && s.name === "etcd")
			);
		},

		/**
		 * Vérifier s'il y a d'autres services etcd
		 */
		async checkForEtcdPeers() {
			const etcdNodes = await this.getEtcdNodes();
			
			if (etcdNodes.length > 1 && !this.electionInProgress) {
				this.logger.info(`Detected ${etcdNodes.length} etcd nodes, triggering election`);
				this.triggerElection();
			}
		},

		/**
		 * Obtenir tous les nœuds etcd
		 */
		async getEtcdNodes() {
			const nodes = await this.broker.registry.getNodeList({ onlyAvailable: true });
			return nodes.filter(node => 
				node.services && 
				Array.isArray(node.services) &&
				node.services.find(s => s && s.name === "etcd")
			);
		},

		/**
		 * Obtenir la taille du cluster
		 */
		async getClusterSize() {
			const etcdNodes = await this.getEtcdNodes();
			return etcdNodes.length;
		},

		/**
		 * Vérifier la santé du cluster
		 */
		async checkClusterHealth() {
			const etcdNodes = await this.getEtcdNodes();
			const healthChecks = [];

			for (const node of etcdNodes) {
				if (node.id === this.broker.nodeID) continue;
				
				try {
					await this.broker.call("etcd.health", {}, { 
						nodeID: node.id,
						timeout: 2000 
					});
					healthChecks.push({ nodeId: node.id, healthy: true });
				} catch (err) {
					healthChecks.push({ nodeId: node.id, healthy: false, error: err.message });
				}
			}

			const healthyNodes = healthChecks.filter(h => h.healthy).length + 1; // +1 pour ce nœud
			const totalNodes = etcdNodes.length;
			
			return {
				healthy: healthyNodes > totalNodes / 2, // Majorité
				totalNodes,
				healthyNodes,
				checks: healthChecks
			};
		},

		/**
		 * Gérer une demande de synchronisation
		 */
		async handleSyncRequest(payload) {
			try {
				const changes = await this.getChangesSince(payload.lastSyncTime);
				
				this.broker.emit("etcd.syncResponse", {
					nodeId: this.broker.nodeID,
					targetNodeId: payload.nodeId,
					changes
				});
			} catch (err) {
				this.logger.error("Error handling sync request:", err);
			}
		},

		/**
		 * Synchroniser périodiquement avec le master (pour les slaves)
		 */
		async periodicSync() {
			if (!this.isMaster && this.masterId) {
				try {
					const response = await this.broker.call("etcd.sync", {
						lastSyncTime: this.lastSyncTime
					}, { 
						nodeID: this.masterId,
						timeout: 5000 
					});
					
					if (response.changes && response.changes.length > 0) {
						await this.applyChanges(response.changes);
						this.lastSyncTime = Date.now();
						this.logger.debug(`Applied ${response.changes.length} changes from master`);
					}
				} catch (err) {
					this.logger.error("Sync with master failed:", err);
				}
			}
		}
	},

	async started() {
		await this.initializeStorage();
		await this.initializeElection();
		
		// Démarrer la synchronisation périodique pour les slaves
		this.syncTimer = setInterval(() => {
			this.periodicSync();
		}, this.settings.syncInterval);
		
		this.logger.info("ETCD service started successfully", {
			nodeId: this.broker.nodeID,
			isMaster: this.isMaster,
			dataPath: this.settings.dbPath
		});

		// Vérifier s'il y a d'autres nœuds etcd après le démarrage
		setTimeout(() => this.checkForEtcdPeers(), 2000);
	},

	async stopped() {
		if (this.syncTimer) {
			clearInterval(this.syncTimer);
		}
		
		await this.closeStorage();
		this.logger.info("ETCD service stopped");
	}
};