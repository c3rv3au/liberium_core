// services/event-monitor.service.js
"use strict";

const BaseService = require("./base.service");

module.exports = {
	name: "event-monitor",

	mixins: [BaseService],

	settings: {
		timeWindow: 60000,
		cleanupInterval: 30000,
		maxEvents: 10000,
		timeBuckets: [1, 5, 15, 30, 60],
		// Agrégation distribuée
		aggregationInterval: 5000, // Synchroniser toutes les 5 secondes
		isAggregator: false // Sera défini dynamiquement
	},

	actions: {
		/**
		 * Obtenir les métriques d'événements locales (ce nœud uniquement)
		 */
		getLocalEventMetrics: {
			cache: {
				keys: [],
				ttl: 2
			},
			async handler(ctx) {
				return this.calculateLocalMetrics(Date.now());
			}
		},

		/**
		 * Obtenir les métriques d'événements agrégées (tout le cluster)
		 */
		getEventMetrics: {
			cache: {
				keys: [],
				ttl: 2
			},
			async handler(ctx) {
				const now = Date.now();

				// Si ce nœud est l'agrégateur, collecter de tous les nœuds
				if (this.isAggregator) {
					return await this.getAggregatedMetrics(now);
				}

				// Sinon, déléguer vers l'agrégateur
				try {
					const aggregatorNodeId = await this.findAggregatorNode();
					if (aggregatorNodeId && aggregatorNodeId !== this.broker.nodeID) {
						return await this.broker.call("event-monitor.getEventMetrics", {}, {
							nodeID: aggregatorNodeId
						});
					}
				} catch (err) {
					this.logger.warn("Failed to delegate to aggregator, using local metrics:", err.message);
				}

				// Fallback : retourner les métriques locales
				return this.calculateLocalMetrics(now);
			}
		},

		/**
		 * Recevoir les métriques d'un autre nœud pour agrégation
		 */
		receiveNodeMetrics: {
			params: {
				nodeId: "string",
				metrics: "object"
			},
			async handler(ctx) {
				if (!this.isAggregator) return;

				const { nodeId, metrics } = ctx.params;
				this.nodeMetrics.set(nodeId, {
					...metrics,
					timestamp: Date.now()
				});

				this.logger.debug(`Received metrics from node ${nodeId}`);
			}
		},

		/**
		 * Forcer ce nœud à devenir l'agrégateur
		 */
		becomeAggregator: {
			async handler(ctx) {
				this.isAggregator = true;
				this.nodeMetrics.clear();
				
				this.logger.info("Became event metrics aggregator");
				
				// Démarrer la collecte périodique
				this.startAggregation();

				return { success: true, nodeId: this.broker.nodeID };
			}
		},

		/**
		 * Arrêter d'être l'agrégateur
		 */
		stopAggregator: {
			async handler(ctx) {
				this.isAggregator = false;
				this.stopAggregation();
				this.nodeMetrics.clear();
				
				this.logger.info("Stopped being event metrics aggregator");
				
				return { success: true, nodeId: this.broker.nodeID };
			}
		},

		/**
		 * Obtenir le statut de l'agrégation
		 */
		getAggregationStatus: {
			async handler(ctx) {
				return {
					nodeId: this.broker.nodeID,
					isAggregator: this.isAggregator,
					aggregatorNode: await this.findAggregatorNode(),
					nodesTracked: this.nodeMetrics.size,
					lastAggregation: this.lastAggregationTime
				};
			}
		}
	},

	events: {
		/**
		 * Intercepter tous les événements du broker
		 */
		"**"(payload, sender, eventName) {
			// Ignorer les événements internes de monitoring
			if (eventName.startsWith('event-monitor.') || 
				eventName.startsWith('$node.') ||
				eventName.startsWith('metrics.')) {
				return;
			}

			this.recordEvent(eventName, sender, payload);
		},

		/**
		 * Quand un nœud se connecte
		 */
		"$node.connected"(payload) {
			// Si on est l'agrégateur, attendre que le nouveau nœud soit prêt
			if (this.isAggregator) {
				setTimeout(() => {
					this.requestMetricsFromNode(payload.node.id);
				}, 2000);
			}
		},

		/**
		 * Quand un nœud se déconnecte
		 */
		"$node.disconnected"(payload) {
			// Nettoyer les métriques du nœud déconnecté
			this.nodeMetrics.delete(payload.node.id);

			// Si l'agrégateur se déconnecte, élire un nouveau
			if (payload.node.id === this.aggregatorNodeId) {
				this.electNewAggregator();
			}
		}
	},

	methods: {
		/**
		 * Enregistrer un événement localement
		 */
		recordEvent(eventName, sender, payload) {
			const now = Date.now();
			const event = {
				timestamp: now,
				eventName,
				source: sender || "unknown",
				target: this.extractTargetFromEvent(eventName, payload),
				payloadSize: this.calculatePayloadSize(payload),
				nodeId: this.broker.nodeID
			};

			this.eventHistory.push(event);
			
			if (this.eventHistory.length > this.settings.maxEvents) {
				this.eventHistory = this.eventHistory.slice(-this.settings.maxEvents);
			}

			this.updateEventCounts(event);
			this.updateServiceMetrics(event);
		},

		/**
		 * Calculer les métriques locales
		 */
		calculateLocalMetrics(now) {
			const recentEvents = this.getRecentEventsByTime(now, this.settings.timeWindow);
			
			return {
				nodeId: this.broker.nodeID,
				timestamp: now,
				isLocal: true,
				summary: this.calculateSummaryMetrics(now),
				services: this.calculateServiceMetrics(now),
				communication: this.calculateCommunicationMetrics(now),
				trends: this.calculateTrendMetrics(now),
				eventCount: recentEvents.length
			};
		},

		/**
		 * Obtenir les métriques agrégées de tout le cluster
		 */
		async getAggregatedMetrics(now) {
			// Collecter les métriques de tous les nœuds
			await this.collectMetricsFromAllNodes();

			// Agréger les métriques
			const aggregated = this.aggregateNodeMetrics(now);
			
			return {
				...aggregated,
				timestamp: now,
				isAggregated: true,
				aggregatorNode: this.broker.nodeID,
				nodesIncluded: this.nodeMetrics.size + 1, // +1 pour ce nœud
				nodeBreakdown: this.getNodeBreakdown()
			};
		},

		/**
		 * Collecter les métriques de tous les nœuds
		 */
		async collectMetricsFromAllNodes() {
			const nodes = await this.getEventMonitorNodes();
			const promises = [];

			for (const node of nodes) {
				if (node.id !== this.broker.nodeID) {
					const promise = this.requestMetricsFromNode(node.id)
						.catch(err => {
							this.logger.warn(`Failed to collect metrics from ${node.id}:`, err.message);
						});
					promises.push(promise);
				}
			}

			await Promise.allSettled(promises);
		},

		/**
		 * Demander les métriques d'un nœud spécifique
		 */
		async requestMetricsFromNode(nodeId) {
			try {
				const metrics = await this.broker.call("event-monitor.getLocalEventMetrics", {}, {
					nodeID: nodeId,
					timeout: 3000
				});

				this.nodeMetrics.set(nodeId, {
					...metrics,
					receivedAt: Date.now()
				});

			} catch (err) {
				this.logger.debug(`Could not get metrics from ${nodeId}:`, err.message);
			}
		},

		/**
		 * Agréger les métriques de tous les nœuds
		 */
		aggregateNodeMetrics(now) {
			const localMetrics = this.calculateLocalMetrics(now);
			const allMetrics = [localMetrics];

			// Ajouter les métriques des autres nœuds
			for (const [nodeId, metrics] of this.nodeMetrics.entries()) {
				// Ignorer les métriques trop anciennes
				if (now - metrics.receivedAt < 30000) { // 30 secondes max
					allMetrics.push(metrics);
				}
			}

			return {
				summary: this.aggregateSummaryMetrics(allMetrics),
				services: this.aggregateServiceMetrics(allMetrics),
				communication: this.aggregateCommunicationMetrics(allMetrics),
				trends: this.aggregateTrendMetrics(allMetrics)
			};
		},

		/**
		 * Agréger les métriques de résumé
		 */
		aggregateSummaryMetrics(allMetrics) {
			return {
				totalEventsLastMinute: allMetrics.reduce((acc, m) => acc + (m.summary?.totalEventsLastMinute || 0), 0),
				eventsPerSecond: allMetrics.reduce((acc, m) => acc + (m.summary?.eventsPerSecond || 0), 0),
				activeServices: new Set(allMetrics.flatMap(m => Object.keys(m.services || {}))).size,
				averagePayloadSize: this.calculateWeightedAverage(
					allMetrics.map(m => ({ value: m.summary?.averagePayloadSize || 0, weight: m.eventCount || 1 }))
				)
			};
		},

		/**
		 * Agréger les métriques par service
		 */
		aggregateServiceMetrics(allMetrics) {
			const aggregated = {};

			allMetrics.forEach(metrics => {
				if (!metrics.services) return;

				Object.entries(metrics.services).forEach(([serviceName, serviceMetrics]) => {
					if (!aggregated[serviceName]) {
						aggregated[serviceName] = {
							eventsSent: { total: 0, perSecond: 0, byTarget: {} },
							eventsReceived: { total: 0, perSecond: 0, bySource: {} },
							totalActivity: 0,
							bandwidth: { sent: { totalBytes: 0, bytesPerSecond: 0 }, received: { totalBytes: 0, bytesPerSecond: 0 } },
							nodes: new Set()
						};
					}

					const agg = aggregated[serviceName];
					agg.nodes.add(metrics.nodeId);
					
					// Agréger les événements envoyés
					agg.eventsSent.total += serviceMetrics.eventsSent?.total || 0;
					agg.eventsSent.perSecond += serviceMetrics.eventsSent?.perSecond || 0;
					
					// Agréger les événements reçus
					agg.eventsReceived.total += serviceMetrics.eventsReceived?.total || 0;
					agg.eventsReceived.perSecond += serviceMetrics.eventsReceived?.perSecond || 0;
					
					// Agréger l'activité totale
					agg.totalActivity += serviceMetrics.totalActivity || 0;
					
					// Agréger la bande passante
					if (serviceMetrics.bandwidth) {
						agg.bandwidth.sent.totalBytes += serviceMetrics.bandwidth.sent?.totalBytes || 0;
						agg.bandwidth.sent.bytesPerSecond += serviceMetrics.bandwidth.sent?.bytesPerSecond || 0;
						agg.bandwidth.received.totalBytes += serviceMetrics.bandwidth.received?.totalBytes || 0;
						agg.bandwidth.received.bytesPerSecond += serviceMetrics.bandwidth.received?.bytesPerSecond || 0;
					}
				});
			});

			// Convertir les Sets en arrays
			Object.values(aggregated).forEach(service => {
				service.nodes = Array.from(service.nodes);
				service.nodeCount = service.nodes.length;
			});

			return aggregated;
		},

		/**
		 * Agréger les métriques de communication
		 */
		aggregateCommunicationMetrics(allMetrics) {
			const aggregated = {};

			allMetrics.forEach(metrics => {
				if (!metrics.communication) return;

				Object.entries(metrics.communication).forEach(([commKey, commMetrics]) => {
					if (!aggregated[commKey]) {
						aggregated[commKey] = {
							source: commMetrics.source,
							target: commMetrics.target,
							totalEvents: 0,
							eventsPerSecond: 0,
							eventTypes: {},
							nodes: new Set()
						};
					}

					const agg = aggregated[commKey];
					agg.nodes.add(metrics.nodeId);
					agg.totalEvents += commMetrics.totalEvents || 0;
					agg.eventsPerSecond += commMetrics.eventsPerSecond || 0;

					// Agréger les types d'événements
					Object.entries(commMetrics.eventTypes || {}).forEach(([eventType, count]) => {
						agg.eventTypes[eventType] = (agg.eventTypes[eventType] || 0) + count;
					});
				});
			});

			// Convertir les Sets en arrays
			Object.values(aggregated).forEach(comm => {
				comm.nodes = Array.from(comm.nodes);
				comm.nodeCount = comm.nodes.length;
			});

			return aggregated;
		},

		/**
		 * Agréger les métriques de tendance
		 */
		aggregateTrendMetrics(allMetrics) {
			const trends = {};
			
			for (const bucket of this.settings.timeBuckets) {
				const bucketKey = `${bucket}s`;
				trends[bucketKey] = {
					totalEvents: 0,
					eventsPerSecond: 0,
					uniqueServices: new Set(),
					communicationPairs: new Set()
				};

				allMetrics.forEach(metrics => {
					const bucketData = metrics.trends?.[bucketKey];
					if (bucketData) {
						trends[bucketKey].totalEvents += bucketData.totalEvents || 0;
						trends[bucketKey].eventsPerSecond += bucketData.eventsPerSecond || 0;
						// Note: uniqueServices et communicationPairs ne peuvent pas être agrégés directement
					}
				});

				// Convertir les Sets
				trends[bucketKey].uniqueServices = trends[bucketKey].uniqueServices.size;
				trends[bucketKey].communicationPairs = trends[bucketKey].communicationPairs.size;
			}

			return trends;
		},

		/**
		 * Obtenir la répartition par nœud
		 */
		getNodeBreakdown() {
			const breakdown = {};
			
			// Ajouter ce nœud
			const localMetrics = this.calculateLocalMetrics(Date.now());
			breakdown[this.broker.nodeID] = {
				eventsPerSecond: localMetrics.summary?.eventsPerSecond || 0,
				activeServices: Object.keys(localMetrics.services || {}).length,
				lastUpdate: Date.now()
			};

			// Ajouter les autres nœuds
			for (const [nodeId, metrics] of this.nodeMetrics.entries()) {
				breakdown[nodeId] = {
					eventsPerSecond: metrics.summary?.eventsPerSecond || 0,
					activeServices: Object.keys(metrics.services || {}).length,
					lastUpdate: metrics.receivedAt
				};
			}

			return breakdown;
		},

		/**
		 * Trouver le nœud agrégateur
		 */
		async findAggregatorNode() {
			try {
				const nodes = await this.getEventMonitorNodes();
				
				// Le nœud avec l'ID le plus petit devient l'agrégateur
				const sortedNodes = nodes.sort((a, b) => a.id.localeCompare(b.id));
				return sortedNodes.length > 0 ? sortedNodes[0].id : this.broker.nodeID;
			} catch (err) {
				this.logger.warn("Failed to find aggregator node:", err);
				return this.broker.nodeID;
			}
		},

		/**
		 * Obtenir tous les nœuds avec event-monitor
		 */
		async getEventMonitorNodes() {
			const nodes = await this.broker.registry.getNodeList({ onlyAvailable: true });
			return nodes.filter(node => 
				node.services && 
				Array.isArray(node.services) &&
				node.services.find(s => s && (s.name === "event-monitor" || s === "event-monitor"))
			);
		},

		/**
		 * Élire un nouveau agrégateur
		 */
		async electNewAggregator() {
			const newAggregator = await this.findAggregatorNode();
			
			if (newAggregator === this.broker.nodeID && !this.isAggregator) {
				this.logger.info("Elected as new event metrics aggregator");
				await this.broker.call("event-monitor.becomeAggregator");
			}
		},

		/**
		 * Démarrer l'agrégation périodique
		 */
		startAggregation() {
			this.stopAggregation();
			
			this.aggregationTimer = setInterval(async () => {
				try {
					await this.collectMetricsFromAllNodes();
					this.lastAggregationTime = Date.now();
				} catch (err) {
					this.logger.error("Aggregation failed:", err);
				}
			}, this.settings.aggregationInterval);
		},

		/**
		 * Arrêter l'agrégation
		 */
		stopAggregation() {
			if (this.aggregationTimer) {
				clearInterval(this.aggregationTimer);
				this.aggregationTimer = null;
			}
		},

		/**
		 * Calculer une moyenne pondérée
		 */
		calculateWeightedAverage(values) {
			const totalWeight = values.reduce((acc, v) => acc + v.weight, 0);
			if (totalWeight === 0) return 0;
			
			const weightedSum = values.reduce((acc, v) => acc + (v.value * v.weight), 0);
			return Math.round(weightedSum / totalWeight);
		},

		// ... Méthodes existantes (recordEvent, calculateSummaryMetrics, etc.)
		// [Conserver toutes les méthodes du service original]

		extractTargetFromEvent(eventName, payload) {
			if (eventName.includes('.')) {
				return eventName.split('.')[0];
			}
			if (payload && typeof payload === 'object') {
				if (payload.service) return payload.service;
				if (payload.targetService) return payload.targetService;
				if (payload.nodeId) return payload.nodeId;
			}
			return "broadcast";
		},

		calculatePayloadSize(payload) {
			try {
				return JSON.stringify(payload).length;
			} catch (err) {
				return 0;
			}
		},

		updateEventCounts(event) {
			const key = `${event.source}->${event.target}:${event.eventName}`;
			if (!this.eventCounts.has(key)) {
				this.eventCounts.set(key, []);
			}
			this.eventCounts.get(key).push(event.timestamp);
		},

		updateServiceMetrics(event) {
			this.updateServiceMetric(event.source, 'sent', event);
			if (event.target !== "broadcast" && event.target !== event.source) {
				this.updateServiceMetric(event.target, 'received', event);
			}
		},

		updateServiceMetric(serviceName, direction, event) {
			if (!this.serviceMetrics.has(serviceName)) {
				this.serviceMetrics.set(serviceName, { sent: [], received: [] });
			}
			this.serviceMetrics.get(serviceName)[direction].push({
				timestamp: event.timestamp,
				eventName: event.eventName,
				target: direction === 'sent' ? event.target : event.source,
				payloadSize: event.payloadSize
			});
		},

		calculateSummaryMetrics(now) {
			const recentEvents = this.getRecentEventsByTime(now, 60000);
			return {
				totalEventsLastMinute: recentEvents.length,
				eventsPerSecond: recentEvents.length / 60,
				activeServices: new Set([...recentEvents.map(e => e.source), ...recentEvents.map(e => e.target)]).size,
				averagePayloadSize: this.calculateAveragePayloadSize(recentEvents)
			};
		},

		calculateServiceMetrics(now) {
			const serviceMetrics = {};
			for (const [serviceName, metrics] of this.serviceMetrics.entries()) {
				const recentSent = this.filterEventsByTime(metrics.sent, now, 60000);
				const recentReceived = this.filterEventsByTime(metrics.received, now, 60000);
				serviceMetrics[serviceName] = {
					eventsSent: {
						total: recentSent.length,
						perSecond: recentSent.length / 60,
						byTarget: this.groupEventsByTarget(recentSent)
					},
					eventsReceived: {
						total: recentReceived.length,
						perSecond: recentReceived.length / 60,
						bySource: this.groupEventsBySource(recentReceived)
					},
					totalActivity: (recentSent.length + recentReceived.length) / 60,
					bandwidth: {
						sent: this.calculateBandwidth(recentSent),
						received: this.calculateBandwidth(recentReceived)
					}
				};
			}
			return serviceMetrics;
		},

		calculateCommunicationMetrics(now) {
			const communications = {};
			for (const [key, timestamps] of this.eventCounts.entries()) {
				const recentTimestamps = timestamps.filter(ts => now - ts <= 60000);
				if (recentTimestamps.length > 0) {
					const [source, targetEvent] = key.split('->');
					const [target, eventName] = targetEvent.split(':');
					const commKey = `${source}->${target}`;
					if (!communications[commKey]) {
						communications[commKey] = {
							source, target, totalEvents: 0, eventsPerSecond: 0, eventTypes: {}
						};
					}
					communications[commKey].totalEvents += recentTimestamps.length;
					communications[commKey].eventsPerSecond += recentTimestamps.length / 60;
					communications[commKey].eventTypes[eventName] = (communications[commKey].eventTypes[eventName] || 0) + recentTimestamps.length;
				}
			}
			return communications;
		},

		calculateTrendMetrics(now) {
			const trends = {};
			for (const bucket of this.settings.timeBuckets) {
				const windowMs = bucket * 1000;
				const events = this.getRecentEventsByTime(now, windowMs);
				trends[`${bucket}s`] = {
					totalEvents: events.length,
					eventsPerSecond: events.length / bucket,
					uniqueServices: new Set([...events.map(e => e.source), ...events.map(e => e.target)]).size,
					communicationPairs: new Set(events.map(e => `${e.source}->${e.target}`)).size
				};
			}
			return trends;
		},

		getRecentEventsByTime(now, windowMs) {
			return this.eventHistory.filter(event => now - event.timestamp <= windowMs);
		},

		filterEventsByTime(events, now, windowMs) {
			return events.filter(event => now - event.timestamp <= windowMs);
		},

		groupEventsByTarget(events) {
			const grouped = {};
			events.forEach(event => {
				grouped[event.target] = (grouped[event.target] || 0) + 1;
			});
			return grouped;
		},

		groupEventsBySource(events) {
			const grouped = {};
			events.forEach(event => {
				const source = event.target;
				grouped[source] = (grouped[source] || 0) + 1;
			});
			return grouped;
		},

		calculateBandwidth(events) {
			const totalSize = events.reduce((acc, event) => acc + (event.payloadSize || 0), 0);
			return {
				totalBytes: totalSize,
				bytesPerSecond: totalSize / 60,
				averageEventSize: events.length > 0 ? totalSize / events.length : 0
			};
		},

		calculateAveragePayloadSize(events) {
			if (events.length === 0) return 0;
			const totalSize = events.reduce((acc, event) => acc + (event.payloadSize || 0), 0);
			return Math.round(totalSize / events.length);
		},

		cleanupOldMetrics() {
			const now = Date.now();
			const cutoff = now - this.settings.timeWindow * 2;

			this.eventHistory = this.eventHistory.filter(event => event.timestamp > cutoff);

			for (const [key, timestamps] of this.eventCounts.entries()) {
				const filteredTimestamps = timestamps.filter(ts => ts > cutoff);
				if (filteredTimestamps.length === 0) {
					this.eventCounts.delete(key);
				} else {
					this.eventCounts.set(key, filteredTimestamps);
				}
			}

			for (const [serviceName, metrics] of this.serviceMetrics.entries()) {
				metrics.sent = metrics.sent.filter(event => event.timestamp > cutoff);
				metrics.received = metrics.received.filter(event => event.timestamp > cutoff);
				if (metrics.sent.length === 0 && metrics.received.length === 0) {
					this.serviceMetrics.delete(serviceName);
				}
			}

			// Nettoyer les métriques des nœuds distants
			for (const [nodeId, metrics] of this.nodeMetrics.entries()) {
				if (now - metrics.receivedAt > 60000) { // 1 minute
					this.nodeMetrics.delete(nodeId);
				}
			}
		}
	},

	created() {
		this.eventHistory = [];
		this.eventCounts = new Map();
		this.serviceMetrics = new Map();
		this.nodeMetrics = new Map(); // Métriques des autres nœuds
		this.isAggregator = false;
		this.lastAggregationTime = null;
		this.aggregatorNodeId = null;
	},

	async started() {
		this.logger.info("Event monitor service started", {
			nodeId: this.broker.nodeID,
			timeWindow: this.settings.timeWindow,
			maxEvents: this.settings.maxEvents
		});

		// Déterminer si ce nœud doit être l'agrégateur
		setTimeout(async () => {
			const aggregatorNode = await this.findAggregatorNode();
			if (aggregatorNode === this.broker.nodeID) {
				await this.broker.call("event-monitor.becomeAggregator");
			}
		}, 3000);

		this.cleanupTimer = setInterval(() => {
			this.cleanupOldMetrics();
		}, this.settings.cleanupInterval);
	},

	async stopped() {
		this.stopAggregation();
		
		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
		}
		
		this.logger.info("Event monitor service stopped");
	}
};