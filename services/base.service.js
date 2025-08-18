// services/base.service.js
"use strict";

module.exports = {
	name: "base",

	settings: {
		// Intervalle de nettoyage des abonnements expirés (en ms)
		cleanupInterval: 30000,
		// TTL par défaut pour les abonnements (en ms) 
		subscriptionTTL: 300000, // 5 minutes
		// Métriques de communication
		metricsRetention: 60000, // 1 minute
		maxMetricsEntries: 1000
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
		 * Obtenir les métriques de communication du service
		 */
		getMetrics: {
			handler(ctx) {
				return this.getServiceMetrics();
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
					sharedMemoryKeys: Object.keys(this.shared_memory),
					metrics: this.getServiceMetrics()
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
		 * Enregistrer un appel sortant
		 */
		recordOutgoingCall(targetService, action, params, duration) {
			const now = Date.now();
			const entry = {
				timestamp: now,
				target: targetService,
				action,
				duration: duration || 0,
				paramSize: this.calculateSize(params),
				direction: 'outgoing'
			};

			this.communicationMetrics.push(entry);
			this.cleanupOldMetrics();
		},

		/**
		 * Enregistrer un appel entrant
		 */
		recordIncomingCall(sourceService, action, params, duration) {
			const now = Date.now();
			const entry = {
				timestamp: now,
				source: sourceService,
				action,
				duration: duration || 0,
				paramSize: this.calculateSize(params),
				direction: 'incoming'
			};

			this.communicationMetrics.push(entry);
			this.cleanupOldMetrics();
		},

		/**
		 * Calculer la taille approximative d'un objet
		 */
		calculateSize(obj) {
			if (!obj) return 0;
			try {
				return JSON.stringify(obj).length;
			} catch (err) {
				return 0;
			}
		},

		/**
		 * Obtenir les métriques du service
		 */
		getServiceMetrics() {
			const now = Date.now();
			const recentMetrics = this.communicationMetrics.filter(
				m => now - m.timestamp <= this.settings.metricsRetention
			);

			const outgoing = recentMetrics.filter(m => m.direction === 'outgoing');
			const incoming = recentMetrics.filter(m => m.direction === 'incoming');

			return {
				nodeId: this.broker.nodeID,
				serviceName: this.name,
				timestamp: now,
				summary: {
					totalCalls: recentMetrics.length,
					outgoingCalls: outgoing.length,
					incomingCalls: incoming.length,
					callsPerSecond: recentMetrics.length / (this.settings.metricsRetention / 1000),
					averageDuration: this.calculateAverageDuration(recentMetrics),
					totalDataSize: recentMetrics.reduce((acc, m) => acc + m.paramSize, 0)
				},
				outgoing: this.groupMetricsByTarget(outgoing),
				incoming: this.groupMetricsBySource(incoming),
				actions: this.groupMetricsByAction(recentMetrics),
				trends: this.calculateTrends()
			};
		},

		/**
		 * Grouper les métriques par cible
		 */
		groupMetricsByTarget(metrics) {
			const grouped = {};
			metrics.forEach(metric => {
				const target = metric.target;
				if (!grouped[target]) {
					grouped[target] = {
						calls: 0,
						totalDuration: 0,
						totalSize: 0,
						actions: {}
					};
				}
				grouped[target].calls++;
				grouped[target].totalDuration += metric.duration;
				grouped[target].totalSize += metric.paramSize;
				grouped[target].actions[metric.action] = (grouped[target].actions[metric.action] || 0) + 1;
			});

			// Calculer les moyennes
			Object.values(grouped).forEach(group => {
				group.averageDuration = group.calls > 0 ? group.totalDuration / group.calls : 0;
				group.averageSize = group.calls > 0 ? group.totalSize / group.calls : 0;
				group.callsPerSecond = group.calls / (this.settings.metricsRetention / 1000);
			});

			return grouped;
		},

		/**
		 * Grouper les métriques par source
		 */
		groupMetricsBySource(metrics) {
			const grouped = {};
			metrics.forEach(metric => {
				const source = metric.source;
				if (!grouped[source]) {
					grouped[source] = {
						calls: 0,
						totalDuration: 0,
						totalSize: 0,
						actions: {}
					};
				}
				grouped[source].calls++;
				grouped[source].totalDuration += metric.duration;
				grouped[source].totalSize += metric.paramSize;
				grouped[source].actions[metric.action] = (grouped[source].actions[metric.action] || 0) + 1;
			});

			// Calculer les moyennes
			Object.values(grouped).forEach(group => {
				group.averageDuration = group.calls > 0 ? group.totalDuration / group.calls : 0;
				group.averageSize = group.calls > 0 ? group.totalSize / group.calls : 0;
				group.callsPerSecond = group.calls / (this.settings.metricsRetention / 1000);
			});

			return grouped;
		},

		/**
		 * Grouper les métriques par action
		 */
		groupMetricsByAction(metrics) {
			const grouped = {};
			metrics.forEach(metric => {
				const action = metric.action;
				if (!grouped[action]) {
					grouped[action] = {
						calls: 0,
						totalDuration: 0,
						averageDuration: 0,
						callsPerSecond: 0
					};
				}
				grouped[action].calls++;
				grouped[action].totalDuration += metric.duration;
			});

			// Calculer les moyennes
			Object.values(grouped).forEach(group => {
				group.averageDuration = group.calls > 0 ? group.totalDuration / group.calls : 0;
				group.callsPerSecond = group.calls / (this.settings.metricsRetention / 1000);
			});

			return grouped;
		},

		/**
		 * Calculer la durée moyenne
		 */
		calculateAverageDuration(metrics) {
			if (metrics.length === 0) return 0;
			const total = metrics.reduce((acc, m) => acc + m.duration, 0);
			return total / metrics.length;
		},

		/**
		 * Calculer les tendances
		 */
		calculateTrends() {
			const now = Date.now();
			const intervals = [5000, 15000, 30000]; // 5s, 15s, 30s
			const trends = {};

			intervals.forEach(interval => {
				const intervalMetrics = this.communicationMetrics.filter(
					m => now - m.timestamp <= interval
				);
				
				trends[`${interval/1000}s`] = {
					calls: intervalMetrics.length,
					callsPerSecond: intervalMetrics.length / (interval / 1000),
					averageDuration: this.calculateAverageDuration(intervalMetrics)
				};
			});

			return trends;
		},

		/**
		 * Nettoyer les anciennes métriques
		 */
		cleanupOldMetrics() {
			const now = Date.now();
			const cutoff = now - (this.settings.metricsRetention * 2); // Garder 2x la rétention
			
			this.communicationMetrics = this.communicationMetrics.filter(
				m => m.timestamp > cutoff
			);

			// Limiter le nombre d'entrées
			if (this.communicationMetrics.length > this.settings.maxMetricsEntries) {
				this.communicationMetrics = this.communicationMetrics.slice(-this.settings.maxMetricsEntries);
			}
		},

		/**
		 * Wrapper pour broker.call avec métriques
		 */
		async callWithMetrics(action, params, options = {}) {
			const start = Date.now();
			const targetService = action.split('.')[0];
			
			try {
				const result = await this.broker.call(action, params, options);
				const duration = Date.now() - start;
				this.recordOutgoingCall(targetService, action, params, duration);
				return result;
			} catch (err) {
				const duration = Date.now() - start;
				this.recordOutgoingCall(targetService, action, params, duration);
				throw err;
			}
		},

		/**
		 * Middleware pour enregistrer les appels entrants
		 */
		createMetricsMiddleware() {
			return {
				name: "Metrics",
				localAction: (next, action) => {
					return async (ctx) => {
						const start = Date.now();
						const sourceService = ctx.caller || 'unknown';
						
						try {
							const result = await next(ctx);
							const duration = Date.now() - start;
							this.recordIncomingCall(sourceService, action.name, ctx.params, duration);
							return result;
						} catch (err) {
							const duration = Date.now() - start;
							this.recordIncomingCall(sourceService, action.name, ctx.params, duration);
							throw err;
						}
					};
				}
			};
		},

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
					const promise = this.callWithMetrics(`${subscriber}.updateSharedMemory`, {
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
		 * Vérifier si un service existe (version améliorée)
		 */
		async checkServiceExists(serviceName) {
			try {
				// Méthode 1: Vérifier via les nœuds disponibles
				const nodes = await this.broker.registry.getNodeList({ onlyAvailable: true });
				
				for (const node of nodes) {
					if (node.services && Array.isArray(node.services)) {
						const serviceExists = node.services.some(service => {
							// Gérer différents formats de service
							if (typeof service === 'string') {
								return service === serviceName;
							}
							if (service && service.name) {
								return service.name === serviceName;
							}
							if (service && service.fullName) {
								return service.fullName === serviceName || 
									   service.fullName.endsWith('.' + serviceName);
							}
							return false;
						});
						
						if (serviceExists) {
							this.logger.debug(`✅ Service ${serviceName} trouvé sur le nœud ${node.id}`);
							return true;
						}
					}
				}
				
				// Méthode 2: Vérifier via la liste des services directement
				const services = this.broker.registry.getServiceList({ 
					onlyAvailable: true,
					onlyLocal: false
				});
				
				const serviceFound = services.some(service => service.name === serviceName);
				
				if (serviceFound) {
					this.logger.debug(`✅ Service ${serviceName} trouvé dans la liste des services`);
					return true;
				}
				
				// Méthode 3: Essayer un appel simple pour vérifier la réactivité
				try {
					await this.broker.call(`${serviceName}.getStatus`, {}, { 
						timeout: 2000,
						retries: 0
					});
					this.logger.debug(`✅ Service ${serviceName} répond aux appels`);
					return true;
				} catch (callErr) {
					// Si l'action n'existe pas mais le service oui, c'est OK
					if (callErr.code === 'ACTION_NOT_FOUND') {
						this.logger.debug(`✅ Service ${serviceName} existe (mais pas d'action getStatus)`);
						return true;
					}
				}
				
				this.logger.debug(`❌ Service ${serviceName} non trouvé`);
				return false;
				
			} catch (err) {
				this.logger.debug(`❌ Erreur lors de la vérification du service ${serviceName}:`, err.message);
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
		
		// Initialiser les métriques de communication
		this.communicationMetrics = [];

		// Ajouter le middleware de métriques
		if (this.broker) {
			this.broker.middlewares.add(this.createMetricsMiddleware());
		}
	},

	/**
	 * Démarrage du service
	 */
	async started() {
		this.logger.info(`${this.name} service started with metrics`);
		
		// Démarrer le nettoyage périodique
		this.cleanupTimer = setInterval(() => {
			this.cleanupExpiredSubscriptions();
			this.cleanupOldMetrics();
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