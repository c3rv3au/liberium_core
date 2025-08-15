// moleculer.config.js
"use strict";

const os = require("os");
const fs = require("fs");

// Détecter si on est dans Kubernetes
const isKubernetes = process.env.KUBERNETES_SERVICE_HOST || 
                    fs.existsSync('/var/run/secrets/kubernetes.io/serviceaccount/token');

// Fonction pour générer les URLs des peers dans un StatefulSet avec nodeID
function generateStatefulSetPeerUrls() {
	const podName = process.env.POD_NAME;
	const headlessService = process.env.HEADLESS_SERVICE || 'liberium-core-headless';
	const namespace = process.env.POD_NAMESPACE || 'brain-prod';
	const replicas = parseInt(process.env.REPLICAS || '3');
	const statefulSetName = process.env.STATEFULSET_NAME || 'liberium-core';
	
	const urls = [];
	
	if (podName) {
		// Générer les URLs de tous les autres pods du StatefulSet avec nodeID
		for (let i = 0; i < replicas; i++) {
			const peerPodName = `${statefulSetName}-${i}`;
			if (peerPodName !== podName) {
				// Format correct selon la documentation: host:port/nodeID
				const nodeId = `${peerPodName}.${namespace}`;
				const host = `${peerPodName}.${headlessService}.${namespace}.svc.cluster.local`;
				urls.push(`${host}:4000/${nodeId}`);
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
		// Utiliser le nom du pod avec le namespace comme ID stable
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
		podName: process.env.POD_NAME,
		namespace: process.env.POD_NAMESPACE
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
		retries: 3,
		delay: 100,
		maxDelay: 2000,
		factor: 2,
		check: err => err && !!err.retryable
	},
	
	maxCallLevel: 100,
	heartbeatInterval: 5,
	heartbeatTimeout: 15,
	
	contextParamsCloning: false,
	maxEventListeners: 100,
	
	bulkhead: {
		enabled: false,
		concurrency: 10,
		maxQueueSize: 50,
	},
	
	registry: {
		strategy: "RoundRobin",
		preferLocal: true,
		discoverer: {
			type: "Local"
		}
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
				broker.logger.info("Connected nodes:", {
					count: nodes.length,
					nodes: nodes.map(n => ({ 
						id: n.id, 
						available: n.available,
						local: n.local,
						hostname: n.hostname 
					}))
				});
				
				const services = broker.registry.getServiceList({ onlyAvailable: true });
				broker.logger.info("Available services:", {
					count: services.length,
					services: services.map(s => s.name).filter(n => n !== '$node')
				});
			} catch (err) {
				broker.logger.warn("Could not list nodes/services:", err.message);
			}
		}, 10000);
	},
	
	stopped(broker) {
		broker.logger.info("Moleculer broker stopped");
	}
};

// Configuration spécifique Kubernetes StatefulSet
const kubernetesConfig = {
	...baseConfig,
	
	// Transporter TCP optimisé pour StatefulSet
	transporter: {
		type: "TCP",
		options: {
			// Écouter sur toutes les interfaces
			host: "0.0.0.0",
			port: 4000,
			
			// Découverte UDP activée avec paramètres optimisés
			udpDiscovery: true,
			udpPort: 4445,
			udpBindAddress: "0.0.0.0",
			udpPeriod: 10,
			udpReuseAddr: true,
			udpMaxDiscoveryHops: 2,
			
			// URLs des peers StatefulSet avec nodeID
			urls: generateStatefulSetPeerUrls(),
			
			// Options de connexion optimisées pour Kubernetes
			maxConnections: 32,
			maxPacketSize: 1024 * 1024,
			maxReconnectAttempts: 10,
			reconnectDelay: 2000,
			reconnectDelayMax: 30000,
			
			// Timeouts adaptés au réseau Kubernetes
			connectionTimeout: 10000,
			packetLogLevel: process.env.NODE_ENV === "production" ? "warn" : "debug",
			
			// Options TCP spécifiques
			tcpNoDelay: true,
			tcpKeepAlive: true
		}
	}
};

const local_urls = []

if (process.env.DISCOVERY_URL)
	local_urls.push(process.env.DISCOVERY_URL);

// Configuration locale (développement)
const localConfig = {
	...baseConfig,
	
	nodeID: `local-${os.hostname()}-${process.pid}`,
	
	// Transporter TCP local simplifié
	transporter: {
		type: "TCP",
		options: {
			port: 4000,
			udpDiscovery: true,
			udpPort: 4445,
			udpPeriod: 30,
			urls: local_urls,
			maxReconnectAttempts: 5,
			reconnectDelay: 1000
		}
	}
};

// Log de la configuration utilisée
if (isKubernetes) {
	const peerUrls = generateStatefulSetPeerUrls();
	console.log("Using Kubernetes StatefulSet configuration");
	console.log("Node ID:", generateNodeId());
	console.log("Pod Name:", process.env.POD_NAME);
	console.log("Pod IP:", process.env.POD_IP);
	console.log("Namespace:", process.env.POD_NAMESPACE);
	console.log("Peer URLs:", peerUrls);
	console.log("Total peers configured:", peerUrls.length);
} else {
	console.log("Using local development configuration");
	console.log("Node ID:", `local-${os.hostname()}-${process.pid}`);
}

// Exporter la configuration appropriée
module.exports = isKubernetes ? kubernetesConfig : localConfig;