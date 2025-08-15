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
                console.log("url:", this.settings.discoveryUrl);
                console.log("path:", path);
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
                    console.log("data:", data);
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
				this.logger.info(`Retrieved ${result.urls.length} bootstrap URLs from discovery`);
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
		 * Mettre à jour la configuration du transporter avec les peers découverts
		 */
		async updateTransporterPeers() {
			try {
				const bootstrapUrls = await this.getBootstrapUrls();
				
				if (bootstrapUrls.length > 0) {
					// Si le transporter supporte la mise à jour dynamique des peers
					if (this.broker.transporter && this.broker.transporter.addPeer) {
						for (const url of bootstrapUrls) {
							this.broker.transporter.addPeer(url);
						}
						this.logger.info(`Added ${bootstrapUrls.length} peers to transporter`);
					}
				}
			} catch (err) {
				this.logger.error("Failed to update transporter peers:", err);
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

		// S'enregistrer auprès du discovery
		try {
			await this.registerWithDiscovery();
		} catch (err) {
			this.logger.error("Initial registration failed:", err);
		}

		// Mettre à jour les peers
		await this.updateTransporterPeers();

		// Démarrer le heartbeat
		this.heartbeatTimer = setInterval(() => {
			this.sendHeartbeat();
		}, this.settings.heartbeatInterval);

		// Démarrer la découverte périodique des peers
		this.peerDiscoveryTimer = setInterval(() => {
			this.updateTransporterPeers();
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