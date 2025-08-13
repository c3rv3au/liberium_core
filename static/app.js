// app.js
class CoderDBInterface {
    constructor() {
        this.currentFunction = null;
        this.functions = [];
        this.editors = {};
        this.currentTestFunction = null;
        this.init();
    }

    async init() {
        await this.initializeMonacoEditor();
        await this.loadFunctions();
        await this.refreshStatus();
        this.loadProductionView();
        this.populateFunctionSelect();
    }

    // Initialisation de Monaco Editor
    async initializeMonacoEditor() {
        return new Promise((resolve) => {
            require.config({ 
                paths: { 
                    vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min/vs' 
                }
            });

            require(['vs/editor/editor.main'], () => {
                // Éditeur de code de fonction
                this.editors.functionCode = monaco.editor.create(
                    document.getElementById('function-code-editor'),
                    {
                        value: 'function(inputParams) {\n    // Votre code ici\n    return inputParams;\n}',
                        language: 'javascript',
                        theme: 'vs-dark',
                        automaticLayout: true,
                        minimap: { enabled: false },
                        fontSize: 14,
                        lineNumbers: 'on',
                        roundedSelection: false,
                        scrollBeyondLastLine: false,
                        readOnly: false
                    }
                );

                // Éditeur de code de test
                this.editors.testCode = monaco.editor.create(
                    document.getElementById('test-code-editor'),
                    {
                        value: '// Tests pour votre fonction\nfunction test(functionName, testInputs, console) {\n    const result = functionName(testInputs);\n    console.assert(result !== undefined, "Function should return a result");\n    return "Tests passed!";\n}',
                        language: 'javascript',
                        theme: 'vs-dark',
                        automaticLayout: true,
                        minimap: { enabled: false },
                        fontSize: 14,
                        lineNumbers: 'on',
                        roundedSelection: false,
                        scrollBeyondLastLine: false,
                        readOnly: false
                    }
                );

                // Éditeur d'aperçu de fonction (lecture seule)
                this.editors.functionPreview = monaco.editor.create(
                    document.getElementById('function-preview-editor'),
                    {
                        value: '// Sélectionnez une fonction pour voir son code',
                        language: 'javascript',
                        theme: 'vs',
                        automaticLayout: true,
                        minimap: { enabled: false },
                        fontSize: 12,
                        lineNumbers: 'on',
                        roundedSelection: false,
                        scrollBeyondLastLine: false,
                        readOnly: true
                    }
                );

                resolve();
            });
        });
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
            this.populateFunctionSelect();
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
                        <span class="status-indicator status-${func.environment === 'production' ? 'prod' : 'dev'}"></span>
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
                    <button onclick="app.selectFunctionForTesting('${func.name}')" class="btn btn-secondary">🧪 Tester</button>
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
            const func = await this.apiCall(`/functions/${encodeURIComponent(name)}`);
            this.currentFunction = func;
            
            document.getElementById('function-name').value = func.name;
            this.editors.functionCode.setValue(func.code);
            this.editors.testCode.setValue(func.testCode);
            
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
                <button onclick="app.removeParam(this)" class="btn-remove">✕</button>
            </div>
        `).join('');

        if (params.length === 0) {
            this.addParam(containerId);
        }
    }

    clearEditor() {
        this.currentFunction = null;
        document.getElementById('function-name').value = '';
        this.editors.functionCode.setValue('function(inputParams) {\n    // Votre code ici\n    return inputParams;\n}');
        this.editors.testCode.setValue('// Tests pour votre fonction\nfunction test(functionName, testInputs, console) {\n    const result = functionName(testInputs);\n    console.assert(result !== undefined, "Function should return a result");\n    return "Tests passed!";\n}');
        
        document.getElementById('input-params').innerHTML = '';
        document.getElementById('output-params').innerHTML = '';
        
        this.addInputParam();
        this.addOutputParam();
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
            <button onclick="app.removeParam(this)" class="btn-remove">✕</button>
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
            const code = this.editors.functionCode.getValue().trim();
            const testCode = this.editors.testCode.getValue().trim();
            
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
                await this.apiCall(`/functions/${encodeURIComponent(this.currentFunction.name)}`, 'PUT', functionData);
                this.showSuccess('Fonction mise à jour avec succès');
            } else {
                await this.apiCall('/functions', 'POST', functionData);
                this.showSuccess('Fonction créée avec succès');
            }

            await this.loadFunctions();
            this.loadProductionView();
        } catch (error) {
            console.error('Erreur sauvegarde:', error);
        }
    }

    // Tests
    populateFunctionSelect() {
        const select = document.getElementById('function-select');
        if (!select) return;

        select.innerHTML = '<option value="">Sélectionner une fonction</option>' +
            this.functions.map(func => `<option value="${func.name}">${func.name}</option>`).join('');
    }

    selectFunctionForTesting(functionName) {
        this.showTab('testing');
        const select = document.getElementById('function-select');
        select.value = functionName;
        this.loadFunctionForTesting();
    }

    showTestTab() {
        this.showTab('testing');
        if (this.currentFunction) {
            const select = document.getElementById('function-select');
            select.value = this.currentFunction.name;
            this.loadFunctionForTesting();
        }
    }

    async loadFunctionForTesting() {
        const select = document.getElementById('function-select');
        const functionName = select.value;
        
        if (!functionName) {
            this.clearTestInterface();
            return;
        }

        try {
            const func = await this.apiCall(`/functions/${encodeURIComponent(functionName)}`);
            this.currentTestFunction = func;
            
            // Mettre à jour l'aperçu
            this.editors.functionPreview.setValue(func.code);
            
            // Générer les champs de paramètres de test
            this.generateTestInputs(func.inputParams || []);
            
            // Réinitialiser les résultats
            this.clearTestResults();
        } catch (error) {
            console.error('Erreur chargement fonction pour test:', error);
        }
    }

    generateTestInputs(inputParams) {
        const container = document.getElementById('test-inputs');
        
        if (inputParams.length === 0) {
            container.innerHTML = '<p style="color: #666; font-style: italic;">Cette fonction n\'a aucun paramètre d\'entrée.</p>';
            return;
        }

        container.innerHTML = inputParams.map(param => {
            const inputId = `test-input-${param.name}`;
            return `
                <div class="test-input-item">
                    <label for="${inputId}">
                        ${param.name} (${param.type})
                        ${param.description ? `- ${param.description}` : ''}
                    </label>
                    ${this.generateInputField(param, inputId)}
                </div>
            `;
        }).join('');
    }

    generateInputField(param, inputId) {
        switch (param.type) {
            case 'boolean':
                return `
                    <select id="${inputId}" data-type="boolean">
                        <option value="true">true</option>
                        <option value="false">false</option>
                    </select>
                `;
            case 'number':
                return `<input type="number" id="${inputId}" data-type="number" placeholder="Entrez un nombre">`;
            case 'object':
            case 'array':
                return `<textarea id="${inputId}" data-type="${param.type}" placeholder="Entrez du JSON valide" rows="3"></textarea>`;
            default:
                return `<input type="text" id="${inputId}" data-type="string" placeholder="Entrez une valeur">`;
        }
    }

    getTestInputs() {
        const container = document.getElementById('test-inputs');
        const inputs = container.querySelectorAll('[id^="test-input-"]');
        const testInputs = {};

        inputs.forEach(input => {
            const paramName = input.id.replace('test-input-', '');
            const type = input.getAttribute('data-type');
            let value = input.value.trim();

            if (!value) return;

            try {
                switch (type) {
                    case 'number':
                        testInputs[paramName] = parseFloat(value);
                        break;
                    case 'boolean':
                        testInputs[paramName] = value === 'true';
                        break;
                    case 'object':
                    case 'array':
                        testInputs[paramName] = JSON.parse(value);
                        break;
                    default:
                        testInputs[paramName] = value;
                }
            } catch (error) {
                throw new Error(`Erreur de format pour ${paramName}: ${error.message}`);
            }
        });

        return testInputs;
    }

    async runTest() {
        if (!this.currentTestFunction) {
            this.showError('Veuillez sélectionner une fonction à tester');
            return;
        }

        try {
            const testInputs = this.getTestInputs();
            const result = await this.apiCall(`/functions/${encodeURIComponent(this.currentTestFunction.name)}/test`, 'POST', {
                testInputs
            });

            this.displayTestResults(result);
        } catch (error) {
            console.error('Erreur test:', error);
            this.displayTestResults({
                success: false,
                error: error.message,
                executedAt: new Date().toISOString()
            });
        }
    }

    displayTestResults(result) {
        const container = document.getElementById('test-results');
        
        if (result.success) {
            container.className = 'test-results success';
            container.innerHTML = `
                <h4 style="color: #28a745; margin-bottom: 10px;">✅ Test réussi</h4>
                <div class="test-output">Résultat de la fonction: ${JSON.stringify(result.result, null, 2)}</div>
                ${result.testResults ? `
                    <div style="margin-top: 15px;">
                        <h5>Résultats des tests unitaires:</h5>
                        <div class="test-output">${result.testResults.success ? '✅ ' + result.testResults.message : '❌ ' + result.testResults.error}</div>
                    </div>
                ` : ''}
                <small style="color: #666; margin-top: 10px; display: block;">Exécuté le ${new Date(result.executedAt).toLocaleString()}</small>
            `;
        } else {
            container.className = 'test-results error';
            container.innerHTML = `
                <h4 style="color: #dc3545; margin-bottom: 10px;">❌ Test échoué</h4>
                <div class="test-output">Erreur: ${result.error}</div>
                <small style="color: #666; margin-top: 10px; display: block;">Exécuté le ${new Date(result.executedAt).toLocaleString()}</small>
            `;
        }
    }

    clearTestInterface() {
        document.getElementById('test-inputs').innerHTML = '<p style="color: #666; font-style: italic;">Sélectionnez une fonction pour commencer les tests.</p>';
        this.clearTestResults();
        this.editors.functionPreview.setValue('// Sélectionnez une fonction pour voir son code');
        this.currentTestFunction = null;
    }

    clearTestResults() {
        const container = document.getElementById('test-results');
        container.className = 'test-results';
        container.innerHTML = '<p class="no-results">Aucun test exécuté</p>';
    }

    // Actions sur les fonctions
    async editFunction(name) {
        this.showEditor(name);
    }

    async cloneFunction(name) {
        try {
            const func = await this.apiCall(`/functions/${encodeURIComponent(name)}`);
            
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
            await this.apiCall(`/functions/${encodeURIComponent(name)}`, 'DELETE');
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
            await this.apiCall(`/functions/${encodeURIComponent(name)}/promote`, 'POST');
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
        document.querySelectorAll('.tab-content').forEach(tab => {
            tab.classList.remove('active');
        });
        
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.classList.remove('active');
        });

        document.getElementById(`${tabName}-tab`).classList.add('active');
        document.querySelector(`[onclick="showTab('${tabName}')"]`).classList.add('active');

        // Redimensionner les éditeurs Monaco si nécessaire
        if (this.editors.functionCode) {
            setTimeout(() => {
                this.editors.functionCode.layout();
                this.editors.testCode.layout();
                this.editors.functionPreview.layout();
            }, 100);
        }
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
                if (document.body.contains(toast)) {
                    document.body.removeChild(toast);
                }
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

function showTestTab() {
    app.showTestTab();
}

function loadFunctionForTesting() {
    app.loadFunctionForTesting();
}

function runTest() {
    app.runTest();
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
    const modal = document.getElementById('modal');
    modal.style.display = 'none';
}

// Fermer modal en cliquant à l'extérieur
window.onclick = function(event) {
    const modal = document.getElementById('modal');
    if (event.target === modal) {
        closeModal();
    }
}