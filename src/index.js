'use strict';

const PLUGIN_NAME = 'serverless-aws-alias-v4';

// Determine debug logging state (can be set via SLS_DEBUG=true or --verbose flag)
const IS_DEBUG = process.env?.SLS_DEBUG || process.argv.includes('--verbose') || process.argv.includes('-v');

class ServerlessLambdaAliasPlugin {
	constructor(serverless) {
		this.serverless = serverless;
		this.provider = serverless.getProvider('aws');

		// Centralized plugin configuration
		this.config = {
			alias: this.stage, // Default alias to stage
			excludedFunctions: new Set(),
			apiGatewayResourceCache: new Map(),
			accountId: null,
			verbose: false,
			region: this.provider.getRegion(),
			stackName: this.provider.naming.getStackName(),
			restApiId: this.serverless.service.provider.apiGateway?.restApiId,
		};

		this.hooks = {
			initialize: () => this.initializePlugin(),
			'before:deploy:deploy': () => this.validateConfiguration(),
			'after:deploy:deploy': () => this.deployAliasWorkflow(),
		};
	}

	/**
	 * Log messages only when debug mode is enabled.
	 * Uses different colors for better readability.
	 */
	debugLog(message, force = false, type = 'info') {
		if (IS_DEBUG || this.config.verbose || force) {
			let color = '\x1b[0m'; // Reset color
			switch (type) {
				case 'success':
					color = '\x1b[32m'; // Green
					break;
				case 'warning':
					color = '\x1b[33m'; // Yellow
					break;
				case 'error':
					color = '\x1b[31m'; // Red
					break;
				case 'info': // Blue for regular debug info
				default:
					color = '\x1b[34m'; // Blue
			}
			this.serverless.cli.log(`${color}${PLUGIN_NAME}: ${message}\x1b[0m`);
		}
	}

	// --- Initialization and Validation ---

	/**
	 * Initializes plugin configuration from serverless.yml.
	 */
	initializePlugin() {
		const CUSTOM_ALIAS_CONFIG = this.serverless.service?.custom?.alias || {};
		const STAGE = this.provider.getStage();

		// Determine the alias name: custom.alias.name > custom.alias (if string) > stage
		this.config.alias =
			CUSTOM_ALIAS_CONFIG.name || (typeof CUSTOM_ALIAS_CONFIG === 'string' ? CUSTOM_ALIAS_CONFIG : STAGE);

		// Load excluded functions
		this.config.excludedFunctions = new Set(CUSTOM_ALIAS_CONFIG.excludedFunctions || []);

		// Verbose logging
		this.config.verbose = CUSTOM_ALIAS_CONFIG.verbose || false;

		// Update REST API ID from potential provider configuration
		this.config.restApiId = this.serverless.service.provider.apiGateway?.restApiId || this.config.restApiId;

		this.debugLog(`Initialized with Alias: ${this.config.alias}`, false, 'success');
		this.debugLog(`Region: ${this.config.region}`);
		if (this.config.excludedFunctions.size > 0) {
			this.debugLog(`Excluded Functions: ${Array.from(this.config.excludedFunctions).join(', ')}`);
		}
		if (this.config.restApiId) {
			this.debugLog(`Target REST API ID: ${this.config.restApiId}`);
		} else {
			this.debugLog(
				'No REST API ID found in provider config, API Gateway integrations will be skipped.',
				false,
				'warning',
			);
		}
	}

	/**
	 * Validates plugin and function configurations before deployment.
	 */
	validateConfiguration() {
		this.debugLog('Validating configuration...');
		const SERVICE = this.serverless.service;

		if (!this.config.alias) {
			throw new this.serverless.classes.Error(
				'Alias name is not defined. Configure it under custom.alias or rely on the stage.',
			);
		}

		// Validate API Gateway Method Settings if API Gateway is configured
		if (this.config.restApiId) {
			const INVALID_METHOD_SETTINGS = this.validateApiGatewayMethodSettings(SERVICE.functions);
			if (INVALID_METHOD_SETTINGS.length > 0) {
				throw new this.serverless.classes.Error(
					`Invalid API Gateway method settings found:\n${INVALID_METHOD_SETTINGS.join('\n')}`,
				);
			}
		}
		this.debugLog('Configuration validated successfully.', false, 'success');
	}

