// services/api/api.service.js
"use strict";

const { Service } = require("moleculer");
const http = require("http");
const url = require("url");

module.exports = {
	name: "api",

	settings: {
		port: process.env.API_PORT || 3001,
		host: process.env.API_HOST || "0.0.0.0",
		cors: {
			origin: "*",
			methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
			headers: ["Content-Type", "Authorization"]
		}
	},

	methods: {
		/**
		 * Créer le serveur HTTP pour l'API
		 */
		createServer() {
			this.server = http.createServer(async (req, res) => {
				try {
					await this.handleRequest(req, res);
				} catch (err) {
					this.logger.error("API request error:", err);
					this.sendError(res, 500, "Internal Server Error");
				}
			});
		},

		/**
		 * Gérer les requêtes HTTP
		 */
		async handleRequest(req, res) {
			const parsedUrl = url.parse(req.url, true);
			const pathname = parsedUrl.pathname;
			const method = req.method;

			// Gestion CORS
			this.setCorsHeaders(res);

			if (method === "OPTIONS") {
				res.writeHead(200);
				res.end();
				return;
			}

			// Toutes les routes commencent par /brain/
			if (!pathname.startsWith("/brain/")) {
				return this.sendError(res, 404, "Not Found");
			}

			// Router automatiquement vers les services
			await this.routeToService(req, res, pathname.substring(7), method, parsedUrl.query);
		},

		/**
		 * Router automatiquement vers les services Moleculer
		 */
		async routeToService(req, res, path, method, query) {
			const segments = path.split("/").filter(s => s);
			
			if (segments.length === 0) {
				return this.sendError(res, 404, "Brain endpoint required");
			}

			// Construire l'action Moleculer à partir de l'URL
			const serviceName = segments[0];
			const actionName = segments[1] || "list";
			const actionPath = `${serviceName}.${actionName}`;

			// Lire le body de la requête
			const body = await this.getRequestBody(req);

			// Construire les paramètres
			const params = this.buildParams(segments, method, body, query);

			try {
				// Essayer d'appeler le service
				const result = await this.broker.call(actionPath, params, {
					meta: {
						httpMethod: method,
						url: req.url,
						headers: req.headers
					}
				});

				// Déterminer le code de statut
				const statusCode = this.getStatusCode(method, actionName);
				this.sendJson(res, statusCode, result);

			} catch (err) {
				this.logger.error(`Error calling ${actionPath}:`, err);
				
				// Si le service n'existe pas, essayer des variantes
				if (err.code === "SERVICE_NOT_FOUND" || err.code === "ACTION_NOT_FOUND") {
					const altResult = await this.tryAlternativeActions(serviceName, actionName, method, params, segments);
					if (altResult.success) {
						const statusCode = this.getStatusCode(method, altResult.action);
						return this.sendJson(res, statusCode, altResult.data);
					}
				}

				// Gérer les erreurs spécifiques
				if (err.code === "VALIDATION_ERROR") {
					return this.sendError(res, 400, err.message);
				} else if (err.code === "NOT_FOUND") {
					return this.sendError(res, 404, err.message);
				} else if (err.code === "FORBIDDEN") {
					return this.sendError(res, 403, err.message);
				} else if (err.code === "SERVICE_NOT_FOUND" || err.code === "ACTION_NOT_FOUND") {
					return this.sendError(res, 404, `Service or action not found: ${actionPath}`);
				} else {
					return this.sendError(res, 500, err.message);
				}
			}
		},

		/**
		 * Essayer des actions alternatives si l'action principale n'existe pas
		 */
		async tryAlternativeActions(serviceName, actionName, method, params, segments) {
			const alternatives = this.getAlternativeActions(serviceName, actionName, method, segments);

			for (const alt of alternatives) {
				try {
					const result = await this.broker.call(alt.action, alt.params || params);
					return { success: true, data: result, action: alt.name };
				} catch (err) {
					// Continuer avec la prochaine alternative
					continue;
				}
			}

			return { success: false };
		},

		/**
		 * Obtenir les actions alternatives basées sur la convention REST
		 */
		getAlternativeActions(serviceName, actionName, method, segments) {
			const alternatives = [];

			// Conventions REST standards
							switch (method) {
				case "GET":
					if (segments.length === 1) {
						// GET /brain/functions -> functions.list
						alternatives.push({ action: `${serviceName}.list`, name: "list" });
						alternatives.push({ action: `${serviceName}.listFunctions`, name: "listFunctions" });
					} else if (segments.length === 2) {
						// GET /brain/functions/name -> functions.get
						alternatives.push({ 
							action: `${serviceName}.get`, 
							name: "get",
							params: { name: decodeURIComponent(segments[1]) }
						});
						alternatives.push({ 
							action: `${serviceName}.getFunction`, 
							name: "getFunction",
							params: { name: decodeURIComponent(segments[1]) }
						});
					}
					break;

				case "POST":
					if (segments.length === 1) {
						// POST /brain/functions -> functions.create
						alternatives.push({ action: `${serviceName}.create`, name: "create" });
						alternatives.push({ action: `${serviceName}.createFunction`, name: "createFunction" });
					} else if (segments.length === 3) {
						// POST /brain/functions/name/action -> functions.action
						const name = decodeURIComponent(segments[1]);
						const action = segments[2];
						alternatives.push({ 
							action: `${serviceName}.${action}`, 
							name: action,
							params: { name }
						});
					}
					break;

				case "PUT":
					if (segments.length === 2) {
						// PUT /brain/functions/name -> functions.update
						alternatives.push({ 
							action: `${serviceName}.update`, 
							name: "update"
						});
						alternatives.push({ 
							action: `${serviceName}.updateFunction`, 
							name: "updateFunction"
						});
					}
					break;

				case "DELETE":
					if (segments.length === 2) {
						// DELETE /brain/functions/name -> functions.delete
						alternatives.push({ 
							action: `${serviceName}.delete`, 
							name: "delete"
						});
						alternatives.push({ 
							action: `${serviceName}.deleteFunction`, 
							name: "deleteFunction"
						});
					}
					break;
			}

			// Actions communes
			alternatives.push({ action: `${serviceName}.${actionName}`, name: actionName });
			alternatives.push({ action: `${serviceName}.getStatus`, name: "getStatus" });
			alternatives.push({ action: `${serviceName}.getStatistics`, name: "getStatistics" });

			return alternatives;
		},

		/**
		 * Construire les paramètres à partir de l'URL et du body
		 */
		buildParams(segments, method, body, query) {
			let params = { ...body };

			// Ajouter les paramètres de query
			if (query) {
				Object.assign(params, query);
			}

			// Ajouter les paramètres d'URL
			if (segments.length >= 2) {
				// Le deuxième segment est souvent un ID ou nom
				params.name = params.name || decodeURIComponent(segments[1]);
				params.id = params.id || decodeURIComponent(segments[1]);
			}

			if (segments.length >= 3) {
				// Le troisième segment peut être une action
				params.action = segments[2];
			}

			// Nettoyer les paramètres vides
			Object.keys(params).forEach(key => {
				if (params[key] === "" || params[key] === null || params[key] === undefined) {
					delete params[key];
				}
			});

			return params;
		},

		/**
		 * Déterminer le code de statut HTTP basé sur l'action
		 */
		getStatusCode(method, actionName) {
			if (method === "POST" && (actionName === "create" || actionName === "createFunction")) {
				return 201; // Created
			}
			return 200; // OK
		},

		/**
		 * Obtenir la liste des services disponibles
		 */
		async getAvailableServices() {
			try {
				const nodes = await this.broker.registry.getNodeList({ onlyAvailable: true });
				const services = new Set();

				nodes.forEach(node => {
					if (node.services && Array.isArray(node.services)) {
						node.services.forEach(service => {
							if (service && service.name) {
								services.add(service.name);
							}
						});
					}
				});

				return Array.from(services);
			} catch (err) {
				this.logger.error("Error getting available services:", err);
				return [];
			}
		},

		/**
		 * Utilitaires HTTP
		 */
		setCorsHeaders(res) {
			const { origin, methods, headers } = this.settings.cors;
			res.setHeader("Access-Control-Allow-Origin", origin);
			res.setHeader("Access-Control-Allow-Methods", methods.join(", "));
			res.setHeader("Access-Control-Allow-Headers", headers.join(", "));
		},

		async getRequestBody(req) {
			return new Promise((resolve, reject) => {
				let body = "";
				req.on("data", chunk => body += chunk.toString());
				req.on("end", () => {
					try {
						resolve(body ? JSON.parse(body) : {});
					} catch (err) {
						resolve({}); // Si ce n'est pas du JSON, retourner un objet vide
					}
				});
				req.on("error", reject);
			});
		},

		sendJson(res, statusCode, data) {
			res.writeHead(statusCode, { 
				"Content-Type": "application/json",
				"Cache-Control": "no-cache"
			});
			res.end(JSON.stringify(data, null, 2));
		},

		sendError(res, statusCode, message) {
			this.sendJson(res, statusCode, { 
				error: message,
				timestamp: new Date().toISOString(),
				statusCode
			});
		}
	},

	actions: {
		/**
		 * Lister tous les services disponibles
		 */
		services: {
			async handler(ctx) {
				const services = await this.getAvailableServices();
				return {
					services,
					count: services.length,
					timestamp: new Date().toISOString()
				};
			}
		},

		/**
		 * Obtenir les informations de santé de l'API gateway
		 */
		health: {
			async handler(ctx) {
				const services = await this.getAvailableServices();
				return {
					status: "healthy",
					timestamp: new Date().toISOString(),
					uptime: process.uptime(),
					nodeId: this.broker.nodeID,
					availableServices: services,
					memoryUsage: process.memoryUsage(),
					version: require("../../package.json").version
				};
			}
		}
	},

	async started() {
		this.createServer();
		
		this.server.listen(this.settings.port, this.settings.host, () => {
			this.logger.info(`Brain API Gateway started on http://${this.settings.host}:${this.settings.port}`);
			this.logger.info("Available endpoints:");
			this.logger.info("  GET  /brain/services - List available services");
			this.logger.info("  GET  /brain/health - API health check");
			this.logger.info("  ALL  /brain/{service}/{action} - Dynamic routing to services");
		});
	},

	async stopped() {
		if (this.server) {
			this.server.close();
		}
		this.logger.info("Brain API Gateway stopped");
	}
};