// services/discovery-client.service.js
"use strict";

const BaseService = require("./base.service");
const http = require("http");

module.exports = {
	name: "discovery-client",

	mixins: [BaseService],

	settings: {
		// URL du service discovery (LoadBalancer Kubernetes)
		discoveryUrl: process.env.DISCOVERY_URL || null,
		// Intervalle de heartbeat vers le discovery en ms
		heartbeatInterval: 30000,
		// Intervalle de récupération des peers en ms
		peerDiscoveryInterval: 60000,
		// Tentatives de connexion aux nouveaux peers
		connectionRetries: 3,
		// Métadonnées à envoyer au discovery
		metadata: {
			environment: process.env.NODE_ENV || "production",
			region: process.env.REGION || "default",
			datacenter: process.env.DATACENTER || "default"
		}
	},

	methods: {
		/**
		 * Appel HTTP vers le service discovery
		 */
		async callDiscovery(path, method = "GET", data = null) {
			if (!this.settings.discoveryUrl) {
				throw new Error("DISCOVERY_URL environment variable is required");
			}

			return new Promise((resolve, reject) => {
				const url = new URL(path, this.settings.discoveryUrl);
				
				const options = {
					hostname: url.hostname,
					port: url.port || 80,
					path: url.pathname + url.search,
					method,
					headers: {
						"Content-Type": "application/json",
						"User-Agent": `liberium-discovery-client/${this.broker.nodeID}`
					}
				};

				if (data) {
					const body = JSON.stringify(data);
					options.headers["Content-Length"] = Buffer.byteLength(body);
				}

				const req = http.request(options, (res) => {
					let responseData = "";
					
					res.on("data", (chunk) => {
						responseData += chunk;
					});
					
					res.on("end", () => {
						try {
							const result = JSON.parse(responseData);
							
							if (res.statusCode >= 200 && res.statusCode < 300) {
								resolve(result);
							} else {
								reject(new Error(`Discovery API error: ${res.statusCode} - ${result.error || result.message}`));
							}
						} catch (err) {
							reject(new Error(`Invalid JSON response: ${err.message}`));
						}
					});
				});

				req.on("error", (err) => {
					reject(new Error(`Discovery request failed: ${err.message}`));
				});

				req.on("timeout", () => {
					req.destroy();
					reject(new Error("Discovery request timeout"));
				});

				req.setTimeout(10000);

				if (data) {
					req.write(JSON.stringify(data));
				}
				
				req.end();
			});
		},

		/**
		 * S'enregistrer auprès du service discovery
		 */
		async registerWithDiscovery() {
			try {
				const services = await this.getLocalServices();
				const metadata = {
					...this.settings.metadata,
					hostname: require("os").hostname(),
					pid: process.pid,
					startedAt: Date.now()
				};

				const result = await this.callDiscovery("/brain/discovery/registerNode", "POST", {
					nodeId: this.broker.nodeID,
					host: this.getLocalIP(),
					port: 4000,
					services,
					metadata
				});

				this.logger.info("Successfully registered with discovery service", result);
				return result;
			} catch (err) {
				this.logger.error("Failed to register with discovery service:", err);
				throw err;
			}
		},

		/**
		 * Envoyer un heartbeat au service discovery
		 */
		async sendHeartbeat() {
			try {
				await this.callDiscovery("/brain/discovery/heartbeat", "POST", {
					nodeId: this.broker.nodeID
				});
				
				this.logger.debug("Heartbeat sent to discovery service");
			} catch (err) {
				this.logger.warn("Failed to send heartbeat to discovery service:", err.message);
			}
		},

		/**
		 * Se désenregistrer du service discovery
		 */
		async unregisterFromDiscovery() {
			try {
				await this.callDiscovery("/brain/discovery/unregisterNode", "POST", {
					nodeId: this.broker.nodeID
				});
				
				this.logger.info("Successfully unregistered from discovery service");
			} catch (err) {
				this.logger.warn("Failed to unregister from discovery service:", err.message);
			}
		},

		/**
		 * Récupérer les URLs de bootstrap
		 */
		async getBootstrapUrls() {
			try {
				const result = await this.callDiscovery("/brain/discovery/getBootstrapUrls", "GET");
				this.logger.info(`Retrieved ${result.urls.length} bootstrap URLs from discovery`, result);
				return result.urls;
			} catch (err) {
				this.logger.error("Failed to get bootstrap URLs:", err);
				return [];
			}
		},

		/**
		 * Obtenir les services locaux
		 */
		async getLocalServices() {
			const services = this.broker.registry.getServiceList({ 
				onlyLocal: true, 
				onlyAvailable: true 
			});
			
			return services
				.map(service => service.name)
				.filter(name => name !== "$node");
		},

		/**
		 * Obtenir l'IP locale
		 */
		getLocalIP() {
			// Si définie explicitement
			if (process.env.LOCAL_IP) {
				return process.env.LOCAL_IP;
			}

			// Utiliser POD_IP si disponible (Kubernetes)
			if (process.env.POD_IP) {
				return process.env.POD_IP;
			}

			const os = require("os");
			const interfaces = os.networkInterfaces();
			
			// Chercher une IP non-loopback
			for (const name of Object.keys(interfaces)) {
				for (const iface of interfaces[name]) {
					if (iface.family === "IPv4" && !iface.internal) {
						return iface.address;
					}
				}
			}
			
			return "127.0.0.1";
		},

		/**
		 * Ajouter des peers au transporter de manière compatible
		 */
		async addPeerToTransporter(peerUrl) {
			if (!this.broker.transporter) {
				this.logger.warn("No transporter available to add peer");
				return false;
			}

			try {
				// Méthode 1: Si c'est un transporter TCP avec une méthode connect
				if (this.broker.transporter.connect && typeof this.broker.transporter.connect === 'function') {
					// Essayer de parser l'URL pour extraire host, port et nodeID
					const [hostPort, nodeID] = peerUrl.split('/');
					const [host, port] = hostPort.split(':');
					
					this.logger.debug(`Attempting to connect to peer: ${host}:${port} (${nodeID})`);
					
					// Utiliser la méthode connect du transporter
					await this.broker.transporter.connect();
					return true;
				}

				// Méthode 2: Essayer d'utiliser les options du transporter
				if (this.broker.transporter.opts && this.broker.transporter.opts.urls) {
					if (!this.broker.transporter.opts.urls.includes(peerUrl)) {
						this.broker.transporter.opts.urls.push(peerUrl);
						this.logger.debug(`Added peer URL to transporter options: ${peerUrl}`);
						return true;
					}
				}

				// Méthode 3: Créer une nouvelle connexion via le registry
				const [hostPort, nodeID] = peerUrl.split('/');
				const [host, port] = hostPort.split(':');
				
				if (nodeID && host && port) {
					// Essayer de déclencher une découverte manuelle
					this.broker.registry.discoverer.discoverNode(nodeID);
					this.logger.debug(`Triggered discovery for node: ${nodeID}`);
					return true;
				}

				return false;

			} catch (err) {
				this.logger.error(`Failed to add peer ${peerUrl}:`, err);
				return false;
			}
		},

		/**
		 * Connecter aux peers découverts
		 */
		async connectToDiscoveredPeers() {
			try {
				const bootstrapUrls = await this.getBootstrapUrls();
				
				if (bootstrapUrls.length === 0) {
					this.logger.debug("No bootstrap URLs received from discovery");
					return;
				}

				// Obtenir la liste des nœuds actuellement connectés
				const connectedNodes = await this.broker.registry.getNodeList({ onlyAvailable: true });
				const connectedNodeIds = connectedNodes.map(node => node.id);

				let newConnections = 0;
				
				for (const url of bootstrapUrls) {
					try {
						// Extraire le nodeID de l'URL
						const [hostPort, nodeID] = url.split('/');
						
						// Vérifier si on n'est pas déjà connecté à ce nœud
						if (nodeID && !connectedNodeIds.includes(nodeID) && nodeID !== this.broker.nodeID) {
							const success = await this.addPeerToTransporter(url);
							if (success) {
								newConnections++;
								this.logger.info(`Connected to new peer: ${url}`);
							}
						} else {
							this.logger.debug(`Skipping already connected or self node: ${nodeID}`);
						}
					} catch (err) {
						this.logger.warn(`Failed to connect to peer ${url}:`, err.message);
					}
				}

				if (newConnections > 0) {
					this.logger.info(`Successfully connected to ${newConnections} new peers`);
					
					// Attendre un peu pour que les connexions s'établissent
					setTimeout(async () => {
						const newConnectedNodes = await this.broker.registry.getNodeList({ onlyAvailable: true });
						this.logger.info(`Total connected nodes after discovery: ${newConnectedNodes.length}`, {
							nodeIds: newConnectedNodes.map(n => n.id)
						});
					}, 2000);
				} else {
					this.logger.debug("No new peer connections established");
				}

			} catch (err) {
				this.logger.error("Failed to connect to discovered peers:", err);
			}
		},

		/**
		 * Diagnostiquer le transporter
		 */
		diagnosticTransporter() {
			if (this.broker.transporter) {
				this.logger.debug("Transporter diagnostic:", {
					type: this.broker.transporter.constructor.name,
					connected: this.broker.transporter.connected,
					hasConnect: typeof this.broker.transporter.connect === 'function',
					hasOpts: !!this.broker.transporter.opts,
					optsUrls: this.broker.transporter.opts ? this.broker.transporter.opts.urls : null,
					methods: Object.getOwnPropertyNames(this.broker.transporter).filter(name => typeof this.broker.transporter[name] === 'function')
				});
			} else {
				this.logger.warn("No transporter available");
			}
		}
	},

	/**
	 * Démarrage
	 */
	async started() {
		if (!this.settings.discoveryUrl) {
			this.logger.warn("Discovery client started without DISCOVERY_URL - operating in standalone mode");
			return;
		}

		this.logger.info("Discovery client started", {
			discoveryUrl: this.settings.discoveryUrl,
			nodeId: this.broker.nodeID,
			localIP: this.getLocalIP()
		});

		// Diagnostic du transporter
		this.diagnosticTransporter();

		// S'enregistrer auprès du discovery
		try {
			await this.registerWithDiscovery();
		} catch (err) {
			this.logger.error("Initial registration failed:", err);
		}

		// Attendre que le broker soit complètement initialisé
		setTimeout(async () => {
			// Découvrir et connecter aux peers
			await this.connectToDiscoveredPeers();
		}, 3000);

		// Démarrer le heartbeat
		this.heartbeatTimer = setInterval(() => {
			this.sendHeartbeat();
		}, this.settings.heartbeatInterval);

		// Démarrer la découverte périodique des peers
		this.peerDiscoveryTimer = setInterval(() => {
			this.connectToDiscoveredPeers();
		}, this.settings.peerDiscoveryInterval);
	},

	/**
	 * Arrêt
	 */
	async stopped() {
		// Arrêter les timers
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
		}
		
		if (this.peerDiscoveryTimer) {
			clearInterval(this.peerDiscoveryTimer);
		}

		// Se désenregistrer
		if (this.settings.discoveryUrl) {
			await this.unregisterFromDiscovery();
		}

		this.logger.info("Discovery client stopped");
	}
};