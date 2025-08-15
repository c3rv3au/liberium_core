// services/discovery.service.js
"use strict";

const { Service } = require("moleculer");
const BaseService = require("./base.service");

module.exports = {
	name: "discovery",

	mixins: [BaseService],

	settings: {
		// Port exposé pour les connections externes
		discoveryPort: process.env.DISCOVERY_PORT || 4000,
		// TTL des nœuds en secondes
		nodeTTL: 60,
		// Intervalle de nettoyage en ms
		cleanupInterval: 30000
	},

	actions: {
		/**
		 * Enregistrer un nœud externe
		 */
		registerNode: {
			params: {
				nodeId: "string",
				host: "string", 
				port: { type: "number", default: 4000 },
				services: { type: "array", optional: true },
				metadata: { type: "object", optional: true }
			},
			async handler(ctx) {
				const { nodeId, host, port, services, metadata } = ctx.params;
				
				const nodeInfo = {
					nodeId,
					host,
					port,
					services: services || [],
					metadata: metadata || {},
					registeredAt: Date.now(),
					lastSeen: Date.now(),
					url: `${host}:${port}/${nodeId}`
				};

				this.externalNodes.set(nodeId, nodeInfo);
				
				this.logger.info(`External node registered: ${nodeId} at ${host}:${port}`);
				
				// Notifier les autres nœuds
				this.broker.broadcast("discovery.nodeRegistered", nodeInfo);
				
				return {
					success: true,
					nodeId,
					registeredAt: nodeInfo.registeredAt
				};
			}
		},

		/**
		 * Heartbeat d'un nœud externe
		 */
		heartbeat: {
			params: {
				nodeId: "string"
			},
			async handler(ctx) {
				const { nodeId } = ctx.params;
				
				if (this.externalNodes.has(nodeId)) {
					const node = this.externalNodes.get(nodeId);
					node.lastSeen = Date.now();
					this.externalNodes.set(nodeId, node);
					
					return { success: true, lastSeen: node.lastSeen };
				}
				
				return { success: false, error: "Node not found" };
			}
		},

		/**
		 * Désenregistrer un nœud
		 */
		unregisterNode: {
			params: {
				nodeId: "string"
			},
			async handler(ctx) {
				const { nodeId } = ctx.params;
				
				if (this.externalNodes.has(nodeId)) {
					this.externalNodes.delete(nodeId);
					
					this.logger.info(`External node unregistered: ${nodeId}`);
					
					// Notifier les autres nœuds
					this.broker.broadcast("discovery.nodeUnregistered", { nodeId });
					
					return { success: true, nodeId };
				}
				
				return { success: false, error: "Node not found" };
			}
		},

		/**
		 * Lister tous les nœuds (internes + externes)
		 */
		listNodes: {
			async handler(ctx) {
				// Nœuds internes (Moleculer)
				const internalNodes = await this.broker.registry.getNodeList({ onlyAvailable: true });
				
				// Nœuds externes
				const externalNodes = Array.from(this.externalNodes.values())
					.filter(node => this.isNodeAlive(node));
				
				return {
					internal: internalNodes.map(node => ({
						nodeId: node.id,
						hostname: node.hostname,
						local: node.local,
						available: node.available,
						services: node.services ? node.services.map(s => s.name) : [],
						type: "internal"
					})),
					external: externalNodes.map(node => ({
						nodeId: node.nodeId,
						host: node.host,
						port: node.port,
						url: node.url,
						services: node.services,
						lastSeen: node.lastSeen,
						type: "external"
					})),
					total: internalNodes.length + externalNodes.length
				};
			}
		},

		/**
		 * Obtenir les URLs de bootstrap pour un nœud externe
		 */
		getBootstrapUrls: {
			async handler(ctx) {
				const urls = [];
				
				// URLs des nœuds internes (Kubernetes)
				const internalNodes = await this.broker.registry.getNodeList({ onlyAvailable: true });
				
				// Stratégie 1: URLs directes des pods (IP pod + port 3001)
				for (const node of internalNodes) {
					if (node.id !== this.broker.nodeID) {
						const podIP = this.getPodIPFromNode(node);
						if (podIP) {
							urls.push(`${podIP}:3001/${node.id}`);
							this.logger.debug(`Added pod direct URL: ${podIP}:3001/${node.id}`);
						}
					}
				}
				
				// Stratégie 2: Si pas d'IP pod disponible, utiliser le LoadBalancer avec port 4000
				// (seulement si aucune URL directe n'a été trouvée)
				if (urls.length === 0) {
					const discoveryPublicUrl = process.env.DISCOVERY_PUBLIC_URL;
					const discoveryPort = process.env.DISCOVERY_PUBLIC_PORT || '4000'; // Port TCP, pas HTTP
					
					if (discoveryPublicUrl) {
						for (const node of internalNodes) {
							if (node.id !== this.broker.nodeID) {
								// Utiliser le port TCP 4000, pas le port HTTP 80
								urls.push(`${discoveryPublicUrl}:${discoveryPort}/${node.id}`);
								this.logger.debug(`Added loadbalancer URL: ${discoveryPublicUrl}:${discoveryPort}/${node.id}`);
							}
						}
					}
				}
				
				// URLs des nœuds externes (autres VMs/services)
				const externalNodes = Array.from(this.externalNodes.values())
					.filter(node => this.isNodeAlive(node));
				
				for (const node of externalNodes) {
					urls.push(node.url);
					this.logger.debug(`Added external node URL: ${node.url}`);
				}
				
				const method = urls.length > 0 && urls[0].includes(process.env.DISCOVERY_PUBLIC_URL) 
					? "loadbalancer" 
					: "direct-pod-ip";
				
				this.logger.info(`Generated ${urls.length} bootstrap URLs`, { 
					urls,
					method,
					internalNodesCount: internalNodes.length - 1,
					externalNodesCount: externalNodes.length,
					discoveryPublicUrl: process.env.DISCOVERY_PUBLIC_URL
				});
				
				return {
					urls,
					count: urls.length,
					discoveryPublicUrl: process.env.DISCOVERY_PUBLIC_URL || null,
					internalNodesCount: internalNodes.length - 1,
					externalNodesCount: externalNodes.length,
					method,
					debug: {
						internalNodes: internalNodes.map(node => ({
							id: node.id,
							podIP: this.getPodIPFromNode(node),
							hostname: node.hostname,
							metadata: node.metadata
						}))
					}
				};
			}
		},

		/**
		 * Obtenir le statut du discovery
		 */
		getStatus: {
			async handler(ctx) {
				const nodes = await this.broker.call("discovery.listNodes");
				
				return {
					service: "discovery",
					status: "healthy",
					uptime: process.uptime(),
					nodeId: this.broker.nodeID,
					isKubernetes: this.isKubernetes(),
					discoveryPublicUrl: process.env.DISCOVERY_PUBLIC_URL,
					nodes: {
						internal: nodes.internal.length,
						external: nodes.external.length,
						total: nodes.total
					},
					externalNodesDetails: Array.from(this.externalNodes.values()).map(node => ({
						nodeId: node.nodeId,
						host: node.host,
						alive: this.isNodeAlive(node),
						lastSeen: new Date(node.lastSeen).toISOString()
					}))
				};
			}
		}
	},

	events: {
		"discovery.nodeRegistered"(payload) {
			this.logger.debug(`Node registered event: ${payload.nodeId}`);
		},

		"discovery.nodeUnregistered"(payload) {
			this.logger.debug(`Node unregistered event: ${payload.nodeId}`);
		}
	},

	methods: {
		/**
		 * Détecter si on est dans Kubernetes
		 */
		isKubernetes() {
			return !!(process.env.KUBERNETES_SERVICE_HOST || 
					  process.env.POD_NAME || 
					  process.env.POD_NAMESPACE);
		},

		/**
		 * Vérifier si un nœud externe est encore vivant
		 */
		isNodeAlive(node) {
			const now = Date.now();
			const timeSinceLastSeen = now - node.lastSeen;
			return timeSinceLastSeen < (this.settings.nodeTTL * 1000);
		},

		/**
		 * Nettoyer les nœuds externes expirés
		 */
		cleanupExpiredNodes() {
			const now = Date.now();
			const expiredNodes = [];
			
			for (const [nodeId, node] of this.externalNodes.entries()) {
				if (!this.isNodeAlive(node)) {
					expiredNodes.push(nodeId);
				}
			}
			
			for (const nodeId of expiredNodes) {
				this.externalNodes.delete(nodeId);
				this.logger.info(`Cleaned up expired external node: ${nodeId}`);
				
				// Notifier
				this.broker.broadcast("discovery.nodeUnregistered", { nodeId });
			}
			
			if (expiredNodes.length > 0) {
				this.logger.info(`Cleaned up ${expiredNodes.length} expired external nodes`);
			}
		},

		/**
		 * Extraire l'IP du pod depuis les métadonnées du nœud
		 */
		getPodIPFromNode(node) {
			// 1. IP du pod depuis les métadonnées Moleculer
			if (node.metadata && node.metadata.podIP) {
				this.logger.debug(`Found podIP in metadata: ${node.metadata.podIP}`, { nodeId: node.id });
				return node.metadata.podIP;
			}
			
			// 2. IP depuis ipList (Moleculer peut stocker les IPs là)
			if (node.ipList && node.ipList.length > 0) {
				// Prendre la première IP non-loopback
				for (const ip of node.ipList) {
					if (ip !== "127.0.0.1" && ip !== "::1" && this.isValidIP(ip)) {
						this.logger.debug(`Found IP in ipList: ${ip}`, { nodeId: node.id });
						return ip;
					}
				}
			}
			
			// 3. Essayer d'extraire depuis le hostname si c'est une IP
			if (node.hostname && this.isValidIP(node.hostname)) {
				this.logger.debug(`Found IP in hostname: ${node.hostname}`, { nodeId: node.id });
				return node.hostname;
			}
			
			// 4. Si le nodeID contient l'IP
			if (this.isValidIP(node.id)) {
				this.logger.debug(`Found IP in nodeID: ${node.id}`, { nodeId: node.id });
				return node.id;
			}
			
			// 5. Essayer d'extraire l'IP depuis les informations de transporter
			if (node.client && node.client.host && this.isValidIP(node.client.host)) {
				this.logger.debug(`Found IP in client.host: ${node.client.host}`, { nodeId: node.id });
				return node.client.host;
			}
			
			this.logger.warn(`Could not find IP for node ${node.id}`, {
				hostname: node.hostname,
				ipList: node.ipList,
				metadata: node.metadata,
				client: node.client
			});
			
			return null;
		},

		/**
		 * Vérifier si une chaîne est une IP valide
		 */
		isValidIP(str) {
			if (!str || typeof str !== 'string') return false;
			
			const ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
			const ipv6Regex = /^(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/;
			return ipv4Regex.test(str) || ipv6Regex.test(str);
		}
	},

	/**
	 * Initialisation
	 */
	created() {
		// Map pour stocker les nœuds externes
		this.externalNodes = new Map();
	},

	/**
	 * Démarrage
	 */
	async started() {
		this.logger.info("Discovery service started", {
			nodeId: this.broker.nodeID,
			isKubernetes: this.isKubernetes(),
			discoveryPublicUrl: process.env.DISCOVERY_PUBLIC_URL,
			discoveryPublicPort: process.env.DISCOVERY_PUBLIC_PORT,
			nodeTTL: this.settings.nodeTTL
		});
		
		// Démarrer le nettoyage périodique
		this.cleanupTimer = setInterval(() => {
			this.cleanupExpiredNodes();
		}, this.settings.cleanupInterval);
	},

	/**
	 * Arrêt
	 */
	async stopped() {
		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
		}
		
		this.logger.info("Discovery service stopped");
	}
};