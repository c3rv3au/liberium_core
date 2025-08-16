// services/network-analyzer.service.js
"use strict";

const BaseService = require("./base.service");

module.exports = {
	name: "network-analyzer",

	mixins: [BaseService],

	settings: {
		updateInterval: 30000,
		cacheTTL: 15000
	},

	dependencies: ["etcd"],

	actions: {
		/**
		 * Obtenir les métriques réseau en temps réel avec événements
		 */
		getRealTimeMetrics: {
			async handler(ctx) {
				const networkAnalysis = await this.analyzeNetwork();
				
				// Obtenir les métriques de communication si disponibles
				let communicationMetrics = null;
				try {
					communicationMetrics = await this.callWithMetrics("metrics-aggregator.getClusterMetrics");
				} catch (err) {
					this.logger.debug("Metrics aggregator not available:", err.message);
				}

				return {
					timestamp: Date.now(),
					cluster: {
						totalNodes: networkAnalysis.nodes.length,
						totalServices: networkAnalysis.services.length,
						healthyNodes: networkAnalysis.nodes.filter(n => n.status === 'healthy').length,
						activeServices: networkAnalysis.services.filter(s => s.status === 'active').length
					},
					topology: {
						nodes: networkAnalysis.nodes,
						services: networkAnalysis.services
					},
					dependencies: networkAnalysis.dependencies,
					statistics: networkAnalysis.statistics,
					realTimeMetrics: communicationMetrics ? {
						summary: communicationMetrics.clusterSummary,
						serviceActivity: this.enrichServicesWithMetrics(
							networkAnalysis.services, 
							communicationMetrics.services
						),
						communication: communicationMetrics.communication,
						trends: communicationMetrics.trends,
						nodeActivity: communicationMetrics.nodes
					} : null
				};
			}
		},

		/**
		 * Analyser l'ampleur du réseau
		 */
		getNetworkScope: {
			cache: {
				keys: [],
				ttl: 15
			},
			async handler(ctx) {
				const analysis = await this.analyzeNetwork();
				return {
					timestamp: Date.now(),
					cluster: {
						totalNodes: analysis.nodes.length,
						totalServices: analysis.services.length,
						healthyNodes: analysis.nodes.filter(n => n.status === 'healthy').length,
						activeServices: analysis.services.filter(s => s.status === 'active').length
					},
					topology: {
						nodes: analysis.nodes,
						services: analysis.services
					},
					dependencies: analysis.dependencies,
					statistics: analysis.statistics
				};
			}
		},

		/**
		 * Obtenir seulement les statistiques rapides
		 */
		getQuickStats: {
			async handler(ctx) {
				const nodes = await this.broker.registry.getNodeList({ onlyAvailable: false });
				const services = this.broker.registry.getServiceList({ onlyAvailable: false });
				
				return {
					timestamp: Date.now(),
					totalNodes: nodes.length,
					availableNodes: nodes.filter(n => n.available).length,
					totalServices: services.length,
					activeServices: services.filter(s => s.available).length,
					nodeId: this.broker.nodeID,
					namespace: this.broker.namespace
				};
			}
		},

		/**
		 * Analyser les dépendances d'un service spécifique
		 */
		analyzeServiceDependencies: {
			params: {
				serviceName: "string"
			},
			async handler(ctx) {
				const { serviceName } = ctx.params;
				return await this.getServiceDependencies(serviceName);
			}
		},

		/**
		 * Obtenir les métriques de communication entre services via metrics-aggregator
		 */
		getServiceCommunicationMetrics: {
			params: {
				sourceService: { type: "string", optional: true },
				targetService: { type: "string", optional: true }
			},
			async handler(ctx) {
				const { sourceService, targetService } = ctx.params;
				
				try {
					let result;
					
					if (sourceService && targetService) {
						// Communication spécifique entre deux services
						result = await this.callWithMetrics("metrics-aggregator.getCommunicationMetrics", {
							sourceService,
							targetService
						});
					} else {
						// Toutes les métriques du cluster
						const clusterMetrics = await this.callWithMetrics("metrics-aggregator.getClusterMetrics");
						
						result = {
							timestamp: Date.now(),
							sourceService: sourceService || "all",
							targetService: targetService || "all",
							communication: this.filterCommunication(clusterMetrics.communication, sourceService, targetService),
							summary: clusterMetrics.clusterSummary
						};
					}

					return result;
				} catch (err) {
					this.logger.warn("Failed to get communication metrics:", err);
					return {
						timestamp: Date.now(),
						error: "Metrics aggregator service not available",
						communication: {},
						summary: { 
							totalCalls: 0, 
							totalCallsPerSecond: 0, 
							averageDuration: 0,
							totalServices: 0,
							totalNodes: 0
						}
					};
				}
			}
		},

		/**
		 * Obtenir la matrice de dépendances
		 */
		getDependencyMatrix: {
			async handler(ctx) {
				return await this.buildDependencyMatrix();
			}
		},

		/**
		 * Obtenir les services les plus actifs
		 */
		getTopActiveServices: {
			params: {
				limit: { type: "number", default: 10, min: 1, max: 50 }
			},
			async handler(ctx) {
				const { limit } = ctx.params;
				
				try {
					return await this.callWithMetrics("metrics-aggregator.getTopServices", { limit });
				} catch (err) {
					this.logger.warn("Failed to get top services:", err);
					return {
						timestamp: Date.now(),
						topServices: [],
						error: "Metrics aggregator not available"
					};
				}
			}
		}
	},

	methods: {
		/**
		 * Enrichir les services avec les métriques de communication
		 */
		enrichServicesWithMetrics(services, metricsServices) {
			if (!metricsServices) return services;

			return services.map(service => ({
				...service,
				metrics: metricsServices[service.name] || {
					instances: 0,
					summary: {
						totalCalls: 0,
						callsPerSecond: 0,
						averageDuration: 0,
						totalDataSize: 0
					},
					outgoing: {},
					incoming: {},
					actions: {}
				}
			}));
		},

		/**
		 * Filtrer les communications selon les paramètres
		 */
		filterCommunication(communication, sourceFilter, targetFilter) {
			if (!communication) return {};
			
			const filtered = {};
			
			Object.entries(communication).forEach(([commKey, metrics]) => {
				const [source, target] = commKey.split('->');
				
				// Appliquer les filtres
				if (sourceFilter && source !== sourceFilter) return;
				if (targetFilter && target !== targetFilter) return;
				
				filtered[commKey] = metrics;
			});

			return filtered;
		},

		/**
		 * Analyser le réseau complet
		 */
		async analyzeNetwork() {
			const nodes = await this.analyzeNodes();
			const services = await this.analyzeServices();
			const dependencies = await this.analyzeDependencies();
			const statistics = this.calculateStatistics(nodes, services, dependencies);

			return {
				nodes,
				services,
				dependencies,
				statistics
			};
		},

		/**
		 * Analyser tous les nœuds
		 */
		async analyzeNodes() {
			const nodes = await this.broker.registry.getNodeList({ onlyAvailable: false });
			
			return nodes.map(node => ({
				type: 'node',
				id: node.id,
				hostname: node.hostname || 'unknown',
				status: node.available ? 'healthy' : 'offline',
				local: node.local,
				lastHeartbeat: node.lastHeartbeatTime,
				uptime: node.uptime,
				metadata: {
					podIP: node.metadata?.podIP,
					podName: node.metadata?.podName,
					namespace: node.metadata?.namespace,
					region: node.metadata?.region || 'default',
					datacenter: node.metadata?.datacenter || 'default'
				},
				services: node.services ? node.services.map(s => ({
					name: this.getServiceName(s),
					version: this.getServiceVersion(s),
					fullName: this.getServiceFullName(s)
				})) : [],
				statistics: {
					cpu: node.cpu,
					memory: node.memory,
					os: node.os
				},
				client: {
					type: node.client?.type,
					version: node.client?.version,
					langVersion: node.client?.langVersion
				}
			}));
		},

		/**
		 * Analyser tous les services
		 */
		async analyzeServices() {
			const services = this.broker.registry.getServiceList({ onlyAvailable: false });
			const serviceAnalysis = [];

			for (const service of services) {
				if (service.name === '$node') continue;

				const dependencies = await this.getServiceDependencies(service.name);
				
				const analysis = {
					type: 'service',
					name: service.name,
					version: service.version,
					fullName: service.fullName,
					status: service.available ? 'active' : 'inactive',
					nodeId: service.nodeID,
					dependencies: dependencies,
					actions: this.getServiceActions(service),
					events: this.getServiceEvents(service),
					settings: service.settings ? Object.keys(service.settings) : [],
					metadata: service.metadata || {}
				};

				serviceAnalysis.push(analysis);
			}

			return serviceAnalysis;
		},

		/**
		 * Extraire le nom d'un service depuis l'objet service
		 */
		getServiceName(serviceObj) {
			if (typeof serviceObj === 'string') return serviceObj;
			if (serviceObj && serviceObj.name) return serviceObj.name;
			if (serviceObj && serviceObj.fullName) {
				return serviceObj.fullName.split('.').pop();
			}
			return 'unknown';
		},

		/**
		 * Extraire la version d'un service
		 */
		getServiceVersion(serviceObj) {
			if (typeof serviceObj === 'object' && serviceObj.version) {
				return serviceObj.version;
			}
			return undefined;
		},

		/**
		 * Extraire le nom complet d'un service
		 */
		getServiceFullName(serviceObj) {
			if (typeof serviceObj === 'object' && serviceObj.fullName) {
				return serviceObj.fullName;
			}
			return undefined;
		},

		/**
		 * Obtenir les actions d'un service
		 */
		getServiceActions(service) {
			if (!service.actions) return [];
			
			return Object.keys(service.actions).map(actionName => ({
				name: actionName,
				fullName: `${service.name}.${actionName}`,
				cached: service.actions[actionName].cache !== undefined,
				params: service.actions[actionName].params ? Object.keys(service.actions[actionName].params) : []
			}));
		},

		/**
		 * Obtenir les événements d'un service
		 */
		getServiceEvents(service) {
			if (!service.events) return [];
			
			return Object.keys(service.events).map(eventName => ({
				name: eventName,
				handler: typeof service.events[eventName] === 'function'
			}));
		},

		/**
		 * Analyser les dépendances globales
		 */
		async analyzeDependencies() {
			const services = this.broker.registry.getServiceList({ onlyAvailable: false });
			const dependencies = {
				serviceDependencies: [],
				nodeDependencies: [],
				crossNodeServices: [],
				dependencyGraph: {}
			};

			// Construire le graphe de dépendances
			for (const service of services) {
				if (service.name === '$node') continue;

				const serviceDeps = await this.getServiceDependencies(service.name);
				dependencies.dependencyGraph[service.name] = serviceDeps.map(dep => dep.service);
				
				if (serviceDeps.length > 0) {
					dependencies.serviceDependencies.push({
						service: service.name,
						nodeId: service.nodeID,
						dependencies: serviceDeps
					});
				}
			}

			// Services distribués sur plusieurs nœuds
			const serviceGroups = this.groupServicesByName(services);
			
			Object.keys(serviceGroups).forEach(serviceName => {
				const nodes = [...new Set(serviceGroups[serviceName])];
				if (nodes.length > 1) {
					dependencies.crossNodeServices.push({
						service: serviceName,
						nodes: nodes,
						instances: serviceGroups[serviceName].length
					});
				}
			});

			// Analyser les dépendances entre nœuds
			dependencies.nodeDependencies = this.analyzeNodeDependencies(services, dependencies.serviceDependencies);

			return dependencies;
		},

		/**
		 * Grouper les services par nom
		 */
		groupServicesByName(services) {
			const serviceGroups = {};
			services.forEach(service => {
				if (service.name === '$node') return;
				
				if (!serviceGroups[service.name]) {
					serviceGroups[service.name] = [];
				}
				serviceGroups[service.name].push(service.nodeID);
			});
			return serviceGroups;
		},

		/**
		 * Analyser les dépendances entre nœuds
		 */
		analyzeNodeDependencies(services, serviceDependencies) {
			const nodeDeps = {};
			
			serviceDependencies.forEach(({ service, nodeId, dependencies }) => {
				if (!nodeDeps[nodeId]) {
					nodeDeps[nodeId] = new Set();
				}
				
				dependencies.forEach(dep => {
					// Trouver sur quels nœuds se trouve le service dépendant
					const dependentServices = services.filter(s => s.name === dep.service);
					dependentServices.forEach(depService => {
						if (depService.nodeID !== nodeId) {
							nodeDeps[nodeId].add(depService.nodeID);
						}
					});
				});
			});

			// Convertir les Sets en arrays
			return Object.keys(nodeDeps).map(nodeId => ({
				nodeId,
				dependsOn: Array.from(nodeDeps[nodeId])
			})).filter(dep => dep.dependsOn.length > 0);
		},

		/**
		 * Obtenir les dépendances d'un service spécifique
		 */
		async getServiceDependencies(serviceName) {
			try {
				const services = this.broker.registry.getServiceList({ onlyAvailable: false });
				const service = services.find(s => s.name === serviceName);
				
				if (!service) return [];

				const dependencies = [];

				// 1. Dépendances explicites
				const explicitDeps = this.getExplicitDependencies(service);
				dependencies.push(...explicitDeps);

				// 2. Dépendances basées sur les mixins
				const mixinDeps = this.getMixinDependencies(service, services);
				dependencies.push(...mixinDeps);

				// 3. Dépendances détectées par pattern matching
				const patternDeps = this.getPatternDependencies(service, services);
				dependencies.push(...patternDeps);

				// 4. Dédupliquer
				return this.deduplicateDependencies(dependencies);
			} catch (err) {
				this.logger.warn(`Error analyzing dependencies for ${serviceName}:`, err);
				return [];
			}
		},

		/**
		 * Obtenir les dépendances explicites
		 */
		getExplicitDependencies(service) {
			const dependencies = [];
			
			if (service.dependencies && Array.isArray(service.dependencies)) {
				dependencies.push(...service.dependencies.map(dep => ({
					type: 'explicit',
					service: dep,
					required: true,
					source: 'dependencies'
				})));
			}

			if (service.schema && service.schema.dependencies && Array.isArray(service.schema.dependencies)) {
				dependencies.push(...service.schema.dependencies.map(dep => ({
					type: 'explicit',
					service: dep,
					required: true,
					source: 'schema.dependencies'
				})));
			}

			return dependencies;
		},

		/**
		 * Obtenir les dépendances basées sur les mixins
		 */
		getMixinDependencies(service, allServices) {
			const dependencies = [];
			const serviceNames = allServices.map(s => s.name).filter(n => n !== '$node' && n !== service.name);

			if (service.schema && service.schema.mixins) {
				service.schema.mixins.forEach(mixin => {
					if (typeof mixin === 'object' && mixin.name) {
						// Si le mixin a un nom qui correspond à un service
						if (serviceNames.includes(mixin.name)) {
							dependencies.push({
								type: 'mixin',
								service: mixin.name,
								required: true,
								source: 'mixin'
							});
						}
					}
				});
			}

			return dependencies;
		},

		/**
		 * Obtenir les dépendances par pattern matching
		 */
		getPatternDependencies(service, allServices) {
			const dependencies = [];
			const serviceNames = allServices.map(s => s.name).filter(n => n !== '$node' && n !== service.name);

			// Patterns de dépendances communes
			const dependencyPatterns = {
				'api': ['etcd', 'coderdb', 'metrics-aggregator'], 
				'coderdb': ['etcd'], 
				'discovery-client': ['discovery'], 
				'network-analyzer': ['etcd', 'metrics-aggregator'],
				'metrics-aggregator': [] // Pas de dépendances pattern pour éviter les cycles
			};

			if (dependencyPatterns[service.name]) {
				dependencyPatterns[service.name].forEach(depName => {
					if (serviceNames.includes(depName)) {
						dependencies.push({
							type: 'pattern',
							service: depName,
							required: false,
							source: 'pattern-matching'
						});
					}
				});
			}

			return dependencies;
		},

		/**
		 * Dédupliquer les dépendances
		 */
		deduplicateDependencies(dependencies) {
			const seen = new Set();
			return dependencies.filter(dep => {
				const key = `${dep.service}-${dep.type}`;
				if (seen.has(key)) {
					return false;
				}
				seen.add(key);
				return true;
			});
		},

		/**
		 * Construire la matrice de dépendances
		 */
		async buildDependencyMatrix() {
			const services = this.broker.registry.getServiceList({ onlyAvailable: false })
				.filter(s => s.name !== '$node');
			
			const matrix = {};
			const serviceNames = services.map(s => s.name);

			for (const service of services) {
				const dependencies = await this.getServiceDependencies(service.name);
				matrix[service.name] = {
					nodeId: service.nodeID,
					dependencies: dependencies.reduce((acc, dep) => {
						acc[dep.service] = {
							type: dep.type,
							required: dep.required,
							source: dep.source
						};
						return acc;
					}, {}),
					dependents: [] // Sera rempli dans la seconde passe
				};
			}

			// Seconde passe pour remplir les dependents
			Object.keys(matrix).forEach(serviceName => {
				Object.keys(matrix[serviceName].dependencies).forEach(depName => {
					if (matrix[depName]) {
						matrix[depName].dependents.push(serviceName);
					}
				});
			});

			return {
				services: serviceNames,
				matrix: matrix,
				statistics: {
					totalServices: serviceNames.length,
					totalDependencies: Object.values(matrix).reduce((acc, service) => 
						acc + Object.keys(service.dependencies).length, 0),
					mostDependentService: this.findMostDependentService(matrix),
					mostRequiredService: this.findMostRequiredService(matrix)
				}
			};
		},

		/**
		 * Trouver le service avec le plus de dépendances
		 */
		findMostDependentService(matrix) {
			let maxDeps = 0;
			let mostDependent = null;

			Object.keys(matrix).forEach(serviceName => {
				const depCount = Object.keys(matrix[serviceName].dependencies).length;
				if (depCount > maxDeps) {
					maxDeps = depCount;
					mostDependent = serviceName;
				}
			});

			return mostDependent ? { service: mostDependent, count: maxDeps } : null;
		},

		/**
		 * Trouver le service le plus requis par d'autres
		 */
		findMostRequiredService(matrix) {
			let maxRequirements = 0;
			let mostRequired = null;

			Object.keys(matrix).forEach(serviceName => {
				const reqCount = matrix[serviceName].dependents.length;
				if (reqCount > maxRequirements) {
					maxRequirements = reqCount;
					mostRequired = serviceName;
				}
			});

			return mostRequired ? { service: mostRequired, count: maxRequirements } : null;
		},

		/**
		 * Calculer les statistiques du réseau
		 */
		calculateStatistics(nodes, services, dependencies) {
			const healthyNodes = nodes.filter(n => n.status === 'healthy');
			const activeServices = services.filter(s => s.status === 'active');
			
			const servicesPerNode = this.calculateServicesPerNode(services);
			const serviceDistribution = this.calculateServiceDistribution(services);

			return {
				health: {
					nodeHealthRate: nodes.length > 0 ? (healthyNodes.length / nodes.length) * 100 : 0,
					serviceActiveRate: services.length > 0 ? (activeServices.length / services.length) * 100 : 0
				},
				distribution: {
					averageServicesPerNode: nodes.length > 0 ? services.length / nodes.length : 0,
					maxServicesPerNode: Math.max(...Object.values(servicesPerNode), 0),
					minServicesPerNode: Math.min(...Object.values(servicesPerNode), 0),
					servicesPerNode: servicesPerNode
				},
				redundancy: {
					distributedServices: Object.values(serviceDistribution).filter(count => count > 1).length,
					singleInstanceServices: Object.values(serviceDistribution).filter(count => count === 1).length,
					serviceDistribution: serviceDistribution
				},
				cluster: {
					totalActions: services.reduce((acc, s) => acc + s.actions.length, 0),
					totalEvents: services.reduce((acc, s) => acc + s.events.length, 0),
					uniqueServices: new Set(services.map(s => s.name)).size
				},
				dependencies: {
					totalDependencies: dependencies.serviceDependencies.reduce((acc, dep) => 
						acc + dep.dependencies.length, 0),
					servicesDependingOnOthers: dependencies.serviceDependencies.length,
					crossNodeDependencies: dependencies.nodeDependencies.length,
					distributedServices: dependencies.crossNodeServices.length
				}
			};
		},

		/**
		 * Calculer la distribution des services par nœud
		 */
		calculateServicesPerNode(services) {
			const servicesPerNode = {};
			services.forEach(service => {
				if (!servicesPerNode[service.nodeId]) {
					servicesPerNode[service.nodeId] = 0;
				}
				servicesPerNode[service.nodeId]++;
			});
			return servicesPerNode;
		},

		/**
		 * Calculer la distribution des services
		 */
		calculateServiceDistribution(services) {
			const serviceDistribution = {};
			services.forEach(service => {
				if (!serviceDistribution[service.name]) {
					serviceDistribution[service.name] = 0;
				}
				serviceDistribution[service.name]++;
			});
			return serviceDistribution;
		}
	},

	async started() {
		this.logger.info("Network analyzer service started", {
			nodeId: this.broker.nodeID,
			updateInterval: this.settings.updateInterval
		});

		setTimeout(async () => {
			try {
				const stats = await this.broker.call("network-analyzer.getQuickStats");
				this.logger.info("Initial network analysis completed", stats);
			} catch (err) {
				this.logger.warn("Initial network analysis failed:", err);
			}
		}, 5000);
	},

	async stopped() {
		this.logger.info("Network analyzer service stopped");
	}
};