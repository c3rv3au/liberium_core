// services/validators/function-validator.js
"use strict";

class FunctionValidator {
	/**
	 * Valider une fonction complète
	 */
	static validate(functionData) {
		const { name, inputParams, outputParams, code, testCode } = functionData;

		// Validation du nom
		this.validateName(name);
		
		// Validation des paramètres d'entrée
		this.validateParams(inputParams, "input");
		
		// Validation des paramètres de sortie
		this.validateParams(outputParams, "output");
		
		// Validation du code
		this.validateCode(code, "execution");
		
		// Validation du code de test
		this.validateCode(testCode, "test");

		return {
			name: name.trim(),
			inputParams: this.normalizeParams(inputParams),
			outputParams: this.normalizeParams(outputParams),
			code: code.trim(),
			testCode: testCode.trim()
		};
	}

	/**
	 * Valider une mise à jour partielle
	 */
	static validateUpdate(updateData) {
		const { name, inputParams, outputParams, code, testCode } = updateData;
		const validated = {};

		if (inputParams !== undefined) {
			this.validateParams(inputParams, "input");
			validated.inputParams = this.normalizeParams(inputParams);
		}

		if (outputParams !== undefined) {
			this.validateParams(outputParams, "output");
			validated.outputParams = this.normalizeParams(outputParams);
		}

		if (code !== undefined) {
			this.validateCode(code, "execution");
			validated.code = code.trim();
		}

		if (testCode !== undefined) {
			this.validateCode(testCode, "test");
			validated.testCode = testCode.trim();
		}

		return validated;
	}

	/**
	 * Valider le nom de la fonction
	 */
	static validateName(name) {
		if (!name || typeof name !== "string") {
			throw new Error("Function name is required and must be a string");
		}

		if (name.trim().length === 0) {
			throw new Error("Function name cannot be empty");
		}

		if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name.trim())) {
			throw new Error("Function name must be a valid identifier");
		}
	}

	/**
	 * Valider les paramètres
	 */
	static validateParams(params, type) {
		if (!Array.isArray(params)) {
			throw new Error(`${type} parameters must be an array`);
		}

		for (let i = 0; i < params.length; i++) {
			const param = params[i];
			
			if (!param || typeof param !== "object") {
				throw new Error(`${type} parameter ${i} must be an object`);
			}

			if (!param.name || typeof param.name !== "string") {
				throw new Error(`${type} parameter ${i} must have a valid name`);
			}

			if (!param.type || typeof param.type !== "string") {
				throw new Error(`${type} parameter ${i} must have a valid type`);
			}

			if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(param.name)) {
				throw new Error(`${type} parameter ${i} name must be a valid identifier`);
			}

			// Vérifier les types valides
			const validTypes = [
				"string", "number", "boolean", "object", "array", 
				"function", "any", "null", "undefined"
			];
			
			if (!validTypes.includes(param.type)) {
				throw new Error(`${type} parameter ${i} has invalid type: ${param.type}`);
			}
		}
	}

	/**
	 * Valider le code
	 */
	static validateCode(code, type) {
		if (!code || typeof code !== "string") {
			throw new Error(`${type} code is required and must be a string`);
		}

		if (code.trim().length === 0) {
			throw new Error(`${type} code cannot be empty`);
		}

		// Validation syntaxique basique
		try {
			// Vérifier que c'est du JavaScript valide
			new Function(code);
		} catch (err) {
			throw new Error(`${type} code has syntax error: ${err.message}`);
		}
	}

	/**
	 * Normaliser les paramètres
	 */
	static normalizeParams(params) {
		return params.map(param => ({
			name: param.name.trim(),
			type: param.type.trim(),
			description: param.description ? param.description.trim() : "",
			required: param.required !== false, // Par défaut true
			default: param.default
		}));
	}
}

module.exports = FunctionValidator;