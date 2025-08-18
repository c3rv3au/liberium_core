// services/pancakeswap.service.js
"use strict";

const { ethers } = require("ethers");
const BaseService = require("./base.service");

module.exports = {
	name: "pancakeswap",

	mixins: [BaseService],

	settings: {
		// Configuration BSC
		bsc: {
			rpcUrl: process.env.BSC_RPC_URL || "https://bsc-dataseed1.binance.org:443",
			chainId: 56
		},
		
		// Adresses des contrats PancakeSwap V2
		contracts: {
			factory: "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73",
			router: "0x10ED43C718714eb63d5aA57B78B54704E256024E",
			quoter: "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997"
		},
		
		// Tokens
		tokens: {
			WBNB: {
				address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
				decimals: 18,
				symbol: "WBNB"
			},
			USDT: {
				address: "0x55d398326f99059fF775485246999027B3197955",
				decimals: 18,
				symbol: "USDT"
			}
		},
		
		// Configuration des quotes
		quotes: {
			updateInterval: 5000,    // 5 secondes
			retryDelay: 2000,        // 2 secondes en cas d'erreur
			maxRetries: 3,
			amounts: [
				ethers.parseEther("1"),     // 1 WBNB
				ethers.parseEther("10"),    // 10 WBNB
				ethers.parseEther("100")    // 100 WBNB
			]
		}
	},

	actions: {
		/**
		 * Obtenir le quote USDT-WBNB en temps réel
		 */
		getQuote: {
			params: {
				amountIn: { type: "string", optional: true },
				tokenIn: { type: "string", optional: true, default: "WBNB" },
				tokenOut: { type: "string", optional: true, default: "USDT" }
			},
			async handler(ctx) {
				const { amountIn, tokenIn, tokenOut } = ctx.params;
				
				try {
					const amount = amountIn ? ethers.parseEther(amountIn) : ethers.parseEther("1");
					const quote = await this.getSwapQuote(tokenIn, tokenOut, amount);
					
					return {
						tokenIn,
						tokenOut,
						amountIn: ethers.formatEther(amount),
						amountOut: ethers.formatEther(quote.amountOut), // formatEther accepte les strings
						pricePerToken: ethers.formatEther(quote.pricePerToken), // formatEther accepte les strings
						timestamp: Date.now(),
						blockNumber: quote.blockNumber
					};
				} catch (err) {
					this.logger.error("Error getting quote:", err);
					throw err;
				}
			}
		},

		/**
		 * Obtenir toutes les données en temps réel
		 */
		getRealTimeData: {
			handler(ctx) {
				return {
					timestamp: Date.now(),
					quotes: this.memory.quotes || {},
					prices: this.memory.prices || {},
					lastUpdate: this.memory.lastUpdate,
					status: this.getConnectionStatus(),
					blockNumber: this.memory.blockNumber
				};
			}
		},

		/**
		 * Obtenir le prix WBNB/USDT
		 */
		getPrice: {
			handler(ctx) {
				const price = this.memory.prices?.["WBNB-USDT"];
				
				return {
					pair: "WBNB-USDT",
					price: price?.price || null,
					timestamp: price?.timestamp || null,
					blockNumber: price?.blockNumber || null
				};
			}
		},

		/**
		 * Obtenir le statut du service
		 */
		getStatus: {
			handler(ctx) {
				return {
					status: this.providerConnected ? "connected" : "disconnected",
					network: {
						chainId: this.settings.bsc.chainId,
						rpcUrl: this.settings.bsc.rpcUrl,
						blockNumber: this.memory.blockNumber
					},
					quotes: Object.keys(this.memory.quotes || {}).length,
					lastUpdate: this.memory.lastUpdate,
					uptime: this.getUptime(),
					timestamp: Date.now()
				};
			}
		},

		/**
		 * Forcer une mise à jour des quotes
		 */
		forceUpdate: {
			async handler(ctx) {
				try {
					await this.updateAllQuotes();
					return {
						updated: true,
						timestamp: Date.now(),
						quotes: this.memory.quotes
					};
				} catch (err) {
					this.logger.error("Error forcing update:", err);
					throw err;
				}
			}
		}
	},

	methods: {
		/**
		 * Convertir les BigInt en strings pour la sérialisation JSON
		 */
		serializeBigInt(obj) {
			return JSON.parse(JSON.stringify(obj, (key, value) =>
				typeof value === 'bigint' ? value.toString() : value
			));
		},

		/**
		 * Initialiser le provider BSC
		 */
		async initializeProvider() {
			try {
				this.provider = new ethers.JsonRpcProvider(this.settings.bsc.rpcUrl);
				
				// Tester la connexion
				const network = await this.provider.getNetwork();
				this.logger.info(`Connected to BSC network: ${network.name} (chainId: ${network.chainId})`);
				
				this.providerConnected = true;
				return true;
			} catch (err) {
				this.logger.error("Failed to initialize BSC provider:", err);
				this.providerConnected = false;
				return false;
			}
		},

		/**
		 * Obtenir un quote de swap
		 */
		async getSwapQuote(tokenInSymbol, tokenOutSymbol, amountIn) {
			const tokenIn = this.settings.tokens[tokenInSymbol];
			const tokenOut = this.settings.tokens[tokenOutSymbol];
			
			if (!tokenIn || !tokenOut) {
				throw new Error(`Token not supported: ${tokenInSymbol} or ${tokenOutSymbol}`);
			}

			try {
				// Utiliser le router pour simuler le swap
				const routerContract = new ethers.Contract(
					this.settings.contracts.router,
					this.getRouterABI(),
					this.provider
				);

				// getAmountsOut pour obtenir le quote
				const path = [tokenIn.address, tokenOut.address];
				const amounts = await routerContract.getAmountsOut(amountIn, path);
				
				const amountOut = amounts[1];
				const blockNumber = await this.provider.getBlockNumber();
				
				// Calculer le prix par token (éviter BigInt dans la division)
				const pricePerToken = (amountOut * ethers.parseEther("1")) / amountIn;

				return {
					amountOut: amountOut.toString(), // Convertir BigInt en string
					pricePerToken: pricePerToken.toString(), // Convertir BigInt en string
					blockNumber: Number(blockNumber), // Convertir en number
					path,
					timestamp: Date.now()
				};
			} catch (err) {
				this.logger.error(`Error getting swap quote ${tokenInSymbol}->${tokenOutSymbol}:`, err);
				throw err;
			}
		},

		/**
		 * Mettre à jour tous les quotes
		 */
		async updateAllQuotes() {
			if (!this.providerConnected) {
				await this.initializeProvider();
				if (!this.providerConnected) return;
			}

			try {
				const quotes = {};
				const prices = {};

				// Quote principal WBNB -> USDT
				for (const amount of this.settings.quotes.amounts) {
					const quote = await this.getSwapQuote("WBNB", "USDT", amount);
					const key = `WBNB-USDT-${ethers.formatEther(amount)}`;
					
					quotes[key] = {
						tokenIn: "WBNB",
						tokenOut: "USDT",
						amountIn: ethers.formatEther(amount),
						amountOut: ethers.formatEther(quote.amountOut), // formatEther accepte les strings
						pricePerToken: ethers.formatEther(quote.pricePerToken), // formatEther accepte les strings
						timestamp: quote.timestamp,
						blockNumber: quote.blockNumber
					};
				}

				// Prix de référence (1 WBNB)
				const mainQuote = quotes["WBNB-USDT-1"];
				if (mainQuote) {
					prices["WBNB-USDT"] = {
						price: mainQuote.pricePerToken,
						timestamp: mainQuote.timestamp,
						blockNumber: mainQuote.blockNumber
					};
				}

				// Obtenir le block number actuel (converti en number)
				const currentBlockNumber = Number(await this.provider.getBlockNumber());

				// Mettre à jour la mémoire locale via l'action updateMemory
				const newMemoryData = {
					quotes,
					prices,
					lastUpdate: Date.now(),
					blockNumber: currentBlockNumber,
					status: "active",
					network: {
						chainId: this.settings.bsc.chainId,
						blockNumber: currentBlockNumber
					}
				};

				// Utiliser l'action updateMemory du BaseService pour déclencher les notifications
				await this.broker.call(`${this.name}.updateMemory`, {
					data: newMemoryData,
					merge: true
				});

				this.logger.debug(`📊 Updated ${Object.keys(quotes).length} PancakeSwap quotes`, {
					mainPrice: mainQuote?.pricePerToken,
					blockNumber: newMemoryData.blockNumber,
					subscribers: this.subscriptions?.size || 0
				});

			} catch (err) {
				this.logger.error("Error updating quotes:", err);
				
				// Mettre à jour le statut d'erreur dans la mémoire
				await this.broker.call(`${this.name}.updateMemory`, {
					data: {
						status: "error",
						lastError: err.message,
						lastErrorTime: Date.now()
					},
					merge: true
				});
				
				// Programmer un retry
				setTimeout(() => {
					this.updateAllQuotes();
				}, this.settings.quotes.retryDelay);
			}
		},

		/**
		 * ABI minimal du router PancakeSwap
		 */
		getRouterABI() {
			return [
				"function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)",
				"function getAmountsIn(uint amountOut, address[] calldata path) external view returns (uint[] memory amounts)"
			];
		},

		/**
		 * Démarrer les mises à jour périodiques
		 */
		startPeriodicUpdates() {
			// Première mise à jour immédiate
			setTimeout(() => {
				this.updateAllQuotes();
			}, 1000);

			// Mises à jour périodiques
			this.updateTimer = setInterval(async () => {
				await this.updateAllQuotes();
			}, this.settings.quotes.updateInterval);

			this.logger.info(`Started periodic updates every ${this.settings.quotes.updateInterval}ms`);
		},

		/**
		 * Arrêter les mises à jour périodiques
		 */
		stopPeriodicUpdates() {
			if (this.updateTimer) {
				clearInterval(this.updateTimer);
				this.updateTimer = null;
			}
		},

		/**
		 * Obtenir le statut de connexion
		 */
		getConnectionStatus() {
			return {
				provider: this.providerConnected,
				network: this.settings.bsc.chainId,
				rpcUrl: this.settings.bsc.rpcUrl
			};
		},

		/**
		 * Obtenir l'uptime
		 */
		getUptime() {
			return this.startTime ? Date.now() - this.startTime : 0;
		},

		/**
		 * Initialiser la structure mémoire
		 */
		initializeMemory() {
			// Initialiser la mémoire avec une structure vide mais cohérente
			this.memory = {
				quotes: {},
				prices: {},
				lastUpdate: null,
				blockNumber: null,
				status: "initializing",
				network: {
					chainId: this.settings.bsc.chainId,
					rpcUrl: this.settings.bsc.rpcUrl,
					blockNumber: null
				},
				tokens: this.settings.tokens
			};

			this.logger.debug("PancakeSwap memory structure initialized");
		}
	},

	/**
	 * Démarrage du service
	 */
	async started() {
		this.startTime = Date.now();
		this.providerConnected = false;

		// Configurer la sérialisation BigInt globale pour ce service
		const originalStringify = JSON.stringify;
		JSON.stringify = function(value, replacer, space) {
			return originalStringify(value, function(key, val) {
				if (typeof val === 'bigint') {
					return val.toString();
				}
				return replacer ? replacer(key, val) : val;
			}, space);
		};

		this.logger.info("Starting PancakeSwap service", {
			rpcUrl: this.settings.bsc.rpcUrl,
			tokens: Object.keys(this.settings.tokens),
			updateInterval: this.settings.quotes.updateInterval
		});

		// Initialiser la mémoire
		this.initializeMemory();

		// Initialiser le provider
		await this.initializeProvider();

		// Démarrer les mises à jour si connecté
		if (this.providerConnected) {
			this.startPeriodicUpdates();
		}

		this.logger.info("PancakeSwap service started", {
			connected: this.providerConnected,
			uptime: this.getUptime()
		});
	},

	/**
	 * Arrêt du service
	 */
	async stopped() {
		// Arrêter les mises à jour
		this.stopPeriodicUpdates();

		// Fermer le provider si nécessaire
		if (this.provider) {
			try {
				await this.provider.destroy?.();
			} catch (err) {
				this.logger.warn("Error closing provider:", err);
			}
		}

		this.logger.info("PancakeSwap service stopped", {
			uptime: this.getUptime()
		});
	}
};