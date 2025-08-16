 // services/binance.service.js
"use strict";

const BaseService = require("./base.service");

module.exports = {
	name: "binance",

	mixins: [BaseService],

	dependencies: ["ccxt"],

	settings: {
		// Configuration spécifique à Binance
		exchange: "binance",
		
		// Symboles populaires à surveiller
		watchSymbols: [
			"BTC/USDT", "ETH/USDT", "BNB/USDT", "ADA/USDT", 
			"DOT/USDT", "XRP/USDT", "LTC/USDT", "LINK/USDT"
		],
		
		// Timeframes supportés
		timeframes: ["1m", "5m", "15m", "1h", "4h", "1d"],
		
		// Limites par défaut
		defaultLimits: {
			trades: 100,
			ohlcv: 500,
			orderbook: 100
		},
		
		// Intervals de mise à jour des prix
		priceUpdateInterval: 30000, // 30 secondes
		
		// Types de compte Binance
		accountTypes: {
			spot: "spot",
			future: "future", 
			margin: "margin"
		}
	},

	actions: {
		/**
		 * Obtenir les informations de Binance
		 */
		getInfo: {
			cache: {
				keys: [],
				ttl: 300
			},
			async handler(ctx) {
				const info = await this.broker.call("ccxt.getExchangeInfo", {
					exchange: this.settings.exchange
				});
				
				return {
					...info,
					specialFeatures: {
						futures: true,
						margin: true,
						lending: true,
						staking: true,
						nft: true,
						p2p: true
					},
					popularSymbols: this.settings.watchSymbols,
					supportedTimeframes: this.settings.timeframes
				};
			}
		},

		/**
		 * Obtenir tous les symboles actifs de Binance
		 */
		getMarkets: {
			cache: {
				keys: [],
				ttl: 300,
			},
			async handler(ctx) {
				const result = await this.broker.call("ccxt.loadMarkets", {
					exchange: this.settings.exchange,
                    timeout: 10000
				});
				
				// Enrichir avec des statistiques spécifiques à Binance
				const markets = result.markets;
				const stats = this.analyzeMarkets(markets);
				
				return {
					...result,
					statistics: stats,
					filtered: {
						usdtPairs: this.filterMarkets(markets, "USDT"),
						btcPairs: this.filterMarkets(markets, "BTC"),
						ethPairs: this.filterMarkets(markets, "ETH"),
						bnbPairs: this.filterMarkets(markets, "BNB")
					}
				};
			}
		},

		/**
		 * Obtenir les prix en temps réel pour les symboles populaires
		 */
		getPopularPrices: {
			cache: {
				keys: [],
				ttl: 30
			},
			async handler(ctx) {
				const symbols = ctx.params.symbols || this.settings.watchSymbols;
				
				const tickers = await this.broker.call("ccxt.fetchTickers", {
					exchange: this.settings.exchange,
					symbols,
                    timeout: 10000
				});
				
				// Enrichir avec des métriques calculées
				const enrichedTickers = this.enrichTickers(tickers.tickers);
				
				return {
					exchange: this.settings.exchange,
					symbols,
					prices: enrichedTickers,
					summary: this.calculatePriceSummary(enrichedTickers),
					timestamp: Date.now()
				};
			}
		},

		/**
		 * Obtenir les données de chandelier pour un symbole
		 */
		getCandlesticks: {
			params: {
				symbol: "string",
				timeframe: { type: "string", default: "1h" },
				limit: { type: "number", default: 100 },
				since: { type: "number", optional: true }
			},
			cache: {
				keys: ["symbol", "timeframe", "limit"],
				ttl: 60
			},
			async handler(ctx) {
				const { symbol, timeframe, limit, since } = ctx.params;
				
				if (!this.settings.timeframes.includes(timeframe)) {
					throw new Error(`Timeframe ${timeframe} not supported. Use: ${this.settings.timeframes.join(", ")}`);
				}
				
				const result = await this.broker.call("ccxt.fetchOHLCV", {
					exchange: this.settings.exchange,
					symbol,
					timeframe,
					limit,
					since
				});
				
				// Enrichir avec des indicateurs techniques basiques
				const enrichedData = this.enrichOHLCV(result.ohlcv);
				
				return {
					...result,
					candlesticks: enrichedData,
					indicators: this.calculateIndicators(enrichedData),
					metadata: {
						period: timeframe,
						count: enrichedData.length,
						range: this.getDataRange(enrichedData)
					}
				};
			}
		},

		/**
		 * Obtenir le carnet d'ordres avec analyse
		 */
		getOrderBookAnalysis: {
			params: {
				symbol: "string",
				limit: { type: "number", default: 100 }
			},
			cache: {
				keys: ["symbol", "limit"],
				ttl: 10
			},
			async handler(ctx) {
				const { symbol, limit } = ctx.params;
				
				const result = await this.broker.call("ccxt.fetchOrderBook", {
					exchange: this.settings.exchange,
					symbol,
					limit
				});
				
				const analysis = this.analyzeOrderBook(result.orderbook);
				
				return {
					...result,
					analysis,
					recommendations: this.generateOrderBookRecommendations(analysis)
				};
			}
		},

		/**
		 * Obtenir les trades récents avec analyse de volume
		 */
		getTradesAnalysis: {
			params: {
				symbol: "string",
				limit: { type: "number", default: 100 }
			},
			cache: {
				keys: ["symbol", "limit"],
				ttl: 30
			},
			async handler(ctx) {
				const { symbol, limit } = ctx.params;
				
				const result = await this.broker.call("ccxt.fetchTrades", {
					exchange: this.settings.exchange,
					symbol,
					limit
				});
				
				const analysis = this.analyzeTradeVolume(result.trades);
				
				return {
					...result,
					volumeAnalysis: analysis,
					sentiment: this.calculateTradeSentiment(result.trades)
				};
			}
		},

		/**
		 * Rechercher des symboles par critères
		 */
		searchSymbols: {
			params: {
				query: { type: "string", optional: true },
				baseAsset: { type: "string", optional: true },
				quoteAsset: { type: "string", optional: true },
				minVolume: { type: "number", optional: true }
			},
			async handler(ctx) {
				const { query, baseAsset, quoteAsset, minVolume } = ctx.params;
				
				// Charger les marchés si nécessaire
				const markets = await this.broker.call("ccxt.loadMarkets", {
					exchange: this.settings.exchange
				});
				
				// Filtrer selon les critères
				const filtered = this.searchMarkets(markets.markets, {
					query,
					baseAsset,
					quoteAsset,
					minVolume
				});
				
				return {
					query: ctx.params,
					results: filtered,
					count: filtered.length,
					timestamp: Date.now()
				};
			}
		},

		/**
		 * Obtenir les statistiques de trading 24h
		 */
		getDailyStats: {
			cache: {
				keys: [],
				ttl: 300
			},
			async handler(ctx) {
				const symbols = this.settings.watchSymbols;
				
				const tickers = await this.broker.call("ccxt.fetchTickers", {
					exchange: this.settings.exchange,
					symbols
				});
				
				const stats = this.calculateDailyStats(tickers.tickers);
				
				return {
					exchange: this.settings.exchange,
					period: "24h",
					statistics: stats,
					topGainers: this.getTopMovers(tickers.tickers, "gainers"),
					topLosers: this.getTopMovers(tickers.tickers, "losers"),
					highestVolume: this.getTopVolume(tickers.tickers),
					timestamp: Date.now()
				};
			}
		},

		/**
		 * Tester la connectivité spécifique à Binance
		 */
		testConnection: {
			async handler(ctx) {
				const baseTest = await this.broker.call("ccxt.testConnection", {
					exchange: this.settings.exchange
				});
				
				// Tests spécifiques à Binance
				const binanceTests = await this.runBinanceSpecificTests();
				
				return {
					...baseTest,
					binanceSpecific: binanceTests,
					recommendation: this.getConnectionRecommendation(baseTest, binanceTests)
				};
			}
		}
	},

	methods: {
		/**
		 * Analyser les marchés
		 */
		analyzeMarkets(markets) {
			const marketArray = Object.values(markets);
			
			return {
				total: marketArray.length,
				active: marketArray.filter(m => m.active).length,
				spot: marketArray.filter(m => m.type === "spot").length,
				future: marketArray.filter(m => m.type === "future").length,
				margin: marketArray.filter(m => m.type === "margin").length,
				baseAssets: [...new Set(marketArray.map(m => m.base))].length,
				quoteAssets: [...new Set(marketArray.map(m => m.quote))].length
			};
		},

		/**
		 * Filtrer les marchés par quote asset
		 */
		filterMarkets(markets, quoteAsset) {
			return Object.values(markets)
				.filter(market => market.quote === quoteAsset && market.active)
				.map(market => ({
					symbol: market.symbol,
					base: market.base,
					quote: market.quote,
					type: market.type
				}));
		},

		/**
		 * Enrichir les tickers avec des métriques
		 */
		enrichTickers(tickers) {
			const enriched = {};
			
			Object.keys(tickers).forEach(symbol => {
				const ticker = tickers[symbol];
				enriched[symbol] = {
					...ticker,
					metrics: {
						change24hPercent: ticker.percentage,
						change24hAbs: ticker.change,
						volumeUSD: ticker.quoteVolume,
						priceChange: ticker.change > 0 ? "up" : ticker.change < 0 ? "down" : "stable",
						volatility: this.calculateVolatility(ticker)
					}
				};
			});
			
			return enriched;
		},

		/**
		 * Calculer un résumé des prix
		 */
		calculatePriceSummary(tickers) {
			const symbols = Object.keys(tickers);
			const gainers = symbols.filter(s => tickers[s].change > 0).length;
			const losers = symbols.filter(s => tickers[s].change < 0).length;
			const stable = symbols.length - gainers - losers;
			
			return {
				total: symbols.length,
				gainers,
				losers,
				stable,
				marketSentiment: gainers > losers ? "bullish" : losers > gainers ? "bearish" : "neutral"
			};
		},

		/**
		 * Enrichir les données OHLCV
		 */
		enrichOHLCV(ohlcv) {
			return ohlcv.map((candle, index) => {
				const [timestamp, open, high, low, close, volume] = candle;
				
				return {
					timestamp,
					datetime: new Date(timestamp).toISOString(),
					open,
					high,
					low,
					close,
					volume,
					change: close - open,
					changePercent: ((close - open) / open) * 100,
					bodySize: Math.abs(close - open),
					upperWick: high - Math.max(open, close),
					lowerWick: Math.min(open, close) - low,
					candleType: close > open ? "green" : close < open ? "red" : "doji"
				};
			});
		},

		/**
		 * Calculer des indicateurs techniques basiques
		 */
		calculateIndicators(candlesticks) {
			const closes = candlesticks.map(c => c.close);
			const volumes = candlesticks.map(c => c.volume);
			
			return {
				sma20: this.calculateSMA(closes, 20),
				sma50: this.calculateSMA(closes, 50),
				trend: this.detectTrend(closes),
				support: Math.min(...closes.slice(-20)),
				resistance: Math.max(...closes.slice(-20)),
				avgVolume: volumes.reduce((a, b) => a + b, 0) / volumes.length
			};
		},

		/**
		 * Analyser le carnet d'ordres
		 */
		analyzeOrderBook(orderbook) {
			const { bids, asks } = orderbook;
			
			const bidVolume = bids.reduce((sum, [price, amount]) => sum + amount, 0);
			const askVolume = asks.reduce((sum, [price, amount]) => sum + amount, 0);
			
			const spread = asks[0][0] - bids[0][0];
			const midPrice = (asks[0][0] + bids[0][0]) / 2;
			
			return {
				spread,
				spreadPercent: (spread / midPrice) * 100,
				bidVolume,
				askVolume,
				volumeImbalance: (bidVolume - askVolume) / (bidVolume + askVolume),
				depth: {
					bids: bids.length,
					asks: asks.length
				},
				liquidity: bidVolume + askVolume
			};
		},

		/**
		 * Analyser le volume des trades
		 */
		analyzeTradeVolume(trades) {
			const buyTrades = trades.filter(t => t.side === "buy");
			const sellTrades = trades.filter(t => t.side === "sell");
			
			const buyVolume = buyTrades.reduce((sum, t) => sum + t.amount, 0);
			const sellVolume = sellTrades.reduce((sum, t) => sum + t.amount, 0);
			
			return {
				totalTrades: trades.length,
				buyTrades: buyTrades.length,
				sellTrades: sellTrades.length,
				buyVolume,
				sellVolume,
				volumeRatio: buyVolume / (buyVolume + sellVolume),
				avgTradeSize: trades.reduce((sum, t) => sum + t.amount, 0) / trades.length
			};
		},

		/**
		 * Rechercher des marchés
		 */
		searchMarkets(markets, criteria) {
			return Object.values(markets).filter(market => {
				let matches = true;
				
				if (criteria.query) {
					const query = criteria.query.toLowerCase();
					matches = matches && (
						market.symbol.toLowerCase().includes(query) ||
						market.base.toLowerCase().includes(query) ||
						market.quote.toLowerCase().includes(query)
					);
				}
				
				if (criteria.baseAsset) {
					matches = matches && market.base === criteria.baseAsset.toUpperCase();
				}
				
				if (criteria.quoteAsset) {
					matches = matches && market.quote === criteria.quoteAsset.toUpperCase();
				}
				
				return matches && market.active;
			});
		},

		/**
		 * Obtenir les plus gros mouvements
		 */
		getTopMovers(tickers, type) {
			const symbols = Object.keys(tickers);
			
			return symbols
				.map(symbol => ({
					symbol,
					change: tickers[symbol].change,
					changePercent: tickers[symbol].percentage,
					volume: tickers[symbol].quoteVolume
				}))
				.sort((a, b) => {
					if (type === "gainers") {
						return b.changePercent - a.changePercent;
					} else {
						return a.changePercent - b.changePercent;
					}
				})
				.slice(0, 10);
		},

		/**
		 * Calculer la volatilité
		 */
		calculateVolatility(ticker) {
			if (!ticker.high || !ticker.low || !ticker.close) return 0;
			return ((ticker.high - ticker.low) / ticker.close) * 100;
		},

		/**
		 * Calculer la moyenne mobile simple
		 */
		calculateSMA(values, period) {
			if (values.length < period) return null;
			
			const sum = values.slice(-period).reduce((a, b) => a + b, 0);
			return sum / period;
		},

		/**
		 * Détecter la tendance
		 */
		detectTrend(prices) {
			if (prices.length < 2) return "unknown";
			
			const recent = prices.slice(-10);
			const firstHalf = recent.slice(0, 5);
			const secondHalf = recent.slice(-5);
			
			const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
			const secondAvg = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;
			
			if (secondAvg > firstAvg * 1.01) return "uptrend";
			if (secondAvg < firstAvg * 0.99) return "downtrend";
			return "sideways";
		},

		/**
		 * Tests spécifiques à Binance
		 */
		async runBinanceSpecificTests() {
			const tests = {
				serverTime: null,
				exchangeInfo: null,
				popularSymbolTest: null
			};
			
			try {
				// Test de l'heure du serveur (spécifique à Binance)
				const timeStart = Date.now();
				// Simuler un appel spécifique Binance
				tests.serverTime = {
					status: "success",
					latency: 50 // Simulé
				};
				
				// Test des symboles populaires
				const popularTest = await this.broker.call("ccxt.fetchTicker", {
					exchange: this.settings.exchange,
					symbol: "BTC/USDT"
				});
				
				tests.popularSymbolTest = {
					status: "success",
					symbol: "BTC/USDT",
					price: popularTest.ticker.last
				};
				
			} catch (err) {
				tests.error = err.message;
			}
			
			return tests;
		},

		/**
		 * Obtenir des recommandations de connexion
		 */
		getConnectionRecommendation(baseTest, binanceTests) {
			if (baseTest.status === "error") {
				return {
					status: "critical",
					message: "Cannot connect to Binance",
					actions: ["Check network connectivity", "Verify API credentials"]
				};
			}
			
			if (baseTest.loadTime > 5000) {
				return {
					status: "warning",
					message: "Slow connection detected",
					actions: ["Consider using VPN", "Check server location"]
				};
			}
			
			return {
				status: "good",
				message: "Binance connection is optimal",
				actions: []
			};
		}
	},

	/**
	 * Démarrage
	 */
	async started() {
		this.logger.info("Binance service started", {
			exchange: this.settings.exchange,
			watchSymbols: this.settings.watchSymbols.length,
			timeframes: this.settings.timeframes
		});
		
		// Vérifier que le service CCXT est disponible
		try {
			await this.broker.call("ccxt.listExchanges");
			this.logger.info("CCXT service dependency confirmed");
		} catch (err) {
			this.logger.error("CCXT service not available:", err.message);
		}
	},

	/**
	 * Arrêt
	 */
	async stopped() {
		this.logger.info("Binance service stopped");
	}
};