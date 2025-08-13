// services/coderdb.service.js
"use strict";

const { Service } = require("moleculer");
const Storage = require("./storage/local-storage");
const Election = require("./election/master-election");
const FunctionValidator = require("./validators/function-validator");

module.exports = {
	name: "coderdb",

	mixins: [Storage, Election],

	settings: {
		dbPath: "./data/coderdb",
		electionTimeout: 5000,
		heartbeatInterval: 2000
	},

	dependencies: [],

	actions: {
		/**
		 * Créer une nouvelle fonction
		 */
		createFunction: {
			params: {
				name: "string",
				inputParams: "array",
				outputParams: "array", 
				code: "string",
				testCode: "string",
				environment: { type: "string", optional: true, default: "development" }
			},
			async handler(ctx) {
				await this.ensureMaster();
				
				const functionData = FunctionValidator.validate(ctx.params);
				functionData.environment = ctx.params.environment || "development";
				
				const result = await this.create(functionData);
				
				// Ne pas répliquer si c'est déjà une réplication
				if (!ctx.meta.isReplication) {
					await this.replicateToSlaves("createFunction", { ...functionData, isReplication: true });
				}
				
				return result;
			}
		},

		/**
		 * Récupérer une fonction par nom
		 */
		getFunction: {
			params: {
				name: "string"
			},
			async handler(ctx) {
				return await this.get(ctx.params.name);
			}
		},

		/**
		 * Mettre à jour une fonction
		 */
		updateFunction: {
			params: {
				name: "string",
				inputParams: { type: "array", optional: true },
				outputParams: { type: "array", optional: true },
				code: { type: "string", optional: true },
				testCode: { type: "string", optional: true },
				environment: { type: "string", optional: true }
			},
			async handler(ctx) {
				await this.ensureMaster();
				
				const updates = FunctionValidator.validateUpdate(ctx.params);
				if (ctx.params.environment) {
					updates.environment = ctx.params.environment;
				}
				
				const result = await this.update(ctx.params.name, updates);
				
				// Ne pas répliquer si c'est déjà une réplication
				if (!ctx.meta.isReplication) {
					await this.replicateToSlaves("updateFunction", { ...ctx.params, isReplication: true });
				}
				
				return result;
			}
		},

		/**
		 * Supprimer une fonction
		 */
		deleteFunction: {
			params: {
				name: "string"
			},
			async handler(ctx) {
				await this.ensureMaster();
				
				const result = await this.delete(ctx.params.name);
				
				// Ne pas répliquer si c'est déjà une réplication
				if (!ctx.meta.isReplication) {
					await this.replicateToSlaves("deleteFunction", { name: ctx.params.name, isReplication: true });
				}
				
				return result;
			}
		},

		/**
		 * Promouvoir une fonction en production
		 */
		promoteToProduction: {
			params: {
				name: "string"
			},
			async handler(ctx) {
				await this.ensureMaster();
				
				// Vérifier que la fonction existe
				const existingFunction = await this.get(ctx.params.name);
				
				if (existingFunction.environment === "production") {
					throw new Error("Function is already in production");
				}
				
				// Mettre à jour l'environnement
				const result = await this.update(ctx.params.name, { 
					environment: "production",
					promotedAt: new Date().toISOString()
				});
				
				// Ne pas répliquer si c'est déjà une réplication
				if (!ctx.meta.isReplication) {
					await this.replicateToSlaves("promoteToProduction", { name: ctx.params.name, isReplication: true });
				}
				
				this.logger.info(`Function '${ctx.params.name}' promoted to production`);
				
				return result;
			}
		},

		/**
		 * Lister les fonctions avec filtres
		 */
		listFunctions: {
			params: {
				environment: { type: "string", optional: true },
				search: { type: "string", optional: true }
			},
			async handler(ctx) {
				let functions = await this.list();
				
				// Filtrer par environnement
				if (ctx.params.environment) {
					functions = functions.filter(f => f.environment === ctx.params.environment);
				}
				
				// Filtrer par recherche
				if (ctx.params.search) {
					const search = ctx.params.search.toLowerCase();
					functions = functions.filter(f => 
						f.name.toLowerCase().includes(search) ||
						(f.description && f.description.toLowerCase().includes(search))
					);
				}
				
				return functions;
			}
		},

		/**
		 * Obtenir les statistiques
		 */
		getStatistics: {
			async handler(ctx) {
				const functions = await this.list();
				
				const stats = {
					total: functions.length,
					development: functions.filter(f => f.environment === "development").length,
					production: functions.filter(f => f.environment === "production").length,
					recentlyCreated: functions.filter(f => {
						const created = new Date(f.createdAt);
						const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
						return created > weekAgo;
					}).length,
					recentlyUpdated: functions.filter(f => {
						const updated = new Date(f.updatedAt);
						const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
						return updated > weekAgo;
					}).length
				};
				
				return stats;
			}
		},

		/**
		 * Obtenir le statut du nœud
		 */
		getStatus: {
			async handler(ctx) {
				const stats = await this.broker.call("coderdb.getStatistics");
				
				return {
					nodeId: this.broker.nodeID,
					isMaster: this.isMaster,
					masterId: this.masterId,
					functionsCount: stats.total,
					developmentCount: stats.development,
					productionCount: stats.production,
					uptime: process.uptime(),
					version: require("../package.json").version
				};
			}
		}
	},

	events: {
		"$node.connected"(payload) {
			this.logger.info(`Node connected: ${payload.node.id}`);
			this.triggerElection();
		},

		"$node.disconnected"(payload) {
			this.logger.info(`Node disconnected: ${payload.node.id}`);
			if (payload.node.id === this.masterId) {
				this.logger.warn("Master node disconnected, triggering election");
				this.triggerElection();
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
		 * Répliquer l'action vers les slaves
		 */
		async replicateToSlaves(action, data) {
			const nodes = await this.broker.registry.getNodeList({ onlyAvailable: true });
			const slaves = nodes.filter(node => 
				node.id !== this.broker.nodeID && 
				node.services && 
				Array.isArray(node.services) &&
				node.services.find(s => s && s.name === "coderdb")
			);

			if (slaves.length === 0) {
				this.logger.debug("No slave nodes available for replication");
				return;
			}

			const promises = slaves.map(slave => 
				this.broker.call(`coderdb.${action}`, data, { 
					nodeID: slave.id,
					meta: { isReplication: true }
				}).catch(err => {
					this.logger.error(`Replication failed to ${slave.id}:`, err);
				})
			);

			await Promise.allSettled(promises);
			this.logger.debug(`Replicated action '${action}' to ${slaves.length} slaves`);
		}
	},

	async started() {
		await this.initializeStorage();
		await this.initializeElection();
		
		this.logger.info("CoderDB service started successfully", {
			nodeId: this.broker.nodeID,
			isMaster: this.isMaster,
			dataPath: this.settings.dbPath
		});
	},

	async stopped() {
		await this.closeStorage();
		this.logger.info("CoderDB service stopped");
	}
};