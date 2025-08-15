// services/election/etcd-election.js
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
			this.electionTimer = null;
			this.lastHeartbeat = null;
			
			// Au démarrage, on se considère comme master jusqu'à preuve du contraire
			// L'élection se déclenchera quand d'autres nœuds etcd se connecteront
			this.becomeMaster();
		},

		/**
		 * Déclencher une élection
		 */
		async triggerElection() {
			if (this.electionInProgress) {
				this.logger.debug("Election already in progress, skipping");
				return;
			}
			
			this.electionInProgress = true;
			this.logger.info("Starting ETCD master election...");
			
			try {
				const etcdNodes = await this.getEtcdNodes();
				
				if (etcdNodes.length === 0) {
					// Aucun autre nœud, on devient master
					this.becomeMaster();
					return;
				}

				// Trier les nœuds par ID pour avoir un ordre déterministe
				const candidates = this.sortNodesByPriority(etcdNodes);
				
				// Le nœud avec l'ID le plus petit devient master
				if (candidates.length === 0 || candidates[0].id === this.broker.nodeID) {
					this.becomeMaster();
				} else {
					this.becomeSlave(candidates[0].id);
				}
				
			} catch (err) {
				this.logger.error("Election error:", err);
				// En cas d'erreur, on reste dans l'état actuel
			} finally {
				this.electionInProgress = false;
			}
		},

		/**
		 * Obtenir les nœuds ETCD disponibles
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
		 * Trier les nœuds par priorité (ID le plus petit gagne)
		 */
		sortNodesByPriority(nodes) {
			return nodes.sort((a, b) => a.id.localeCompare(b.id));
		},

		/**
		 * Devenir master
		 */
		becomeMaster() {
			const wasSlaveBeforeMaster = !this.isMaster;
			
			this.isMaster = true;
			this.masterId = this.broker.nodeID;
			this.lastHeartbeat = Date.now();
			
			if (wasSlaveBeforeMaster) {
				this.logger.info("Became ETCD MASTER node");
			} else {
				this.logger.debug("Remaining as ETCD MASTER node");
			}
			
			// Démarrer le heartbeat
			this.startHeartbeat();
			
			// Notifier les autres nœuds
			this.broker.broadcast("etcd.masterElected", {
				masterId: this.masterId,
				timestamp: Date.now()
			});
		},

		/**
		 * Devenir slave
		 */
		becomeSlave(masterId) {
			this.isMaster = false;
			this.masterId = masterId;
			this.lastHeartbeat = Date.now();
			
			this.logger.info(`Became ETCD SLAVE node. Master: ${masterId}`);
			
			// Arrêter le heartbeat si actif
			this.stopHeartbeat();
			
			// Démarrer la surveillance du master
			this.startMasterMonitoring();
		},

		/**
		 * Démarrer le heartbeat (pour le master)
		 */
		startHeartbeat() {
			this.stopHeartbeat();
			
			this.heartbeatTimer = setInterval(() => {
				this.broker.broadcast("etcd.heartbeat", {
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
		},

		/**
		 * Démarrer la surveillance du master (pour les slaves)
		 */
		startMasterMonitoring() {
			this.stopMasterMonitoring();
			
			this.electionTimer = setInterval(() => {
				this.checkMasterHealth();
			}, this.settings.heartbeatInterval * 2);
		},

		/**
		 * Arrêter la surveillance du master
		 */
		stopMasterMonitoring() {
			if (this.electionTimer) {
				clearInterval(this.electionTimer);
				this.electionTimer = null;
			}
		},

		/**
		 * Vérifier la santé du master
		 */
		async checkMasterHealth() {
			if (this.isMaster) return;
			
			const now = Date.now();
			const timeSinceLastHeartbeat = now - this.lastHeartbeat;
			
			// Si on n'a pas reçu de heartbeat depuis trop longtemps
			if (timeSinceLastHeartbeat > this.settings.electionTimeout) {
				this.logger.warn(`Master heartbeat timeout (${timeSinceLastHeartbeat}ms), triggering election`);
				this.triggerElection();
				return;
			}
			
			// Vérifier si le master est toujours accessible
			if (this.masterId) {
				try {
					await this.broker.call("etcd.health", {}, { 
						nodeID: this.masterId, 
						timeout: 2000 
					});
				} catch (err) {
					this.logger.warn(`Master node ${this.masterId} is not responding, triggering election`);
					this.triggerElection();
				}
			}
		},

		/**
		 * Gérer l'événement de master élu
		 */
		handleMasterElected(payload) {
			if (payload.masterId !== this.broker.nodeID) {
				this.becomeSlave(payload.masterId);
			}
		},

		/**
		 * Gérer l'événement de heartbeat
		 */
		handleHeartbeat(payload) {
			if (payload.masterId !== this.broker.nodeID) {
				// Mettre à jour les informations du master
				this.masterId = payload.masterId;
				this.lastHeartbeat = payload.timestamp;
				
				// Si on n'était pas au courant de ce master, devenir slave
				if (this.isMaster) {
					this.logger.info(`Detected active master ${payload.masterId}, becoming slave`);
					this.becomeSlave(payload.masterId);
				}
			}
		},

		/**
		 * Forcer une nouvelle élection (pour les tests ou la maintenance)
		 */
		async forceElection() {
			this.logger.info("Forcing new election");
			this.stopHeartbeat();
			this.stopMasterMonitoring();
			
			// Attendre un peu pour que les autres nœuds détectent l'absence
			setTimeout(() => {
				this.triggerElection();
			}, this.settings.heartbeatInterval);
		},

		/**
		 * Obtenir l'état de l'élection
		 */
		getElectionState() {
			return {
				isMaster: this.isMaster,
				masterId: this.masterId,
				electionInProgress: this.electionInProgress,
				lastHeartbeat: this.lastHeartbeat,
				nodeId: this.broker.nodeID
			};
		}
	},

	events: {
		"etcd.masterElected"(payload) {
			this.handleMasterElected(payload);
		},

		"etcd.heartbeat"(payload) {
			this.handleHeartbeat(payload);
		}
	},

	async stopped() {
		this.stopHeartbeat();
		this.stopMasterMonitoring();
	}
};