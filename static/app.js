// app.js
class CoderDBInterface {
    constructor() {
        this.currentFunction = null;
        this.functions = [];
        this.init();
    }

    async init() {
        await this.loadFunctions();
        await this.refreshStatus();
        this.loadProductionView();
    }

    // API Calls
    async apiCall(endpoint, method = 'GET', data = null) {
        try {
            const options = {
                method,
                headers: {
                    'Content-Type': 'application/json'
                }
            };

            if (data) {
                options.body = JSON.stringify(data);
            }

            const response = await fetch(`/api${endpoint}`, options);
            const result = await response.json();

            if (!response.ok) {
                throw new Error(result.error || 'Erreur API');
            }

            return result;
        } catch (error) {
            this.showError(error.message);
            throw error;
        }
    }

    // Gestion des fonctions
    async loadFunctions() {
        try {
            this.functions = await this.apiCall('/functions');
            this.renderFunctions();
        } catch (error) {
            console.error('Erreur chargement fonctions:', error);
        }
    }

    renderFunctions() {
        const container = document.getElementById('functions-list');
        if (!container) return;

        if (this.functions.length === 0) {
            container.innerHTML = `
                <div style="text-align: center; padding: 40px; color: #666;">
                    <h3>Aucune fonction trouvée</h3>
                    <p>Commencez par créer une nouvelle fonction</p>
                    <button onclick="app.showEditor()" class="btn btn-primary">Créer ma première fonction</button>
                </div>
            `;
            return;
        }

        container.innerHTML = this.functions.map(func => `
            <div class="function-card ${func.environment || 'dev'}" data-name="${func.name}">
                <h3>${func.name}</h3>
                <div class="function-meta">
                    <div>
                        <span class="status-indicator status-${func.environment || 'dev'}"></span>
                        ${func.environment === 'production' ? 'Production' : 'Développement'}
                    </div>
                    <div>Créé: ${new Date(func.createdAt).toLocaleDateString()}</div>
                    <div>Modifié: ${new Date(func.updatedAt).toLocaleDateString()}</div>
                </div>
                <div class="function-params">
                    <strong>Entrées:</strong> ${func.inputParams?.length || 0} paramètres<br>
                    <strong>Sorties:</strong> ${func.outputParams?.length || 0} paramètres
                </div>
                <div class="function-actions">
                    <button onclick="app.editFunction('${func.name}')" class="btn btn-primary">✏️ Éditer</button>
                    <button onclick="app.testFunction('${func.name}')" class="btn btn-secondary">🧪 Tester</button>
                    <button onclick="app.cloneFunction('${func.name}')" class="btn">📋 Cloner</button>
                    ${func.environment !== 'production' ? 
                        `<button onclick="app.promoteToProduction('${func.name}')" class="btn" style="background: #28a745; color: white;">🚀 Production</button>` : 
                        ''
                    }
                    <button onclick="app.deleteFunction('${func.name}')" class="btn btn-danger">🗑️ Supprimer</button>
                </div>
            </div>
        `).join('');
    }

    filterFunctions() {
        const search = document.getElementById('search').value.toLowerCase();
        const cards = document.querySelectorAll('.function-card');
        
        cards.forEach(card => {
            const name = card.getAttribute('data-name').toLowerCase();
            card.style.display = name.includes(search) ? 'block' : 'none';
        });
    }

    // Éditeur
    showEditor(functionName = null) {
        this.showTab('editor');
        
        if (functionName) {
            this.loadFunctionInEditor(functionName);
        } else {
            this.clearEditor();
        }
    }

    async loadFunctionInEditor(name) {
        try {
            const func = await this.apiCall(`/functions/${name}`);
            this.currentFunction = func;
            
            document.getElementById('function-name').value = func.name;
            document.getElementById('function-code').value = func.code;
            document.getElementById('test-code').value = func.testCode;
            
            this.loadParams('input-params', func.inputParams || []);
            this.loadParams('output-params', func.outputParams || []);
        } catch (error) {
            console.error('Erreur chargement fonction:', error);
        }
    }

