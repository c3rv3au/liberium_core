// index.js
"use strict";

const { ServiceBroker } = require("moleculer");
const path = require("path");

/**
 * Lanceur de services configurable
 * Permet de démarrer différents services selon la variable SERVICES
 */
class ServiceLauncher {
	constructor() {
		this.availableServices = {
			"etcd": "./services/etcd.service.js", 
			"api": "./services/api.service.js",
		};
		
		this.broker = null;
	}

	/**
	 * Parser la liste des services depuis la variable d'environnement
	 */
	parseServices() {
		const servicesEnv = process.env.SERVICES || "coderdb,api";
		const requestedServices = servicesEnv
			.split(",")
			.map(s => s.trim().toLowerCase())
			.filter(s => s.length > 0);

		console.log(`[ServiceLauncher] Services demandés: ${requestedServices.join(", ")}`);

		// Valider que tous les services existent
		const validServices = [];
		const invalidServices = [];

		for (const service of requestedServices) {
			//if (this.availableServices[service]) {
				validServices.push(service);
			//} else {
			//	invalidServices.push(service);
			//}
		}

		if (invalidServices.length > 0) {
			console.warn(`[ServiceLauncher] Services invalides ignorés: ${invalidServices.join(", ")}`);
			console.warn(`[ServiceLauncher] Services disponibles: ${Object.keys(this.availableServices).join(", ")}`);
		}

		if (validServices.length === 0) {
			console.error("[ServiceLauncher] Aucun service valide trouvé, utilisation des services par défaut");
			return ["coderdb", "api"];
		}

		return validServices;
	}

	/**
	 * Créer le broker Moleculer
	 */
	createBroker() {
		// Charger la configuration Moleculer
		const config = require("./moleculer.config.js");
		
		this.broker = new ServiceBroker(config);
		
		return this.broker;
	}

	/**
	 * Charger les services sélectionnés
	 */
	loadServices(services) {
		console.log(`[ServiceLauncher] Chargement des services: ${services.join(", ")}`);
		
		for (const serviceName of services) {
			const servicePath = "./services/" + serviceName + ".service.js";
			
			try {
				console.log(`[ServiceLauncher] Chargement de ${serviceName} depuis ${servicePath}`);
				this.broker.loadService(path.resolve(servicePath));
			} catch (error) {
				console.error(`[ServiceLauncher] Erreur lors du chargement de ${serviceName}:`, error);
				process.exit(1);
			}
		}
	}

	/**
	 * Démarrer le broker et les services
	 */
	async start() {
		try {
			console.log("[ServiceLauncher] Démarrage du broker Moleculer...");
			
			// Parser et valider les services
			const services = this.parseServices();
			
			// Créer le broker
			this.createBroker();
			
			// Charger les services
			this.loadServices(services);
			
			// Démarrer le broker
			await this.broker.start();
			
			console.log(`[ServiceLauncher] Broker démarré avec succès avec les services: ${services.join(", ")}`);
			
			// Afficher des informations utiles
			this.displayInfo(services);
			
		} catch (error) {
			console.error("[ServiceLauncher] Erreur lors du démarrage:", error);
			process.exit(1);
		}
	}

	/**
	 * Arrêter proprement les services
	 */
	async stop() {
		if (this.broker) {
			console.log("[ServiceLauncher] Arrêt du broker...");
			await this.broker.stop();
			console.log("[ServiceLauncher] Broker arrêté");
		}
	}

	/**
	 * Afficher les informations de démarrage
	 */
	displayInfo(services) {
		console.log("\n" + "=".repeat(50));
		console.log("🚀 LIBERIUM CORE - Services actifs");
		console.log("=".repeat(50));
		
		services.forEach(service => {
			console.log(`✅ ${service.toUpperCase()}`);
		});
		
		/*
		if (services.includes("api")) {
			console.log("\n📡 API disponible sur:");
			console.log(`   http://localhost:${process.env.API_PORT || 3001}/brain/health`);
		}		
		console.log(`\n🔧 Node ID: ${this.broker.nodeID}`);
		console.log(`🏷️  Namespace: ${this.broker.namespace}`);
		console.log("=".repeat(50) + "\n");
		*/
	}

	/**
	 * Gérer les signaux de fermeture
	 */
	setupGracefulShutdown() {
		const signals = ["SIGINT", "SIGTERM", "SIGQUIT"];
		
		signals.forEach(signal => {
			process.on(signal, async () => {
				console.log(`\n[ServiceLauncher] Signal ${signal} reçu, arrêt gracieux...`);
				await this.stop();
				process.exit(0);
			});
		});

		process.on("uncaughtException", async (error) => {
			console.error("[ServiceLauncher] Exception non gérée:", error);
			await this.stop();
			process.exit(1);
		});

		process.on("unhandledRejection", async (reason, promise) => {
			console.error("[ServiceLauncher] Promesse rejetée non gérée:", reason);
			await this.stop();
			process.exit(1);
		});
	}
}

// Point d'entrée principal
async function main() {
	const launcher = new ServiceLauncher();
	
	// Configurer l'arrêt gracieux
	launcher.setupGracefulShutdown();
	
	// Démarrer les services
	await launcher.start();
}

// Lancer l'application si ce fichier est exécuté directement
if (require.main === module) {
	main().catch(error => {
		console.error("[ServiceLauncher] Erreur fatale:", error);
		process.exit(1);
	});
}

module.exports = ServiceLauncher;