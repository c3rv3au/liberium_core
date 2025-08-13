// services/election/master-election.js
"use strict";

module.exports = {
	methods: {
		/**
		 * Initialiser le système d'élection
		 */
		async initializeElection() {
			this.isMaster = false;
			this.masterId = null;
			this.electionInProgress = false;
			this.heartbeatTimer = null;
			
			// Démarrer l'élection initiale
			setTimeout(() => this.triggerElection(), 1000);
		},

		/**
		 * Déclencher une élection
		 */
		async triggerElection() {
			if (this.electionInProgress) return;
			
			this.electionInProgress = true;
			this.logger.info("Starting master election...");
			
			try {
				const nodes = await this.getAvailableNodes();
				const candidates = this.sortNodesByPriority(nodes);
				
				if (candidates.length === 0) {
					this.becomeMaster();
				} else if (candidates[0].id === this.broker.nodeID) {
					this.becomeMaster();
				} else {
					this.becomeSlave(candidates[0].id);
				}
			} catch (err) {
				this.logger.error("Election error:", err);
			} finally {
				this.electionInProgress = false;
			}
		},

		/**
		 * Obtenir les nœuds disponibles
		 */
		async getAvailableNodes() {
			const nodes = await this.broker.registry.getNodeList({ onlyAvailable: true });
			return nodes.filter(node => 
				node.services && 
				Array.isArray(node.services) && 
				node.services.find(s => s && s.name === "coderdb")
			);
		},

		/**
		 * Trier les nœuds par priorité (ID le plus petit gagne)
		 */
		sortNodesByPriority(nodes) {
			return nodes.sort((a, b) => a.id.localeCompare(b.id));
		},

		/**
		 * Devenir master
		 */
		becomeMaster() {
			this.isMaster = true;
			this.masterId = this.broker.nodeID;
			
			this.logger.info("Became MASTER node");
			
			// Démarrer le heartbeat
			this.startHeartbeat();
			
			// Notifier les autres nœuds
			this.broker.broadcast("coderdb.masterElected", {
				masterId: this.masterId
			});
		},

		/**
		 * Devenir slave
		 */
		becomeSlave(masterId) {
			this.isMaster = false;
			this.masterId = masterId;
			
			this.logger.info(`Became SLAVE node. Master: ${masterId}`);
			
			// Arrêter le heartbeat si actif
			this.stopHeartbeat();
		},

		/**
		 * Démarrer le heartbeat
		 */
		startHeartbeat() {
			this.stopHeartbeat();
			
			this.heartbeatTimer = setInterval(() => {
				this.broker.broadcast("coderdb.heartbeat", {
					masterId: this.broker.nodeID,
					timestamp: Date.now()
				});
			}, this.settings.heartbeatInterval);
		},

		/**
		 * Arrêter le heartbeat
		 */
		stopHeartbeat() {
			if (this.heartbeatTimer) {
				clearInterval(this.heartbeatTimer);
				this.heartbeatTimer = null;
			}
		}
	},

	events: {
		"coderdb.masterElected"(payload) {
			if (payload.masterId !== this.broker.nodeID) {
				this.becomeSlave(payload.masterId);
			}
		},

		"coderdb.heartbeat"(payload) {
			if (payload.masterId !== this.broker.nodeID) {
				this.masterId = payload.masterId;
				this.lastHeartbeat = payload.timestamp;
			}
		}
	},

	async stopped() {
		this.stopHeartbeat();
	}
};