    loadParams(containerId, params) {
        const container = document.getElementById(containerId);
        container.innerHTML = params.map(param => `
            <div class="param-item">
                <input type="text" placeholder="Nom" class="param-name" value="${param.name || ''}">
                <select class="param-type">
                    <option value="string" ${param.type === 'string' ? 'selected' : ''}>string</option>
                    <option value="number" ${param.type === 'number' ? 'selected' : ''}>number</option>
                    <option value="boolean" ${param.type === 'boolean' ? 'selected' : ''}>boolean</option>
                    <option value="object" ${param.type === 'object' ? 'selected' : ''}>object</option>
                    <option value="array" ${param.type === 'array' ? 'selected' : ''}>array</option>
                    <option value="any" ${param.type === 'any' ? 'selected' : ''}>any</option>
                </select>
                <input type="text" placeholder="Description" class="param-desc" value="${param.description || ''}">
                <button onclick="app.removeParam(this)" class="btn-remove">❌</button>
            </div>
        `).join('');

        if (params.length === 0) {
            this.addParam(containerId);
        }
    }

    clearEditor() {
        this.currentFunction = null;
        document.getElementById('function-name').value = '';
        document.getElementById('function-code').value = '';
        document.getElementById('test-code').value = '';
        
        document.getElementById('input-params').innerHTML = '';
        document.getElementById('output-params').innerHTML = '';
        
        this.addInputParam();
        this.addOutputParam();
        
        document.getElementById('test-results').style.display = 'none';
    }

    addInputParam() {
        this.addParam('input-params');
    }

    addOutputParam() {
        this.addParam('output-params');
    }

    addParam(containerId) {
        const container = document.getElementById(containerId);
        const paramDiv = document.createElement('div');
        paramDiv.className = 'param-item';
        paramDiv.innerHTML = `
            <input type="text" placeholder="Nom" class="param-name">
            <select class="param-type">
                <option value="string">string</option>
                <option value="number">number</option>
                <option value="boolean">boolean</option>
                <option value="object">object</option>
                <option value="array">array</option>
                <option value="any">any</option>
            </select>
            <input type="text" placeholder="Description" class="param-desc">
            <button onclick="app.removeParam(this)" class="btn-remove">❌</button>
        `;
        container.appendChild(paramDiv);
    }

    removeParam(button) {
        button.parentElement.remove();
    }

    getParamsFromContainer(containerId) {
        const container = document.getElementById(containerId);
        const paramItems = container.querySelectorAll('.param-item');
        
        return Array.from(paramItems).map(item => {
            const name = item.querySelector('.param-name').value.trim();
            const type = item.querySelector('.param-type').value;
            const description = item.querySelector('.param-desc').value.trim();
            
            return name ? { name, type, description } : null;
        }).filter(param => param !== null);
    }

    async saveFunction() {
        try {
            const name = document.getElementById('function-name').value.trim();
            const code = document.getElementById('function-code').value.trim();
            const testCode = document.getElementById('test-code').value.trim();
            
            if (!name || !code || !testCode) {
                this.showError('Tous les champs sont requis');
                return;
            }

            const inputParams = this.getParamsFromContainer('input-params');
            const outputParams = this.getParamsFromContainer('output-params');

            const functionData = {
                name,
                inputParams,
                outputParams,
                code,
                testCode
            };

            if (this.currentFunction) {
                // Mise à jour
                await this.apiCall(`/functions/${this.currentFunction.name}`, 'PUT', functionData);
                this.showSuccess('Fonction mise à jour avec succès');
            } else {
                // Création
                await this.apiCall('/functions', 'POST', functionData);
                this.showSuccess('Fonction créée avec succès');
            }

            await this.loadFunctions();
            this.loadProductionView();
        } catch (error) {
            console.error('Erreur sauvegarde:', error);
        }
    }

