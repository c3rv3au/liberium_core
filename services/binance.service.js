// services/binance.service.js
"use strict";

const WebSocket = require('ws');
const BaseService = require("./base.service");

module.exports = {
	name: "binance",

	mixins: [BaseService],

	settings: {
		// Symboles à surveiller (format Binance: bnbusdt)
		watchSymbols: ["bnbusdt"],
		
		// URLs WebSocket Binance
		websocket: {
			baseUrl: "wss://stream.binance.com:9443/ws/",
			streamUrl: "wss://stream.binance.com:9443/stream?streams=",
			reconnectDelay: 5000,
			maxReconnectAttempts: 10,
			pingInterval: 30000
		},
		
		// Timeframes pour les klines
		klineIntervals: ["1m", "5m", "15m", "1h", "4h", "1d"],
		
		// Limites de stockage
		storage: {
			maxTrades: 500,
			maxKlines: 1000,
			maxDepthLevels: 100
		},

		// Configuration des notifications
		notifications: {
			throttle: 1000, // Minimum 1s entre notifications
			batchUpdates: true
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
					connections: this.getConnectionStatus(),
					uptime: this.getUptime()
				};
			}
		},

		/**
		 * Obtenir les tickers 24h
		 */
		getTickers: {
			params: {
				symbol: { type: "string", optional: true }
			},
			handler(ctx) {
				const { symbol } = ctx.params;
				
				if (symbol) {
					const binanceSymbol = symbol.toLowerCase().replace('/', '');
					return {
						symbol,
						ticker: this.memory.tickers?.[binanceSymbol] || null,
						timestamp: Date.now()
					};
				}
				
				return {
					tickers: this.memory.tickers || {},
					count: Object.keys(this.memory.tickers || {}).length,
					timestamp: Date.now()
				};
			}
		},

		/**
		 * Obtenir les prix en temps réel
		 */
		getPrices: {
			params: {
				symbol: { type: "string", optional: true }
			},
			handler(ctx) {
				const { symbol } = ctx.params;
				
				if (symbol) {
					const binanceSymbol = symbol.toLowerCase().replace('/', '');
					return {
						symbol,
						price: this.memory.prices?.[binanceSymbol] || null,
						timestamp: Date.now()
					};
				}
				
				return {
					prices: this.memory.prices || {},
					count: Object.keys(this.memory.prices || {}).length,
					timestamp: Date.now()
				};
			}
		},

		/**
		 * Obtenir les klines (candlesticks)
		 */
		getKlines: {
			params: {
				symbol: { type: "string", optional: true },
				interval: { type: "string", optional: true, default: "1m" },
				limit: { type: "number", optional: true, default: 100 }
			},
			handler(ctx) {
				const { symbol, interval, limit } = ctx.params;
				
				if (symbol) {
					const binanceSymbol = symbol.toLowerCase().replace('/', '');
					const klines = this.memory.klines?.[binanceSymbol]?.[interval] || [];
					return {
						symbol,
						interval,
						klines: klines.slice(-limit),
						count: klines.length,
						timestamp: Date.now()
					};
				}
				
				return {
					klines: this.memory.klines || {},
					timestamp: Date.now()
				};
			}
		},

		/**
		 * Obtenir les trades en temps réel
		 */
		getTrades: {
			params: {
				symbol: { type: "string", optional: true },
				limit: { type: "number", optional: true, default: 50 }
			},
			handler(ctx) {
				const { symbol, limit } = ctx.params;
				
				if (symbol) {
					const binanceSymbol = symbol.toLowerCase().replace('/', '');
					const trades = this.memory.trades?.[binanceSymbol] || [];
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
		 * Obtenir le carnet d'ordres
		 */
		getDepth: {
			params: {
				symbol: { type: "string", optional: true },
				limit: { type: "number", optional: true, default: 20 }
			},
			handler(ctx) {
				const { symbol, limit } = ctx.params;
				
				if (symbol) {
					const binanceSymbol = symbol.toLowerCase().replace('/', '');
					const depth = this.memory.depth?.[binanceSymbol];
					if (!depth) return null;
					
					return {
						symbol,
						depth: {
							bids: depth.bids?.slice(0, limit) || [],
							asks: depth.asks?.slice(0, limit) || [],
							lastUpdateId: depth.lastUpdateId,
							timestamp: depth.timestamp
						},
						timestamp: Date.now()
					};
				}
				
				return {
					depth: this.memory.depth || {},
					timestamp: Date.now()
				};
			}
		},

		/**
		 * Obtenir le statut des connexions
		 */
		getStatus: {
			handler(ctx) {
				return {
					status: this.getConnectionStatus(),
					uptime: this.getUptime(),
					symbols: this.settings.watchSymbols,
					streams: this.getActiveStreams(),
					dataStatus: this.getDataStatus(),
					subscribers: this.getActiveSubscriptions(),
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
				const binanceSymbol = symbol.toLowerCase().replace('/', '');
				
				if (!this.settings.watchSymbols.includes(binanceSymbol)) {
					this.settings.watchSymbols.push(binanceSymbol);
					this.initializeSymbolData(binanceSymbol);
					await this.subscribeToSymbol(binanceSymbol);
					
					this.logger.info(`Added symbol ${symbol} (${binanceSymbol}) to watch list`);
				}
				
				return {
					symbol,
					binanceSymbol,
					added: true,
					watchSymbols: this.settings.watchSymbols
				};
			}
		}
	},

	methods: {
		/**
		 * Initialiser la structure mémoire
		 */
		initializeMemoryStructure() {
			this.memory = {
				tickers: {},    // Stats 24h
				prices: {},     // Prix temps réel
				klines: {},     // Candlesticks
				trades: {},     // Trades temps réel
				depth: {},      // Carnet d'ordres
				lastUpdate: {}
			};

			// Variables de connexion
			this.connections = new Map();
			this.reconnectAttempts = new Map();
			this.activeStreams = new Set();

			// Variables pour les notifications
			this.lastNotificationTime = 0;
			this.pendingNotification = false;

			// Initialiser pour chaque symbole
			this.settings.watchSymbols.forEach(symbol => {
				this.initializeSymbolData(symbol);
			});
		},

		/**
		 * Initialiser les données d'un symbole
		 */
		initializeSymbolData(symbol) {
			// Klines par intervalle
			if (!this.memory.klines[symbol]) {
				this.memory.klines[symbol] = {};
				this.settings.klineIntervals.forEach(interval => {
					this.memory.klines[symbol][interval] = [];
				});
			}
			
			// Autres données
			if (!this.memory.trades[symbol]) this.memory.trades[symbol] = [];
			if (!this.memory.tickers[symbol]) this.memory.tickers[symbol] = null;
			if (!this.memory.prices[symbol]) this.memory.prices[symbol] = null;
			if (!this.memory.depth[symbol]) this.memory.depth[symbol] = { bids: [], asks: [], lastUpdateId: 0 };
			
			this.memory.lastUpdate[symbol] = Date.now();
		},

		/**
		 * Notifier les abonnés des changements de mémoire
		 */
		async notifyMemoryUpdate() {
			// Throttling des notifications
			const now = Date.now();
			if (now - this.lastNotificationTime < this.settings.notifications.throttle) {
				// Programmer une notification différée si pas déjà programmée
				if (!this.pendingNotification) {
					this.pendingNotification = true;
					setTimeout(() => {
						this.pendingNotification = false;
						this.notifyMemoryUpdate();
					}, this.settings.notifications.throttle);
				}
				return;
			}

			this.lastNotificationTime = now;

			try {
				// Notifier via l'événement standard
				this.broker.emit("memory.updated", {
					service: this.name,
					memory: this.memory,
					timestamp: now
				});

				// Notifier directement les abonnés s'il y en a
				if (this.subscriptions && this.subscriptions.size > 0) {
					this.logger.debug(`📡 Notification envoyée à ${this.subscriptions.size} abonnés`);
				}

			} catch (err) {
				this.logger.error("Erreur lors de la notification des abonnés:", err);
			}
		},

		/**
		 * Démarrer tous les WebSockets
		 */
		async startWebSockets() {
			this.logger.info("Starting Binance WebSocket connections...");

			for (const symbol of this.settings.watchSymbols) {
				await this.subscribeToSymbol(symbol);
			}

			this.logger.info(`WebSocket connections established for ${this.settings.watchSymbols.length} symbols`);
		},

		/**
		 * S'abonner aux flux d'un symbole
		 */
		async subscribeToSymbol(symbol) {
			// Créer les streams pour ce symbole
			const streams = this.createStreamsForSymbol(symbol);
			
			// Connexion combinée pour tous les streams du symbole
			const streamUrl = this.settings.websocket.streamUrl + streams.join('/');
			
			this.logger.info(`Connecting to streams for ${symbol.toUpperCase()}: ${streams.length} streams`);
			
			this.connectWebSocket(symbol, streamUrl, streams);
		},

		/**
		 * Créer la liste des streams pour un symbole
		 */
		createStreamsForSymbol(symbol) {
			const streams = [];

			// Ticker 24h
			streams.push(`${symbol}@ticker`);
			
			// Prix en temps réel
			streams.push(`${symbol}@miniTicker`);
			
			// Trades en temps réel
			streams.push(`${symbol}@trade`);
			
			// Carnet d'ordres
			streams.push(`${symbol}@depth20@100ms`);
			
			// Klines pour tous les intervalles
			this.settings.klineIntervals.forEach(interval => {
				streams.push(`${symbol}@kline_${interval}`);
			});

			return streams;
		},

		/**
		 * Connexion WebSocket
		 */
		connectWebSocket(symbol, url, streams) {
			const ws = new WebSocket(url);
			
			ws.on('open', () => {
				this.logger.info(`WebSocket connected for ${symbol.toUpperCase()}`);
				this.connections.set(symbol, ws);
				this.reconnectAttempts.set(symbol, 0);
				streams.forEach(stream => this.activeStreams.add(stream));
				
				// Ping périodique
				this.startPing(ws);
			});

			ws.on('message', (data) => {
				try {
					const message = JSON.parse(data);
					this.handleMessage(symbol, message);
				} catch (err) {
					this.logger.error(`Error parsing WebSocket message for ${symbol}:`, err);
				}
			});

			ws.on('error', (error) => {
				this.logger.error(`WebSocket error for ${symbol}:`, error);
			});

			ws.on('close', (code, reason) => {
				this.logger.warn(`WebSocket closed for ${symbol}: ${code} - ${reason}`);
				this.connections.delete(symbol);
				streams.forEach(stream => this.activeStreams.delete(stream));
				
				// Programmer une reconnexion
				this.scheduleReconnect(symbol);
			});
		},

		/**
		 * Gérer les messages WebSocket
		 */
		handleMessage(symbol, message) {
			if (message.stream) {
				const streamParts = message.stream.split('@');
				const streamSymbol = streamParts[0];
				const streamType = streamParts[1];
				
				switch (streamType) {
					case 'ticker':
						this.handleTicker(streamSymbol, message.data);
						break;
					case 'miniTicker':
						this.handleMiniTicker(streamSymbol, message.data);
						break;
					case 'trade':
						this.handleTrade(streamSymbol, message.data);
						break;
					case 'depth20@100ms':
						this.handleDepth(streamSymbol, message.data);
						break;
					default:
						if (streamType.startsWith('kline_')) {
							const interval = streamType.replace('kline_', '');
							this.handleKline(streamSymbol, interval, message.data);
						}
						break;
				}
			}
		},

		/**
		 * Gérer les tickers 24h
		 */
		handleTicker(symbol, data) {
			this.memory.tickers[symbol] = {
				symbol: data.s,
				priceChange: parseFloat(data.p),
				priceChangePercent: parseFloat(data.P),
				weightedAvgPrice: parseFloat(data.w),
				prevClosePrice: parseFloat(data.x),
				lastPrice: parseFloat(data.c),
				lastQty: parseFloat(data.Q),
				bidPrice: parseFloat(data.b),
				askPrice: parseFloat(data.a),
				openPrice: parseFloat(data.o),
				highPrice: parseFloat(data.h),
				lowPrice: parseFloat(data.l),
				volume: parseFloat(data.v),
				quoteVolume: parseFloat(data.q),
				openTime: data.O,
				closeTime: data.C,
				count: data.c,
				receivedAt: Date.now()
			};
			
			this.memory.lastUpdate[symbol] = Date.now();
			this.notifyMemoryUpdate();
		},

		/**
		 * Gérer les mini tickers (prix temps réel)
		 */
		handleMiniTicker(symbol, data) {
			this.memory.prices[symbol] = {
				symbol: data.s,
				lastPrice: parseFloat(data.c),
				openPrice: parseFloat(data.o),
				highPrice: parseFloat(data.h),
				lowPrice: parseFloat(data.l),
				volume: parseFloat(data.v),
				quoteVolume: parseFloat(data.q),
				receivedAt: Date.now()
			};
			
			this.memory.lastUpdate[symbol] = Date.now();
			this.notifyMemoryUpdate();
		},

		/**
		 * Gérer les trades
		 */
		handleTrade(symbol, data) {
			const trade = {
				eventType: data.e,
				eventTime: data.E,
				symbol: data.s,
				tradeId: data.t,
				price: parseFloat(data.p),
				quantity: parseFloat(data.q),
				buyerOrderId: data.b,
				sellerOrderId: data.a,
				tradeTime: data.T,
				isBuyerMaker: data.m,
				receivedAt: Date.now()
			};

			this.memory.trades[symbol].push(trade);

			// Limiter le nombre de trades stockés
			if (this.memory.trades[symbol].length > this.settings.storage.maxTrades) {
				this.memory.trades[symbol] = this.memory.trades[symbol]
					.slice(-this.settings.storage.maxTrades);
			}
			
			this.memory.lastUpdate[symbol] = Date.now();
			this.notifyMemoryUpdate();
		},

		/**
		 * Gérer le carnet d'ordres
		 */
		handleDepth(symbol, data) {
			this.memory.depth[symbol] = {
				lastUpdateId: data.lastUpdateId,
				bids: data.bids.map(bid => ({
					price: parseFloat(bid[0]),
					quantity: parseFloat(bid[1])
				})).slice(0, this.settings.storage.maxDepthLevels),
				asks: data.asks.map(ask => ({
					price: parseFloat(ask[0]),
					quantity: parseFloat(ask[1])
				})).slice(0, this.settings.storage.maxDepthLevels),
				timestamp: Date.now(),
				receivedAt: Date.now()
			};
			
			this.memory.lastUpdate[symbol] = Date.now();
			this.notifyMemoryUpdate();
		},

		/**
		 * Gérer les klines (candlesticks)
		 */
		handleKline(symbol, interval, data) {
			const klineData = data.k;
			
			const kline = {
				openTime: klineData.t,
				closeTime: klineData.T,
				symbol: klineData.s,
				interval: klineData.i,
				firstTradeId: klineData.f,
				lastTradeId: klineData.L,
				open: parseFloat(klineData.o),
				close: parseFloat(klineData.c),
				high: parseFloat(klineData.h),
				low: parseFloat(klineData.l),
				volume: parseFloat(klineData.v),
				numberOfTrades: klineData.n,
				isFinal: klineData.x,
				quoteVolume: parseFloat(klineData.q),
				takerBuyBaseVolume: parseFloat(klineData.V),
				takerBuyQuoteVolume: parseFloat(klineData.Q),
				change: parseFloat(klineData.c) - parseFloat(klineData.o),
				changePercent: ((parseFloat(klineData.c) - parseFloat(klineData.o)) / parseFloat(klineData.o)) * 100,
				receivedAt: Date.now()
			};

			// Ne garder que les klines finalisées
			if (kline.isFinal) {
				this.memory.klines[symbol][interval].push(kline);

				// Limiter le stockage
				if (this.memory.klines[symbol][interval].length > this.settings.storage.maxKlines) {
					this.memory.klines[symbol][interval] = this.memory.klines[symbol][interval]
						.slice(-this.settings.storage.maxKlines);
				}
			}
			
			this.memory.lastUpdate[symbol] = Date.now();
			this.notifyMemoryUpdate();
		},

		/**
		 * Démarrer le ping périodique
		 */
		startPing(ws) {
			const pingInterval = setInterval(() => {
				if (ws.readyState === WebSocket.OPEN) {
					ws.ping();
				} else {
					clearInterval(pingInterval);
				}
			}, this.settings.websocket.pingInterval);
		},

		/**
		 * Programmer une reconnexion
		 */
		scheduleReconnect(symbol) {
			const attempts = this.reconnectAttempts.get(symbol) || 0;
			
			if (attempts >= this.settings.websocket.maxReconnectAttempts) {
				this.logger.error(`Max reconnect attempts reached for ${symbol}`);
				return;
			}

			const delay = this.settings.websocket.reconnectDelay * (attempts + 1);
			this.reconnectAttempts.set(symbol, attempts + 1);
			
			this.logger.info(`Scheduling reconnect for ${symbol} in ${delay}ms (attempt ${attempts + 1})`);
			
			setTimeout(() => {
				this.subscribeToSymbol(symbol);
			}, delay);
		},

		/**
		 * Obtenir le statut des connexions
		 */
		getConnectionStatus() {
			const status = {};
			
			this.settings.watchSymbols.forEach(symbol => {
				const ws = this.connections.get(symbol);
				status[symbol] = {
					connected: ws && ws.readyState === WebSocket.OPEN,
					readyState: ws ? ws.readyState : 'not_connected',
					reconnectAttempts: this.reconnectAttempts.get(symbol) || 0
				};
			});
			
			return status;
		},

		/**
		 * Obtenir les streams actifs
		 */
		getActiveStreams() {
			return Array.from(this.activeStreams);
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
						price: !!this.memory.prices[symbol],
						trades: (this.memory.trades[symbol]?.length || 0) > 0,
						depth: !!(this.memory.depth[symbol]?.bids?.length > 0),
						klines: Object.keys(this.memory.klines[symbol] || {}).length > 0
					}
				};
			});
			
			return status;
		},

		/**
		 * Obtenir l'uptime
		 */
		getUptime() {
			return this.startTime ? Date.now() - this.startTime : 0;
		}
	},

	/**
	 * Démarrage du service
	 */
	async started() {
		this.startTime = Date.now();

		this.logger.info("Starting Binance Real-Time WebSocket service", {
			symbols: this.settings.watchSymbols,
			intervals: this.settings.klineIntervals,
			streams: this.settings.watchSymbols.length * (4 + this.settings.klineIntervals.length)
		});

		// Initialiser la structure mémoire
		this.initializeMemoryStructure();

		// Démarrer les WebSockets
		await this.startWebSockets();

		this.logger.info("Binance Real-Time service started successfully", {
			symbolsCount: this.settings.watchSymbols.length,
			streamsCount: this.getActiveStreams().length,
			uptime: this.getUptime()
		});
	},

	/**
	 * Arrêt du service
	 */
	async stopped() {
		// Fermer toutes les connexions WebSocket
		for (const [symbol, ws] of this.connections.entries()) {
			if (ws && ws.readyState === WebSocket.OPEN) {
				ws.close();
			}
		}

		this.connections.clear();
		this.activeStreams.clear();

		this.logger.info("Binance Real-Time WebSocket service stopped");
	}
};