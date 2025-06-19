'use strict';

const PLUGIN_NAME = 'serverless-aws-alias-v4';

// Determine debug logging state (can be set via SLS_DEBUG=true or --verbose flag)
const IS_DEBUG = process.env?.SLS_DEBUG || process.argv.includes('--verbose') || process.argv.includes('-v');
// Check if force deployment is requested
const IS_FORCE = process.argv.includes('--force');

class ServerlessLambdaAliasPlugin {
	constructor(serverless) {
		this.serverless = serverless;
		this.provider = serverless.getProvider('aws');

		this.config = {
			alias: this.stage, // Default alias to stage
			excludedFunctions: new Set(),
			apiGatewayResourceCache: new Map(),
			accountId: null,
			verbose: false,
			region: this.provider.getRegion(),
			restApiId: this.serverless.service.provider.apiGateway?.restApiId,
			websocketApiId: this.serverless.service.provider.websocketApiId,
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

		// Check what event types are used in this service
		const { hasHttpEvents, hasWebsocketEvents } = this.detectEventTypes();

		this.debugLog(`Initialized with Alias: ${this.config.alias}`, false, 'success');
		this.debugLog(`Region: ${this.config.region}`);

		if (this.config.excludedFunctions.size > 0) {
			this.debugLog(`Excluded Functions: ${Array.from(this.config.excludedFunctions).join(', ')}`);
		}

		if (hasHttpEvents) {
			if (this.config.restApiId) {
				this.debugLog(`HTTP API Gateway ID: ${this.config.restApiId}`);
			} else {
				this.debugLog(
					'No REST API ID found in provider config, HTTP API Gateway integrations will be skipped.',
					false,
					'warning',
				);
			}
		}

		if (hasWebsocketEvents) {
			if (this.config.websocketApiId) {
				this.debugLog(`WebSocket API Gateway ID: ${this.config.websocketApiId}`);
			} else {
				this.debugLog(
					'No WebSocket API ID found in provider config, WebSocket API Gateway integrations will be skipped.',
					false,
					'warning',
				);
			}
		}

		if (!hasHttpEvents && !hasWebsocketEvents) {
			this.debugLog('No API Gateway events detected in functions.', false, 'warning');
		}
	}

	/**
	 * Detects what event types (HTTP, WebSocket) are used in this service.
	 */
	detectEventTypes() {
		const FUNCTIONS = this.serverless.service.functions || {};
		let hasHttpEvents = false;
		let hasWebsocketEvents = false;

		// Check all functions' events to detect API types
		Object.values(FUNCTIONS).forEach((funcDef) => {
			if (!funcDef.events) return;

			funcDef.events.forEach((event) => {
				if (event.http) hasHttpEvents = true;
				if (event.websocket) hasWebsocketEvents = true;
			});
		});

		this.debugLog(`Detected event types - HTTP: ${hasHttpEvents}, WebSocket: ${hasWebsocketEvents}`);
		return { hasHttpEvents, hasWebsocketEvents };
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

		const INVALID_CONFIG = [];

		// Validate HTTP API Gateway Method Settings
		if (this.config.restApiId) {
			const INVALID_METHOD_SETTINGS = this.validateApiGatewayMethodSettings(SERVICE.functions);
			INVALID_CONFIG.push(...INVALID_METHOD_SETTINGS);
		}

		// Validate WebSocket API Settings
		if (this.config.websocketApiId) {
			const INVALID_WEBSOCKET_SETTINGS = this.validateWebSocketSettings(SERVICE.functions);
			INVALID_CONFIG.push(...INVALID_WEBSOCKET_SETTINGS);
		}

		if (INVALID_CONFIG.length > 0) {
			throw new this.serverless.classes.Error(`Invalid API Gateway configuration found:\n${INVALID_CONFIG.join('\n')}`);
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
	 * Validates WebSocket settings for functions
	 */
	validateWebSocketSettings(functions) {
		const INVALID_CONFIG = [];
		const VALID_ROUTES = ['$connect', '$disconnect', '$default'];

		Object.entries(functions).forEach(([funcName, funcDef]) => {
			if (!funcDef.events) return;

			funcDef.events.forEach((event) => {
				if (!event.websocket) return;

				// Check if route is specified
				if (!event.websocket.route && typeof event.websocket !== 'string') {
					INVALID_CONFIG.push(`Function '${funcName}' has a websocket event without a specified route`);
					return;
				}

				// Get the route (handle both formats: string or object)
				const ROUTE = typeof event.websocket === 'string' ? event.websocket : event.websocket.route;

				// Validate predefined routes have correct format
				if (ROUTE.startsWith('$') && !VALID_ROUTES.includes(ROUTE)) {
					INVALID_CONFIG.push(
						`Function '${funcName}' has invalid WebSocket route '${ROUTE}'. Predefined routes are: ${VALID_ROUTES.join(', ')}`
					);
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
			this.debugLog(`${PLUGIN_NAME}: Starting alias deployment workflow...`, false, 'info');

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

			if (CREATED_ALIASES.length === 0) {
				this.debugLog(
					'No aliases were created or updated. Consider using the --force flag to force alias deployment if needed.',
					false,
					'warning',
				);
				return;
			}

			// Update API Gateway integrations for both HTTP and WebSocket events
			const HTTP_ALIASES = CREATED_ALIASES.filter((alias) => this.hasHttpEvents(alias.name, FUNCTIONS));
			const WEBSOCKET_ALIASES = CREATED_ALIASES.filter((alias) => this.hasWebSocketEvents(alias.name, FUNCTIONS));

			// Process HTTP API Gateway integrations if needed
			if (HTTP_ALIASES.length > 0 && this.config.restApiId) {
				await this.updateApiGatewayIntegrations(FUNCTIONS, HTTP_ALIASES);
			} else if (HTTP_ALIASES.length > 0) {
				this.debugLog('HTTP events found but no REST API ID provided. Skipping HTTP integrations.', false, 'warning');
			}

			// Process WebSocket API Gateway integrations if needed
			if (WEBSOCKET_ALIASES.length > 0 && this.config.websocketApiId) {
				await this.updateWebSocketApiIntegrations(FUNCTIONS, WEBSOCKET_ALIASES);
			} else if (WEBSOCKET_ALIASES.length > 0) {
				this.debugLog(
					'WebSocket events found but no WebSocket API ID provided. Skipping WebSocket integrations.',
					false,
					'warning',
				);
			}

			this.debugLog(
				`${PLUGIN_NAME}: Successfully deployed aliases for ${CREATED_ALIASES.length} functions.`,
				false,
				'info',
			);
		} catch (error) {
			this.debugLog(`Error in alias deployment workflow: ${error.message}`, true, 'error');
			this.debugLog(error?.stack, false, 'error');
			throw new this.serverless.classes.Error(`Alias deployment failed: ${error.message}`);
		}
	}

	/**
	 * Checks if a function has HTTP events.
	 */
	hasHttpEvents(functionName, functions) {
		const FUNCTION = functions.find((f) => f.name === functionName);
		if (!FUNCTION) return false;

		return FUNCTION.events.some((event) => event.http);
	}

	/**
	 * Checks if a function has WebSocket events.
	 */
	hasWebSocketEvents(functionName, functions) {
		const FUNCTION = functions.find((f) => f.name === functionName);
		if (!FUNCTION) return false;

		return FUNCTION.events.some((event) => event.websocket);
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

			// Merge provider environment with function environment
			const PROVIDER_ENV = SERVICES.provider.environment || {};
			const FUNCTION_ENV = funcDef.environment || {};
			const MERGED_ENV = { ...PROVIDER_ENV, ...FUNCTION_ENV };

			// Add function to the list for alias deployment
			FUNCTIONS.push({
				name: funcName,
				functionName: funcDef.name || this.provider.naming.getLambdaLogicalId(funcName),
				handler: funcDef.handler,
				environment: MERGED_ENV,
				events: funcDef.events || [],
				description: funcDef.description || '',
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
		const FAILED_FUNCTIONS = [];

		for (const FUNCTION of functions) {
			try {
				let version;

				// First check if the alias exists
				const EXISTING_ALIAS = await this.getExistingAlias(FUNCTION.functionName);

				// Get the latest function version
				const LATEST_VERSION = await this.getLatestFunctionVersion(FUNCTION.functionName);

				// Determine which version to use for the alias
				if (IS_FORCE && LATEST_VERSION) {
					// When force flag is set and we have a latest version (freshly deployed by serverless), always use it
					this.debugLog(
						`Force flag detected for function: ${FUNCTION.functionName}. Using latest version ${LATEST_VERSION}`,
					);
					version = LATEST_VERSION;
				} else if (!LATEST_VERSION) {
					// No versions exist (with or without alias), publish a new one
					this.debugLog(`No existing versions for function: ${FUNCTION.functionName}. Publishing new version...`);
					version = await this.publishNewFunctionVersion(FUNCTION);
				} else {
					// Check if there are changes compared to the relevant version
					const COMPARE_VERSION = EXISTING_ALIAS ? EXISTING_ALIAS.FunctionVersion : LATEST_VERSION;
					const HAS_CHANGES = await this.haveFunctionChanges(FUNCTION, COMPARE_VERSION);

					if (HAS_CHANGES) {
						// Changes detected, publish a new version
						this.debugLog(`Changes detected for function: ${FUNCTION.functionName}. Publishing new version...`);
						version = await this.publishNewFunctionVersion(FUNCTION);
					} else if (!EXISTING_ALIAS) {
						// For new aliases with no changes, use latest version
						this.debugLog(
							`No changes detected for new function: ${FUNCTION.functionName}. Using latest version ${LATEST_VERSION}`,
						);
						version = LATEST_VERSION;
					} else {
						// No changes for existing alias, skip this function
						this.debugLog(
							`No changes detected for existing function alias: ${FUNCTION.functionName}:${this.config.alias}. Skipping.`,
						);
						continue;
					}
				}

				if (!version) {
					this.debugLog(`Could not determine version for function: ${FUNCTION.functionName}`, true, 'error');
					FAILED_FUNCTIONS.push(FUNCTION.functionName);
					continue;
				}

				// Create or update the alias only if needed
				const ALIAS = await this.createOrUpdateAlias(FUNCTION.functionName, version);

				if (ALIAS) {
					CREATED_ALIASES.push({
						functionName: FUNCTION.functionName,
						name: FUNCTION.name,
						aliasName: this.config.alias,
						aliasArn: ALIAS.AliasArn,
						version: version,
						events: FUNCTION.events,
					});
					this.debugLog(
						`Created/updated alias '${this.config.alias}' for function '${FUNCTION.functionName}' pointing to version ${version}`,
						false,
						'success',
					);
				}
			} catch (error) {
				this.debugLog(
					`Error creating/updating alias for function '${FUNCTION.functionName}': ${error.message}`,
					true,
					'error',
				);
				FAILED_FUNCTIONS.push(FUNCTION.functionName);
			}
		}

		// Check if any functions failed
		if (FAILED_FUNCTIONS.length > 0) {
			this.debugLog(
				`WARNING: Failed to process aliases for ${FAILED_FUNCTIONS.length} functions: ${FAILED_FUNCTIONS.join(', ')}`,
				true,
				'warning',
			);
		}

		return CREATED_ALIASES;
	}

	/**
	 * Gets the existing alias if it exists, or returns null.
	 */
	async getExistingAlias(functionName) {
		try {
			const LAMBDA = new this.provider.sdk.Lambda({ region: this.config.region });

			const ALIAS = await LAMBDA.getAlias({
				FunctionName: functionName,
				Name: this.config.alias,
			}).promise();

			return ALIAS;
		} catch (error) {
			// If alias doesn't exist, return null
			if (error.code === 'ResourceNotFoundException') {
				return null;
			}
			throw error;
		}
	}

	/**
	 * Checks if a function has changed between serverless config and a specific function version.
	 * Compares code hash, configuration settings, and environment variables.
	 * Also checks if the specified version already has the alias attached.
	 * Returns true if changes are detected, false otherwise.
	 */
	async haveFunctionChanges(functionData, specificVersion) {
		try {
			const LAMBDA = new this.provider.sdk.Lambda({ region: this.config.region });

			// Get the function's current configuration (from $LATEST)
			const LATEST_CONFIG = await LAMBDA.getFunctionConfiguration({
				FunctionName: functionData.functionName,
			}).promise();

			// Get configuration for the specific version
			let versionConfig;

			try {
				versionConfig = await LAMBDA.getFunctionConfiguration({
					FunctionName: functionData.functionName,
					Qualifier: specificVersion,
				}).promise();

				// Compare important configuration parameters

				// 1. Compare code hashes - if they're different, code has changed
				if (LATEST_CONFIG.CodeSha256 !== versionConfig.CodeSha256) {
					this.debugLog(`Code has changed for function: ${functionData.functionName}`);
					return true;
				}

				// 2. Compare handler
				if (LATEST_CONFIG.Handler !== versionConfig.Handler) {
					this.debugLog(`Handler changed for function: ${functionData.functionName}`);
					return true;
				}

				// 3. Compare runtime
				if (LATEST_CONFIG.Runtime !== versionConfig.Runtime) {
					this.debugLog(`Runtime changed for function: ${functionData.functionName}`);
					return true;
				}

				// 4. Compare memory size
				if (LATEST_CONFIG.MemorySize !== versionConfig.MemorySize) {
					this.debugLog(`Memory size changed for function: ${functionData.functionName}`);
					return true;
				}

				// 5. Compare timeout
				if (LATEST_CONFIG.Timeout !== versionConfig.Timeout) {
					this.debugLog(`Timeout changed for function: ${functionData.functionName}`);
					return true;
				}

				// 6. Compare role
				if (LATEST_CONFIG.Role !== versionConfig.Role) {
					this.debugLog(`Role changed for function: ${functionData.functionName}`);
					return true;
				}

				// 7. Compare environment variables
				const CURRENT_ENV = versionConfig.Environment?.Variables || {};
				const LATEST_ENV = LATEST_CONFIG.Environment?.Variables || {};
				const CONFIG_ENV = functionData.environment || {};

				// Compare environment variable keys and values
				const CURRENT_KEYS = Object.keys(CURRENT_ENV).sort();
				const LATEST_KEYS = Object.keys(LATEST_ENV).sort();
				const CONFIG_KEYS = Object.keys(CONFIG_ENV).sort();

				// Check if current version env vars differ from latest function env vars
				if (JSON.stringify(CURRENT_KEYS) !== JSON.stringify(LATEST_KEYS)) {
					this.debugLog(
						`Environment variable keys changed between versions for function: ${functionData.functionName}`,
					);
					return true;
				}

				// Check if env vars in config differ from current version
				if (JSON.stringify(CURRENT_KEYS) !== JSON.stringify(CONFIG_KEYS)) {
					this.debugLog(
						`Environment variable keys in config different from current version for function: ${functionData.functionName}`,
					);
					return true;
				}

				// Compare values for each key between versions
				for (const KEY of CURRENT_KEYS) {
					if (CURRENT_ENV[KEY] !== LATEST_ENV[KEY]) {
						this.debugLog(
							`Environment variable '${KEY}' value changed between versions for function: ${functionData.functionName}`,
						);
						return true;
					}
				}

				// Compare values for each key between current version and config
				for (const KEY of CURRENT_KEYS) {
					if (CURRENT_ENV[KEY] !== CONFIG_ENV[KEY]) {
						this.debugLog(
							`Environment variable '${KEY}' value in config different from current version for function: ${functionData.functionName}`,
						);
						return true;
					}
				}

				// 8. Compare layers
				const VERSION_LAYER_ARNS = (versionConfig.Layers || []).map((layer) => layer.Arn).sort();
				const LATEST_LAYER_ARNS = (LATEST_CONFIG.Layers || []).map((layer) => layer.Arn).sort();

				if (JSON.stringify(VERSION_LAYER_ARNS) !== JSON.stringify(LATEST_LAYER_ARNS)) {
					this.debugLog(`Layers changed for function: ${functionData.functionName}`);
					return true;
				}

				// Finally, check if the specified version already has the alias attached
				// This is checked last because even if the alias points to this version,
				// the function code or configuration could have changed since that version was created
				try {
					const ALIAS_CONFIG = await LAMBDA.getAlias({
						FunctionName: functionData.functionName,
						Name: this.config.alias,
					}).promise();

					// If the alias exists and already points to the specified version,
					// and we've reached this point (no changes detected above), no changes are needed
					if (ALIAS_CONFIG.FunctionVersion === specificVersion) {
						this.debugLog(
							`Alias ${this.config.alias} already points to version ${specificVersion} for function: ${functionData.functionName}, and no changes detected`,
						);
						return false;
					}

					this.debugLog(
						`Alias ${this.config.alias} points to version ${ALIAS_CONFIG.FunctionVersion}, but no changes detected for version ${specificVersion}`,
					);
				} catch (error) {
					// If the alias doesn't exist, that's fine - we'll continue
					if (error.code !== 'ResourceNotFoundException') {
						throw error;
					}
					this.debugLog(
						`Alias ${this.config.alias} doesn't exist for function: ${functionData.functionName}, no changes detected`,
					);
				}

				this.debugLog(`No function changes detected for: ${functionData.functionName}`);
				return false;
			} catch (error) {
				// If version doesn't exist, assume it's new
				if (error.code === 'ResourceNotFoundException') {
					this.debugLog(
						`Version ${specificVersion} doesn't exist for function: ${functionData.functionName}, treating as new deployment`,
					);
					return true;
				}
				throw error;
			}
		} catch (error) {
			this.debugLog(
				`Error checking function changes for '${functionData.functionName}': ${error.message}`,
				true,
				'error',
			);
			// In case of error, assume changes to be safe
			return true;
		}
	}

	/**
	 * Publishes a new version of the Lambda function with updated configuration.
	 */
	async publishNewFunctionVersion(functionData) {
		try {
			this.debugLog(`Publishing new version for function: ${functionData.functionName}`);

			const LAMBDA = new this.provider.sdk.Lambda({ region: this.config.region });

			// Update the function configuration with new environment variables
			await LAMBDA.updateFunctionConfiguration({
				FunctionName: functionData.functionName,
				Environment: {
					Variables: functionData.environment,
				},
			}).promise();

			// Wait for the update to complete
			await this.waitForFunctionUpdateToComplete(functionData.functionName);

			// Publish a new version
			const RESULT = await LAMBDA.publishVersion({
				FunctionName: functionData.functionName,
				Description: functionData.description || '',
			}).promise();

			this.debugLog(
				`Published new version ${RESULT.Version} for function: ${functionData.functionName}`,
				false,
				'success',
			);
			return RESULT.Version;
		} catch (error) {
			this.debugLog(
				`Error publishing new version for function '${functionData.functionName}': ${error.message}`,
				true,
				'error',
			);
			throw error;
		}
	}

	/**
	 * Waits for a function update operation to complete.
	 */
	async waitForFunctionUpdateToComplete(functionName) {
		this.debugLog(`Waiting for function update to complete: ${functionName}`);

		const LAMBDA = new this.provider.sdk.Lambda({ region: this.config.region });
		let isUpdating = true;
		let retries = 0;
		const MAX_RETRIES = 30;

		while (isUpdating && retries < MAX_RETRIES) {
			try {
				const CONFIG = await LAMBDA.getFunctionConfiguration({
					FunctionName: functionName,
				}).promise();

				if (CONFIG.LastUpdateStatus === 'Successful') {
					isUpdating = false;
					this.debugLog(`Function update completed successfully: ${functionName}`);
				} else if (CONFIG.LastUpdateStatus === 'Failed') {
					throw new Error(`Function update failed: ${CONFIG.LastUpdateStatusReason || 'Unknown reason'}`);
				} else {
					// Still in progress, wait and retry
					await new Promise((resolve) => setTimeout(resolve, 1000));
					retries++;
				}
			} catch (error) {
				if (error.code === 'ResourceNotFoundException') {
					throw error;
				}
				// For other errors, wait and retry
				await new Promise((resolve) => setTimeout(resolve, 1000));
				retries++;
			}
		}

		if (retries >= MAX_RETRIES) {
			throw new Error(`Function update timed out after ${MAX_RETRIES} retries: ${functionName}`);
		}
	}

	/**
	 * Gets the latest version of a Lambda function.
	 */
	async getLatestFunctionVersion(functionName) {
		try {
			this.debugLog(`Getting latest version for function: ${functionName}`);

			const LAMBDA = new this.provider.sdk.Lambda({ region: this.config.region });

			// First check if the function exists
			try {
				await LAMBDA.getFunction({
					FunctionName: functionName,
				}).promise();
			} catch (funcError) {
				// If function doesn't exist, log and return null
				if (funcError.code === 'ResourceNotFoundException') {
					this.debugLog(`Function '${functionName}' not found`, true, 'warning');
					return null;
				}

				throw funcError;
			}

			// Try to get versions - if no versions exist, we'll use $LATEST
			try {
				const RESULT = await LAMBDA.listVersionsByFunction({
					FunctionName: functionName,
					MaxItems: 20,
				}).promise();

				// Filter out $LATEST and sort versions in descending order
				const VERSIONS = RESULT.Versions.filter((version) => version.Version !== '$LATEST').sort(
					(a, b) => parseInt(b.Version) - parseInt(a.Version),
				);

				if (VERSIONS.length > 0) {
					// Return the most recent version
					return VERSIONS[0].Version;
				}

				// If no published versions found, use the unqualified $LATEST and note this
				this.debugLog(
					`No numbered versions found for function: ${functionName}, falling back to $LATEST`,
					false,
					'warning',
				);
				return '$LATEST';
			} catch (error) {
				// If versions can't be listed but function exists, fall back to $LATEST
				this.debugLog(
					`Error listing versions for '${functionName}': ${error.message}, falling back to $LATEST`,
					false,
					'warning',
				);
				return '$LATEST';
			}
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
			// Validate inputs
			if (!functionName) throw new Error('Function name is required');
			if (!version) throw new Error('Function version is required');

			const LAMBDA = new this.provider.sdk.Lambda({ region: this.config.region });

			// Special handling for $LATEST
			if (version === '$LATEST') {
				this.debugLog(
					`Using $LATEST version for function '${functionName}' since no published versions found`,
					false,
					'warning',
				);
			}

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
					false,
					'success',
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
	async updateApiGatewayIntegrations(functions, httpAliases) {
		if (!this.config.restApiId || httpAliases.length === 0) {
			this.debugLog(
				'Skipping API Gateway integration updates (no REST API ID or no HTTP aliases created)',
				false,
				'warning',
			);
			return;
		}

		this.debugLog(`Updating HTTP API Gateway integrations for ${httpAliases.length} functions...`);

		try {
			// Get all API Gateway resources
			const RESOURCES = await this.getApiGatewayResources();

			// For each created alias that has HTTP events, update the API Gateway integration
			for (const ALIAS of httpAliases) {
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

			this.debugLog('HTTP API Gateway integrations updated successfully.', false, 'success');
		} catch (error) {
			this.debugLog(`Error updating HTTP API Gateway integrations: ${error.message}`, true, 'error');
			throw error;
		}
	}

	/**
	 * Updates WebSocket API integrations to use function aliases.
	 */
	async updateWebSocketApiIntegrations(functions, websocketAliases) {
		if (!this.config.websocketApiId || websocketAliases.length === 0) {
			this.debugLog(
				'Skipping WebSocket API integration updates (no WebSocket API ID or no WebSocket aliases created)',
				false,
				'warning',
			);
			return;
		}

		this.debugLog(`Updating WebSocket API integrations for ${websocketAliases.length} functions...`);

		try {
			// Get all WebSocket API routes
			const ROUTES = await this.getWebSocketApiRoutes();

			// For each created alias that has WebSocket events, update the WebSocket API integration
			for (const ALIAS of websocketAliases) {
				// Filter for WebSocket events
				const WEBSOCKET_EVENTS = this.getWebSocketEventsForFunction(ALIAS.name, functions);

				if (WEBSOCKET_EVENTS.length === 0) {
					this.debugLog(`No WebSocket events found for function '${ALIAS.name}'. Skipping WebSocket API integration.`);
					continue;
				}

				// Update each WebSocket event integration
				for (const EVENT of WEBSOCKET_EVENTS) {
					await this.updateWebSocketApiIntegration(ROUTES, ALIAS, EVENT);
				}
			}

			// Deploy the WebSocket API stage to apply changes
			await this.deployWebSocketApi();

			this.debugLog('WebSocket API integrations updated successfully.', false, 'success');
		} catch (error) {
			this.debugLog(`Error updating WebSocket API integrations: ${error.message}`, true, 'error');
			throw error;
		}
	}

	/**
	 * Gets all WebSocket API routes.
	 */
	async getWebSocketApiRoutes() {
		try {
			this.debugLog(`Getting WebSocket API routes for API ID: ${this.config.websocketApiId}`);

			const API_GATEWAY_V2 = new this.provider.sdk.ApiGatewayV2({ region: this.config.region });
			const RESULT = await API_GATEWAY_V2.getRoutes({ ApiId: this.config.websocketApiId }).promise();

			this.debugLog(`Found ${RESULT.Items.length} WebSocket API routes.`);
			return RESULT.Items;
		} catch (error) {
			this.debugLog(`Error getting WebSocket API routes: ${error.message}`, true, 'error');
			throw error;
		}
	}

	/**
	 * Gets all WebSocket events for a specific function.
	 */
	getWebSocketEventsForFunction(functionName, functions) {
		const FUNCTION = functions.find((f) => f.name === functionName);
		if (!FUNCTION) return [];

		return FUNCTION.events
			.filter((event) => event.websocket)
			.map((event) => {
				// Handle string format (just the route) or object format with route property
				if (typeof event.websocket === 'string') {
					return { route: event.websocket };
				}
				return { route: event.websocket.route };
			});
	}

	/**
	 * Updates a WebSocket API integration to use the function alias.
	 */
	async updateWebSocketApiIntegration(routes, alias, websocketEvent) {
		try {
			// Find the route integration for the given route key
			const ROUTE = routes.find((route) => route.RouteKey === websocketEvent.route);

			if (!ROUTE) {
				this.debugLog(
					`Route not found for key '${websocketEvent.route}'. Skipping integration update.`,
					false,
					'warning',
				);
				return;
			}

			this.debugLog(`Updating integration for WebSocket route: ${websocketEvent.route}`);

			const API_GATEWAY_V2 = new this.provider.sdk.ApiGatewayV2({ region: this.config.region });

			// Get current integration for the route
			const INTEGRATIONS = await API_GATEWAY_V2.getIntegrations({
				ApiId: this.config.websocketApiId,
			}).promise();

			const ROUTE_INTEGRATION = INTEGRATIONS.Items.find(
				(integration) =>
					integration.ApiId === this.config.websocketApiId &&
					integration.IntegrationId === ROUTE.Target?.split('/').pop(),
			);

			if (!ROUTE_INTEGRATION) {
				this.debugLog(`No integration found for route: ${websocketEvent.route}`, false, 'warning');
				return;
			}

			// Create the new integration URI pointing to the alias
			const STAGE_VARIABLES_ALIAS = '${stageVariables.alias}';
			const LAMBDA_ARN = `arn:aws:lambda:${this.config.region}:${this.config.accountId}:function:${alias.functionName}:${STAGE_VARIABLES_ALIAS}`;
			const URI = `arn:aws:apigateway:${this.config.region}:lambda:path/2015-03-31/functions/${LAMBDA_ARN}/invocations`;

			// Update the integration to point to the alias
			await API_GATEWAY_V2.updateIntegration({
				ApiId: this.config.websocketApiId,
				IntegrationId: ROUTE_INTEGRATION.IntegrationId,
				IntegrationUri: URI,
			}).promise();

			// Add permission for WebSocket API Gateway to invoke the Lambda alias
			await this.addWebSocketLambdaPermission(alias, ROUTE.RouteId, websocketEvent.route);

			this.debugLog(
				`Successfully updated integration for WebSocket route: ${websocketEvent.route} to use alias: ${this.config.alias}`,
				false,
				'success',
			);
		} catch (error) {
			this.debugLog(
				`Error updating WebSocket API integration for route '${websocketEvent.route}': ${error.message}`,
				true,
				'error',
			);
			throw error;
		}
	}

	/**
	 * Adds permission for WebSocket API Gateway to invoke the Lambda alias.
	 */
	async addWebSocketLambdaPermission(alias, routeId, routeKey) {
		try {
			const LAMBDA = new this.provider.sdk.Lambda({ region: this.config.region });

			// Get the qualified function ARN with the alias
			const QUALIFIED_FUNCTION_NAME = `${alias.functionName}:${this.config.alias}`;

			// Create statement IDs for the specific route
			const STATEMENT_ID = `apigateway-ws-${this.config.websocketApiId}-${this.config.alias}-${routeId}`.replace(
				/[^a-zA-Z0-9-_]/g,
				'-',
			);

			const SOURCE_ARN = `arn:aws:execute-api:${this.config.region}:${this.config.accountId}:${this.config.websocketApiId}/*/${routeKey}`;

			this.debugLog(`Adding permission for WebSocket API Gateway to invoke Lambda alias: ${QUALIFIED_FUNCTION_NAME}`);

			// Try to remove any existing permissions first
			try {
				await LAMBDA.removePermission({
					FunctionName: QUALIFIED_FUNCTION_NAME,
					StatementId: STATEMENT_ID,
				}).promise();
			} catch (error) {
				// Ignore if the permission doesn't exist
				if (error.code !== 'ResourceNotFoundException') {
					this.debugLog(`Warning: ${error.message}`, false, 'warning');
				}
			}

			// Add the permission
			await LAMBDA.addPermission({
				FunctionName: QUALIFIED_FUNCTION_NAME,
				StatementId: STATEMENT_ID,
				Action: 'lambda:InvokeFunction',
				Principal: 'apigateway.amazonaws.com',
				SourceArn: SOURCE_ARN,
			}).promise();

			this.debugLog(
				`Successfully added permission for WebSocket API Gateway to invoke Lambda alias: ${QUALIFIED_FUNCTION_NAME}`,
				false,
				'success',
			);
		} catch (error) {
			this.debugLog(`Error adding WebSocket Lambda permission: ${error.message}`, true, 'error');
			throw error;
		}
	}

	/**
	 * Deploys the WebSocket API to apply changes.
	 */
	async deployWebSocketApi() {
		try {
			this.debugLog(`Deploying WebSocket API (API ID: ${this.config.websocketApiId})...`);

			const API_GATEWAY_V2 = new this.provider.sdk.ApiGatewayV2({ region: this.config.region });
			const STAGE = this.provider.getStage();

			// Create a new deployment
			const DEPLOYMENT = await API_GATEWAY_V2.createDeployment({
				ApiId: this.config.websocketApiId,
				Description: `Deployed by ${PLUGIN_NAME} for alias: ${this.config.alias}`,
			}).promise();

			this.debugLog(`Created deployment with ID: ${DEPLOYMENT.DeploymentId}`);

			// Update or create the stage with the new deployment
			try {
				// First try to get the stage
				await API_GATEWAY_V2.getStage({
					ApiId: this.config.websocketApiId,
					StageName: STAGE,
				}).promise();

				// If stage exists, update it
				await API_GATEWAY_V2.updateStage({
					ApiId: this.config.websocketApiId,
					StageName: STAGE,
					DeploymentId: DEPLOYMENT.DeploymentId,
					StageVariables: {
						alias: this.config.alias,
					},
				}).promise();

				this.debugLog(`Updated existing stage: ${STAGE} with new deployment`);
			} catch (error) {
				// If stage doesn't exist, create it
				if (error.code === 'NotFoundException') {
					await API_GATEWAY_V2.createStage({
						ApiId: this.config.websocketApiId,
						StageName: STAGE,
						DeploymentId: DEPLOYMENT.DeploymentId,
						StageVariables: {
							alias: this.config.alias,
						},
					}).promise();

					this.debugLog(`Created new stage: ${STAGE} with deployment`);
				} else {
					throw error;
				}
			}

			// Print endpoint URL
			const ENDPOINT_URL = `wss://${this.config.websocketApiId}.execute-api.${this.config.region}.amazonaws.com/${STAGE}`;
			this.debugLog(`${PLUGIN_NAME}: WebSocket API endpoint: ${ENDPOINT_URL}`, false, 'info');

			this.debugLog(`Successfully deployed WebSocket API to stage: ${STAGE}`, false, 'success');
		} catch (error) {
			this.debugLog(`Error deploying WebSocket API: ${error.message}`, true, 'error');
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
		const RESOURCE = resources.find((resource) => resource.path === NORMALIZED_PATH);

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
			this.debugLog(`${PLUGIN_NAME}: API Gateway endpoint: ${ENDPOINT_URL}`, false, 'info');

			this.debugLog(`Successfully deployed API Gateway to stage: ${STAGE}`, false, 'success');
		} catch (error) {
			this.debugLog(`Error deploying API Gateway: ${error.message}`, true, 'error');
			throw error;
		}
	}
}

module.exports = ServerlessLambdaAliasPlugin;
