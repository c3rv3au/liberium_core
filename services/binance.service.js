// services/binance.service.js
"use strict";

const ccxt = require("ccxt");
const BaseService = require("./base.service");

module.exports = {
	name: "binance",

	mixins: [BaseService],

	dependencies: [],

	settings: {
		// Symboles à surveiller en temps réel
		watchSymbols: ["BNB/USDT"],
		
		// Configuration WebSocket
		websocket: {
			enabled: true,
			reconnectDelay: 5000,
			maxReconnectAttempts: 10
		},
		
		// Configuration de l'exchange
		exchange: {
			id: "binance",
			sandbox: process.env.NODE_ENV !== "production",
			apiKey: process.env.BINANCE_API_KEY,
			secret: process.env.BINANCE_SECRET,
			options: {
				defaultType: "spot"
			}
		},
		
		// Timeframes pour les candlesticks
		candleTimeframes: ["1m", "5m", "15m", "1h", "4h", "1d"],
		
		// Paramètres de stockage
		storage: {
			maxCandles: 1000,
			maxTrades: 500,
			maxOrderBookLevels: 100
		}
	},

	actions: {
		/**
		 * Obtenir toutes les données temps réel
		 */
		getRealTimeData: {
			handler(ctx) {
				return {
					timestamp: Date.now(),
					symbols: this.settings.watchSymbols,
					data: this.memory,
					status: this.getConnectionStatus(),
					uptime: this.getUptime()
				};
			}
		},

		/**
		 * Obtenir les tickers en temps réel
		 */
		getTickers: {
			params: {
				symbol: { type: "string", optional: true }
			},
			handler(ctx) {
				const { symbol } = ctx.params;
				
				if (symbol) {
					return {
						symbol,
						ticker: this.memory.tickers?.[symbol] || null,
						timestamp: Date.now()
					};
				}
				
				return {
					tickers: this.memory.tickers || {},
					symbols: Object.keys(this.memory.tickers || {}),
					timestamp: Date.now()
				};
			}
		},

		/**
		 * Obtenir les candlesticks
		 */
		getCandles: {
			params: {
				symbol: { type: "string", optional: true },
				timeframe: { type: "string", optional: true, default: "1m" },
				limit: { type: "number", optional: true, default: 100 }
			},
			handler(ctx) {
				const { symbol, timeframe, limit } = ctx.params;
				
				if (symbol) {
					const candles = this.memory.candles?.[symbol]?.[timeframe] || [];
					return {
						symbol,
						timeframe,
						candles: candles.slice(-limit),
						count: candles.length,
						timestamp: Date.now()
					};
				}
				
				return {
					candles: this.memory.candles || {},
					timestamp: Date.now()
				};
			}
		},

		/**
		 * Obtenir les trades récents
		 */
		getTrades: {
			params: {
				symbol: { type: "string", optional: true },
				limit: { type: "number", optional: true, default: 100 }
			},
			handler(ctx) {
				const { symbol, limit } = ctx.params;
				
				if (symbol) {
					const trades = this.memory.trades?.[symbol] || [];
					return {
						symbol,
						trades: trades.slice(-limit),
						count: trades.length,
						timestamp: Date.now()
					};
				}
				
				return {
					trades: this.memory.trades || {},
					timestamp: Date.now()
				};
			}
		},

		/**
		 * Obtenir l'order book
		 */
		getOrderBook: {
			params: {
				symbol: { type: "string", optional: true },
				limit: { type: "number", optional: true, default: 20 }
			},
			handler(ctx) {
				const { symbol, limit } = ctx.params;
				
				if (symbol) {
					const orderBook = this.memory.orderBooks?.[symbol];
					if (!orderBook) return null;
					
					return {
						symbol,
						orderBook: {
							bids: orderBook.bids?.slice(0, limit) || [],
							asks: orderBook.asks?.slice(0, limit) || [],
							timestamp: orderBook.timestamp,
							datetime: orderBook.datetime
						},
						timestamp: Date.now()
					};
				}
				
				return {
					orderBooks: this.memory.orderBooks || {},
					timestamp: Date.now()
				};
			}
		},

		/**
		 * Obtenir les statistiques 24h
		 */
		get24hStats: {
			params: {
				symbol: { type: "string", optional: true }
			},
			handler(ctx) {
				const { symbol } = ctx.params;
				
				if (symbol) {
					return {
						symbol,
						stats: this.memory.stats24h?.[symbol] || null,
						timestamp: Date.now()
					};
				}
				
				return {
					stats24h: this.memory.stats24h || {},
					timestamp: Date.now()
				};
			}
		},

		/**
		 * Obtenir le statut de connexion
		 */
		getStatus: {
			handler(ctx) {
				return {
					status: this.getConnectionStatus(),
					uptime: this.getUptime(),
					symbols: this.settings.watchSymbols,
					dataStatus: this.getDataStatus(),
					websocket: {
						connected: this.wsConnected,
						reconnectAttempts: this.reconnectAttempts
					},
					timestamp: Date.now()
				};
			}
		},

		/**
		 * Ajouter un symbole à surveiller
		 */
		addSymbol: {
			params: {
				symbol: "string"
			},
			async handler(ctx) {
				const { symbol } = ctx.params;
				
				if (!this.settings.watchSymbols.includes(symbol)) {
					this.settings.watchSymbols.push(symbol);
					await this.initializeSymbolData(symbol);
					await this.subscribeToSymbol(symbol);
					
					this.logger.info(`Added symbol ${symbol} to watch list`);
				}
				
				return {
					symbol,
					added: true,
					watchSymbols: this.settings.watchSymbols
				};
			}
		},

		/**
		 * Supprimer un symbole surveillé
		 */
		removeSymbol: {
			params: {
				symbol: "string"
			},
			async handler(ctx) {
				const { symbol } = ctx.params;
				
				const index = this.settings.watchSymbols.indexOf(symbol);
				if (index > -1) {
					this.settings.watchSymbols.splice(index, 1);
					await this.unsubscribeFromSymbol(symbol);
					this.cleanupSymbolData(symbol);
					
					this.logger.info(`Removed symbol ${symbol} from watch list`);
				}
				
				return {
					symbol,
					removed: true,
					watchSymbols: this.settings.watchSymbols
				};
			}
		}
	},

	methods: {
		/**
		 * Initialiser l'exchange CCXT
		 */
		async initializeExchange() {
			try {
				const ExchangeClass = ccxt[this.settings.exchange.id];
				
				this.exchange = new ExchangeClass({
					...this.settings.exchange,
					verbose: false,
					enableRateLimit: true,
					timeout: 30000
				});

				// Charger les marchés
				await this.exchange.loadMarkets();
				
				this.logger.info("Exchange initialized", {
					exchange: this.settings.exchange.id,
					symbolsAvailable: Object.keys(this.exchange.markets).length,
					watchSymbols: this.settings.watchSymbols
				});

				return true;
			} catch (err) {
				this.logger.error("Failed to initialize exchange:", err);
				return false;
			}
		},

		/**
		 * Initialiser les données en mémoire
		 */
		initializeMemoryStructure() {
			this.memory = {
				tickers: {},
				candles: {},
				trades: {},
				orderBooks: {},
				stats24h: {},
				lastUpdate: {}
			};

			// Initialiser pour chaque symbole
			this.settings.watchSymbols.forEach(symbol => {
				this.initializeSymbolData(symbol);
			});
		},

		/**
		 * Initialiser les données d'un symbole
		 */
		initializeSymbolData(symbol) {
			if (!this.memory.candles[symbol]) {
				this.memory.candles[symbol] = {};
				this.settings.candleTimeframes.forEach(timeframe => {
					this.memory.candles[symbol][timeframe] = [];
				});
			}
			
			if (!this.memory.trades[symbol]) {
				this.memory.trades[symbol] = [];
			}
			
			if (!this.memory.tickers[symbol]) {
				this.memory.tickers[symbol] = null;
			}
			
			if (!this.memory.orderBooks[symbol]) {
				this.memory.orderBooks[symbol] = { bids: [], asks: [], timestamp: null };
			}
			
			if (!this.memory.stats24h[symbol]) {
				this.memory.stats24h[symbol] = null;
			}
			
			this.memory.lastUpdate[symbol] = Date.now();
		},

		/**
		 * Nettoyer les données d'un symbole
		 */
		cleanupSymbolData(symbol) {
			delete this.memory.tickers[symbol];
			delete this.memory.candles[symbol];
			delete this.memory.trades[symbol];
			delete this.memory.orderBooks[symbol];
			delete this.memory.stats24h[symbol];
			delete this.memory.lastUpdate[symbol];
		},

		/**
		 * Démarrer les WebSockets
		 */
		async startWebSockets() {
			if (!this.settings.websocket.enabled) {
				this.logger.info("WebSocket disabled in settings");
				return;
			}

			try {
				this.wsConnected = false;
				this.reconnectAttempts = 0;

				// S'abonner aux différents flux pour chaque symbole
				for (const symbol of this.settings.watchSymbols) {
					await this.subscribeToSymbol(symbol);
				}

				this.wsConnected = true;
				this.logger.info("WebSocket connections established");

			} catch (err) {
				this.logger.error("Failed to start WebSockets:", err);
				await this.scheduleReconnect();
			}
		},

		/**
		 * S'abonner aux flux d'un symbole
		 */
		async subscribeToSymbol(symbol) {
			try {
				// Ticker 24h stats
				this.watchTicker(symbol);
				
				// Order Book
				this.watchOrderBook(symbol);
				
				// Trades
				this.watchTrades(symbol);
				
				// Candlesticks pour tous les timeframes
				this.settings.candleTimeframes.forEach(timeframe => {
					this.watchOHLCV(symbol, timeframe);
				});

				this.logger.debug(`Subscribed to ${symbol} streams`);
			} catch (err) {
				this.logger.error(`Failed to subscribe to ${symbol}:`, err);
			}
		},

		/**
		 * Se désabonner des flux d'un symbole
		 */
		async unsubscribeFromSymbol(symbol) {
			// CCXT gère automatiquement la désinscription
			this.logger.debug(`Unsubscribed from ${symbol} streams`);
		},

		/**
		 * Surveiller les tickers
		 */
		async watchTicker(symbol) {
			try {
				if (!this.exchange.has['watchTicker']) {
					// Fallback: fetch périodique
					this.startPeriodicTickerFetch(symbol);
					return;
				}

				while (this.wsConnected) {
					try {
						const ticker = await this.exchange.watchTicker(symbol);
						this.updateTicker(symbol, ticker);
					} catch (err) {
						this.logger.warn(`Ticker watch error for ${symbol}:`, err.message);
						await this.sleep(1000);
					}
				}
			} catch (err) {
				this.logger.error(`Failed to watch ticker for ${symbol}:`, err);
			}
		},

		/**
		 * Surveiller l'order book
		 */
		async watchOrderBook(symbol) {
			try {
				if (!this.exchange.has['watchOrderBook']) {
					this.startPeriodicOrderBookFetch(symbol);
					return;
				}

				while (this.wsConnected) {
					try {
						const orderBook = await this.exchange.watchOrderBook(symbol);
						this.updateOrderBook(symbol, orderBook);
					} catch (err) {
						this.logger.warn(`OrderBook watch error for ${symbol}:`, err.message);
						await this.sleep(1000);
					}
				}
			} catch (err) {
				this.logger.error(`Failed to watch order book for ${symbol}:`, err);
			}
		},

		/**
		 * Surveiller les trades
		 */
		async watchTrades(symbol) {
			try {
				if (!this.exchange.has['watchTrades']) {
					this.startPeriodicTradesFetch(symbol);
					return;
				}

				while (this.wsConnected) {
					try {
						const trades = await this.exchange.watchTrades(symbol);
						this.updateTrades(symbol, trades);
					} catch (err) {
						this.logger.warn(`Trades watch error for ${symbol}:`, err.message);
						await this.sleep(1000);
					}
				}
			} catch (err) {
				this.logger.error(`Failed to watch trades for ${symbol}:`, err);
			}
		},

		/**
		 * Surveiller les OHLCV
		 */
		async watchOHLCV(symbol, timeframe) {
			try {
				if (!this.exchange.has['watchOHLCV']) {
					this.startPeriodicCandlesFetch(symbol, timeframe);
					return;
				}

				while (this.wsConnected) {
					try {
						const candles = await this.exchange.watchOHLCV(symbol, timeframe);
						this.updateCandles(symbol, timeframe, candles);
					} catch (err) {
						this.logger.warn(`OHLCV watch error for ${symbol} ${timeframe}:`, err.message);
						await this.sleep(1000);
					}
				}
			} catch (err) {
				this.logger.error(`Failed to watch OHLCV for ${symbol} ${timeframe}:`, err);
			}
		},

		/**
		 * Mettre à jour le ticker
		 */
		updateTicker(symbol, ticker) {
			this.memory.tickers[symbol] = {
				...ticker,
				receivedAt: Date.now()
			};
			
			// Mettre à jour les stats 24h
			this.memory.stats24h[symbol] = {
				symbol,
				priceChange: ticker.change,
				priceChangePercent: ticker.percentage,
				prevClosePrice: ticker.previous,
				lastPrice: ticker.last,
				volume: ticker.baseVolume,
				quoteVolume: ticker.quoteVolume,
				openTime: ticker.timestamp,
				closeTime: ticker.timestamp,
				high: ticker.high,
				low: ticker.low,
				open: ticker.open,
				close: ticker.close,
				receivedAt: Date.now()
			};
			
			this.memory.lastUpdate[symbol] = Date.now();
			this.notifySubscribers();
		},

		/**
		 * Mettre à jour l'order book
		 */
		updateOrderBook(symbol, orderBook) {
			this.memory.orderBooks[symbol] = {
				bids: orderBook.bids.slice(0, this.settings.storage.maxOrderBookLevels),
				asks: orderBook.asks.slice(0, this.settings.storage.maxOrderBookLevels),
				timestamp: orderBook.timestamp,
				datetime: orderBook.datetime,
				receivedAt: Date.now()
			};
			
			this.memory.lastUpdate[symbol] = Date.now();
			this.notifySubscribers();
		},

		/**
		 * Mettre à jour les trades
		 */
		updateTrades(symbol, trades) {
			if (!Array.isArray(trades)) return;

			// Ajouter les nouveaux trades
			this.memory.trades[symbol].push(...trades.map(trade => ({
				...trade,
				receivedAt: Date.now()
			})));

			// Garder seulement les derniers trades
			if (this.memory.trades[symbol].length > this.settings.storage.maxTrades) {
				this.memory.trades[symbol] = this.memory.trades[symbol]
					.slice(-this.settings.storage.maxTrades);
			}
			
			this.memory.lastUpdate[symbol] = Date.now();
			this.notifySubscribers();
		},

		/**
		 * Mettre à jour les candlesticks
		 */
		updateCandles(symbol, timeframe, candles) {
			if (!Array.isArray(candles)) return;

			const enrichedCandles = candles.map(candle => {
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
					receivedAt: Date.now()
				};
			});

			// Remplacer ou ajouter les nouvelles bougies
			this.memory.candles[symbol][timeframe] = enrichedCandles;

			// Garder seulement les dernières bougies
			if (this.memory.candles[symbol][timeframe].length > this.settings.storage.maxCandles) {
				this.memory.candles[symbol][timeframe] = this.memory.candles[symbol][timeframe]
					.slice(-this.settings.storage.maxCandles);
			}
			
			this.memory.lastUpdate[symbol] = Date.now();
			this.notifySubscribers();
		},

		/**
		 * Fallback: fetch périodique des tickers
		 */
		startPeriodicTickerFetch(symbol) {
			setInterval(async () => {
				try {
					const ticker = await this.exchange.fetchTicker(symbol);
					this.updateTicker(symbol, ticker);
				} catch (err) {
					this.logger.warn(`Periodic ticker fetch failed for ${symbol}:`, err.message);
				}
			}, 5000); // Toutes les 5 secondes
		},

		/**
		 * Fallback: fetch périodique de l'order book
		 */
		startPeriodicOrderBookFetch(symbol) {
			setInterval(async () => {
				try {
					const orderBook = await this.exchange.fetchOrderBook(symbol);
					this.updateOrderBook(symbol, orderBook);
				} catch (err) {
					this.logger.warn(`Periodic order book fetch failed for ${symbol}:`, err.message);
				}
			}, 2000); // Toutes les 2 secondes
		},

		/**
		 * Fallback: fetch périodique des trades
		 */
		startPeriodicTradesFetch(symbol) {
			setInterval(async () => {
				try {
					const trades = await this.exchange.fetchTrades(symbol);
					this.updateTrades(symbol, trades);
				} catch (err) {
					this.logger.warn(`Periodic trades fetch failed for ${symbol}:`, err.message);
				}
			}, 10000); // Toutes les 10 secondes
		},

		/**
		 * Fallback: fetch périodique des candlesticks
		 */
		startPeriodicCandlesFetch(symbol, timeframe) {
			const interval = this.getTimeframeMs(timeframe);
			
			setInterval(async () => {
				try {
					const candles = await this.exchange.fetchOHLCV(symbol, timeframe, undefined, 100);
					this.updateCandles(symbol, timeframe, candles);
				} catch (err) {
					this.logger.warn(`Periodic candles fetch failed for ${symbol} ${timeframe}:`, err.message);
				}
			}, Math.min(interval, 60000)); // Maximum 1 minute
		},

		/**
		 * Convertir timeframe en millisecondes
		 */
		getTimeframeMs(timeframe) {
			const timeframes = {
				'1m': 60000,
				'5m': 300000,
				'15m': 900000,
				'1h': 3600000,
				'4h': 14400000,
				'1d': 86400000
			};
			return timeframes[timeframe] || 60000;
		},

		/**
		 * Programmer une reconnexion
		 */
		async scheduleReconnect() {
			if (this.reconnectAttempts >= this.settings.websocket.maxReconnectAttempts) {
				this.logger.error("Max reconnect attempts reached");
				return;
			}

			this.reconnectAttempts++;
			const delay = this.settings.websocket.reconnectDelay * this.reconnectAttempts;
			
			this.logger.info(`Scheduling reconnect attempt ${this.reconnectAttempts} in ${delay}ms`);
			
			setTimeout(() => {
				this.startWebSockets();
			}, delay);
		},

		/**
		 * Obtenir le statut de connexion
		 */
		getConnectionStatus() {
			if (this.wsConnected) return "connected";
			if (this.reconnectAttempts > 0) return "reconnecting";
			return "disconnected";
		},

		/**
		 * Obtenir l'uptime
		 */
		getUptime() {
			return this.startTime ? Date.now() - this.startTime : 0;
		},

		/**
		 * Obtenir le statut des données
		 */
		getDataStatus() {
			const status = {};
			
			this.settings.watchSymbols.forEach(symbol => {
				const lastUpdate = this.memory.lastUpdate[symbol];
				const timeSinceUpdate = lastUpdate ? Date.now() - lastUpdate : null;
				
				status[symbol] = {
					lastUpdate,
					timeSinceUpdate,
					hasData: {
						ticker: !!this.memory.tickers[symbol],
						orderBook: !!this.memory.orderBooks[symbol],
						trades: (this.memory.trades[symbol]?.length || 0) > 0,
						candles: Object.keys(this.memory.candles[symbol] || {}).length > 0
					}
				};
			});
			
			return status;
		},

		/**
		 * Sleep utilitaire
		 */
		sleep(ms) {
			return new Promise(resolve => setTimeout(resolve, ms));
		}
	},

	/**
	 * Démarrage du service
	 */
	async started() {
		this.startTime = Date.now();
		this.wsConnected = false;
		this.reconnectAttempts = 0;

		this.logger.info("Starting Binance WebSocket service", {
			symbols: this.settings.watchSymbols,
			timeframes: this.settings.candleTimeframes
		});

		// Initialiser la structure mémoire
		this.initializeMemoryStructure();

		// Initialiser l'exchange
		const exchangeReady = await this.initializeExchange();
		if (!exchangeReady) {
			this.logger.error("Failed to initialize exchange, service will not function properly");
			return;
		}

		// Démarrer les WebSockets
		await this.startWebSockets();

		this.logger.info("Binance WebSocket service started successfully", {
			status: this.getConnectionStatus(),
			watchSymbols: this.settings.watchSymbols.length,
			timeframes: this.settings.candleTimeframes.length
		});
	},

	/**
	 * Arrêt du service
	 */
	async stopped() {
		this.wsConnected = false;

		if (this.exchange) {
			try {
				await this.exchange.close();
			} catch (err) {
				this.logger.warn("Error closing exchange:", err.message);
			}
		}

		this.logger.info("Binance WebSocket service stopped");
	}
};