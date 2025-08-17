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
				this.logger.debug("Binance memory updated, executing position function");
				this.executePositionFunction(payload.memory);
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
						: this.settings.watchSymbols.filter(symbol => binanceData.tickers && binanceData.tickers[symbol]);
					
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
			const orderBook = binanceData.orderBooks?.[symbol];
			const trades = binanceData.trades?.[symbol];
			const stats24h = binanceData.stats24h?.[symbol];
			
			this.logger.info(`🔍 Analyse de ${symbol}:`);
			
			if (ticker) {
				this.logger.info(`  💰 Prix: ${ticker.last} (${ticker.percentage > 0 ? '+' : ''}${ticker.percentage?.toFixed(2)}%)`);
			}
			
			if (stats24h) {
				this.logger.info(`  📈 24h: High=${stats24h.high}, Low=${stats24h.low}, Volume=${stats24h.volume}`);
			}
			
			if (orderBook) {
				const bestBid = orderBook.bids?.[0]?.[0];
				const bestAsk = orderBook.asks?.[0]?.[0];
				if (bestBid && bestAsk) {
					this.logger.info(`  📋 OrderBook: Bid=${bestBid}, Ask=${bestAsk}, Spread=${(bestAsk - bestBid).toFixed(6)}`);
				}
			}
			
			if (trades && trades.length > 0) {
				const lastTrade = trades[trades.length - 1];
				this.logger.info(`  🔄 Dernier trade: ${lastTrade.amount} @ ${lastTrade.price} (${lastTrade.side})`);
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
					const currentDataHash = JSON.stringify(data.data);
					
					if (this.lastDataHash !== currentDataHash) {
						this.lastDataHash = currentDataHash;
						this.logger.debug("🔄 Nouvelles données Binance détectées");
						await this.executePositionFunction(data.data);
					}
				}
				
			} catch (err) {
				this.logger.debug("❌ Erreur lors de la récupération des données Binance:", err.message);
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

		this.logger.info("🎯 NFT Position service démarré mais attendons un peu");

        await new Promise(r => setTimeout(r, 3000));

		
		// Essayer de s'abonner à la mémoire du service Binance
		try {
			// Vérifier d'abord que le service Binance est disponible
			//const binanceAvailable = await this.checkServiceExists("binance");
            const binanceAvailable = true;
			
			if (!binanceAvailable) {
				this.logger.warn("⚠️  Service Binance non trouvé, mode vérification périodique activé");
			} else {
				// Essayer de s'abonner
				await this.subscribe({
					targetService: "binance",
					subscriberService: this.name
				});
				
				this.logger.info("✅ Abonné à la mémoire du service Binance");
				
				// Obtenir les données initiales si disponibles
				const initialData = await this.callWithMetrics("binance.getRealTimeData").catch(() => null);
				if (initialData && initialData.data) {
					this.logger.info("📥 Données initiales Binance reçues");
					await this.executePositionFunction(initialData.data);
				}
			}
			
		} catch (err) {
			this.logger.warn("⚠️  Impossible de s'abonner au service Binance:", err.message);
			this.logger.info("🔄 Basculement en mode vérification périodique");
		}
		
		// Démarrer la vérification périodique (fonctionne dans tous les cas)
		this.startFallbackCheck();
		
		this.logger.info("🚀 NFT Position service prêt", {
			watchSymbols: this.settings.watchSymbols,
			autoExecute: this.settings.positionConfig.autoExecute
		});
	},

	/**
	 * Arrêt du service
	 */
	async stopped() {
		// Arrêter la vérification périodique
		this.stopFallbackCheck();
		
		// Se désabonner du service Binance
		try {
			const binanceAvailable = await this.checkServiceExists("binance");
			
			if (binanceAvailable) {
				await this.unsubscribe({
					targetService: "binance",
					subscriberService: this.name
				});
				
				this.logger.info("✅ Désabonné du service Binance");
			}
		} catch (err) {
			this.logger.warn("⚠️  Erreur lors du désabonnement:", err.message);
		}
		
		this.logger.info("🛑 NFT Position service arrêté", {
			totalExecutions: this.executionCount,
			lastExecution: this.lastExecutionTime
		});
	}
};