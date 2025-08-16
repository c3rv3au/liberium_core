// services/metrics-aggregator.service.js
"use strict";

const BaseService = require("./base.service");

module.exports = {
	name: "metrics-aggregator",

	mixins: [BaseService],

	settings: {
		// Intervalle de collecte des métriques (en ms)
		collectionInterval: 10000, // 10 secondes
		// Cache TTL pour les métriques agrégées
		cacheTTL: 5000 // 5 secondes
	},

	actions: {
		/**
		 * Obtenir les métriques agrégées de tout le cluster
		 */
		getClusterMetrics: {
			cache: {
				keys: [],
				ttl: 5
			},
			async handler(ctx) {
				try {
					const allMetrics = await this.collectAllServiceMetrics();
					const aggregated = this.aggregateMetrics(allMetrics);
					
					return {
						timestamp: Date.now(),
						clusterSummary: aggregated.summary,
						services: aggregated.services,
						communication: aggregated.communication,
						nodes: aggregated.nodes,
						trends: aggregated.trends
					};
				} catch (err) {
					this.logger.error("Error collecting cluster metrics:", err);
					return {
						timestamp: Date.now(),
						error: "Failed to collect metrics",
						clusterSummary: this.getEmptyMetrics()
					};
				}
			}
		},

		/**
		 * Obtenir les métriques d'un service spécifique
		 */
		getServiceMetrics: {
			params: {
				serviceName: "string"
			},
			async handler(ctx) {
				const { serviceName } = ctx.params;
				
				try {
					const services = await this.getServicesWithName(serviceName);
					const metricsPromises = services.map(service => 
						this.broker.call(`${serviceName}.getMetrics`, {}, { 
							nodeID: service.nodeID,
							timeout: 3000 
						}).catch(err => {
							this.logger.warn(`Failed to get metrics from ${serviceName} on ${service.nodeID}:`, err.message);
							return null;
						})
					);

					const results = await Promise.all(metricsPromises);
					const validMetrics = results.filter(m => m !== null);

					if (validMetrics.length === 0) {
						throw new Error(`No metrics available for service ${serviceName}`);
					}

					return {
						serviceName,
						timestamp: Date.now(),
						instances: validMetrics.length,
						metrics: validMetrics,
						aggregated: this.aggregateServiceMetrics(validMetrics)
					};
				} catch (err) {
					this.logger.error(`Error getting metrics for ${serviceName}:`, err);
					throw err;
				}
			}
		},

		/**
		 * Obtenir les métriques de communication entre deux services
		 */
		getCommunicationMetrics: {
			params: {
				sourceService: "string",
				targetService: "string"
			},
			async handler(ctx) {
				const { sourceService, targetService } = ctx.params;
				
				try {
					const sourceMetrics = await this.broker.call(`metrics-aggregator.getServiceMetrics`, {
						serviceName: sourceService
					});

					// Extraire les métriques de communication vers le service cible
					const communication = [];
					
					sourceMetrics.metrics.forEach(metric => {
						if (metric.outgoing && metric.outgoing[targetService]) {
							communication.push({
								nodeId: metric.nodeId,
								source: sourceService,
								target: targetService,
								...metric.outgoing[targetService]
							});
						}
					});

					return {
						sourceService,
						targetService,
						timestamp: Date.now(),
						communication,
						summary: this.summarizeCommunication(communication)
					};
				} catch (err) {
					this.logger.error(`Error getting communication metrics between ${sourceService} and ${targetService}:`, err);
					throw err;
				}
			}
		},

		/**
		 * Obtenir les top services par activité
		 */
		getTopServices: {
			params: {
				limit: { type: "number", default: 10, min: 1, max: 50 }
			},
			async handler(ctx) {
				const { limit } = ctx.params;
				
				try {
					const clusterMetrics = await this.broker.call("metrics-aggregator.getClusterMetrics");
					
					// Trier les services par activité
					const sortedServices = Object.entries(clusterMetrics.services)
						.map(([name, metrics]) => ({
							name,
							totalCalls: metrics.summary.totalCalls,
							callsPerSecond: metrics.summary.callsPerSecond,
							averageDuration: metrics.summary.averageDuration,
							instances: metrics.instances
						}))
						.sort((a, b) => b.callsPerSecond - a.callsPerSecond)
						.slice(0, limit);

					return {
						timestamp: Date.now(),
						topServices: sortedServices,
						limit
					};
				} catch (err) {
					this.logger.error("Error getting top services:", err);
					throw err;
				}
			}
		}
	},

	methods: {
		/**
		 * Collecter les métriques de tous les services
		 */
		async collectAllServiceMetrics() {
			const services = this.broker.registry.getServiceList({ 
				onlyAvailable: true 
			}).filter(s => s.name !== '$node' && s.name !== 'metrics-aggregator');

			const metricsPromises = services.map(service => 
				this.callWithMetrics(`${service.name}.getMetrics`, {}, { 
					nodeID: service.nodeID,
					timeout: 3000 
				}).catch(err => {
					this.logger.debug(`Failed to get metrics from ${service.name} on ${service.nodeID}:`, err.message);
					return null;
				})
			);

			const results = await Promise.all(metricsPromises);
			return results.filter(m => m !== null);
		},

		/**
		 * Agréger toutes les métriques
		 */
		aggregateMetrics(allMetrics) {
			const summary = this.calculateClusterSummary(allMetrics);
			const services = this.groupMetricsByService(allMetrics);
			const communication = this.extractCommunicationMatrix(allMetrics);
			const nodes = this.groupMetricsByNode(allMetrics);
			const trends = this.calculateClusterTrends(allMetrics);

			return { summary, services, communication, nodes, trends };
		},

		/**
		 * Calculer le résumé du cluster
		 */
		calculateClusterSummary(allMetrics) {
			const totalCalls = allMetrics.reduce((acc, m) => acc + (m.summary?.totalCalls || 0), 0);
			const totalCallsPerSecond = allMetrics.reduce((acc, m) => acc + (m.summary?.callsPerSecond || 0), 0);
			const durations = allMetrics.map(m => m.summary?.averageDuration || 0).filter(d => d > 0);
			const averageDuration = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;

			return {
				totalServices: new Set(allMetrics.map(m => m.serviceName)).size,
				totalNodes: new Set(allMetrics.map(m => m.nodeId)).size,
				totalCalls,
				totalCallsPerSecond: Math.round(totalCallsPerSecond * 100) / 100,
				averageDuration: Math.round(averageDuration * 100) / 100,
				totalDataSize: allMetrics.reduce((acc, m) => acc + (m.summary?.totalDataSize || 0), 0)
			};
		},

		/**
		 * Grouper les métriques par service
		 */
		groupMetricsByService(allMetrics) {
			const grouped = {};

			allMetrics.forEach(metric => {
				const serviceName = metric.serviceName;
				if (!grouped[serviceName]) {
					grouped[serviceName] = {
						instances: 0,
						nodes: new Set(),
						summary: {
							totalCalls: 0,
							callsPerSecond: 0,
							averageDuration: 0,
							totalDataSize: 0
						},
						outgoing: {},
						incoming: {},
						actions: {}
					};
				}

				const service = grouped[serviceName];
				service.instances++;
				service.nodes.add(metric.nodeId);
				
				// Agréger le résumé
				service.summary.totalCalls += metric.summary?.totalCalls || 0;
				service.summary.callsPerSecond += metric.summary?.callsPerSecond || 0;
				service.summary.totalDataSize += metric.summary?.totalDataSize || 0;

				// Agréger les communications sortantes
				if (metric.outgoing) {
					Object.entries(metric.outgoing).forEach(([target, outMetrics]) => {
						if (!service.outgoing[target]) {
							service.outgoing[target] = {
								calls: 0,
								totalDuration: 0,
								callsPerSecond: 0,
								actions: {}
							};
						}
						service.outgoing[target].calls += outMetrics.calls || 0;
						service.outgoing[target].totalDuration += outMetrics.totalDuration || 0;
						service.outgoing[target].callsPerSecond += outMetrics.callsPerSecond || 0;
						
						// Agréger les actions
						Object.entries(outMetrics.actions || {}).forEach(([action, count]) => {
							service.outgoing[target].actions[action] = (service.outgoing[target].actions[action] || 0) + count;
						});
					});
				}

				// Agréger les communications entrantes
				if (metric.incoming) {
					Object.entries(metric.incoming).forEach(([source, inMetrics]) => {
						if (!service.incoming[source]) {
							service.incoming[source] = {
								calls: 0,
								totalDuration: 0,
								callsPerSecond: 0,
								actions: {}
							};
						}
						service.incoming[source].calls += inMetrics.calls || 0;
						service.incoming[source].totalDuration += inMetrics.totalDuration || 0;
						service.incoming[source].callsPerSecond += inMetrics.callsPerSecond || 0;
						
						// Agréger les actions
						Object.entries(inMetrics.actions || {}).forEach(([action, count]) => {
							service.incoming[source].actions[action] = (service.incoming[source].actions[action] || 0) + count;
						});
					});
				}

				// Agréger les actions
				if (metric.actions) {
					Object.entries(metric.actions).forEach(([action, actionMetrics]) => {
						if (!service.actions[action]) {
							service.actions[action] = {
								calls: 0,
								totalDuration: 0,
								callsPerSecond: 0
							};
						}
						service.actions[action].calls += actionMetrics.calls || 0;
						service.actions[action].totalDuration += actionMetrics.totalDuration || 0;
						service.actions[action].callsPerSecond += actionMetrics.callsPerSecond || 0;
					});
				}
			});

			// Calculer les moyennes et convertir les Sets
			Object.values(grouped).forEach(service => {
				service.nodes = Array.from(service.nodes);
				
				// Calculer la durée moyenne
				if (service.summary.totalCalls > 0) {
					const totalDuration = Object.values(service.outgoing).reduce((acc, out) => acc + out.totalDuration, 0) +
									   Object.values(service.incoming).reduce((acc, inc) => acc + inc.totalDuration, 0);
					service.summary.averageDuration = totalDuration / service.summary.totalCalls;
				}

				// Calculer les moyennes pour les communications
				Object.values(service.outgoing).forEach(out => {
					out.averageDuration = out.calls > 0 ? out.totalDuration / out.calls : 0;
				});

				Object.values(service.incoming).forEach(inc => {
					inc.averageDuration = inc.calls > 0 ? inc.totalDuration / inc.calls : 0;
				});

				// Calculer les moyennes pour les actions
				Object.values(service.actions).forEach(action => {
					action.averageDuration = action.calls > 0 ? action.totalDuration / action.calls : 0;
				});
			});

			return grouped;
		},

		/**
		 * Extraire la matrice de communication
		 */
		extractCommunicationMatrix(allMetrics) {
			const matrix = {};

			allMetrics.forEach(metric => {
				const sourceName = metric.serviceName;
				
				if (metric.outgoing) {
					Object.entries(metric.outgoing).forEach(([target, outMetrics]) => {
						const commKey = `${sourceName}->${target}`;
						if (!matrix[commKey]) {
							matrix[commKey] = {
								source: sourceName,
								target,
								calls: 0,
								callsPerSecond: 0,
								totalDuration: 0,
								averageDuration: 0,
								actions: {},
								nodes: new Set()
							};
						}
						
						matrix[commKey].calls += outMetrics.calls || 0;
						matrix[commKey].callsPerSecond += outMetrics.callsPerSecond || 0;
						matrix[commKey].totalDuration += outMetrics.totalDuration || 0;
						matrix[commKey].nodes.add(metric.nodeId);
						
						// Agréger les actions
						Object.entries(outMetrics.actions || {}).forEach(([action, count]) => {
							matrix[commKey].actions[action] = (matrix[commKey].actions[action] || 0) + count;
						});
					});
				}
			});

			// Calculer les moyennes et convertir les Sets
			Object.values(matrix).forEach(comm => {
				comm.averageDuration = comm.calls > 0 ? comm.totalDuration / comm.calls : 0;
				comm.nodes = Array.from(comm.nodes);
				comm.nodeCount = comm.nodes.length;
			});

			return matrix;
		},

		/**
		 * Grouper les métriques par nœud
		 */
		groupMetricsByNode(allMetrics) {
			const grouped = {};

			allMetrics.forEach(metric => {
				const nodeId = metric.nodeId;
				if (!grouped[nodeId]) {
					grouped[nodeId] = {
						services: [],
						totalCalls: 0,
						totalCallsPerSecond: 0,
						averageDuration: 0,
						totalDataSize: 0
					};
				}

				const node = grouped[nodeId];
				node.services.push(metric.serviceName);
				node.totalCalls += metric.summary?.totalCalls || 0;
				node.totalCallsPerSecond += metric.summary?.callsPerSecond || 0;
				node.totalDataSize += metric.summary?.totalDataSize || 0;
			});

			// Calculer les moyennes
			Object.values(grouped).forEach(node => {
				node.servicesCount = node.services.length;
				node.averageDuration = node.totalCalls > 0 ? 
					allMetrics
						.filter(m => node.services.includes(m.serviceName))
						.reduce((acc, m) => acc + (m.summary?.averageDuration || 0), 0) / node.services.length 
					: 0;
			});

			return grouped;
		},

		/**
		 * Calculer les tendances du cluster
		 */
		calculateClusterTrends(allMetrics) {
			const trends = {};
			const intervals = ['5s', '15s', '30s'];

			intervals.forEach(interval => {
				trends[interval] = {
					totalCalls: 0,
					callsPerSecond: 0,
					averageDuration: 0
				};

				allMetrics.forEach(metric => {
					const intervalData = metric.trends?.[interval];
					if (intervalData) {
						trends[interval].totalCalls += intervalData.calls || 0;
						trends[interval].callsPerSecond += intervalData.callsPerSecond || 0;
					}
				});

				// Calculer la durée moyenne pondérée
				const durations = allMetrics
					.map(m => m.trends?.[interval]?.averageDuration || 0)
					.filter(d => d > 0);
				
				trends[interval].averageDuration = durations.length > 0 
					? durations.reduce((a, b) => a + b, 0) / durations.length 
					: 0;
			});

			return trends;
		},

		/**
		 * Obtenir les services avec un nom donné
		 */
		async getServicesWithName(serviceName) {
			const services = this.broker.registry.getServiceList({ onlyAvailable: true });
			return services.filter(s => s.name === serviceName);
		},

		/**
		 * Agréger les métriques d'un service spécifique
		 */
		aggregateServiceMetrics(metrics) {
			if (metrics.length === 0) return this.getEmptyServiceMetrics();

			const aggregated = {
				instances: metrics.length,
				nodes: [...new Set(metrics.map(m => m.nodeId))],
				summary: {
					totalCalls: metrics.reduce((acc, m) => acc + (m.summary?.totalCalls || 0), 0),
					callsPerSecond: metrics.reduce((acc, m) => acc + (m.summary?.callsPerSecond || 0), 0),
					totalDataSize: metrics.reduce((acc, m) => acc + (m.summary?.totalDataSize || 0), 0),
					averageDuration: 0
				}
			};

			// Calculer la durée moyenne pondérée
			const durations = metrics.map(m => m.summary?.averageDuration || 0).filter(d => d > 0);
			aggregated.summary.averageDuration = durations.length > 0 
				? durations.reduce((a, b) => a + b, 0) / durations.length 
				: 0;

			return aggregated;
		},

		/**
		 * Résumer les métriques de communication
		 */
		summarizeCommunication(communication) {
			if (communication.length === 0) {
				return {
					totalCalls: 0,
					totalCallsPerSecond: 0,
					averageDuration: 0,
					nodes: 0
				};
			}

			return {
				totalCalls: communication.reduce((acc, c) => acc + (c.calls || 0), 0),
				totalCallsPerSecond: communication.reduce((acc, c) => acc + (c.callsPerSecond || 0), 0),
				averageDuration: communication.reduce((acc, c) => acc + (c.averageDuration || 0), 0) / communication.length,
				nodes: [...new Set(communication.map(c => c.nodeId))].length
			};
		},

		/**
		 * Métriques vides
		 */
		getEmptyMetrics() {
			return {
				totalServices: 0,
				totalNodes: 0,
				totalCalls: 0,
				totalCallsPerSecond: 0,
				averageDuration: 0,
				totalDataSize: 0
			};
		},

		/**
		 * Métriques de service vides
		 */
		getEmptyServiceMetrics() {
			return {
				instances: 0,
				nodes: [],
				summary: this.getEmptyMetrics()
			};
		}
	},

	async started() {
		this.logger.info("Metrics aggregator service started", {
			nodeId: this.broker.nodeID,
			collectionInterval: this.settings.collectionInterval
		});

		// Collecter les métriques périodiquement pour maintenir le cache chaud
		this.collectionTimer = setInterval(async () => {
			try {
				await this.broker.call("metrics-aggregator.getClusterMetrics");
			} catch (err) {
				this.logger.debug("Periodic metrics collection failed:", err.message);
			}
		}, this.settings.collectionInterval);
	},

	async stopped() {
		if (this.collectionTimer) {
			clearInterval(this.collectionTimer);
		}
		
		this.logger.info("Metrics aggregator service stopped");
	}
};