    async testFunction() {
        const code = document.getElementById('function-code').value.trim();
        const testCode = document.getElementById('test-code').value.trim();
        
        if (!code || !testCode) {
            this.showError('Code de fonction et de test requis');
            return;
        }

        try {
            // Exécuter le test dans un contexte sécurisé
            const result = this.executeTest(code, testCode);
            
            const resultsDiv = document.getElementById('test-results');
            const outputPre = document.getElementById('test-output');
            
            outputPre.textContent = result;
            resultsDiv.style.display = 'block';
            
        } catch (error) {
            const resultsDiv = document.getElementById('test-results');
            const outputPre = document.getElementById('test-output');
            
            outputPre.textContent = `Erreur: ${error.message}`;
            resultsDiv.style.display = 'block';
        }
    }

    executeTest(functionCode, testCode) {
        try {
            // Créer un contexte sécurisé pour l'exécution
            const functionWrapper = new Function('return ' + functionCode)();
            const testWrapper = new Function('functionName', testCode);
            
            // Capturer la sortie console
            let output = '';
            const originalLog = console.log;
            const originalAssert = console.assert;
            
            console.log = (...args) => {
                output += args.join(' ') + '\n';
            };
            
            console.assert = (condition, message) => {
                if (!condition) {
                    output += `ASSERTION FAILED: ${message}\n`;
                }
            };
            
            // Exécuter le test
            const result = testWrapper(functionWrapper);
            
            // Restaurer console
            console.log = originalLog;
            console.assert = originalAssert;
            
            return output + (result ? `\nRésultat: ${result}` : '');
            
        } catch (error) {
            throw new Error(`Erreur d'exécution: ${error.message}`);
        }
    }

    // Actions sur les fonctions
    async editFunction(name) {
        this.showEditor(name);
    }

    async cloneFunction(name) {
        try {
            const func = await this.apiCall(`/functions/${name}`);
            
            // Créer une copie avec un nouveau nom
            const newName = prompt('Nom de la nouvelle fonction:', `${func.name}_copy`);
            if (!newName) return;
            
            const clonedFunction = {
                ...func,
                name: newName
            };
            
            delete clonedFunction.createdAt;
            delete clonedFunction.updatedAt;
            
            await this.apiCall('/functions', 'POST', clonedFunction);
            this.showSuccess('Fonction clonée avec succès');
            await this.loadFunctions();
        } catch (error) {
            console.error('Erreur clonage:', error);
        }
    }

    async deleteFunction(name) {
        if (!confirm(`Êtes-vous sûr de vouloir supprimer la fonction "${name}" ?`)) {
            return;
        }

        try {
            await this.apiCall(`/functions/${name}`, 'DELETE');
            this.showSuccess('Fonction supprimée avec succès');
            await this.loadFunctions();
            this.loadProductionView();
        } catch (error) {
            console.error('Erreur suppression:', error);
        }
    }

    async promoteToProduction(name) {
        if (!confirm(`Promouvoir "${name}" en production ?`)) {
            return;
        }

        try {
            await this.apiCall(`/functions/${name}/promote`, 'POST');
            this.showSuccess('Fonction promue en production');
            await this.loadFunctions();
            this.loadProductionView();
        } catch (error) {
            console.error('Erreur promotion:', error);
        }
    }

    // Vue production
    loadProductionView() {
        const devFunctions = this.functions.filter(f => f.environment !== 'production');
        const prodFunctions = this.functions.filter(f => f.environment === 'production');

        this.renderProductionFunctions('dev-functions', devFunctions, 'dev');
        this.renderProductionFunctions('prod-functions', prodFunctions, 'prod');
    }

