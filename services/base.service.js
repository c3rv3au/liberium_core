// services/base.service.js
"use strict";

module.exports = {
	name: "base",

	settings: {
		// Intervalle de nettoyage des abonnements expirés (en ms)
		cleanupInterval: 30000,
		// TTL par défaut pour les abonnements (en ms) 
		subscriptionTTL: 300000 // 5 minutes
	},

	actions: {
		/**
		 * Obtenir le nom du module/service
		 */
		caption: {
			cache: true,
			handler(ctx) {
				return this.name;
			}
		},

		/**
		 * S'abonner à la mémoire d'un autre service
		 */
		subscribe: {
			params: {
				targetService: "string",
				subscriberService: { type: "string", optional: true }
			},
			async handler(ctx) {
				const { targetService } = ctx.params;
				const subscriberService = ctx.params.subscriberService || ctx.caller;

				if (!subscriberService) {
					throw new Error("Subscriber service must be specified");
				}

				// Vérifier que le service cible existe
				const targetExists = await this.checkServiceExists(targetService);
				if (!targetExists) {
					throw new Error(`Target service '${targetService}' not found`);
				}

				// Ajouter l'abonnement
				this.addSubscription(subscriberService, targetService);

				// Envoyer la mémoire actuelle du service cible
				try {
					const targetMemory = await this.broker.call(`${targetService}.getMemory`);
					await this.updateSharedMemory(subscriberService, targetService, targetMemory);
				} catch (err) {
					this.logger.warn(`Failed to get initial memory from ${targetService}:`, err.message);
				}

				this.logger.info(`${subscriberService} subscribed to ${targetService} memory`);
				
				return {
					subscribed: true,
					targetService,
					subscriberService,
					timestamp: Date.now()
				};
			}
		},

		/**
		 * Se désabonner de la mémoire d'un service
		 */
		unsubscribe: {
			params: {
				targetService: "string",
				subscriberService: { type: "string", optional: true }
			},
			handler(ctx) {
				const { targetService } = ctx.params;
				const subscriberService = ctx.params.subscriberService || ctx.caller;

				this.removeSubscription(subscriberService, targetService);
				this.removeSharedMemory(subscriberService, targetService);

				this.logger.info(`${subscriberService} unsubscribed from ${targetService} memory`);

				return {
					unsubscribed: true,
					targetService,
					subscriberService,
					timestamp: Date.now()
				};
			}
		},

		/**
		 * Obtenir la mémoire locale du service
		 */
		getMemory: {
			handler(ctx) {
				return this.memory;
			}
		},

		/**
		 * Obtenir la mémoire partagée
		 */
		getSharedMemory: {
			params: {
				serviceFilter: { type: "string", optional: true }
			},
			handler(ctx) {
				const { serviceFilter } = ctx.params;
				
				if (serviceFilter) {
					return this.shared_memory[serviceFilter] || null;
				}
				
				return this.shared_memory;
			}
		},

		/**
		 * Mettre à jour la mémoire locale
		 */
		updateMemory: {
			params: {
				data: "any",
				merge: { type: "boolean", optional: true, default: true }
			},
			async handler(ctx) {
				const { data, merge } = ctx.params;
				
				// Sauvegarder l'ancienne mémoire
				const oldMemory = { ...this.memory };
				
				// Mettre à jour la mémoire
				if (merge && typeof data === "object" && data !== null) {
					this.memory = { ...this.memory, ...data };
				} else {
					this.memory = data;
				}

				// Notifier les abonnés
				await this.notifySubscribers();

				this.logger.debug("Memory updated", { 
					service: this.name,
					hasSubscribers: this.subscriptions.size > 0
				});

				return {
					updated: true,
					oldMemory,
					newMemory: this.memory,
					timestamp: Date.now()
				};
			}
		},

		/**
		 * Lister tous les abonnements actifs
		 */
		listSubscriptions: {
			handler(ctx) {
				const subscriptions = {};
				
				for (const [subscriber, targets] of this.subscriptions.entries()) {
					subscriptions[subscriber] = {
						targets: Array.from(targets.keys()),
						count: targets.size
					};
				}

				return {
					subscriptions,
					totalSubscribers: this.subscriptions.size,
					sharedMemoryKeys: Object.keys(this.shared_memory)
				};
			}
		}
	},

	events: {
		/**
		 * Notification de changement de mémoire d'un autre service
		 */
		"memory.updated"(payload) {
			const { service, memory } = payload;
			
			// Mettre à jour la mémoire partagée si on est abonné
			if (this.shared_memory[service] !== undefined) {
				this.shared_memory[service] = memory;
				this.logger.debug(`Shared memory updated for ${service}`);
			}
		},

		/**
		 * Service connecté
		 */
		"$node.connected"(payload) {
			this.logger.debug(`Node connected: ${payload.node.id}`);
		},

		/**
		 * Service déconnecté
		 */
		"$node.disconnected"(payload) {
			this.logger.debug(`Node disconnected: ${payload.node.id}`);
			// Nettoyer les abonnements du service déconnecté
			this.cleanupDisconnectedService(payload.node.id);
		}
	},

	methods: {
		/**
		 * Ajouter un abonnement
		 */
		addSubscription(subscriber, target) {
			if (!this.subscriptions.has(subscriber)) {
				this.subscriptions.set(subscriber, new Map());
			}
			
			this.subscriptions.get(subscriber).set(target, {
				timestamp: Date.now(),
				ttl: this.settings.subscriptionTTL
			});
		},

		/**
		 * Supprimer un abonnement
		 */
		removeSubscription(subscriber, target) {
			if (this.subscriptions.has(subscriber)) {
				this.subscriptions.get(subscriber).delete(target);
				
				// Supprimer le subscriber s'il n'a plus d'abonnements
				if (this.subscriptions.get(subscriber).size === 0) {
					this.subscriptions.delete(subscriber);
				}
			}
		},

		/**
		 * Mettre à jour la mémoire partagée
		 */
		async updateSharedMemory(subscriber, target, memory) {
			// Initialiser shared_memory pour ce subscriber s'il n'existe pas
			if (!this.shared_memory[target]) {
				this.shared_memory[target] = {};
			}
			
			this.shared_memory[target] = memory;
		},

		/**
		 * Supprimer la mémoire partagée
		 */
		removeSharedMemory(subscriber, target) {
			delete this.shared_memory[target];
		},

		/**
		 * Notifier tous les abonnés des changements de mémoire
		 */
		async notifySubscribers() {
			if (this.subscriptions.size === 0) return;

			const payload = {
				service: this.name,
				memory: this.memory,
				timestamp: Date.now()
			};

			// Envoyer l'événement de mise à jour
			this.broker.emit("memory.updated", payload);

			// Mettre à jour directement chaque abonné
			const notifications = [];
			
			for (const [subscriber] of this.subscriptions) {
				try {
					const promise = this.broker.call(`${subscriber}.updateSharedMemory`, {
						targetService: this.name,
						memory: this.memory
					}).catch(err => {
						this.logger.warn(`Failed to notify ${subscriber}:`, err.message);
						// Supprimer l'abonnement défaillant
						this.removeSubscription(subscriber, this.name);
					});
					
					notifications.push(promise);
				} catch (err) {
					this.logger.warn(`Error preparing notification for ${subscriber}:`, err.message);
				}
			}

			// Attendre toutes les notifications
			await Promise.allSettled(notifications);
		},

		/**
		 * Vérifier si un service existe
		 */
		async checkServiceExists(serviceName) {
			try {
				const nodes = await this.broker.registry.getNodeList({ onlyAvailable: true });
				
				for (const node of nodes) {
					if (node.services && Array.isArray(node.services)) {
						const serviceExists = node.services.some(service => 
							service && service.name === serviceName
						);
						if (serviceExists) return true;
					}
				}
				
				return false;
			} catch (err) {
				this.logger.error("Error checking service existence:", err);
				return false;
			}
		},

		/**
		 * Nettoyer les abonnements d'un service déconnecté
		 */
		cleanupDisconnectedService(nodeId) {
			const toRemove = [];
			
			for (const [subscriber, targets] of this.subscriptions.entries()) {
				// Identifier les services par nodeId (approximatif)
				if (subscriber.includes(nodeId)) {
					toRemove.push(subscriber);
				}
			}

			toRemove.forEach(subscriber => {
				this.subscriptions.delete(subscriber);
				// Nettoyer la mémoire partagée associée
				Object.keys(this.shared_memory).forEach(key => {
					if (key.includes(nodeId)) {
						delete this.shared_memory[key];
					}
				});
			});

			if (toRemove.length > 0) {
				this.logger.info(`Cleaned up ${toRemove.length} subscriptions from disconnected node ${nodeId}`);
			}
		},

		/**
		 * Nettoyer les abonnements expirés
		 */
		cleanupExpiredSubscriptions() {
			const now = Date.now();
			const expired = [];

			for (const [subscriber, targets] of this.subscriptions.entries()) {
				for (const [target, info] of targets.entries()) {
					if (now - info.timestamp > info.ttl) {
						expired.push({ subscriber, target });
					}
				}
			}

			expired.forEach(({ subscriber, target }) => {
				this.removeSubscription(subscriber, target);
				this.removeSharedMemory(subscriber, target);
			});

			if (expired.length > 0) {
				this.logger.debug(`Cleaned up ${expired.length} expired subscriptions`);
			}
		}
	},

	/**
	 * Initialisation du service
	 */
	created() {
		// Initialiser la mémoire locale
		this.memory = {};
		
		// Initialiser la mémoire partagée
		this.shared_memory = {};
		
		// Initialiser les abonnements (Map de Maps)
		// Structure: subscriber -> Map(target -> {timestamp, ttl})
		this.subscriptions = new Map();
	},

	/**
	 * Démarrage du service
	 */
	async started() {
		this.logger.info(`${this.name} service started`);
		
		// Démarrer le nettoyage périodique
		this.cleanupTimer = setInterval(() => {
			this.cleanupExpiredSubscriptions();
		}, this.settings.cleanupInterval);
	},

	/**
	 * Arrêt du service
	 */
	async stopped() {
		// Arrêter le timer de nettoyage
		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
			this.cleanupTimer = null;
		}

		// Notifier les autres services qu'on se déconnecte
		if (this.subscriptions.size > 0) {
			this.broker.emit("service.disconnecting", {
				service: this.name,
				timestamp: Date.now()
			});
		}

		this.logger.info(`${this.name} service stopped`);
	}
};