	/**
	 * Validates the `methodSettings` within http events for functions.
	 */
	validateApiGatewayMethodSettings(functions) {
		const INVALID_CONFIG = [];

		const VALID_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'ANY'];

		const VALID_SETTINGS = new Set([
			'cacheDataEncrypted',
			'cacheTtlInSeconds',
			'cachingEnabled',
			'dataTraceEnabled',
			'loggingLevel',
			'metricsEnabled',
			'requireAuthorizationForCacheControl',
			'throttlingBurstLimit',
			'throttlingRateLimit',
			'unauthorizedCacheControlHeaderStrategy',
		]);

		// Iterate through functions and validate their method settings (https://docs.aws.amazon.com/apigateway/latest/api/API_MethodSetting.html)
		Object.entries(functions).forEach(([funcName, funcDef]) => {
			if (!funcDef.events) return;

			funcDef.events.forEach((event) => {
				if (!event.http?.method) return;

				this.validateEventMethod(funcName, event, VALID_METHODS, INVALID_CONFIG);

				if (event.http?.methodSettings) {
					this.validateEventMethodSettings(funcName, event, VALID_SETTINGS, INVALID_CONFIG);
				}
			});
		});

		return INVALID_CONFIG;
	}

	/**
	 * Validates the HTTP method for an event.
	 */
	validateEventMethod(funcName, event, validMethods, invalidConfig) {
		const METHOD = event.http.method.toUpperCase();
		if (!validMethods.includes(METHOD)) {
			invalidConfig.push(
				`Function '${funcName}' has invalid HTTP method '${METHOD}'. Valid methods are: ${validMethods.join(', ')}`,
			);
		}
	}

	/**
	 * Validates the method settings for an event.
	 */
	validateEventMethodSettings(funcName, event, validSettings, invalidConfig) {
		Object.keys(event.http.methodSettings).forEach((setting) => {
			if (!validSettings.has(setting)) {
				invalidConfig.push(
					`Function '${funcName}' has invalid method setting '${setting}'. Valid settings are: ${Array.from(
						validSettings,
					).join(', ')}`,
				);
			}
		});
	}

	// --- Core Deployment Workflow ---

	/**
	 * Main workflow to deploy aliases after stack deployment.
	 */
	async deployAliasWorkflow() {
		try {
			this.debugLog(`${PLUGIN_NAME}: Starting alias deployment workflow...`, 'info');

			// Get AWS account ID (needed for ARNs)
			await this.getAwsAccountId();

			// Get all functions that need aliases (excluding the ones in the excludedFunctions set)
			const FUNCTIONS = this.getFunctionsForAliasDeployment();

			if (FUNCTIONS.length === 0) {
				this.debugLog('No functions to process for alias deployment. Exiting.', true, 'warning');
				return;
			}

			this.debugLog(`Found ${FUNCTIONS.length} functions to process for alias deployment.`);

			// Create/update Lambda function aliases
			const CREATED_ALIASES = await this.createOrUpdateFunctionAliases(FUNCTIONS);

			// Update API Gateway resources if REST API ID is provided
			if (this.config.restApiId) {
				await this.updateApiGatewayIntegrations(FUNCTIONS, CREATED_ALIASES);
			}

			this.debugLog(`${PLUGIN_NAME}: Successfully deployed aliases for ${CREATED_ALIASES.length} functions.`, 'info');
		} catch (error) {
			this.debugLog(`Error in alias deployment workflow: ${error.message}`, true, 'error');
			this.debugLog(error.stack, false, 'error');
			throw new this.serverless.classes.Error(`Alias deployment failed: ${error.message}`);
		}
	}

	/**
	 * Gets AWS account ID for the current deployment.
	 */
	async getAwsAccountId() {
		if (this.config.accountId) {
			return this.config.accountId;
		}

		try {
			this.debugLog('Fetching AWS account ID...');
			const STS = new this.provider.sdk.STS({ region: this.config.region });
			const IDENTITY = await STS.getCallerIdentity().promise();
			this.config.accountId = IDENTITY.Account;
			this.debugLog(`AWS Account ID: ${this.config.accountId}`);
			return this.config.accountId;
		} catch (error) {
			this.debugLog(`Error getting AWS account ID: ${error.message}`, true, 'error');
			throw error;
		}
	}

	/**
	 * Gets all functions that need aliases (excluding the ones in the excludedFunctions set).
	 */
	getFunctionsForAliasDeployment() {
		const SERVICES = this.serverless.service;
		const FUNCTIONS = [];

		Object.entries(SERVICES.functions || {}).forEach(([funcName, funcDef]) => {
			// Skip if function is in the excluded list
			if (this.config.excludedFunctions.has(funcName)) {
				this.debugLog(`Skipping excluded function: ${funcName}`);
				return;
			}

			// Add function to the list for alias deployment
			FUNCTIONS.push({
				name: funcName,
				functionName: funcDef.name || this.provider.naming.getLambdaLogicalId(funcName),
				handler: funcDef.handler,
				environment: funcDef.environment || {},
				events: funcDef.events || [],
			});
		});

		return FUNCTIONS;
	}

	/**
	 * Creates or updates Lambda function aliases.
	 */
	async createOrUpdateFunctionAliases(functions) {
		this.debugLog('Creating or updating Lambda function aliases...');
		const CREATED_ALIASES = [];

		for (const FUNC of functions) {
			try {
				// Get the latest function version
				const VERSION = await this.getLatestFunctionVersion(FUNC.functionName);

				if (!VERSION) {
					this.debugLog(`Could not determine latest version for function: ${FUNC.functionName}`, true, 'error');
					continue;
				}

				// Create or update the alias
				const ALIAS = await this.createOrUpdateAlias(FUNC.functionName, VERSION);

				if (ALIAS) {
					CREATED_ALIASES.push({
						functionName: FUNC.functionName,
						name: FUNC.name,
						aliasName: this.config.alias,
						aliasArn: ALIAS.AliasArn,
						version: VERSION,
						events: FUNC.events,
					});
					this.debugLog(
						`Created/updated alias '${this.config.alias}' for function '${FUNC.functionName}' pointing to version ${VERSION}`,
						false,
						'success',
					);
				}
			} catch (error) {
				this.debugLog(
					`Error creating/updating alias for function '${FUNC.functionName}': ${error.message}`,
					true,
					'error',
				);
			}
		}

		return CREATED_ALIASES;
	}

	/**
	 * Gets the latest version of a Lambda function.
	 */
	async getLatestFunctionVersion(functionName) {
		try {
			this.debugLog(`Getting latest version for function: ${functionName}`);

			const LAMBDA = new this.provider.sdk.Lambda({ region: this.config.region });
			const RESULT = await LAMBDA.listVersionsByFunction({
				FunctionName: functionName,
				MaxItems: 20,
			}).promise();

			// Filter out $LATEST and sort versions in descending order
			const VERSIONS = RESULT.Versions.filter((version) => version.Version !== '$LATEST').sort(
				(a, b) => parseInt(b.Version) - parseInt(a.Version),
			);

			if (VERSIONS.length === 0) {
				this.debugLog(`No versions found for function: ${functionName}`, true, 'warning');
				return null;
			}

			return VERSIONS[0].Version;
		} catch (error) {
			this.debugLog(`Error getting latest version for function '${functionName}': ${error.message}`, true, 'error');
			throw error;
		}
	}

	/**
	 * Creates or updates a Lambda function alias.
	 */
	async createOrUpdateAlias(functionName, version) {
		try {
			const LAMBDA = new this.provider.sdk.Lambda({ region: this.config.region });

			// First, try to get the existing alias
			try {
				this.debugLog(`Checking if alias '${this.config.alias}' exists for function '${functionName}'`);
				const EXISTING_ALIAS = await LAMBDA.getAlias({
					FunctionName: functionName,
					Name: this.config.alias,
				}).promise();

				// If alias exists but points to a different version, update it
				if (EXISTING_ALIAS.FunctionVersion !== version) {
					this.debugLog(
						`Updating alias '${this.config.alias}' for function '${functionName}' from version ${EXISTING_ALIAS.FunctionVersion} to ${version}`,
					);

					return await LAMBDA.updateAlias({
						FunctionName: functionName,
						Name: this.config.alias,
						FunctionVersion: version,
						Description: `Alias for ${this.config.alias}`,
					}).promise();
				}

				this.debugLog(
					`Alias '${this.config.alias}' for function '${functionName}' already points to version ${version}. No update needed.`,
				);
				return EXISTING_ALIAS;
			} catch (error) {
				// If alias doesn't exist, create it
				if (error.code === 'ResourceNotFoundException') {
					this.debugLog(
						`Creating new alias '${this.config.alias}' for function '${functionName}' pointing to version ${version}`,
					);

					return await LAMBDA.createAlias({
						FunctionName: functionName,
						Name: this.config.alias,
						FunctionVersion: version,
						Description: `Alias for ${this.config.alias}`,
					}).promise();
				}
				throw error;
			}
		} catch (error) {
			this.debugLog(`Error managing alias for function '${functionName}': ${error.message}`, true, 'error');
			throw error;
		}
	}

	/**
	 * Updates API Gateway integrations to use the function aliases.
	 */
	async updateApiGatewayIntegrations(functions, createdAliases) {
		if (!this.config.restApiId || createdAliases.length === 0) {
			this.debugLog(
				'Skipping API Gateway integration updates (no REST API ID or no aliases created)',
				false,
				'warning',
			);
			return;
		}

		this.debugLog(`Updating API Gateway integrations for ${createdAliases.length} functions...`);

		try {
			// Get all API Gateway resources
			const RESOURCES = await this.getApiGatewayResources();

			// For each created alias that has HTTP events, update the API Gateway integration
			for (const ALIAS of createdAliases) {
				// Filter for HTTP events
				const HTTP_EVENTS = this.getHttpEventsForFunction(ALIAS.name, functions);

				if (HTTP_EVENTS.length === 0) {
					this.debugLog(`No HTTP events found for function '${ALIAS.name}'. Skipping API Gateway integration.`);
					continue;
				}

				// Update each HTTP event integration
				for (const EVENT of HTTP_EVENTS) {
					await this.updateApiGatewayIntegration(RESOURCES, ALIAS, EVENT);
				}
			}

			// Deploy the API stage to apply changes
			await this.deployApiGateway();

			this.debugLog('API Gateway integrations updated successfully.', false, 'success');
		} catch (error) {
			this.debugLog(`Error updating API Gateway integrations: ${error.message}`, true, 'error');
			throw error;
		}
	}

	/**
	 * Gets all HTTP events for a specific function.
	 */
	getHttpEventsForFunction(functionName, functions) {
		const FUNCTION = functions.find((f) => f.name === functionName);
		if (!FUNCTION) return [];

		return FUNCTION.events
			.filter((event) => event.http)
			.map((event) => ({
				path: event.http.path,
				method: event.http.method.toUpperCase(),
				cors: event.http.cors || false,
				methodSettings: event.http.methodSettings || {},
			}));
	}

	/**
	 * Gets all API Gateway resources.
	 */
	async getApiGatewayResources() {
		try {
			this.debugLog(`Getting API Gateway resources for REST API ID: ${this.config.restApiId}`);

			const API_GATEWAY = new this.provider.sdk.APIGateway({ region: this.config.region });
			const RESULT = await API_GATEWAY.getResources({ restApiId: this.config.restApiId, limit: 500 }).promise();

			this.debugLog(`Found ${RESULT.items.length} API Gateway resources.`);
			return RESULT.items;
		} catch (error) {
			this.debugLog(`Error getting API Gateway resources: ${error.message}`, true, 'error');
			throw error;
		}
	}

	/**
	 * Updates an API Gateway integration to use the function alias.
	 */
	async updateApiGatewayIntegration(resources, alias, httpEvent) {
		try {
			// Find the resource for the given path
			const RESOURCE = this.findResourceByPath(resources, httpEvent.path);

			if (!RESOURCE) {
				this.debugLog(
					`Resource not found for path '${httpEvent.path}'. Skipping integration update.`,
					false,
					'warning',
				);
				return;
			}

			this.debugLog(`Updating integration for path: ${httpEvent.path}, method: ${httpEvent.method}`);

			const API_GATEWAY = new this.provider.sdk.APIGateway({ region: this.config.region });

			// Get the current integration
			const INTEGRATION = await API_GATEWAY.getIntegration({
				restApiId: this.config.restApiId,
				resourceId: RESOURCE.id,
				httpMethod: httpEvent.method,
			}).promise();

			if (INTEGRATION) {
				this.debugLog(`Current integration: ${JSON.stringify(INTEGRATION, null, 2)}`, false, 'info');
			} else {
				this.debugLog(
					`No integration found for path: ${httpEvent.path}, method: ${httpEvent.method}`,
					false,
					'warning',
				);
			}

			// Create the new integration URI pointing to the alias
			const STAGE_VARIABLES_ALIAS = '${stageVariables.alias}';
			const LAMBDA_ARN = `arn:aws:lambda:${this.config.region}:${this.config.accountId}:function:${alias.functionName}:${STAGE_VARIABLES_ALIAS}`;
			const URI = `arn:aws:apigateway:${this.config.region}:lambda:path/2015-03-31/functions/${LAMBDA_ARN}/invocations`;

			// Update the integration to point to the alias
			await API_GATEWAY.updateIntegration({
				restApiId: this.config.restApiId,
				resourceId: RESOURCE.id,
				httpMethod: httpEvent.method,
				patchOperations: [
					{
						op: 'replace',
						path: '/uri',
						value: URI,
					},
				],
			}).promise();

			// Add permission for API Gateway to invoke the Lambda alias
			await this.addLambdaPermission(alias, RESOURCE.id, httpEvent.method, httpEvent.path);

			this.debugLog(
				`Successfully updated integration for path: ${httpEvent.path}, method: ${httpEvent.method} to use alias: ${this.config.alias}`,
				false,
				'success',
			);
		} catch (error) {
			this.debugLog(
				`Error updating API Gateway integration for path '${httpEvent.path}', method '${httpEvent.method}': ${error.message}`,
				true,
				'error',
			);
			throw error;
		}
	}

	/**
	 * Finds an API Gateway resource by path.
	 */
	findResourceByPath(resources, path) {
		// Normalize path (remove leading slash if present)
		const NORMALIZED_PATH = path.startsWith('/') ? path : `/${path}`;

		// First check the cache
		if (this.config.apiGatewayResourceCache.has(NORMALIZED_PATH)) {
			return this.config.apiGatewayResourceCache.get(NORMALIZED_PATH);
		}

		// Find the resource
		const RESOURCE = resources.find((r) => r.path === NORMALIZED_PATH);

		// Cache the result
		if (RESOURCE) {
			this.config.apiGatewayResourceCache.set(NORMALIZED_PATH, RESOURCE);
		}

		return RESOURCE;
	}

	/**
	 * Adds permission for API Gateway to invoke the Lambda alias.
	 */
	async addLambdaPermission(alias, resourceId, method, path) {
		try {
			const LAMBDA = new this.provider.sdk.Lambda({ region: this.config.region });

			// Get the qualified function ARN with the alias
			const QUALIFIED_FUNCTION_NAME = `${alias.functionName}:${this.config.alias}`;

			// Create statement IDs for both the specific stage and for test invocations
			const STAGE_STATEMENT_ID =
				`apigateway-${this.config.restApiId}-${this.config.alias}-${method}-${resourceId}`.replace(
					/[^a-zA-Z0-9-_]/g,
					'-',
				);
			const TEST_STATEMENT_ID =
				`apigateway-test-${this.config.restApiId}-${this.config.alias}-${method}-${resourceId}`.replace(
					/[^a-zA-Z0-9-_]/g,
					'-',
				);

			// Both stage invocation and test invocation need permissions
			const SOURCE_ARN = `arn:aws:execute-api:${this.config.region}:${this.config.accountId}:${this.config.restApiId}/*/${method}${path.startsWith('/') ? path : `/${path}`}`;

			this.debugLog(`Adding permission for API Gateway to invoke Lambda alias: ${QUALIFIED_FUNCTION_NAME}`);

			// Try to remove any existing permissions first
			try {
				await LAMBDA.removePermission({
					FunctionName: QUALIFIED_FUNCTION_NAME,
					StatementId: STAGE_STATEMENT_ID,
				}).promise();
			} catch (error) {
				// Ignore if the permission doesn't exist
				if (error.code !== 'ResourceNotFoundException') {
					this.debugLog(`Warning: ${error.message}`, false, 'warning');
				}
			}

			try {
				await LAMBDA.removePermission({
					FunctionName: QUALIFIED_FUNCTION_NAME,
					StatementId: TEST_STATEMENT_ID,
				}).promise();
			} catch (error) {
				// Ignore if the permission doesn't exist
				if (error.code !== 'ResourceNotFoundException') {
					this.debugLog(`Warning: ${error.message}`, false, 'warning');
				}
			}

			// Add the stage invocation permission
			await LAMBDA.addPermission({
				FunctionName: QUALIFIED_FUNCTION_NAME,
				StatementId: STAGE_STATEMENT_ID,
				Action: 'lambda:InvokeFunction',
				Principal: 'apigateway.amazonaws.com',
				SourceArn: SOURCE_ARN,
			}).promise();

			// Add permission for test invocations
			await LAMBDA.addPermission({
				FunctionName: QUALIFIED_FUNCTION_NAME,
				StatementId: TEST_STATEMENT_ID,
				Action: 'lambda:InvokeFunction',
				Principal: 'apigateway.amazonaws.com',
				SourceArn: `arn:aws:execute-api:${this.config.region}:${this.config.accountId}:${this.config.restApiId}/test-invoke-stage/${method}${path.startsWith('/') ? path : `/${path}`}`,
			}).promise();

			this.debugLog(
				`Successfully added permission for API Gateway to invoke Lambda alias: ${QUALIFIED_FUNCTION_NAME}`,
				false,
				'success',
			);
		} catch (error) {
			this.debugLog(`Error adding Lambda permission: ${error.message}`, true, 'error');
			throw error;
		}
	}

	/**
	 * Deploys the API Gateway to apply changes.
	 */
	async deployApiGateway() {
		try {
			this.debugLog(`Deploying API Gateway (REST API ID: ${this.config.restApiId})...`);

			const API_GATEWAY = new this.provider.sdk.APIGateway({ region: this.config.region });
			const STAGE = this.provider.getStage();

			// Create a new deployment
			const DEPLOYMENT = await API_GATEWAY.createDeployment({
				restApiId: this.config.restApiId,
				stageName: STAGE,
				description: `Deployed by ${PLUGIN_NAME} for alias: ${this.config.alias}`,
			}).promise();

			this.debugLog(`Created deployment with ID: ${DEPLOYMENT.id} for stage: ${STAGE}`);

			// Update stage variables
			await API_GATEWAY.updateStage({
				restApiId: this.config.restApiId,
				stageName: STAGE,
				patchOperations: [
					{
						op: 'replace',
						path: '/variables/alias',
						value: this.config.alias,
					},
				],
			}).promise();

			this.debugLog(`Set stage variable 'alias=${this.config.alias}' for stage: ${STAGE}`);

			// Print endpoint URL
			const ENDPOINT_URL = `https://${this.config.restApiId}.execute-api.${this.config.region}.amazonaws.com/${STAGE}`;
			this.debugLog(`${PLUGIN_NAME}: API Gateway endpoint: ${ENDPOINT_URL}`, 'info');

			this.debugLog(`Successfully deployed API Gateway to stage: ${STAGE}`, false, 'success');
		} catch (error) {
			this.debugLog(`Error deploying API Gateway: ${error.message}`, true, 'error');
			throw error;
		}
	}
}

module.exports = ServerlessLambdaAliasPlugin;
