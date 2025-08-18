// services/nft-position.service.js
"use strict";

const BaseService = require("./base.service");

module.exports = {
	name: "nft-position",

	mixins: [BaseService],

	dependencies: ["binance"],

	settings: {
		// Configuration des positions NFT
		positionConfig: {
			enabled: true,
			autoExecute: true,
			logLevel: "info"
		},
		
		// Symboles à surveiller (par défaut ceux de Binance)
		watchSymbols: ["bnbusdt"],
		
		// Intervalle de vérification si pas de mémoire partagée
		fallbackCheckInterval: 10000
	},

	actions: {
		/**
		 * Obtenir l'état actuel du service
		 */
		getStatus: {
			handler(ctx) {
				return {
					status: "active",
					subscriptions: this.getActiveSubscriptions(),
					lastExecution: this.lastExecutionTime,
					executionCount: this.executionCount,
					binanceData: this.shared_memory.binance || null,
					isSubscribed: this.isSubscribedToBinance,
					timestamp: Date.now()
				};
			}
		},

		/**
		 * Forcer l'exécution de la fonction de position
		 */
		executePosition: {
			params: {
				symbol: { type: "string", optional: true },
				force: { type: "boolean", optional: true, default: false }
			},
			async handler(ctx) {
				const { symbol, force } = ctx.params;
				
				const binanceData = this.shared_memory.binance;
				if (!binanceData && !force) {
					throw new Error("No Binance data available");
				}

				await this.executePositionFunction(binanceData, symbol);
				
				return {
					executed: true,
					symbol: symbol || "all",
					timestamp: Date.now(),
					executionCount: this.executionCount
				};
			}
		},

		/**
		 * S'abonner manuellement au service Binance
		 */
		subscribeToBinance: {
			async handler(ctx) {
				try {
					const result = await this.broker.call("nft-position.subscribe", {
						targetService: "binance",
						subscriberService: this.name
					});
					
					this.isSubscribedToBinance = true;
					this.logger.info("✅ Abonné manuellement au service Binance");
					
					return result;
				} catch (err) {
					this.logger.error("❌ Erreur lors de l'abonnement manuel:", err);
					throw err;
				}
			}
		},

		/**
		 * Se désabonner du service Binance
		 */
		unsubscribeFromBinance: {
			async handler(ctx) {
				try {
					const result = await this.broker.call("nft-position.unsubscribe", {
						targetService: "binance",
						subscriberService: this.name
					});
					
					this.isSubscribedToBinance = false;
					this.logger.info("✅ Désabonné manuellement du service Binance");
					
					return result;
				} catch (err) {
					this.logger.error("❌ Erreur lors du désabonnement manuel:", err);
					throw err;
				}
			}
		},

		/**
		 * Configurer les symboles à surveiller
		 */
		setWatchSymbols: {
			params: {
				symbols: { type: "array", items: "string" }
			},
			handler(ctx) {
				const { symbols } = ctx.params;
				
				this.settings.watchSymbols = symbols;
				this.logger.info(`Updated watch symbols: ${symbols.join(", ")}`);
				
				return {
					updated: true,
					watchSymbols: this.settings.watchSymbols,
					timestamp: Date.now()
				};
			}
		},

		/**
		 * Obtenir les métriques d'exécution
		 */
		getExecutionMetrics: {
			handler(ctx) {
				return {
					totalExecutions: this.executionCount,
					lastExecution: this.lastExecutionTime,
					averageExecutionTime: this.executionTimes.length > 0 
						? this.executionTimes.reduce((a, b) => a + b, 0) / this.executionTimes.length 
						: 0,
					executionHistory: this.executionTimes.slice(-10), // Dernières 10 exécutions
					subscriptionStatus: this.getActiveSubscriptions(),
					isSubscribed: this.isSubscribedToBinance,
					timestamp: Date.now()
				};
			}
		}
	},

	events: {
		/**
		 * Réagir aux mises à jour de mémoire de Binance
		 */
		"memory.updated"(payload) {
			if (payload.service === "binance") {
				this.logger.debug("🔄 Binance memory updated, executing position function");
				this.executePositionFunction(payload.memory);
			}
		},

		/**
		 * Réagir quand des services se connectent
		 */
		"$services.changed"(payload) {
			// Vérifier si le service Binance vient de devenir disponible
			if (!this.isSubscribedToBinance && payload.added) {
				const binanceAdded = payload.added.some(service => service.name === "binance");
				if (binanceAdded) {
					this.logger.info("🎉 Service Binance détecté, tentative d'abonnement...");
					// Essayer de s'abonner après un petit délai
					setTimeout(() => {
						this.trySubscribeToBinance();
					}, 1000);
				}
			}
		}
	},

	methods: {
		/**
		 * Fonction principale d'exécution de position
		 */
		async executePositionFunction(binanceData, specificSymbol = null) {
			const startTime = Date.now();
			
			try {
				// Pour le moment, juste logger qu'une modification a eu lieu
				this.logger.info("🚀 NFT Position: Modification détectée dans les données Binance");
				
				if (binanceData) {
					const symbols = specificSymbol 
						? [specificSymbol] 
						: this.settings.watchSymbols.filter(symbol => 
							binanceData.tickers && binanceData.tickers[symbol]
						);
					
					if (symbols.length > 0) {
						this.logger.info(`📊 Données disponibles pour: ${symbols.join(", ")}`);
						
						// Analyser chaque symbole
						for (const symbol of symbols) {
							await this.analyzeSymbolData(symbol, binanceData);
						}
					} else {
						this.logger.warn("⚠️  Aucune donnée disponible pour les symboles surveillés");
					}
				} else {
					this.logger.info("📝 Exécution forcée sans données Binance");
				}
				
				// Mettre à jour les métriques
				this.updateExecutionMetrics(startTime);
				
			} catch (err) {
				this.logger.error("❌ Erreur lors de l'exécution de la fonction de position:", err);
				throw err;
			}
		},

		/**
		 * Analyser les données d'un symbole spécifique
		 */
		async analyzeSymbolData(symbol, binanceData) {
			const ticker = binanceData.tickers?.[symbol];
			const prices = binanceData.prices?.[symbol];
			const trades = binanceData.trades?.[symbol];
			const depth = binanceData.depth?.[symbol];
			
			this.logger.info(`🔍 Analyse de ${symbol.toUpperCase()}:`);
			
			if (ticker) {
				this.logger.info(`  💰 Prix: ${ticker.lastPrice} (${ticker.priceChangePercent > 0 ? '+' : ''}${ticker.priceChangePercent?.toFixed(2)}%)`);
				this.logger.info(`  📈 24h: High=${ticker.highPrice}, Low=${ticker.lowPrice}, Volume=${ticker.volume}`);
			}
			
			if (prices) {
				this.logger.info(`  ⚡ Prix temps réel: ${prices.lastPrice}`);
			}
			
			if (depth && depth.bids && depth.asks) {
				const bestBid = depth.bids[0]?.price;
				const bestAsk = depth.asks[0]?.price;
				if (bestBid && bestAsk) {
					const spread = (bestAsk - bestBid).toFixed(6);
					this.logger.info(`  📋 OrderBook: Bid=${bestBid}, Ask=${bestAsk}, Spread=${spread}`);
				}
			}
			
			if (trades && trades.length > 0) {
				const lastTrade = trades[trades.length - 1];
				this.logger.info(`  🔄 Dernier trade: ${lastTrade.quantity} @ ${lastTrade.price} (${lastTrade.isBuyerMaker ? 'SELL' : 'BUY'})`);
			}
		},

		/**
		 * Mettre à jour les métriques d'exécution
		 */
		updateExecutionMetrics(startTime) {
			const executionTime = Date.now() - startTime;
			
			this.executionCount++;
			this.lastExecutionTime = Date.now();
			this.executionTimes.push(executionTime);
			
			// Garder seulement les 100 derniers temps d'exécution
			if (this.executionTimes.length > 100) {
				this.executionTimes = this.executionTimes.slice(-100);
			}
			
			this.logger.debug(`⏱️  Exécution #${this.executionCount} terminée en ${executionTime}ms`);
		},

		/**
		 * Obtenir les abonnements actifs
		 */
		getActiveSubscriptions() {
			const subscriptions = [];
			
			for (const [subscriber, targets] of this.subscriptions.entries()) {
				for (const [target] of targets.entries()) {
					subscriptions.push({
						subscriber,
						target,
						timestamp: targets.get(target).timestamp
					});
				}
			}
			
			return subscriptions;
		},

		/**
		 * Récupérer les données Binance périodiquement
		 */
		async fetchBinanceData() {
			try {
				const data = await this.callWithMetrics("binance.getRealTimeData");
				
				if (data && data.data) {
					// Vérifier si les données ont changé
					const currentDataHash = this.calculateDataHash(data.data);
					
					if (this.lastDataHash !== currentDataHash) {
						this.lastDataHash = currentDataHash;
						this.logger.debug("🔄 Nouvelles données Binance détectées via polling");
						await this.executePositionFunction(data.data);
					}
				}
				
			} catch (err) {
				this.logger.debug("❌ Erreur lors de la récupération des données Binance:", err.message);
			}
		},

		/**
		 * Calculer un hash simple des données pour détecter les changements
		 */
		calculateDataHash(data) {
			try {
				// Hash basé sur les prix et timestamps principaux
				let hashStr = "";
				
				if (data.tickers) {
					Object.keys(data.tickers).forEach(symbol => {
						const ticker = data.tickers[symbol];
						if (ticker) {
							hashStr += `${symbol}:${ticker.lastPrice}:${ticker.closeTime};`;
						}
					});
				}
				
				if (data.prices) {
					Object.keys(data.prices).forEach(symbol => {
						const price = data.prices[symbol];
						if (price) {
							hashStr += `${symbol}:${price.lastPrice}:${price.receivedAt};`;
						}
					});
				}
				
				return hashStr;
			} catch (err) {
				return Date.now().toString(); // Fallback pour forcer l'exécution
			}
		},

		/**
		 * Vérifier périodiquement la disponibilité des données Binance
		 */
		startFallbackCheck() {
			this.fallbackTimer = setInterval(async () => {
				await this.fetchBinanceData();
			}, this.settings.fallbackCheckInterval);
			
			this.logger.info("🔄 Mode surveillance périodique activé");
		},

		/**
		 * Arrêter la vérification périodique
		 */
		stopFallbackCheck() {
			if (this.fallbackTimer) {
				clearInterval(this.fallbackTimer);
				this.fallbackTimer = null;
			}
		},

		/**
		 * Essayer de s'abonner au service Binance
		 */
		async trySubscribeToBinance() {
			try {
				// Vérifier d'abord que le service Binance est disponible
				const binanceAvailable = await this.checkServiceExists("binance");
				
				if (!binanceAvailable) {
					this.logger.debug("🔍 Service Binance pas encore disponible");
					return false;
				}

				// Essayer de s'abonner via l'action
				await this.broker.call("nft-position.subscribe", {
					targetService: "binance",
					subscriberService: this.name
				});
				
				this.isSubscribedToBinance = true;
				this.logger.info("✅ Abonné à la mémoire du service Binance");
				
				// Obtenir les données initiales si disponibles
				try {
					const initialData = await this.callWithMetrics("binance.getRealTimeData");
					if (initialData && initialData.data) {
						this.logger.info("📥 Données initiales Binance reçues");
						await this.executePositionFunction(initialData.data);
					}
				} catch (err) {
					this.logger.warn("⚠️  Impossible d'obtenir les données initiales:", err.message);
				}
				
				return true;
				
			} catch (err) {
				this.logger.debug("🔄 Tentative d'abonnement échouée:", err.message);
				this.isSubscribedToBinance = false;
				return false;
			}
		},

		/**
		 * Démarrer les tentatives d'abonnement en arrière-plan
		 */
		startSubscriptionRetry() {
			let attempts = 0;
			const maxAttempts = 20; // Essayer pendant ~5 minutes
			const retryInterval = 15000; // Toutes les 15 secondes
			
			this.subscriptionRetryTimer = setInterval(async () => {
				if (this.isSubscribedToBinance) {
					// Déjà abonné, arrêter les tentatives
					clearInterval(this.subscriptionRetryTimer);
					this.logger.info("🎯 Arrêt des tentatives d'abonnement : déjà connecté");
					return;
				}
				
				attempts++;
				this.logger.debug(`🔄 Tentative d'abonnement ${attempts}/${maxAttempts}...`);
				
				const success = await this.trySubscribeToBinance();
				
				if (success) {
					clearInterval(this.subscriptionRetryTimer);
					this.logger.info("🎉 Abonnement réussi après", attempts, "tentatives");
				} else if (attempts >= maxAttempts) {
					clearInterval(this.subscriptionRetryTimer);
					this.logger.warn(`⏰ Arrêt des tentatives d'abonnement après ${maxAttempts} essais`);
					this.logger.info("📊 Le service continue en mode polling uniquement");
				}
			}, retryInterval);
			
			this.logger.info(`🔄 Tentatives d'abonnement démarrées (${maxAttempts} max, toutes les ${retryInterval/1000}s)`);
		},

		/**
		 * Arrêter les tentatives d'abonnement
		 */
		stopSubscriptionRetry() {
			if (this.subscriptionRetryTimer) {
				clearInterval(this.subscriptionRetryTimer);
				this.subscriptionRetryTimer = null;
			}
		}
	},

	/**
	 * Démarrage du service
	 */
	async started() {
		// Initialiser les métriques
		this.executionCount = 0;
		this.lastExecutionTime = null;
		this.executionTimes = [];
		this.lastDataHash = null;
		this.isSubscribedToBinance = false;

		this.logger.info("🎯 NFT Position service démarré, attente de l'initialisation complète du broker...");

		// Démarrer la vérification périodique immédiatement (ne dépend pas de l'abonnement)
		this.startFallbackCheck();
		
		// Démarrer la tentative d'abonnement en arrière-plan
		this.startSubscriptionRetry();
		
		this.logger.info("🚀 NFT Position service prêt en mode hybride", {
			watchSymbols: this.settings.watchSymbols,
			autoExecute: this.settings.positionConfig.autoExecute,
			fallbackPolling: true,
			subscriptionRetryActive: true
		});
	},

	/**
	 * Arrêt du service
	 */
	async stopped() {
		// Arrêter la vérification périodique
		this.stopFallbackCheck();
		
		// Se désabonner du service Binance si abonné
		if (this.isSubscribedToBinance) {
			try {
				await this.broker.call("nft-position.unsubscribe", {
					targetService: "binance",
					subscriberService: this.name
				});
				
				this.logger.info("✅ Désabonné du service Binance");
			} catch (err) {
				this.logger.warn("⚠️  Erreur lors du désabonnement:", err.message);
			}
		}
		
		this.logger.info("🛑 NFT Position service arrêté", {
			totalExecutions: this.executionCount,
			lastExecution: this.lastExecutionTime
		});
	}
};