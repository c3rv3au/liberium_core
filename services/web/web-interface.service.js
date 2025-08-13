// services/web-interface.service.js
"use strict";

const { Service } = require("moleculer");
const http = require("http");
const url = require("url");

module.exports = {
	name: "webInterface",
	//version: 1,

	settings: {
		port: process.env.WEB_PORT || 3000,
		host: process.env.WEB_HOST || "0.0.0.0"
	},

	dependencies: [
		"coderdb"
	],

	methods: {
		/**
		 * Créer le serveur HTTP
		 */
		createServer() {
			this.server = http.createServer(async (req, res) => {
				try {
					await this.handleRequest(req, res);
				} catch (err) {
					this.logger.error("Request error:", err);
					this.sendError(res, 500, "Internal Server Error");
				}
			});
		},

		/**
		 * Gérer les requêtes HTTP
		 */
		async handleRequest(req, res) {
			const parsedUrl = url.parse(req.url, true);
			const pathname = parsedUrl.pathname;
			const method = req.method;

			// CORS headers
			res.setHeader("Access-Control-Allow-Origin", "*");
			res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
			res.setHeader("Access-Control-Allow-Headers", "Content-Type");

			if (method === "OPTIONS") {
				res.writeHead(200);
				res.end();
				return;
			}

			// Routes statiques
			if (pathname === "/" || pathname === "/index.html") {
				return this.serveStaticContent(res, "index.html", "text/html");
			}

			if (pathname === "/styles.css") {
				return this.serveStaticContent(res, "styles.css", "text/css");
			}

			if (pathname === "/app.js") {
				return this.serveStaticContent(res, "app.js", "application/javascript");
			}

			// API Routes
			if (pathname.startsWith("/api/")) {
				return this.handleApiRequest(req, res, pathname, method);
			}

			this.sendError(res, 404, "Not Found");
		},

		/**
		 * Servir le contenu statique
		 */
		async serveStaticContent(res, filename, contentType) {
			try {
				let content = "";
				
				switch (filename) {
					case "index.html":
						content = this.getIndexHtml();
						break;
					case "styles.css":
						content = this.getStylesCss();
						break;
					case "app.js":
						content = this.getAppJs();
						break;
					default:
						throw new Error("File not found");
				}
				
				res.writeHead(200, { "Content-Type": contentType });
				res.end(content);
			} catch (err) {
				this.sendError(res, 404, "File not found");
			}
		},

		/**
		 * Gérer les requêtes API
		 */
		async handleApiRequest(req, res, pathname, method) {
			const body = await this.getRequestBody(req);

			try {
				switch (true) {
					case pathname === "/api/functions" && method === "GET":
						return this.handleListFunctions(res);

					case pathname === "/api/functions" && method === "POST":
						return this.handleCreateFunction(res, body);

					case pathname.match(/^\/api\/functions\/[^\/]+$/) && method === "GET":
						const name = decodeURIComponent(pathname.split("/")[3]);
						return this.handleGetFunction(res, name);

					case pathname.match(/^\/api\/functions\/[^\/]+$/) && method === "PUT":
						const updateName = decodeURIComponent(pathname.split("/")[3]);
						return this.handleUpdateFunction(res, updateName, body);

					case pathname.match(/^\/api\/functions\/[^\/]+$/) && method === "DELETE":
						const deleteName = decodeURIComponent(pathname.split("/")[3]);
						return this.handleDeleteFunction(res, deleteName);

					case pathname.match(/^\/api\/functions\/[^\/]+\/promote$/) && method === "POST":
						const promoteName = decodeURIComponent(pathname.split("/")[3]);
						return this.handlePromoteToProduction(res, promoteName);

					case pathname === "/api/status" && method === "GET":
						return this.handleGetStatus(res);

					default:
						this.sendError(res, 404, "API endpoint not found");
				}
			} catch (err) {
				this.logger.error("API error:", err);
				this.sendError(res, 500, err.message);
			}
		},

		/**
		 * Lire le body de la requête
		 */
		async getRequestBody(req) {
			return new Promise((resolve, reject) => {
				let body = "";
				req.on("data", chunk => body += chunk.toString());
				req.on("end", () => {
					try {
						resolve(body ? JSON.parse(body) : {});
					} catch (err) {
						reject(new Error("Invalid JSON"));
					}
				});
				req.on("error", reject);
			});
		},

		/**
		 * Envoyer une réponse JSON
		 */
		sendJson(res, statusCode, data) {
			res.writeHead(statusCode, { "Content-Type": "application/json" });
			res.end(JSON.stringify(data, null, 2));
		},

		/**
		 * Envoyer une erreur
		 */
		sendError(res, statusCode, message) {
			this.sendJson(res, statusCode, { error: message });
		},

		// Handlers API
		async handleListFunctions(res) {
			try {
				const functions = await this.broker.call("coderdb.listFunctions");
				this.sendJson(res, 200, functions);
			} catch (err) {
				this.logger.error("Failed to list functions:", err);
				this.sendError(res, 500, "Failed to load functions");
			}
		},

		async handleCreateFunction(res, body) {
			try {
				const result = await this.broker.call("coderdb.createFunction", body);
				this.sendJson(res, 201, result);
			} catch (err) {
				this.logger.error("Failed to create function:", err);
				this.sendError(res, 400, err.message);
			}
		},

		async handleGetFunction(res, name) {
			try {
				const func = await this.broker.call("coderdb.getFunction", { name });
				this.sendJson(res, 200, func);
			} catch (err) {
				this.logger.error("Failed to get function:", err);
				this.sendError(res, 404, err.message);
			}
		},

		async handleUpdateFunction(res, name, body) {
			try {
				const result = await this.broker.call("coderdb.updateFunction", { name, ...body });
				this.sendJson(res, 200, result);
			} catch (err) {
				this.logger.error("Failed to update function:", err);
				this.sendError(res, 400, err.message);
			}
		},

		async handleDeleteFunction(res, name) {
			try {
				const result = await this.broker.call("coderdb.deleteFunction", { name });
				this.sendJson(res, 200, result);
			} catch (err) {
				this.logger.error("Failed to delete function:", err);
				this.sendError(res, 400, err.message);
			}
		},

		async handlePromoteToProduction(res, name) {
			try {
				const result = await this.broker.call("coderdb.promoteToProduction", { name });
				this.sendJson(res, 200, result);
			} catch (err) {
				this.logger.error("Failed to promote function:", err);
				this.sendError(res, 400, err.message);
			}
		},

		async handleGetStatus(res) {
			try {
				const status = await this.broker.call("coderdb.getStatus");
				this.sendJson(res, 200, status);
			} catch (err) {
				this.logger.error("Failed to get status:", err);
				this.sendError(res, 500, "Failed to get status");
			}
		},

		/**
		 * Générer le contenu HTML minifié
		 */
		getIndexHtml() {
			return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>CoderDB - Interface</title><link rel="stylesheet" href="/styles.css"></head><body><div class="container"><header><h1>CoderDB - Interface</h1><div class="status" id="status"><span id="node-status">Chargement...</span><button onclick="refreshStatus()" class="btn btn-sm">🔄</button></div></header><nav class="tabs"><button class="tab-btn active" onclick="showTab('functions')">Fonctions</button><button class="tab-btn" onclick="showTab('editor')">Éditeur</button><button class="tab-btn" onclick="showTab('production')">Production</button></nav><div id="functions-tab" class="tab-content active"><div class="toolbar"><button onclick="showEditor()" class="btn btn-primary">➕ Nouvelle fonction</button><button onclick="loadFunctions()" class="btn">🔄 Actualiser</button><input type="text" id="search" placeholder="Rechercher..." onkeyup="filterFunctions()"></div><div class="functions-grid" id="functions-list"></div></div><div id="editor-tab" class="tab-content"><div class="editor-container"><div class="editor-header"><input type="text" id="function-name" placeholder="Nom de la fonction" class="form-input"><div class="editor-actions"><button onclick="saveFunction()" class="btn btn-primary">💾 Sauvegarder</button><button onclick="testFunction()" class="btn btn-secondary">🧪 Tester</button><button onclick="clearEditor()" class="btn btn-danger">🗑️ Effacer</button></div></div><div class="editor-panels"><div class="panel"><h3>Paramètres d'entrée</h3><div id="input-params"></div><button onclick="addInputParam()" class="btn btn-sm">➕ Ajouter</button></div><div class="panel"><h3>Paramètres de sortie</h3><div id="output-params"></div><button onclick="addOutputParam()" class="btn btn-sm">➕ Ajouter</button></div></div><div class="code-panels"><div class="code-panel"><h3>Code de la fonction</h3><textarea id="function-code" placeholder="function(inputParams) {\\n    // Votre code ici\\n    return result;\\n}" rows="15"></textarea></div><div class="code-panel"><h3>Code de test</h3><textarea id="test-code" placeholder="// Tests pour votre fonction\\nfunction test() {\\n    const result = functionName(testParams);\\n    console.assert(result === expectedValue, 'Test failed');\\n    return 'Tests passed!';\\n}" rows="15"></textarea></div></div><div class="test-results" id="test-results" style="display: none;"><h3>Résultats des tests</h3><pre id="test-output"></pre></div></div></div><div id="production-tab" class="tab-content"><div class="production-header"><h2>Gestion de production</h2><p>Promouvoir les fonctions développées vers la production</p></div><div class="production-pipeline"><div class="pipeline-section"><h3>🔧 Développement</h3><div id="dev-functions" class="function-cards"></div></div><div class="pipeline-arrow">➡️</div><div class="pipeline-section"><h3>🚀 Production</h3><div id="prod-functions" class="function-cards"></div></div></div></div></div><div id="modal" class="modal" style="display: none;"><div class="modal-content"><span class="close" onclick="closeModal()">&times;</span><div id="modal-body"></div></div></div><script src="/app.js"></script></body></html>`;
		},

		/**
		 * CSS minifié pour performance
		 */
		getStylesCss() {
			return `*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);min-height:100vh;color:#333}.container{max-width:1400px;margin:0 auto;padding:20px}header{background:rgba(255,255,255,0.95);border-radius:15px;padding:20px;margin-bottom:20px;display:flex;justify-content:space-between;align-items:center;box-shadow:0 8px 32px rgba(0,0,0,0.1);backdrop-filter:blur(10px)}header h1{color:#2c3e50;font-size:2.5em;font-weight:700}.status{display:flex;align-items:center;gap:10px;background:#ecf0f1;padding:10px 15px;border-radius:8px}.tabs{display:flex;background:rgba(255,255,255,0.9);border-radius:12px;padding:5px;margin-bottom:20px;box-shadow:0 4px 20px rgba(0,0,0,0.1)}.tab-btn{flex:1;padding:12px 24px;border:none;background:transparent;border-radius:8px;cursor:pointer;font-weight:600;transition:all 0.3s ease}.tab-btn.active{background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:white;box-shadow:0 4px 15px rgba(102,126,234,0.4)}.tab-content{display:none;background:rgba(255,255,255,0.95);border-radius:15px;padding:25px;box-shadow:0 8px 32px rgba(0,0,0,0.1);backdrop-filter:blur(10px)}.tab-content.active{display:block}.btn{padding:10px 20px;border:none;border-radius:8px;cursor:pointer;font-weight:600;transition:all 0.3s ease;text-decoration:none;display:inline-block}.btn-primary{background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:white}.btn-secondary{background:linear-gradient(135deg,#ffecd2 0%,#fcb69f 100%);color:#333}.btn-danger{background:linear-gradient(135deg,#ff6b6b 0%,#ee5a52 100%);color:white}.btn-sm{padding:5px 10px;font-size:0.9em}.btn:hover{transform:translateY(-2px);box-shadow:0 5px 15px rgba(0,0,0,0.2)}.toolbar{display:flex;gap:15px;margin-bottom:25px;align-items:center;flex-wrap:wrap}#search{padding:10px 15px;border:2px solid #e0e0e0;border-radius:8px;flex:1;min-width:200px;font-size:16px}.functions-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(350px,1fr));gap:20px}.function-card{background:white;border-radius:12px;padding:20px;box-shadow:0 4px 20px rgba(0,0,0,0.1);transition:all 0.3s ease;border-left:4px solid #667eea}.function-card:hover{transform:translateY(-5px);box-shadow:0 8px 30px rgba(0,0,0,0.15)}.function-card h3{color:#2c3e50;margin-bottom:10px;font-size:1.3em}.function-meta{color:#7f8c8d;font-size:0.9em;margin-bottom:15px}.function-actions{display:flex;gap:10px;margin-top:15px;flex-wrap:wrap}.function-actions .btn{padding:5px 12px;font-size:0.9em}.editor-container{max-width:100%}.editor-header{display:flex;gap:15px;margin-bottom:25px;align-items:center;flex-wrap:wrap}.form-input{padding:12px 15px;border:2px solid #e0e0e0;border-radius:8px;font-size:16px;flex:1;min-width:200px}.editor-actions{display:flex;gap:10px}.editor-panels{display:grid;grid-template-columns:1fr 1fr;gap:25px;margin-bottom:25px}.panel{background:#f8f9fa;padding:20px;border-radius:12px;border:2px solid #e9ecef}.panel h3{margin-bottom:15px;color:#495057}.param-item{display:grid;grid-template-columns:1fr 120px 2fr 40px;gap:10px;margin-bottom:10px;align-items:center}.param-name,.param-type,.param-desc{padding:8px 12px;border:1px solid #ced4da;border-radius:6px;font-size:14px}.btn-remove{background:#dc3545;color:white;border:none;border-radius:4px;padding:5px;cursor:pointer;font-size:12px}.code-panels{display:grid;grid-template-columns:1fr 1fr;gap:25px;margin-bottom:25px}.code-panel h3{margin-bottom:10px;color:#495057}textarea{width:100%;padding:15px;border:2px solid #e0e0e0;border-radius:8px;font-family:'Consolas','Monaco','Courier New',monospace;font-size:14px;line-height:1.5;resize:vertical}.test-results{background:#f8f9fa;padding:20px;border-radius:12px;border-left:4px solid #28a745}.test-results pre{background:#2d3748;color:#e2e8f0;padding:15px;border-radius:8px;overflow-x:auto;font-family:'Consolas','Monaco','Courier New',monospace}.production-header{text-align:center;margin-bottom:30px}.production-pipeline{display:grid;grid-template-columns:1fr auto 1fr;gap:30px;align-items:start}.pipeline-section{background:#f8f9fa;padding:25px;border-radius:12px;border:2px solid #e9ecef}.pipeline-section h3{margin-bottom:20px;text-align:center;font-size:1.5em}.pipeline-arrow{font-size:2em;color:#667eea;align-self:center}.function-cards{display:flex;flex-direction:column;gap:15px}.function-card-small{background:white;padding:15px;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,0.1);display:flex;justify-content:space-between;align-items:center}.function-card-small.dev{border-left:4px solid #ffc107}.function-card-small.prod{border-left:4px solid #28a745}.modal{position:fixed;z-index:1000;left:0;top:0;width:100%;height:100%;background-color:rgba(0,0,0,0.5);backdrop-filter:blur(5px)}.modal-content{background-color:white;margin:5% auto;padding:30px;border-radius:15px;width:90%;max-width:600px;box-shadow:0 20px 60px rgba(0,0,0,0.3)}.close{color:#aaa;float:right;font-size:28px;font-weight:bold;cursor:pointer;line-height:1}.close:hover{color:#000}.status-indicator{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:8px}.status-master{background-color:#28a745}.status-slave{background-color:#ffc107}.status-offline{background-color:#dc3545}@media (max-width:768px){.container{padding:10px}.editor-panels,.code-panels,.production-pipeline{grid-template-columns:1fr}.pipeline-arrow{transform:rotate(90deg)}.functions-grid{grid-template-columns:1fr}.param-item{grid-template-columns:1fr;gap:8px}.toolbar{flex-direction:column;align-items:stretch}.editor-header{flex-direction:column;align-items:stretch}}`;
		},

		/**
		 * JavaScript minifié pour performance
		 */
		getAppJs() {
			return `class CoderDBInterface{constructor(){this.currentFunction=null;this.functions=[];this.init()}async init(){await this.loadFunctions();await this.refreshStatus();this.loadProductionView()}async apiCall(endpoint,method='GET',data=null){try{const options={method,headers:{'Content-Type':'application/json'}};if(data){options.body=JSON.stringify(data)}const response=await fetch(\`/api\${endpoint}\`,options);const result=await response.json();if(!response.ok){throw new Error(result.error||'Erreur API')}return result}catch(error){this.showError(error.message);throw error}}async loadFunctions(){try{this.functions=await this.apiCall('/functions');this.renderFunctions()}catch(error){console.error('Erreur chargement fonctions:',error)}}renderFunctions(){const container=document.getElementById('functions-list');if(!container)return;if(this.functions.length===0){container.innerHTML=\`<div style="text-align:center;padding:40px;color:#666;"><h3>Aucune fonction trouvée</h3><p>Commencez par créer une nouvelle fonction</p><button onclick="app.showEditor()" class="btn btn-primary">Créer ma première fonction</button></div>\`;return}container.innerHTML=this.functions.map(func=>\`<div class="function-card \${func.environment||'dev'}" data-name="\${func.name}"><h3>\${func.name}</h3><div class="function-meta"><div><span class="status-indicator status-\${func.environment==='production'?'prod':'dev'}"></span>\${func.environment==='production'?'Production':'Développement'}</div><div>Créé: \${new Date(func.createdAt).toLocaleDateString()}</div><div>Modifié: \${new Date(func.updatedAt).toLocaleDateString()}</div></div><div class="function-params"><strong>Entrées:</strong> \${func.inputParams?.length||0} paramètres<br><strong>Sorties:</strong> \${func.outputParams?.length||0} paramètres</div><div class="function-actions"><button onclick="app.editFunction('\${func.name}')" class="btn btn-primary">✏️ Éditer</button><button onclick="app.testFunction('\${func.name}')" class="btn btn-secondary">🧪 Tester</button><button onclick="app.cloneFunction('\${func.name}')" class="btn">📋 Cloner</button>\${func.environment!=='production'?\`<button onclick="app.promoteToProduction('\${func.name}')" class="btn" style="background:#28a745;color:white;">🚀 Production</button>\`:''}<button onclick="app.deleteFunction('\${func.name}')" class="btn btn-danger">🗑️ Supprimer</button></div></div>\`).join('')}filterFunctions(){const search=document.getElementById('search').value.toLowerCase();const cards=document.querySelectorAll('.function-card');cards.forEach(card=>{const name=card.getAttribute('data-name').toLowerCase();card.style.display=name.includes(search)?'block':'none'})}showEditor(functionName=null){this.showTab('editor');if(functionName){this.loadFunctionInEditor(functionName)}else{this.clearEditor()}}async loadFunctionInEditor(name){try{const func=await this.apiCall(\`/functions/\${encodeURIComponent(name)}\`);this.currentFunction=func;document.getElementById('function-name').value=func.name;document.getElementById('function-code').value=func.code;document.getElementById('test-code').value=func.testCode;this.loadParams('input-params',func.inputParams||[]);this.loadParams('output-params',func.outputParams||[])}catch(error){console.error('Erreur chargement fonction:',error)}}loadParams(containerId,params){const container=document.getElementById(containerId);container.innerHTML=params.map(param=>\`<div class="param-item"><input type="text" placeholder="Nom" class="param-name" value="\${param.name||''}"><select class="param-type"><option value="string" \${param.type==='string'?'selected':''}>string</option><option value="number" \${param.type==='number'?'selected':''}>number</option><option value="boolean" \${param.type==='boolean'?'selected':''}>boolean</option><option value="object" \${param.type==='object'?'selected':''}>object</option><option value="array" \${param.type==='array'?'selected':''}>array</option><option value="any" \${param.type==='any'?'selected':''}>any</option></select><input type="text" placeholder="Description" class="param-desc" value="\${param.description||''}"><button onclick="app.removeParam(this)" class="btn-remove">✕</button></div>\`).join('');if(params.length===0){this.addParam(containerId)}}clearEditor(){this.currentFunction=null;document.getElementById('function-name').value='';document.getElementById('function-code').value='';document.getElementById('test-code').value='';document.getElementById('input-params').innerHTML='';document.getElementById('output-params').innerHTML='';this.addInputParam();this.addOutputParam();document.getElementById('test-results').style.display='none'}addInputParam(){this.addParam('input-params')}addOutputParam(){this.addParam('output-params')}addParam(containerId){const container=document.getElementById(containerId);const paramDiv=document.createElement('div');paramDiv.className='param-item';paramDiv.innerHTML=\`<input type="text" placeholder="Nom" class="param-name"><select class="param-type"><option value="string">string</option><option value="number">number</option><option value="boolean">boolean</option><option value="object">object</option><option value="array">array</option><option value="any">any</option></select><input type="text" placeholder="Description" class="param-desc"><button onclick="app.removeParam(this)" class="btn-remove">✕</button>\`;container.appendChild(paramDiv)}removeParam(button){button.parentElement.remove()}getParamsFromContainer(containerId){const container=document.getElementById(containerId);const paramItems=container.querySelectorAll('.param-item');return Array.from(paramItems).map(item=>{const name=item.querySelector('.param-name').value.trim();const type=item.querySelector('.param-type').value;const description=item.querySelector('.param-desc').value.trim();return name?{name,type,description}:null}).filter(param=>param!==null)}async saveFunction(){try{const name=document.getElementById('function-name').value.trim();const code=document.getElementById('function-code').value.trim();const testCode=document.getElementById('test-code').value.trim();if(!name||!code||!testCode){this.showError('Tous les champs sont requis');return}const inputParams=this.getParamsFromContainer('input-params');const outputParams=this.getParamsFromContainer('output-params');const functionData={name,inputParams,outputParams,code,testCode};if(this.currentFunction){await this.apiCall(\`/functions/\${encodeURIComponent(this.currentFunction.name)}\`,'PUT',functionData);this.showSuccess('Fonction mise à jour avec succès')}else{await this.apiCall('/functions','POST',functionData);this.showSuccess('Fonction créée avec succès')}await this.loadFunctions();this.loadProductionView()}catch(error){console.error('Erreur sauvegarde:',error)}}async testFunction(){const code=document.getElementById('function-code').value.trim();const testCode=document.getElementById('test-code').value.trim();if(!code||!testCode){this.showError('Code de fonction et de test requis');return}try{const result=this.executeTest(code,testCode);const resultsDiv=document.getElementById('test-results');const outputPre=document.getElementById('test-output');outputPre.textContent=result;resultsDiv.style.display='block'}catch(error){const resultsDiv=document.getElementById('test-results');const outputPre=document.getElementById('test-output');outputPre.textContent=\`Erreur: \${error.message}\`;resultsDiv.style.display='block'}}executeTest(functionCode,testCode){try{const functionWrapper=new Function('return '+functionCode)();const testWrapper=new Function('functionName',testCode);let output='';const originalLog=console.log;const originalAssert=console.assert;console.log=(...args)=>{output+=args.join(' ')+'\\n'};console.assert=(condition,message)=>{if(!condition){output+=\`ASSERTION FAILED: \${message}\\n\`}};const result=testWrapper(functionWrapper);console.log=originalLog;console.assert=originalAssert;return output+(result?\`\\nRésultat: \${result}\`:'')}catch(error){throw new Error(\`Erreur d'exécution: \${error.message}\`)}}async editFunction(name){this.showEditor(name)}async cloneFunction(name){try{const func=await this.apiCall(\`/functions/\${encodeURIComponent(name)}\`);const newName=prompt('Nom de la nouvelle fonction:',\`\${func.name}_copy\`);if(!newName)return;const clonedFunction={...func,name:newName};delete clonedFunction.createdAt;delete clonedFunction.updatedAt;await this.apiCall('/functions','POST',clonedFunction);this.showSuccess('Fonction clonée avec succès');await this.loadFunctions()}catch(error){console.error('Erreur clonage:',error)}}async deleteFunction(name){if(!confirm(\`Êtes-vous sûr de vouloir supprimer la fonction "\${name}" ?\`)){return}try{await this.apiCall(\`/functions/\${encodeURIComponent(name)}\`,'DELETE');this.showSuccess('Fonction supprimée avec succès');await this.loadFunctions();this.loadProductionView()}catch(error){console.error('Erreur suppression:',error)}}async promoteToProduction(name){if(!confirm(\`Promouvoir "\${name}" en production ?\`)){return}try{await this.apiCall(\`/functions/\${encodeURIComponent(name)}/promote\`,'POST');this.showSuccess('Fonction promue en production');await this.loadFunctions();this.loadProductionView()}catch(error){console.error('Erreur promotion:',error)}}loadProductionView(){const devFunctions=this.functions.filter(f=>f.environment!=='production');const prodFunctions=this.functions.filter(f=>f.environment==='production');this.renderProductionFunctions('dev-functions',devFunctions,'dev');this.renderProductionFunctions('prod-functions',prodFunctions,'prod')}renderProductionFunctions(containerId,functions,type){const container=document.getElementById(containerId);if(!container)return;if(functions.length===0){container.innerHTML=\`<div style="text-align:center;padding:20px;color:#666;"><p>Aucune fonction en \${type==='dev'?'développement':'production'}</p></div>\`;return}container.innerHTML=functions.map(func=>\`<div class="function-card-small \${type}"><div><strong>\${func.name}</strong><br><small>Modifié: \${new Date(func.updatedAt).toLocaleDateString()}</small></div><div>\${type==='dev'?\`<button onclick="app.promoteToProduction('\${func.name}')" class="btn btn-sm" style="background:#28a745;color:white;">🚀 Promouvoir</button>\`:\`<span style="color:#28a745;">✅ En production</span>\`}</div></div>\`).join('')}async refreshStatus(){try{const status=await this.apiCall('/status');const statusElement=document.getElementById('node-status');statusElement.innerHTML=\`<span class="status-indicator status-\${status.isMaster?'master':'slave'}"></span>Node: \${status.nodeId} (\${status.isMaster?'Master':'Slave'}) | Fonctions: \${status.functionsCount}\`}catch(error){const statusElement=document.getElementById('node-status');statusElement.innerHTML=\`<span class="status-indicator status-offline"></span>Hors ligne\`}}showTab(tabName){document.querySelectorAll('.tab-content').forEach(tab=>{tab.classList.remove('active')});document.querySelectorAll('.tab-btn').forEach(btn=>{btn.classList.remove('active')});document.getElementById(\`\${tabName}-tab\`).classList.add('active');document.querySelector(\`[onclick="showTab('\${tabName}')"]\`).classList.add('active')}showSuccess(message){this.showToast(message,'success')}showError(message){this.showToast(message,'error')}showToast(message,type){const toast=document.createElement('div');toast.className=\`toast toast-\${type}\`;toast.textContent=message;toast.style.cssText=\`position:fixed;top:20px;right:20px;padding:15px 20px;border-radius:8px;color:white;font-weight:600;z-index:1001;background:\${type==='success'?'#28a745':'#dc3545'};box-shadow:0 4px 20px rgba(0,0,0,0.3);transform:translateX(400px);transition:transform 0.3s ease;\`;document.body.appendChild(toast);setTimeout(()=>{toast.style.transform='translateX(0)'},100);setTimeout(()=>{toast.style.transform='translateX(400px)';setTimeout(()=>{if(document.body.contains(toast)){document.body.removeChild(toast)}},300)},3000)}}const app=new CoderDBInterface();function showTab(tabName){app.showTab(tabName)}function showEditor(){app.showEditor()}function loadFunctions(){app.loadFunctions()}function filterFunctions(){app.filterFunctions()}function saveFunction(){app.saveFunction()}function testFunction(){app.testFunction()}function clearEditor(){app.clearEditor()}function addInputParam(){app.addInputParam()}function addOutputParam(){app.addOutputParam()}function removeParam(button){app.removeParam(button)}function refreshStatus(){app.refreshStatus()}function closeModal(){const modal=document.getElementById('modal');modal.style.display='none'}window.onclick=function(event){const modal=document.getElementById('modal');if(event.target===modal){closeModal()}}`;
		}
	},

	async started() {
		this.createServer();
		
		this.server.listen(this.settings.port, this.settings.host, () => {
			this.logger.info(`Web interface started on http://${this.settings.host}:${this.settings.port}`);
		});
	},

	async stopped() {
		if (this.server) {
			this.server.close();
		}
		this.logger.info("Web interface stopped");
	}
};