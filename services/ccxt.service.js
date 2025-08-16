// services/ccxt.service.js
"use strict";

const ccxt = require("ccxt");
const BaseService = require("./base.service");

module.exports = {
	name: "ccxt",

	mixins: [BaseService],

	settings: {
		// Exchange par défaut
		defaultExchange: process.env.DEFAULT_EXCHANGE || "binance",
		
		// Configuration des exchanges
		exchangeConfigs: {
			binance: {
				apiKey: process.env.BINANCE_API_KEY,
				secret: process.env.BINANCE_SECRET,
				sandbox: process.env.NODE_ENV !== "production",
				options: {
					defaultType: "spot" // spot, future, margin
				}
			},
			coinbase: {
				apiKey: process.env.COINBASE_API_KEY,
				secret: process.env.COINBASE_SECRET,
				sandbox: process.env.NODE_ENV !== "production"
			},
			kraken: {
				apiKey: process.env.KRAKEN_API_KEY,
				secret: process.env.KRAKEN_SECRET,
				sandbox: process.env.NODE_ENV !== "production"
			}
		},
		
		// Limites et timeouts
		rateLimit: 1000,
		enableRateLimit: true,
		timeout: 30000,
		
		// Cache pour les markets
		cacheTimeout: 300000, // 5 minutes
		
		// Retry settings
		maxRetries: 3,
		retryDelay: 1000
	},

	actions: {
		/**
		 * Lister tous les exchanges supportés
		 */
		listExchanges: {
			cache: {
				keys: [],
				ttl: 3600 // 1 heure
			},
			async handler(ctx) {
				return {
					supported: ccxt.exchanges,
					configured: Object.keys(this.settings.exchangeConfigs),
					default: this.settings.defaultExchange,
					count: ccxt.exchanges.length
				};
			}
		},

		/**
		 * Obtenir les informations d'un exchange
		 */
		getExchangeInfo: {
			params: {
				exchange: { type: "string", optional: true }
			},
			cache: {
				keys: ["exchange"],
				ttl: 3600
			},
			async handler(ctx) {
				const exchangeId = ctx.params.exchange || this.settings.defaultExchange;
				const exchange = this.getExchange(exchangeId);
				
				return {
					id: exchange.id,
					name: exchange.name,
					countries: exchange.countries,
					urls: exchange.urls,
					version: exchange.version,
					has: exchange.has,
					timeframes: exchange.timeframes,
					fees: exchange.fees,
					limits: exchange.limits,
					precisionMode: exchange.precisionMode,
					symbols: exchange.symbols || null,
					currencies: Object.keys(exchange.currencies || {}),
					marketsLoaded: !!exchange.markets
				};
			}
		},

		/**
		 * Charger les marchés d'un exchange
		 */
		loadMarkets: {
			params: {
				exchange: { type: "string", optional: true },
				reload: { type: "boolean", default: false }
			},
			cache: {
				keys: ["exchange"],
				ttl: 300 // 5 minutes
			},
			async handler(ctx) {
				const exchangeId = ctx.params.exchange || this.settings.defaultExchange;
				const { reload } = ctx.params;
				
				const exchange = this.getExchange(exchangeId);
				const markets = await this.retry(() => exchange.loadMarkets(reload));
				
				return {
					exchange: exchangeId,
					marketsCount: Object.keys(markets).length,
					symbols: exchange.symbols,
					markets: markets,
					timestamp: Date.now()
				};
			}
		},

		/**
		 * Obtenir un ticker pour un symbole
		 */
		fetchTicker: {
			params: {
				symbol: "string",
				exchange: { type: "string", optional: true }
			},
			cache: {
				keys: ["symbol", "exchange"],
				ttl: 30 // 30 secondes
			},
			async handler(ctx) {
				const { symbol } = ctx.params;
				const exchangeId = ctx.params.exchange || this.settings.defaultExchange;
				
				const exchange = this.getExchange(exchangeId);
				await this.ensureMarketsLoaded(exchange);
				
				const ticker = await this.retry(() => exchange.fetchTicker(symbol));
				
				return {
					exchange: exchangeId,
					symbol,
					ticker,
					timestamp: Date.now()
				};
			}
		},

		/**
		 * Obtenir plusieurs tickers
		 */
		fetchTickers: {
			params: {
				symbols: { type: "array", optional: true },
				exchange: { type: "string", optional: true }
			},
			cache: {
				keys: ["symbols", "exchange"],
				ttl: 30
			},
			async handler(ctx) {
				const { symbols } = ctx.params;
				const exchangeId = ctx.params.exchange || this.settings.defaultExchange;
				
				const exchange = this.getExchange(exchangeId);
				await this.ensureMarketsLoaded(exchange);
				
				if (!exchange.has.fetchTickers) {
					throw new Error(`Exchange ${exchangeId} does not support fetchTickers`);
				}
				
				const tickers = await this.retry(() => exchange.fetchTickers(symbols));
				
				return {
					exchange: exchangeId,
					symbols: symbols || Object.keys(tickers),
					tickers,
					count: Object.keys(tickers).length,
					timestamp: Date.now()
				};
			}
		},

		/**
		 * Obtenir l'ordre book
		 */
		fetchOrderBook: {
			params: {
				symbol: "string",
				limit: { type: "number", optional: true },
				exchange: { type: "string", optional: true }
			},
			cache: {
				keys: ["symbol", "limit", "exchange"],
				ttl: 10 // 10 secondes
			},
			async handler(ctx) {
				const { symbol, limit } = ctx.params;
				const exchangeId = ctx.params.exchange || this.settings.defaultExchange;
				
				const exchange = this.getExchange(exchangeId);
				await this.ensureMarketsLoaded(exchange);
				
				const orderbook = await this.retry(() => exchange.fetchOrderBook(symbol, limit));
				
				return {
					exchange: exchangeId,
					symbol,
					orderbook,
					timestamp: Date.now()
				};
			}
		},

		/**
		 * Obtenir les données OHLCV
		 */
		fetchOHLCV: {
			params: {
				symbol: "string",
				timeframe: { type: "string", default: "1h" },
				since: { type: "number", optional: true },
				limit: { type: "number", optional: true },
				exchange: { type: "string", optional: true }
			},
			cache: {
				keys: ["symbol", "timeframe", "since", "limit", "exchange"],
				ttl: 60 // 1 minute
			},
			async handler(ctx) {
				const { symbol, timeframe, since, limit } = ctx.params;
				const exchangeId = ctx.params.exchange || this.settings.defaultExchange;
				
				const exchange = this.getExchange(exchangeId);
				await this.ensureMarketsLoaded(exchange);
				
				if (!exchange.has.fetchOHLCV) {
					throw new Error(`Exchange ${exchangeId} does not support fetchOHLCV`);
				}
				
				if (!exchange.timeframes[timeframe]) {
					throw new Error(`Timeframe ${timeframe} is not supported by ${exchangeId}`);
				}
				
				const ohlcv = await this.retry(() => exchange.fetchOHLCV(symbol, timeframe, since, limit));
				
				return {
					exchange: exchangeId,
					symbol,
					timeframe,
					since,
					limit,
					ohlcv,
					count: ohlcv.length,
					timestamp: Date.now()
				};
			}
		},

		/**
		 * Obtenir les trades récents
		 */
		fetchTrades: {
			params: {
				symbol: "string",
				since: { type: "number", optional: true },
				limit: { type: "number", optional: true },
				exchange: { type: "string", optional: true }
			},
			cache: {
				keys: ["symbol", "since", "limit", "exchange"],
				ttl: 30
			},
			async handler(ctx) {
				const { symbol, since, limit } = ctx.params;
				const exchangeId = ctx.params.exchange || this.settings.defaultExchange;
				
				const exchange = this.getExchange(exchangeId);
				await this.ensureMarketsLoaded(exchange);
				
				const trades = await this.retry(() => exchange.fetchTrades(symbol, since, limit));
				
				return {
					exchange: exchangeId,
					symbol,
					since,
					limit,
					trades,
					count: trades.length,
					timestamp: Date.now()
				};
			}
		},

		/**
		 * Obtenir les devises supportées
		 */
		fetchCurrencies: {
			params: {
				exchange: { type: "string", optional: true }
			},
			cache: {
				keys: ["exchange"],
				ttl: 3600
			},
			async handler(ctx) {
				const exchangeId = ctx.params.exchange || this.settings.defaultExchange;
				
				const exchange = this.getExchange(exchangeId);
				
				if (!exchange.has.fetchCurrencies) {
					await this.ensureMarketsLoaded(exchange);
					return {
						exchange: exchangeId,
						currencies: exchange.currencies,
						count: Object.keys(exchange.currencies || {}).length,
						timestamp: Date.now()
					};
				}
				
				const currencies = await this.retry(() => exchange.fetchCurrencies());
				
				return {
					exchange: exchangeId,
					currencies,
					count: Object.keys(currencies).length,
					timestamp: Date.now()
				};
			}
		},

		/**
		 * Tester la connectivité d'un exchange
		 */
		testConnection: {
			params: {
				exchange: { type: "string", optional: true }
			},
			async handler(ctx) {
				const exchangeId = ctx.params.exchange || this.settings.defaultExchange;
				
				try {
					const exchange = this.getExchange(exchangeId);
					
					// Test basique - charger les marchés
					const startTime = Date.now();
					await exchange.loadMarkets();
					const loadTime = Date.now() - startTime;
					
					// Test fetch ticker sur un symbole populaire
					let tickerTest = null;
					if (exchange.symbols && exchange.symbols.length > 0) {
						const symbol = this.findCommonSymbol(exchange.symbols);
						if (symbol) {
							const tickerStartTime = Date.now();
							tickerTest = await exchange.fetchTicker(symbol);
							tickerTest.fetchTime = Date.now() - tickerStartTime;
						}
					}
					
					return {
						exchange: exchangeId,
						status: "connected",
						loadTime,
						marketsCount: Object.keys(exchange.markets).length,
						symbolsCount: exchange.symbols ? exchange.symbols.length : 0,
						tickerTest,
						capabilities: exchange.has,
						timestamp: Date.now()
					};
					
				} catch (err) {
					return {
						exchange: exchangeId,
						status: "error",
						error: err.message,
						timestamp: Date.now()
					};
				}
			}
		},

		/**
		 * Obtenir le statut de santé du service
		 */
		getHealth: {
			async handler(ctx) {
				const configured = Object.keys(this.settings.exchangeConfigs);
				const health = {
					status: "healthy",
					exchanges: {},
					summary: {
						total: configured.length,
						healthy: 0,
						errors: 0
					}
				};
				
				for (const exchangeId of configured) {
					try {
						const exchange = this.getExchange(exchangeId);
						const hasMarkets = !!exchange.markets;
						
						health.exchanges[exchangeId] = {
							status: "healthy",
							hasMarkets,
							symbolsCount: exchange.symbols ? exchange.symbols.length : 0,
							lastError: null
						};
						
						health.summary.healthy++;
					} catch (err) {
						health.exchanges[exchangeId] = {
							status: "error",
							error: err.message,
							lastError: Date.now()
						};
						
						health.summary.errors++;
					}
				}
				
				if (health.summary.errors > health.summary.healthy) {
					health.status = "degraded";
				}
				
				return health;
			}
		}
	},

	methods: {
		/**
		 * Obtenir une instance d'exchange
		 */
		getExchange(exchangeId) {
			if (!this.exchanges.has(exchangeId)) {
				this.createExchange(exchangeId);
			}
			
			return this.exchanges.get(exchangeId);
		},

		/**
		 * Créer une nouvelle instance d'exchange
		 */
		createExchange(exchangeId) {
			if (!ccxt.exchanges.includes(exchangeId)) {
				throw new Error(`Exchange ${exchangeId} is not supported by CCXT`);
			}
			
			const config = this.settings.exchangeConfigs[exchangeId] || {};
			const ExchangeClass = ccxt[exchangeId];
			
			const exchangeConfig = {
				...config,
				rateLimit: this.settings.rateLimit,
				enableRateLimit: this.settings.enableRateLimit,
				timeout: this.settings.timeout,
				verbose: this.logger.level === "debug"
			};
			
			// Nettoyer les clés vides
			Object.keys(exchangeConfig).forEach(key => {
				if (exchangeConfig[key] === undefined || exchangeConfig[key] === "") {
					delete exchangeConfig[key];
				}
			});
			
			const exchange = new ExchangeClass(exchangeConfig);
			this.exchanges.set(exchangeId, exchange);
			
			this.logger.info(`Created exchange instance: ${exchangeId}`, {
				hasCredentials: !!(config.apiKey && config.secret),
				sandbox: config.sandbox
			});
			
			return exchange;
		},

		/**
		 * S'assurer que les marchés sont chargés
		 */
		async ensureMarketsLoaded(exchange) {
			if (!exchange.markets) {
				await this.retry(() => exchange.loadMarkets());
			}
		},

		/**
		 * Retry avec backoff exponentiel
		 */
		async retry(fn, maxRetries = null, delay = null) {
			const retries = maxRetries || this.settings.maxRetries;
			const baseDelay = delay || this.settings.retryDelay;
			
			for (let attempt = 0; attempt <= retries; attempt++) {
				try {
					return await fn();
				} catch (err) {
					if (attempt === retries) {
						throw err;
					}
					
					// Gestion des erreurs spécifiques CCXT
					if (this.isRetryableError(err)) {
						const waitTime = baseDelay * Math.pow(2, attempt);
						this.logger.warn(`Retry attempt ${attempt + 1}/${retries + 1} after ${waitTime}ms`, {
							error: err.message,
							type: err.constructor.name
						});
						
						await this.sleep(waitTime);
					} else {
						throw err;
					}
				}
			}
		},

		/**
		 * Vérifier si l'erreur est retryable
		 */
		isRetryableError(err) {
			return err instanceof ccxt.NetworkError ||
				   err instanceof ccxt.RequestTimeout ||
				   err instanceof ccxt.DDoSProtection ||
				   (err instanceof ccxt.ExchangeNotAvailable);
		},

		/**
		 * Sleep utilitaire
		 */
		sleep(ms) {
			return new Promise(resolve => setTimeout(resolve, ms));
		},

		/**
		 * Trouver un symbole commun pour les tests
		 */
		findCommonSymbol(symbols) {
			const commonSymbols = ['BTC/USDT', 'BTC/USD', 'ETH/USDT', 'ETH/USD', 'ETH/BTC'];
			
			for (const symbol of commonSymbols) {
				if (symbols.includes(symbol)) {
					return symbol;
				}
			}
			
			return symbols[0]; // Fallback au premier symbole disponible
		}
	},

	/**
	 * Initialisation
	 */
	created() {
		// Map pour stocker les instances d'exchanges
		this.exchanges = new Map();
	},

	/**
	 * Démarrage
	 */
	async started() {
		this.logger.info("CCXT service started", {
			supportedExchanges: ccxt.exchanges.length,
			configuredExchanges: Object.keys(this.settings.exchangeConfigs),
			defaultExchange: this.settings.defaultExchange
		});
		
		// Pré-charger l'exchange par défaut
		try {
			const defaultExchange = this.getExchange(this.settings.defaultExchange);
			await defaultExchange.loadMarkets();
			this.logger.info(`Default exchange ${this.settings.defaultExchange} pre-loaded with ${defaultExchange.symbols.length} symbols`);
		} catch (err) {
			this.logger.warn(`Failed to pre-load default exchange: ${err.message}`);
		}
	},

	/**
	 * Arrêt
	 */
	async stopped() {
		// Fermer toutes les connexions
		for (const [exchangeId, exchange] of this.exchanges) {
			try {
				if (exchange.close) {
					await exchange.close();
				}
			} catch (err) {
				this.logger.warn(`Error closing exchange ${exchangeId}: ${err.message}`);
			}
		}
		
		this.exchanges.clear();
		this.logger.info("CCXT service stopped");
	}
};