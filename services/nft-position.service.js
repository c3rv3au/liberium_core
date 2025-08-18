// services/nft-position.service.js
"use strict";

const BaseService = require("./base.service");

module.exports = {
	name: "nft-position",

	mixins: [BaseService],

	dependencies: ["binance", "pancakeswap"],

	settings: {
		// Configuration des positions NFT
		positionConfig: {
			enabled: true,
			autoExecute: true,
			logLevel: "info"
		},
		
		// Symboles à surveiller
		watchSymbols: {
			binance: ["bnbusdt"],
			pancakeswap: ["WBNB-USDT"]
		},
		
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
					pancakeswapData: this.shared_memory.pancakeswap || null,
					isSubscribedToBinance: this.isSubscribedToBinance,
					isSubscribedToPancakeswap: this.isSubscribedToPancakeswap,
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
				const pancakeswapData = this.shared_memory.pancakeswap;
				
				if (!binanceData && !pancakeswapData && !force) {
					throw new Error("No market data available");
				}

				if (binanceData) {
					await this.executePositionFunction(binanceData, "binance");
				}
				
				if (pancakeswapData) {
					await this.executePositionFunction(pancakeswapData, "pancakeswap");
				}
				
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
					this.logger.error("❌ Erreur lors de l'abonnement manuel Binance:", err);
					throw err;
				}
			}
		},

		/**
		 * S'abonner manuellement au service PancakeSwap
		 */
		subscribeToPancakeswap: {
			async handler(ctx) {
				try {
					const result = await this.broker.call("nft-position.subscribe", {
						targetService: "pancakeswap",
						subscriberService: this.name
					});
					
					this.isSubscribedToPancakeswap = true;
					this.logger.info("✅ Abonné manuellement au service PancakeSwap");
					
					return result;
				} catch (err) {
					this.logger.error("❌ Erreur lors de l'abonnement manuel PancakeSwap:", err);
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
					this.logger.error("❌ Erreur lors du désabonnement manuel Binance:", err);
					throw err;
				}
			}
		},

		/**
		 * Se désabonner du service PancakeSwap
		 */
		unsubscribeFromPancakeswap: {
			async handler(ctx) {
				try {
					const result = await this.broker.call("nft-position.unsubscribe", {
						targetService: "pancakeswap",
						subscriberService: this.name
					});
					
					this.isSubscribedToPancakeswap = false;
					this.logger.info("✅ Désabonné manuellement du service PancakeSwap");
					
					return result;
				} catch (err) {
					this.logger.error("❌ Erreur lors du désabonnement manuel PancakeSwap:", err);
					throw err;
				}
			}
		},

		/**
		 * Configurer les symboles à surveiller
		 */
		setWatchSymbols: {
			params: {
				binance: { type: "array", items: "string", optional: true },
				pancakeswap: { type: "array", items: "string", optional: true }
			},
			handler(ctx) {
				const { binance, pancakeswap } = ctx.params;
				
				if (binance) {
					this.settings.watchSymbols.binance = binance;
				}
				
				if (pancakeswap) {
					this.settings.watchSymbols.pancakeswap = pancakeswap;
				}
				
				this.logger.info("Updated watch symbols", this.settings.watchSymbols);
				
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
					isSubscribedToBinance: this.isSubscribedToBinance,
					isSubscribedToPancakeswap: this.isSubscribedToPancakeswap,
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
				this.executePositionFunction(payload.memory, "binance");
			} else if (payload.service === "pancakeswap") {
				this.logger.debug("🥞 PancakeSwap memory updated, executing position function");
				this.executePositionFunction(payload.memory, "pancakeswap");
			}
		},

		/**
		 * Réagir quand des services se connectent
		 */
		"$services.changed"(payload) {
			if (payload.added) {
				// Vérifier si Binance vient de devenir disponible
				const binanceAdded = payload.added.some(service => service.name === "binance");
				if (binanceAdded && !this.isSubscribedToBinance) {
					this.logger.info("🎉 Service Binance détecté, tentative d'abonnement...");
					setTimeout(() => this.trySubscribeToBinance(), 1000);
				}

				// Vérifier si PancakeSwap vient de devenir disponible
				const pancakeswapAdded = payload.added.some(service => service.name === "pancakeswap");
				if (pancakeswapAdded && !this.isSubscribedToPancakeswap) {
					this.logger.info("🥞 Service PancakeSwap détecté, tentative d'abonnement...");
					setTimeout(() => this.trySubscribeToPancakeswap(), 1000);
				}
			}
		}
	},

	methods: {
		/**
		 * Fonction principale d'exécution de position
		 */
		async executePositionFunction(serviceData, sourceService = "unknown") {
			const startTime = Date.now();
			
			try {
				this.logger.info(`🚀 NFT Position: Modification détectée dans ${sourceService}`);
				
				if (sourceService === "binance" && serviceData) {
					await this.analyzeBinanceData(serviceData);
				} else if (sourceService === "pancakeswap" && serviceData) {
					await this.analyzePancakeswapData(serviceData);
				} else {
					this.logger.info("📝 Exécution générique sans données spécifiques");
				}
				
				// Analyse comparative si les deux services sont disponibles
				if (this.shared_memory.binance && this.shared_memory.pancakeswap) {
					await this.compareMarketData();
				}
				
				// Mettre à jour les métriques
				this.updateExecutionMetrics(startTime);
				
			} catch (err) {
				this.logger.error("❌ Erreur lors de l'exécution de la fonction de position:", err);
				throw err;
			}
		},

		/**
		 * Analyser les données Binance
		 */
		async analyzeBinanceData(binanceData) {
			const symbols = this.settings.watchSymbols.binance.filter(symbol => 
				binanceData.tickers && binanceData.tickers[symbol]
			);
			
			if (symbols.length > 0) {
				this.logger.info(`📊 Données Binance disponibles pour: ${symbols.join(", ")}`);
				
				for (const symbol of symbols) {
					await this.analyzeSymbolData(symbol, binanceData, "binance");
				}
			} else {
				this.logger.warn("⚠️  Aucune donnée Binance disponible pour les symboles surveillés");
			}
		},

		/**
		 * Analyser les données PancakeSwap
		 */
		async analyzePancakeswapData(pancakeswapData) {
			const symbols = this.settings.watchSymbols.pancakeswap;
			
			this.logger.info(`🥞 Données PancakeSwap mises à jour:`);
			
			if (pancakeswapData.prices) {
				Object.entries(pancakeswapData.prices).forEach(([pair, priceData]) => {
					this.logger.info(`  💰 ${pair}: ${priceData.price} (Block: ${priceData.blockNumber})`);
				});
			}
			
			if (pancakeswapData.quotes) {
				const quoteCount = Object.keys(pancakeswapData.quotes).length;
				this.logger.info(`  📈 ${quoteCount} quotes disponibles`);
				
				// Afficher quelques quotes importants
				Object.entries(pancakeswapData.quotes).forEach(([key, quote]) => {
					if (key.includes("1")) { // Quotes pour 1 token
						this.logger.info(`  🔄 ${quote.tokenIn}->${quote.tokenOut}: ${quote.amountOut} (${quote.pricePerToken} per token)`);
					}
				});
			}
			
			this.logger.info(`  ⏰ Dernière mise à jour: ${new Date(pancakeswapData.lastUpdate).toLocaleString()}`);
			this.logger.info(`  🔗 Block: ${pancakeswapData.blockNumber}, Statut: ${pancakeswapData.status}`);
		},

		/**
		 * Comparer les données des deux marchés
		 */
		async compareMarketData() {
			const binanceData = this.shared_memory.binance;
			const pancakeswapData = this.shared_memory.pancakeswap;
			
			// Comparer BNB/USDT (Binance) vs WBNB/USDT (PancakeSwap)
			const binanceTicker = binanceData.tickers?.["bnbusdt"];
			const pancakeswapPrice = pancakeswapData.prices?.["WBNB-USDT"];
			
			if (binanceTicker && pancakeswapPrice) {
				const binancePrice = parseFloat(binanceTicker.lastPrice);
				const pancakePrice = parseFloat(pancakeswapPrice.price);
				const difference = pancakePrice - binancePrice;
				const percentageDiff = (difference / binancePrice) * 100;
				
				this.logger.info("🔄 Comparaison des marchés BNB/WBNB:");
				this.logger.info(`  📊 Binance BNB/USDT: ${binancePrice}`);
				this.logger.info(`  🥞 PancakeSwap WBNB/USDT: ${pancakePrice}`);
				this.logger.info(`  📈 Différence: ${difference.toFixed(6)} (${percentageDiff.toFixed(4)}%)`);
				
				// Alertes sur les écarts importants
				if (Math.abs(percentageDiff) > 1) {
					this.logger.warn(`⚠️  ÉCART IMPORTANT DÉTECTÉ: ${percentageDiff.toFixed(4)}%`);
				}
			}
		},

		/**
		 * Analyser les données d'un symbole spécifique
		 */
		async analyzeSymbolData(symbol, serviceData, sourceService = "binance") {
			if (sourceService === "binance") {
				const ticker = serviceData.tickers?.[symbol];
				const prices = serviceData.prices?.[symbol];
				const trades = serviceData.trades?.[symbol];
				const depth = serviceData.depth?.[symbol];
				
				this.logger.info(`🔍 Analyse Binance de ${symbol.toUpperCase()}:`);
				
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
						await this.executePositionFunction(data.data, "binance");
					}
				}
				
			} catch (err) {
				this.logger.debug("❌ Erreur lors de la récupération des données Binance:", err.message);
			}
		},

		/**
		 * Récupérer les données PancakeSwap périodiquement
		 */
		async fetchPancakeswapData() {
			try {
				const data = await this.callWithMetrics("pancakeswap.getRealTimeData");
				
				if (data) {
					// Vérifier si les données ont changé
					const currentDataHash = this.calculateDataHash(data);
					
					if (this.lastPancakeswapHash !== currentDataHash) {
						this.lastPancakeswapHash = currentDataHash;
						this.logger.debug("🥞 Nouvelles données PancakeSwap détectées via polling");
						await this.executePositionFunction(data, "pancakeswap");
					}
				}
				
			} catch (err) {
				this.logger.debug("❌ Erreur lors de la récupération des données PancakeSwap:", err.message);
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
							hashStr += `${symbol}:${price.lastPrice || price.price}:${price.receivedAt || price.timestamp};`;
						}
					});
				}
				
				if (data.quotes) {
					Object.keys(data.quotes).forEach(key => {
						const quote = data.quotes[key];
						if (quote) {
							hashStr += `${key}:${quote.pricePerToken}:${quote.timestamp};`;
						}
					});
				}
				
				return hashStr;
			} catch (err) {
				return Date.now().toString(); // Fallback pour forcer l'exécution
			}
		},

		/**
		 * Vérifier périodiquement la disponibilité des données
		 */
		startFallbackCheck() {
			this.fallbackTimer = setInterval(async () => {
				await this.fetchBinanceData();
				await this.fetchPancakeswapData();
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
				const binanceAvailable = await this.checkServiceExists("binance");
				if (!binanceAvailable) {
					this.logger.debug("🔍 Service Binance pas encore disponible");
					return false;
				}

				await this.broker.call("nft-position.subscribe", {
					targetService: "binance",
					subscriberService: this.name
				});
				
				this.isSubscribedToBinance = true;
				this.logger.info("✅ Abonné à la mémoire du service Binance");
				
				// Obtenir les données initiales
				try {
					const initialData = await this.callWithMetrics("binance.getRealTimeData");
					if (initialData && initialData.data) {
						this.logger.info("📥 Données initiales Binance reçues");
						await this.executePositionFunction(initialData.data, "binance");
					}
				} catch (err) {
					this.logger.warn("⚠️  Impossible d'obtenir les données initiales Binance:", err.message);
				}
				
				return true;
			} catch (err) {
				this.logger.debug("🔄 Tentative d'abonnement Binance échouée:", err.message);
				this.isSubscribedToBinance = false;
				return false;
			}
		},

		/**
		 * Essayer de s'abonner au service PancakeSwap
		 */
		async trySubscribeToPancakeswap() {
			try {
				const pancakeswapAvailable = await this.checkServiceExists("pancakeswap");
				if (!pancakeswapAvailable) {
					this.logger.debug("🔍 Service PancakeSwap pas encore disponible");
					return false;
				}

				await this.broker.call("nft-position.subscribe", {
					targetService: "pancakeswap",
					subscriberService: this.name
				});
				
				this.isSubscribedToPancakeswap = true;
				this.logger.info("✅ Abonné à la mémoire du service PancakeSwap");
				
				// Obtenir les données initiales
				try {
					const initialData = await this.callWithMetrics("pancakeswap.getRealTimeData");
					if (initialData) {
						this.logger.info("📥 Données initiales PancakeSwap reçues");
						await this.executePositionFunction(initialData, "pancakeswap");
					}
				} catch (err) {
					this.logger.warn("⚠️  Impossible d'obtenir les données initiales PancakeSwap:", err.message);
				}
				
				return true;
			} catch (err) {
				this.logger.debug("🔄 Tentative d'abonnement PancakeSwap échouée:", err.message);
				this.isSubscribedToPancakeswap = false;
				return false;
			}
		},

		/**
		 * Démarrer les tentatives d'abonnement en arrière-plan
		 */
		startSubscriptionRetry() {
			let binanceAttempts = 0;
			let pancakeswapAttempts = 0;
			const maxAttempts = 20;
			const retryInterval = 15000;
			
			this.subscriptionRetryTimer = setInterval(async () => {
				let allSubscribed = true;
				
				// Tentative d'abonnement Binance
				if (!this.isSubscribedToBinance && binanceAttempts < maxAttempts) {
					binanceAttempts++;
					this.logger.debug(`🔄 Tentative d'abonnement Binance ${binanceAttempts}/${maxAttempts}...`);
					
					const binanceSuccess = await this.trySubscribeToBinance();
					if (binanceSuccess) {
						this.logger.info("🎉 Abonnement Binance réussi après", binanceAttempts, "tentatives");
					} else {
						allSubscribed = false;
					}
				}
				
				// Tentative d'abonnement PancakeSwap
				if (!this.isSubscribedToPancakeswap && pancakeswapAttempts < maxAttempts) {
					pancakeswapAttempts++;
					this.logger.debug(`🔄 Tentative d'abonnement PancakeSwap ${pancakeswapAttempts}/${maxAttempts}...`);
					
					const pancakeswapSuccess = await this.trySubscribeToPancakeswap();
					if (pancakeswapSuccess) {
						this.logger.info("🎉 Abonnement PancakeSwap réussi après", pancakeswapAttempts, "tentatives");
					} else {
						allSubscribed = false;
					}
				}
				
				// Arrêter si tous les services sont connectés ou si max tentatives atteint
				if ((this.isSubscribedToBinance && this.isSubscribedToPancakeswap) || 
					(binanceAttempts >= maxAttempts && pancakeswapAttempts >= maxAttempts)) {
					clearInterval(this.subscriptionRetryTimer);
					
					if (allSubscribed) {
						this.logger.info("🎯 Tous les abonnements sont actifs");
					} else {
						this.logger.warn(`⏰ Arrêt des tentatives après ${maxAttempts} essais`);
						this.logger.info("📊 Le service continue en mode polling uniquement");
					}
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
		this.lastPancakeswapHash = null;
		this.isSubscribedToBinance = false;
		this.isSubscribedToPancakeswap = false;

		this.logger.info("🎯 NFT Position service démarré, attente de l'initialisation complète du broker...");

		// Démarrer la vérification périodique immédiatement (ne dépend pas de l'abonnement)
		this.startFallbackCheck();
		
		// Démarrer la tentative d'abonnement en arrière-plan
		this.startSubscriptionRetry();
		
		this.logger.info("🚀 NFT Position service prêt en mode hybride", {
			watchSymbols: this.settings.watchSymbols,
			autoExecute: this.settings.positionConfig.autoExecute,
			fallbackPolling: true,
			subscriptionRetryActive: true,
			supportedServices: ["binance", "pancakeswap"]
		});
	},

	/**
	 * Arrêt du service
	 */
	async stopped() {
		// Arrêter la vérification périodique
		this.stopFallbackCheck();
		
		// Se désabonner des services si abonnés
		if (this.isSubscribedToBinance) {
			try {
				await this.broker.call("nft-position.unsubscribe", {
					targetService: "binance",
					subscriberService: this.name
				});
				this.logger.info("✅ Désabonné du service Binance");
			} catch (err) {
				this.logger.warn("⚠️  Erreur lors du désabonnement Binance:", err.message);
			}
		}
		
		if (this.isSubscribedToPancakeswap) {
			try {
				await this.broker.call("nft-position.unsubscribe", {
					targetService: "pancakeswap",
					subscriberService: this.name
				});
				this.logger.info("✅ Désabonné du service PancakeSwap");
			} catch (err) {
				this.logger.warn("⚠️  Erreur lors du désabonnement PancakeSwap:", err.message);
			}
		}
		
		this.logger.info("🛑 NFT Position service arrêté", {
			totalExecutions: this.executionCount,
			lastExecution: this.lastExecutionTime
		});
	}
};