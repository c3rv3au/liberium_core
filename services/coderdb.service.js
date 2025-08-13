// services/coderdb.service.js
"use strict";

const { Service } = require("moleculer");
const Storage = require("./storage/local-storage");
const Election = require("./election/master-election");
const FunctionValidator = require("./validators/function-validator");

module.exports = {
	name: "coderdb",
	version: 1,

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
				testCode: "string"
			},
			async handler(ctx) {
				await this.ensureMaster();
				
				const functionData = FunctionValidator.validate(ctx.params);
				const result = await this.storage.create(functionData);
				
				await this.replicateToSlaves("createFunction", functionData);
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
				return await this.storage.get(ctx.params.name);
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
				testCode: { type: "string", optional: true }
			},
			async handler(ctx) {
				await this.ensureMaster();
				
				const updates = FunctionValidator.validateUpdate(ctx.params);
				const result = await this.storage.update(ctx.params.name, updates);
				
				await this.replicateToSlaves("updateFunction", ctx.params);
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
				
				const result = await this.storage.delete(ctx.params.name);
				
				await this.replicateToSlaves("deleteFunction", { name: ctx.params.name });
				return result;
			}
		},

		/**
		 * Lister toutes les fonctions
		 */
		listFunctions: {
			async handler(ctx) {
				return await this.storage.list();
			}
		},

		/**
		 * Obtenir le statut du nœud
		 */
		getStatus: {
			async handler(ctx) {
				return {
					nodeId: this.broker.nodeID,
					isMaster: this.isMaster,
					masterId: this.masterId,
					functionsCount: await this.storage.count()
				};
			}
		}
	},

	events: {
		"$node.connected"(payload) {
			this.triggerElection();
		},

		"$node.disconnected"(payload) {
			if (payload.node.id === this.masterId) {
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

			await Promise.all(
				slaves.map(slave => 
					this.broker.call(`coderdb.${action}`, data, { nodeID: slave.id })
						.catch(err => this.logger.error(`Replication failed to ${slave.id}:`, err))
				)
			);
		}
	},

	async started() {
		await this.initializeStorage();
		await this.initializeElection();
		this.logger.info("CoderDB service started");
	},

	async stopped() {
		await this.closeStorage();
		this.logger.info("CoderDB service stopped");
	}
};