    renderProductionFunctions(containerId, functions, type) {
        const container = document.getElementById(containerId);
        if (!container) return;

        if (functions.length === 0) {
            container.innerHTML = `
                <div style="text-align: center; padding: 20px; color: #666;">
                    <p>Aucune fonction en ${type === 'dev' ? 'développement' : 'production'}</p>
                </div>
            `;
            return;
        }

        container.innerHTML = functions.map(func => `
            <div class="function-card-small ${type}">
                <div>
                    <strong>${func.name}</strong><br>
                    <small>Modifié: ${new Date(func.updatedAt).toLocaleDateString()}</small>
                </div>
                <div>
                    ${type === 'dev' ? 
                        `<button onclick="app.promoteToProduction('${func.name}')" class="btn btn-sm" style="background: #28a745; color: white;">🚀 Promouvoir</button>` :
                        `<span style="color: #28a745;">✅ En production</span>`
                    }
                </div>
            </div>
        `).join('');
    }

    // Status
    async refreshStatus() {
        try {
            const status = await this.apiCall('/status');
            const statusElement = document.getElementById('node-status');
            
            statusElement.innerHTML = `
                <span class="status-indicator status-${status.isMaster ? 'master' : 'slave'}"></span>
                Node: ${status.nodeId} (${status.isMaster ? 'Master' : 'Slave'}) | 
                Fonctions: ${status.functionsCount}
            `;
        } catch (error) {
            const statusElement = document.getElementById('node-status');
            statusElement.innerHTML = `
                <span class="status-indicator status-offline"></span>
                Hors ligne
            `;
        }
    }

    // Navigation
    showTab(tabName) {
        // Masquer tous les onglets
        document.querySelectorAll('.tab-content').forEach(tab => {
            tab.classList.remove('active');
        });
        
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.classList.remove('active');
        });

        // Afficher l'onglet sélectionné
        document.getElementById(`${tabName}-tab`).classList.add('active');
        document.querySelector(`[onclick="showTab('${tabName}')"]`).classList.add('active');
    }

    // Modal
    showModal(title, content) {
        const modal = document.getElementById('modal');
        const modalBody = document.getElementById('modal-body');
        
        modalBody.innerHTML = `
            <h2>${title}</h2>
            ${content}
        `;
        
        modal.style.display = 'block';
    }

    closeModal() {
        document.getElementById('modal').style.display = 'none';
    }

    // Messages
    showSuccess(message) {
        this.showToast(message, 'success');
    }

    showError(message) {
        this.showToast(message, 'error');
    }

    showToast(message, type) {
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.textContent = message;
        toast.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            padding: 15px 20px;
            border-radius: 8px;
            color: white;
            font-weight: 600;
            z-index: 1001;
            background: ${type === 'success' ? '#28a745' : '#dc3545'};
            box-shadow: 0 4px 20px rgba(0,0,0,0.3);
            transform: translateX(400px);
            transition: transform 0.3s ease;
        `;
        
        document.body.appendChild(toast);
        
        setTimeout(() => {
            toast.style.transform = 'translateX(0)';
        }, 100);
        
        setTimeout(() => {
            toast.style.transform = 'translateX(400px)';
            setTimeout(() => {
                document.body.removeChild(toast);
            }, 300);
        }, 3000);
    }
}

// Fonctions globales pour l'HTML
const app = new CoderDBInterface();

function showTab(tabName) {
    app.showTab(tabName);
}

function showEditor() {
    app.showEditor();
}

function loadFunctions() {
    app.loadFunctions();
}

function filterFunctions() {
    app.filterFunctions();
}

function saveFunction() {
    app.saveFunction();
}

function testFunction() {
    app.testFunction();
}

function clearEditor() {
    app.clearEditor();
}

function addInputParam() {
    app.addInputParam();
}

function addOutputParam() {
    app.addOutputParam();
}

function removeParam(button) {
    app.removeParam(button);
}

function refreshStatus() {
    app.refreshStatus();
}

function closeModal() {
    app.closeModal();
}

// Fermer modal en cliquant à l'extérieur
window.onclick = function(event) {
    const modal = document.getElementById('modal');
    if (event.target === modal) {
        app.closeModal();
    }
}