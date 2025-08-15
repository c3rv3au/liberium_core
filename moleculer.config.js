// moleculer.config.js
"use strict";

const os = require("os");
const fs = require("fs");

// Détecter si on est dans Kubernetes
const isKubernetes = process.env.KUBERNETES_SERVICE_HOST || 
                    fs.existsSync('/var/run/secrets/kubernetes.io/serviceaccount/token');

// Fonction pour générer les URLs des peers dans un StatefulSet
function generateStatefulSetPeerUrls() {
	const podName = process.env.POD_NAME;
	const headlessService = process.env.HEADLESS_SERVICE || 'liberium-core-headless';
	const namespace = process.env.POD_NAMESPACE || 'brain-prod';
	const replicas = parseInt(process.env.REPLICAS || '3');
	const statefulSetName = process.env.STATEFULSET_NAME || 'liberium-core';
	
	const urls = [];
	
	if (podName) {
		// Générer les URLs de tous les autres pods du StatefulSet
		for (let i = 0; i < replicas; i++) {
			const peerPodName = `${statefulSetName}-${i}`;
			if (peerPodName !== podName) {
				urls.push(`${peerPodName}.${headlessService}.${namespace}.svc.cluster.local:4000`);
			}
		}
	}
	
	return urls;
}

// Fonction pour générer un NodeID stable basé sur le pod
function generateNodeId() {
	const podName = process.env.POD_NAME;
	const namespace = process.env.POD_NAMESPACE || 'brain-prod';
	
	if (podName) {
		// Utiliser le nom du pod comme base pour l'ID
		return `${podName}.${namespace}`;
	}
	
	// Fallback pour le développement local
	return `local-${os.hostname()}-${process.pid}`;
}

// Configuration de base
const baseConfig = {
	namespace: process.env.NAMESPACE || "liberium-core",
	nodeID: generateNodeId(),
	metadata: {
		hostname: os.hostname(),
		pid: process.pid,
		podIP: process.env.POD_IP,
		podName: process.env.POD_NAME
	},
	
	logger: {
		type: "Console",
		options: {
			colors: !isKubernetes,
			moduleColors: false,
			formatter: "full",
			objectPrinter: null,
			autoPadding: false
		}
	},
	
	logLevel: process.env.LOG_LEVEL || (process.env.NODE_ENV === "production" ? "info" : "debug"),
	
	serializer: "JSON",
	requestTimeout: 15 * 1000,
	
	retryPolicy: {
		enabled: true,
		retries: 5,
		delay: 100,
		maxDelay: 2000,
		factor: 2,
		check: err => err && !!err.retryable
	},
	
	maxCallLevel: 100,
	heartbeatInterval: 3,
	heartbeatTimeout: 10,
	
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
		enabled: true,
		threshold: 0.5,
		windowTime: 60000,
		minRequestCount: 5,
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
	
	cacher: false,
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
			hostname: os.hostname(),
			podIP: process.env.POD_IP,
			podName: process.env.POD_NAME
		});
	},
	
	started(broker) {
		broker.logger.info("Moleculer broker started successfully", {
			nodeID: broker.nodeID,
			namespace: broker.namespace,
			environment: isKubernetes ? "kubernetes" : "local",
			podName: process.env.POD_NAME
		});
		
		// Afficher les services et nœuds après initialisation
		setTimeout(() => {
			try {
				const nodes = broker.registry.getNodeList({ onlyAvailable: true });
				broker.logger.info("Available nodes:", {
					count: nodes.length,
					nodes: nodes.map(n => ({ id: n.id, available: n.available }))
				});
			} catch (err) {
				broker.logger.warn("Could not list nodes:", err.message);
			}
		}, 5000);
	},
	
	stopped(broker) {
		broker.logger.info("Moleculer broker stopped");
	}
};

// Configuration spécifique Kubernetes StatefulSet
const kubernetesConfig = {
	...baseConfig,
	
	// NodeID basé sur le nom du pod pour la consistance
	nodeID: process.env.POD_NAME || `node-${os.hostname()}-${process.pid}`,
	
	// Transporter TCP optimisé pour StatefulSet
	transporter: {
		type: "TCP",
		options: {
			// Écouter sur toutes les interfaces
			host: "0.0.0.0",
			port: 4000,
			
			// Découverte UDP activée
			udpDiscovery: true,
			udpPort: 4445,
			udpBindAddress: "0.0.0.0",
			udpPeriod: 5,
			udpReuseAddr: true,
			udpMaxDiscoveryHops: 3,
			
			// URLs des peers StatefulSet
			urls: generateStatefulSetPeerUrls(),
			
			// Options de connexion optimisées
			maxConnections: 32,
			maxPacketSize: 1024 * 1024,
			maxReconnectAttempts: 20,
			reconnectDelay: 1000,
			reconnectDelayMax: 10000,
			
			// Timeouts plus agressifs pour détecter les déconnexions
			connectionTimeout: 5000,
			packetLogLevel: "debug"
		}
	}
};

// Configuration locale (développement)
const localConfig = {
	...baseConfig,
	
	nodeID: `local-${os.hostname()}-${process.pid}`,
	
	// Transporter TCP local
	transporter: {
		type: "TCP",
		options: {
			port: 4000,
			udpDiscovery: true,
			udpPort: 4445,
			udpPeriod: 10,
			urls: []
		}
	}
};

// Log de la configuration utilisée
if (isKubernetes) {
	console.log("Using Kubernetes StatefulSet configuration");
	console.log("Pod Name:", process.env.POD_NAME);
	console.log("Pod IP:", process.env.POD_IP);
	console.log("Peer URLs:", generateStatefulSetPeerUrls());
} else {
	console.log("Using local development configuration");
}

// Exporter la configuration appropriée
module.exports = isKubernetes ? kubernetesConfig : localConfig;