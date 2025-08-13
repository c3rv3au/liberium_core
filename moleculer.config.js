// moleculer.config.js
"use strict";

module.exports = {
	// Nom de l'espace de noms du broker
	namespace: "liberium-core",
	
	// Nom unique du nœud
	nodeID: null,
	
	// Configuration du métadonnées du nœud
	metadata: {},
	
	// Configuration du logger
	logger: {
		type: "Console",
		options: {
			// Couleurs activées par défaut dans les logs
			colors: true,
			
			// Module name que sera écrit au début des lignes de log
			moduleColors: false,
			
			// Formatage des logs
			formatter: "full",
			
			// Séparateur d'objet pour l'affichage JSON
			objectPrinter: null,
			
			// Auto-padding du nom de module
			autoPadding: false
		}
	},
	
	// Niveau de log par défaut
	logLevel: "info",
	
	// Configuration du transporter pour la communication entre nœuds
	transporter: {
		type: "TCP",
		options: {
			// Port UDP pour la découverte automatique des nœuds
			udpDiscovery: true,
			udpPort: 4445,
			udpBindAddress: null,
			udpPeriod: 30,
			
			// Port TCP pour la communication
			port: 4000,
			urls: []
		}
	},
	
	// Configuration du système de mise en cache
	cacher: {
		type: "Memory",
		options: {
			// Taille maximum du cache
			max: 100,
			// TTL par défaut en secondes
			ttl: 30
		}
	},
	
	// Configuration du serializer pour les messages
	serializer: "JSON",
	
	// Configuration du request timeout en millisecondes
	requestTimeout: 10 * 1000,
	
	// Retry policy settings
	retryPolicy: {
		// Activation de la politique de retry
		enabled: false,
		// Nombre de tentatives
		retries: 5,
		// Délai entre les tentatives en ms
		delay: 100,
		// Multiplicateur de délai
		maxDelay: 1000,
		// Facteur d'expansion du délai
		factor: 2,
		// Vérifier si l'erreur est retriable
		check: err => err && !!err.retryable
	},
	
	// Configuration du maximum de paramètres
	maxCallLevel: 100,
	
	// Configuration du heartbeat
	heartbeatInterval: 10,
	heartbeatTimeout: 30,
	
	// Configuration du contexte de tracking
	contextParamsCloning: false,
	
	// Configuration du maximum d'événements
	maxEventListeners: 100,
	
	// Configuration de bulkhead (isolement de circuit)
	bulkhead: {
		// Activation du bulkhead
		enabled: false,
		// Nombre maximum de requêtes concurrentes
		concurrency: 10,
		// Nombre maximum de requêtes en attente
		maxQueueSize: 50,
	},
	
	// Configuration du registry pour la découverte de services
	registry: {
		// Stratégie de découverte
		strategy: "RoundRobin",
		// Préféreur de stratégie
		preferLocal: true
	},
	
	// Configuration du circuit breaker
	circuitBreaker: {
		// Activation du circuit breaker
		enabled: false,
		// Seuil de défaillance (0.5 = 50%)
		threshold: 0.5,
		// Délai de récupération en ms
		windowTime: 60000,
		// Nombre minimum de requêtes avant évaluation
		minRequestCount: 20,
		// Délai avant half-open state en ms
		halfOpenTime: 10000
	},
	
	// Configuration du load balancing
	balancer: {
		// Préférer les nœuds locaux
		preferLocal: true
	},
	
	// Configuration des métriques
	metrics: {
		enabled: false,
		reporter: {
			type: "Prometheus",
			options: {
				port: 3030,
				path: "/metrics",
				defaultLabels: registry => ({
					namespace: registry.broker.namespace,
					nodeID: registry.broker.nodeID
				})
			}
		}
	},
	
	// Configuration du tracing
	tracing: {
		enabled: false,
		exporter: {
			type: "Console",
			options: {
				// Log avec couleurs
				colors: true,
				// Largeur des colonnes
				width: 100,
				// Format de timestamp
				gaugeWidth: 40
			}
		}
	},
	
	// Désactiver les statistiques internes par défaut
	statistics: false,
	
	// Paramètres de validation
	validation: true,
	
	// Configuration du validator
	validator: true,
	
	// Configuration de l'errorHandler
	errorHandler: null,
	
	// Configuration des middlewares
	middlewares: [],
	
	// Configuration des hook du cycle de vie
	created(broker) {
		// Appelé après la création du broker
	},
	
	started(broker) {
		// Appelé après le démarrage du broker
		broker.logger.info("Moleculer broker started successfully");
	},
	
	stopped(broker) {
		// Appelé après l'arrêt du broker
		broker.logger.info("Moleculer broker stopped");
	}
};