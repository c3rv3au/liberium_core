// services/network-analyzer.service.js
"use strict";

const BaseService = require("./base.service");
const { dependencies } = require("./etcd.service");

module.exports = {
	name: "network-analyzer",

	mixins: [BaseService],

	settings: {
		// Intervalle de mise à jour de l'analyse en ms
		updateInterval: 30000,
		// Cache TTL en ms
		cacheTTL: 15000
	},

    dependencies: ["etcd"],

	actions: {
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
		}
	},

	methods: {
		/**
		 * Analyser l'ensemble du réseau
		 */
		async analyzeNetwork() {
			const nodes = await this.analyzeNodes();
			const services = await this.analyzeServices();
			const dependencies = await this.analyzeDependencies();
			const statistics = this.calculateStatistics(nodes, services);

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
					name: typeof s === 'string' ? s : s.name,
					version: typeof s === 'object' ? s.version : undefined,
					fullName: typeof s === 'object' ? s.fullName : undefined
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
				if (service.name === '$node') continue; // Ignorer le service système

				const analysis = {
					type: 'service',
					name: service.name,
					version: service.version,
					fullName: service.fullName,
					status: service.available ? 'active' : 'inactive',
					nodeId: service.nodeID,
					dependencies: await this.getServiceDependencies(service.name),
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
				crossNodeServices: []
			};

			// Dépendances entre services
			for (const service of services) {
				if (service.name === '$node') continue;

				const serviceDeps = await this.getServiceDependencies(service.name);
				if (serviceDeps.length > 0) {
					dependencies.serviceDependencies.push({
						service: service.name,
						nodeId: service.nodeID,
						dependencies: serviceDeps
					});
				}
			}

			// Services distribués sur plusieurs nœuds
			const serviceGroups = {};
			services.forEach(service => {
				if (service.name === '$node') return;
				
				if (!serviceGroups[service.name]) {
					serviceGroups[service.name] = [];
				}
				serviceGroups[service.name].push(service.nodeID);
			});

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

			return dependencies;
		},

		/**
		 * Obtenir les dépendances d'un service spécifique
		 */
		async getServiceDependencies(serviceName) {
			try {
				// Chercher le service dans le registry
				const services = this.broker.registry.getServiceList({ onlyAvailable: false });
				const service = services.find(s => s.name === serviceName);
				
				if (!service) return [];

				const dependencies = [];

				// Dépendances explicites dans la configuration
				if (service.dependencies && Array.isArray(service.dependencies)) {
					dependencies.push(...service.dependencies.map(dep => ({
						type: 'explicit',
						service: dep,
						required: true
					})));
				}

				// Dépendances implicites basées sur les appels d'actions
				const implicitDeps = await this.findImplicitDependencies(service);
				dependencies.push(...implicitDeps);

				return dependencies;
			} catch (err) {
				this.logger.warn(`Error analyzing dependencies for ${serviceName}:`, err);
				return [];
			}
		},

		/**
		 * Trouver les dépendances implicites en analysant le code
		 */
		async findImplicitDependencies(service) {
			const dependencies = [];
			
			// Cette fonction pourrait être étendue pour analyser le code source
			// et détecter les appels broker.call() vers d'autres services
			
			// Pour l'instant, on se base sur les services disponibles
			// et on fait des suppositions basées sur les noms communs
			const allServices = this.broker.registry.getServiceList({ onlyAvailable: false });
			const serviceNames = allServices.map(s => s.name).filter(n => n !== '$node' && n !== service.name);

			// Vérifier les mixins (dépendances probables)
			if (service.schema && service.schema.mixins) {
				// Analyser les mixins pour détecter des services de base
				const baseMixins = ['base.service', 'etcd-storage', 'etcd-election'];
				baseMixins.forEach(mixin => {
					if (service.schema.mixins.some(m => m.toString().includes(mixin))) {
						const dependentService = mixin.replace('.service', '').replace('-', '');
						if (serviceNames.includes(dependentService)) {
							dependencies.push({
								type: 'mixin',
								service: dependentService,
								required: true
							});
						}
					}
				});
			}

			return dependencies;
		},

		/**
		 * Calculer les statistiques du réseau
		 */
		calculateStatistics(nodes, services) {
			const healthyNodes = nodes.filter(n => n.status === 'healthy');
			const activeServices = services.filter(s => s.status === 'active');
			
			// Distribution des services par nœud
			const servicesPerNode = {};
			services.forEach(service => {
				if (!servicesPerNode[service.nodeId]) {
					servicesPerNode[service.nodeId] = 0;
				}
				servicesPerNode[service.nodeId]++;
			});

			// Services les plus distribués
			const serviceDistribution = {};
			services.forEach(service => {
				if (!serviceDistribution[service.name]) {
					serviceDistribution[service.name] = 0;
				}
				serviceDistribution[service.name]++;
			});

			return {
				health: {
					nodeHealthRate: nodes.length > 0 ? (healthyNodes.length / nodes.length) * 100 : 0,
					serviceActiveRate: services.length > 0 ? (activeServices.length / services.length) * 100 : 0
				},
				distribution: {
					averageServicesPerNode: nodes.length > 0 ? services.length / nodes.length : 0,
					maxServicesPerNode: Math.max(...Object.values(servicesPerNode), 0),
					minServicesPerNode: Math.min(...Object.values(servicesPerNode), 0)
				},
				redundancy: {
					distributedServices: Object.values(serviceDistribution).filter(count => count > 1).length,
					singleInstanceServices: Object.values(serviceDistribution).filter(count => count === 1).length
				},
				cluster: {
					totalActions: services.reduce((acc, s) => acc + s.actions.length, 0),
					totalEvents: services.reduce((acc, s) => acc + s.events.length, 0),
					uniqueServices: new Set(services.map(s => s.name)).size
				}
			};
		}
	},

	/**
	 * Démarrage
	 */
	async started() {
		this.logger.info("Network analyzer service started", {
			nodeId: this.broker.nodeID,
			updateInterval: this.settings.updateInterval
		});

		// Première analyse au démarrage
		setTimeout(async () => {
			try {
				const stats = await this.broker.call("network-analyzer.getQuickStats");
				this.logger.info("Initial network analysis completed", stats);
			} catch (err) {
				this.logger.warn("Initial network analysis failed:", err);
			}
		}, 5000);
	},

	/**
	 * Arrêt
	 */
	async stopped() {
		this.logger.info("Network analyzer service stopped");
	}
};