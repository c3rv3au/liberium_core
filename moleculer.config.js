// moleculer.config.js
"use strict";

const os = require("os");
const fs = require("fs");

// Détecter si on est dans Kubernetes
const isKubernetes = process.env.KUBERNETES_SERVICE_HOST || 
                    fs.existsSync('/var/run/secrets/kubernetes.io/serviceaccount/token');

// Configuration de base
const baseConfig = {
	namespace: process.env.NAMESPACE || "liberium-core",
	nodeID: null,
	metadata: {},
	
	logger: {
		type: "Console",
		options: {
			colors: !isKubernetes, // Pas de couleurs en prod K8s
			moduleColors: false,
			formatter: "full",
			objectPrinter: null,
			autoPadding: false
		}
	},
	
	logLevel: process.env.LOG_LEVEL || (process.env.NODE_ENV === "production" ? "info" : "debug"),
	
	serializer: "JSON",
	requestTimeout: 10 * 1000,
	
	retryPolicy: {
		enabled: true,
		retries: 3,
		delay: 100,
		maxDelay: 1000,
		factor: 2,
		check: err => err && !!err.retryable
	},
	
	maxCallLevel: 100,
	heartbeatInterval: 10,
	heartbeatTimeout: 30,
	
	contextParamsCloning: false,
	maxEventListeners: 100,
	
	bulkhead: {
		enabled: false,
		concurrency: 10,
		maxQueueSize: 50,
	},
	
	registry: {
		strategy: "RoundRobin",
		preferLocal: true
	},
	
	circuitBreaker: {
		enabled: false,
		threshold: 0.5,
		windowTime: 60000,
		minRequestCount: 20,
		halfOpenTime: 10000
	},
	
	balancer: {
		preferLocal: true
	},
	
	metrics: {
		enabled: false
	},
	
	tracing: {
		enabled: false
	},
	
	statistics: false,
	validation: true,
	validator: true,
	errorHandler: null,
	middlewares: [],
	
	created(broker) {
		broker.logger.info("Broker created", {
			nodeID: broker.nodeID,
			namespace: broker.namespace,
			environment: isKubernetes ? "kubernetes" : "local",
			hostname: os.hostname()
		});
	},
	
	started(broker) {
		broker.logger.info("Moleculer broker started successfully", {
			nodeID: broker.nodeID,
			namespace: broker.namespace,
			environment: isKubernetes ? "kubernetes" : "local"
		});
	},
	
	stopped(broker) {
		broker.logger.info("Moleculer broker stopped");
	}
};

// Configuration spécifique Kubernetes
const kubernetesConfig = {
	...baseConfig,
	
	// NodeID unique en K8s
	nodeID: process.env.HOSTNAME || `node-${os.hostname()}-${process.pid}`,
	
	// Transporter optimisé pour K8s
	transporter: {
		type: "TCP",
		options: {
			udpDiscovery: true,
			udpPort: 4445,
			udpBindAddress: "0.0.0.0",
			udpPeriod: 30,
			udpReuseAddr: true,
			port: 4000,
			urls: process.env.MOLECULER_URLS ? 
				process.env.MOLECULER_URLS.split(",") : [],
			maxConnections: 32,
			maxPacketSize: 1024 * 1024
		}
	},
	
	cacher: {
		type: "Memory",
		options: {
			max: 100,
			ttl: 30,
			clone: true
		}
	},
	
	// Circuit breaker activé en K8s
	circuitBreaker: {
		enabled: true,
		threshold: 0.5,
		windowTime: 60000,
		minRequestCount: 20,
		halfOpenTime: 10000
	}
};

// Configuration locale (développement)
const localConfig = {
	...baseConfig,
	
	// Transporter TCP local
	transporter: {
		type: "TCP",
		options: {
			udpDiscovery: true,
			udpPort: 4445,
			udpBindAddress: null,
			udpPeriod: 30,
			port: 4000,
			urls: []
		}
	},
	
	cacher: {
		type: "Memory",
		options: {
			max: 100,
			ttl: 30
		}
	}
};

// Exporter la configuration appropriée
module.exports = isKubernetes ? kubernetesConfig : localConfig;