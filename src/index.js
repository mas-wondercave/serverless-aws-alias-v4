'use strict';

/**
 * serverless-aws-alias-v4 (patched)
 *
 * Adds Lambda alias management and updates API Gateway (REST & WebSocket) integrations
 * to route traffic through a stage variable. This patched version supports per-function
 * stage variables so each function can resolve to a different alias (blue/green) at runtime.
 *
 * New config in `custom.alias`:
 *  - perFunctionStageVars: boolean (default false)
 *    If true, API Gateway URIs will reference a per-function stage variable instead of a single global `alias`.
 *  - stageVarKeyTemplate: string (default "{functionName}Alias")
 *    Template used to derive the stage variable key. Placeholders:
 *      {functionName}: the Serverless logical function name (e.g. "audiences")
 *      {aliasName}: the current alias name (e.g. "blue")
 *  - stageVarSanitize: boolean (default true)
 *    If true, non [A-Za-z0-9_] characters are replaced with `_` to produce a valid stage variable key.
 *
 * Example:
 * custom:
 *   alias:
 *     name: ${env:ALIAS_NAME}
 *     skipApiGateway: true
 *     skipWebSocketGateway: true
 *     perFunctionStageVars: true
 *     stageVarKeyTemplate: "{functionName}Alias"
 *     stageVarSanitize: true
 *
 * At integration time:
 *   - global:  arn:...:function:<fnName>:${stageVariables.alias}
 *   - per-fn:  arn:...:function:<fnName>:${stageVariables.<audiencesAlias>}
 *
 * IMPORTANT: When perFunctionStageVars=true this plugin WILL NOT attempt to set the global
 * `alias` stage variable on your API Gateway stage. You must manage all per-function stage
 * variables in your pipeline (e.g., set audiencesAlias=blue|green for each function).
 */

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
      alias: this.stage, // default alias to stage (overridden in initializePlugin)
      excludedFunctions: new Set(),
      apiGatewayResourceCache: new Map(),
      accountId: null,
      verbose: false,
      region: this.provider.getRegion(),
      restApiId: this.serverless.service.provider.apiGateway?.restApiId,
      websocketApiId: this.serverless.service.provider.websocketApiId,

      // --- New per-function stage var options ---
      perFunctionStageVars: false,
      stageVarKeyTemplate: '{functionName}Alias',
      stageVarSanitize: true,
      // If true, plugin won't set a global stage variable 'alias' during deployApiGateway/update
      // (this is automatically true when perFunctionStageVars is enabled)
      skipSetGlobalStageVar: false,
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
      let color = '\\x1b[0m'; // Reset color
      switch (type) {
        case 'success':
          color = '\\x1b[32m'; // Green
          break;
        case 'warning':
          color = '\\x1b[33m'; // Yellow
          break;
        case 'error':
          color = '\\x1b[31m'; // Red
          break;
        case 'info': // Blue for regular debug info
        default:
          color = '\\x1b[34m'; // Blue
      }
      this.serverless.cli.log(`${color}${PLUGIN_NAME}: ${message}\\x1b[0m`);
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

    // Load Deploy ApiGateway (with CLI flag override)
    this.config.skipApiGateway = CUSTOM_ALIAS_CONFIG.skipApiGateway !== undefined
      ? CUSTOM_ALIAS_CONFIG.skipApiGateway : false;

    // Load Deploy WebSocket Gateway (with CLI flag override)
    this.config.skipWebSocketGateway = CUSTOM_ALIAS_CONFIG.skipWebSocketGateway !== undefined
      ? CUSTOM_ALIAS_CONFIG.skipWebSocketGateway : false;

    // --- New options for per-function stage variables ---
    this.config.perFunctionStageVars = !!CUSTOM_ALIAS_CONFIG.perFunctionStageVars;
    this.config.stageVarKeyTemplate = CUSTOM_ALIAS_CONFIG.stageVarKeyTemplate || '{functionName}Alias';
    this.config.stageVarSanitize = CUSTOM_ALIAS_CONFIG.stageVarSanitize !== false; // default true

    // If per-function stage vars are active, never set the global 'alias' stage var here
    this.config.skipSetGlobalStageVar = this.config.perFunctionStageVars || !!CUSTOM_ALIAS_CONFIG.skipSetGlobalStageVar;

    // Check what event types are used in this service
    const { hasHttpEvents, hasWebsocketEvents } = this.detectEventTypes();

    this.debugLog(`Initialized with Alias: ${this.config.alias}`, false, 'success');
    this.debugLog(`Region: ${this.config.region}`);

    if (this.config.excludedFunctions.size > 0) {
      this.debugLog(`Excluded Functions: ${Array.from(this.config.excludedFunctions).join(', ')}`);
    }

    if (this.config.perFunctionStageVars) {
      this.debugLog(
        `Per-function stage variables ENABLED. Key template: "${this.config.stageVarKeyTemplate}" (sanitize=${this.config.stageVarSanitize}).`,
        false,
        'info'
      );
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
      throw new this.serverless.classes.Error(`Invalid API Gateway configuration found:\\n${INVALID_CONFIG.join('\\n')}`);
    }

    // Warn if API Gateway deployment is disabled
    if (this.config.skipApiGateway) {
      this.debugLog(
        'WARNING: API Gateway deployment is disabled. Ensure APIs are deployed manually if integration URIs have changed.',
        true,
        'warning'
      );
    }

    if (this.config.skipWebSocketGateway) {
      this.debugLog(
        'WARNING: WebSocket Gateway deployment is disabled. Ensure APIs are deployed manually if integration URIs have changed.',
        true,
        'warning'
      );
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
        if (!event.websocket.route && typeof event.websocket !== 'string') {
          INVALID_CONFIG.push(`Function '${funcName}' has a websocket event without a specified route`);
          return;
        }
        const ROUTE = typeof event.websocket === 'string' ? event.websocket : event.websocket.route;
        if (ROUTE.startsWith('$') && !VALID_ROUTES.includes(ROUTE)) {
          INVALID_CONFIG.push(
            `Function '${funcName}' has invalid WebSocket route '${ROUTE}'. Predefined routes are: ${VALID_ROUTES.join(', ')}`
          );
        }
      });
    });

    return INVALID_CONFIG;
  }

  validateEventMethod(funcName, event, validMethods, invalidConfig) {
    const METHOD = event.http.method.toUpperCase();
    if (!validMethods.includes(METHOD)) {
      invalidConfig.push(
        `Function '${funcName}' has invalid HTTP method '${METHOD}'. Valid methods are: ${validMethods.join(', ')}`,
      );
    }
  }

  validateEventMethodSettings(funcName, event, validSettings, invalidConfig) {
    Object.keys(event.http.methodSettings).forEach((setting) => {
      if (!validSettings.has(setting)) {
        invalidConfig.push(
          `Function '${funcName}' has invalid method setting '${setting}'. Valid settings are: ${Array.from(validSettings).join(', ')}`,
        );
      }
    });
  }

  // --- Helpers for per-function stage vars ---

  /**
   * Build the stage variable key for a function based on template and sanitization.
   * @param {string} functionName - The logical serverless function name (as in serverless.yml)
   * @returns {string} stage variable key (e.g., "audiencesAlias")
   */
  buildStageVarKey(functionName) {
    const template = this.config.stageVarKeyTemplate || '{functionName}Alias';
    const aliasName = this.config.alias || '';
    let key = template
      .replace(/{functionName}/g, functionName || 'function')
      .replace(/{aliasName}/g, aliasName);
    if (this.config.stageVarSanitize) {
      key = key.replace(/[^A-Za-z0-9_]/g, '_');
    }
    return key;
  }

  /**
   * Returns the stage variable expression to inject in integration URIs.
   * For global mode: ${stageVariables.alias}
   * For per-function mode: ${stageVariables.<key>}
   */
  getStageVarExprForFunction(functionName) {
    if (!this.config.perFunctionStageVars) {
      return '${stageVariables.alias}';
    }
    const key = this.buildStageVarKey(functionName);
    return `\${stageVariables.${key}}`;
  }

  // --- Core Deployment Workflow ---

  async deployAliasWorkflow() {
    try {
      this.debugLog(`${PLUGIN_NAME}: Starting alias deployment workflow...`, false, 'info');
      await this.getAwsAccountId();

      const FUNCTIONS = this.getFunctionsForAliasDeployment();
      if (FUNCTIONS.length === 0) {
        this.debugLog('No functions to process for alias deployment. Exiting.', true, 'warning');
        return;
      }

      this.debugLog(`Found ${FUNCTIONS.length} functions to process for alias deployment.`);
      const CREATED_ALIASES = await this.createOrUpdateFunctionAliases(FUNCTIONS);

      if (CREATED_ALIASES.length === 0) {
        this.debugLog(
          'No aliases were created or updated. Consider using the --force flag to force alias deployment if needed.',
          false,
          'warning',
        );
        return;
      }

      const HTTP_ALIASES = CREATED_ALIASES.filter((alias) => this.hasHttpEvents(alias.name, FUNCTIONS));
      const WEBSOCKET_ALIASES = CREATED_ALIASES.filter((alias) => this.hasWebSocketEvents(alias.name, FUNCTIONS));

      if (HTTP_ALIASES.length > 0 && this.config.restApiId) {
        await this.updateApiGatewayIntegrations(FUNCTIONS, HTTP_ALIASES);
      } else if (HTTP_ALIASES.length > 0) {
        this.debugLog('HTTP events found but no REST API ID provided. Skipping HTTP integrations.', false, 'warning');
      }

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

  hasHttpEvents(functionName, functions) {
    const FUNCTION = functions.find((f) => f.name === functionName);
    if (!FUNCTION) return false;
    return FUNCTION.events.some((event) => event.http);
  }

  hasWebSocketEvents(functionName, functions) {
    const FUNCTION = functions.find((f) => f.name === functionName);
    if (!FUNCTION) return false;
    return FUNCTION.events.some((event) => event.websocket);
  }

  async getAwsAccountId() {
    if (this.config.accountId) return this.config.accountId;
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

  getFunctionsForAliasDeployment() {
    const SERVICES = this.serverless.service;
    const FUNCTIONS = [];

    Object.entries(SERVICES.functions || {}).forEach(([funcName, funcDef]) => {
      if (this.config.excludedFunctions.has(funcName)) {
        this.debugLog(`Skipping excluded function: ${funcName}`);
        return;
      }
      const PROVIDER_ENV = SERVICES.provider.environment || {};
      const FUNCTION_ENV = funcDef.environment || {};
      const MERGED_ENV = { ...PROVIDER_ENV, ...FUNCTION_ENV };

      FUNCTIONS.push({
        name: funcName, // logical name
        functionName: funcDef.name || this.provider.naming.getLambdaLogicalId(funcName),
        handler: funcDef.handler,
        environment: MERGED_ENV,
        events: funcDef.events || [],
        description: funcDef.description || '',
      });
    });

    return FUNCTIONS;
  }

  async createOrUpdateFunctionAliases(functions) {
    this.debugLog('Creating or updating Lambda function aliases...');
    const CREATED_ALIASES = [];
    const FAILED_FUNCTIONS = [];

    for (const FUNCTION of functions) {
      try {
        let version;
        const EXISTING_ALIAS = await this.getExistingAlias(FUNCTION.functionName);
        const LATEST_VERSION = await this.getLatestFunctionVersion(FUNCTION.functionName);

        if (IS_FORCE && LATEST_VERSION) {
          this.debugLog(
            `Force flag detected for function: ${FUNCTION.functionName}. Using latest version ${LATEST_VERSION}`,
          );
          version = LATEST_VERSION;
        } else if (!LATEST_VERSION) {
          this.debugLog(`No existing versions for function: ${FUNCTION.functionName}. Publishing new version...`);
          version = await this.publishNewFunctionVersion(FUNCTION);
        } else {
          const COMPARE_VERSION = EXISTING_ALIAS ? EXISTING_ALIAS.FunctionVersion : LATEST_VERSION;
          const HAS_CHANGES = await this.haveFunctionChanges(FUNCTION, COMPARE_VERSION);

          if (HAS_CHANGES) {
            this.debugLog(`Changes detected for function: ${FUNCTION.functionName}. Publishing new version...`);
            version = await this.publishNewFunctionVersion(FUNCTION);
          } else if (!EXISTING_ALIAS) {
            this.debugLog(
              `No changes detected for new function: ${FUNCTION.functionName}. Using latest version ${LATEST_VERSION}`,
            );
            version = LATEST_VERSION;
          } else {
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

        const ALIAS = await this.createOrUpdateAlias(FUNCTION.functionName, version);
        if (ALIAS) {
          CREATED_ALIASES.push({
            functionName: FUNCTION.functionName, // physical name
            name: FUNCTION.name,                // logical name
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

    if (FAILED_FUNCTIONS.length > 0) {
      this.debugLog(
        `WARNING: Failed to process aliases for ${FAILED_FUNCTIONS.length} functions: ${FAILED_FUNCTIONS.join(', ')}`,
        true,
        'warning',
      );
    }

    return CREATED_ALIASES;
  }

  async getExistingAlias(functionName) {
    try {
      const LAMBDA = new this.provider.sdk.Lambda({ region: this.config.region });
      const ALIAS = await LAMBDA.getAlias({ FunctionName: functionName, Name: this.config.alias }).promise();
      return ALIAS;
    } catch (error) {
      if (error.code === 'ResourceNotFoundException') return null;
      throw error;
    }
  }

  async haveFunctionChanges(functionData, specificVersion) {
    try {
      const LAMBDA = new this.provider.sdk.Lambda({ region: this.config.region });
      const LATEST_CONFIG = await LAMBDA.getFunctionConfiguration({ FunctionName: functionData.functionName }).promise();
      let versionConfig;
      try {
        versionConfig = await LAMBDA.getFunctionConfiguration({
          FunctionName: functionData.functionName,
          Qualifier: specificVersion,
        }).promise();

        if (LATEST_CONFIG.CodeSha256 !== versionConfig.CodeSha256) return true;
        if (LATEST_CONFIG.Handler !== versionConfig.Handler) return true;
        if (LATEST_CONFIG.Runtime !== versionConfig.Runtime) return true;
        if (LATEST_CONFIG.MemorySize !== versionConfig.MemorySize) return true;
        if (LATEST_CONFIG.Timeout !== versionConfig.Timeout) return true;
        if (LATEST_CONFIG.Role !== versionConfig.Role) return true;

        const CURRENT_ENV = versionConfig.Environment?.Variables || {};
        const LATEST_ENV = LATEST_CONFIG.Environment?.Variables || {};
        const CONFIG_ENV = functionData.environment || {};

        const CURRENT_KEYS = Object.keys(CURRENT_ENV).sort();
        const LATEST_KEYS = Object.keys(LATEST_ENV).sort();
        const CONFIG_KEYS = Object.keys(CONFIG_ENV).sort();

        if (JSON.stringify(CURRENT_KEYS) !== JSON.stringify(LATEST_KEYS)) return true;
        if (JSON.stringify(CURRENT_KEYS) !== JSON.stringify(CONFIG_KEYS)) return true;

        for (const KEY of CURRENT_KEYS) {
          if (CURRENT_ENV[KEY] !== LATEST_ENV[KEY]) return true;
        }
        for (const KEY of CURRENT_KEYS) {
          if (CURRENT_ENV[KEY] !== CONFIG_ENV[KEY]) return true;
        }

        const VERSION_LAYER_ARNS = (versionConfig.Layers || []).map((layer) => layer.Arn).sort();
        const LATEST_LAYER_ARNS = (LATEST_CONFIG.Layers || []).map((layer) => layer.Arn).sort();
        if (JSON.stringify(VERSION_LAYER_ARNS) !== JSON.stringify(LATEST_LAYER_ARNS)) return true;

        try {
          const ALIAS_CONFIG = await LAMBDA.getAlias({
            FunctionName: functionData.functionName,
            Name: this.config.alias,
          }).promise();
          if (ALIAS_CONFIG.FunctionVersion === specificVersion) {
            return false;
          }
        } catch (error) {
          if (error.code !== 'ResourceNotFoundException') throw error;
        }
        return false;
      } catch (error) {
        if (error.code === 'ResourceNotFoundException') return true;
        throw error;
      }
    } catch (error) {
      this.debugLog(
        `Error checking function changes for '${functionData.functionName}': ${error.message}`,
        true,
        'error',
      );
      return true;
    }
  }

  async publishNewFunctionVersion(functionData) {
    try {
      this.debugLog(`Publishing new version for function: ${functionData.functionName}`);
      const LAMBDA = new this.provider.sdk.Lambda({ region: this.config.region });

      await LAMBDA.updateFunctionConfiguration({
        FunctionName: functionData.functionName,
        Environment: { Variables: functionData.environment },
      }).promise();

      await this.waitForFunctionUpdateToComplete(functionData.functionName);

      const RESULT = await LAMBDA.publishVersion({
        FunctionName: functionData.functionName,
        Description: functionData.description || '',
      }).promise();

      this.debugLog(`Published new version ${RESULT.Version} for function: ${functionData.functionName}`, false, 'success');
      return RESULT.Version;
    } catch (error) {
      this.debugLog(`Error publishing new version for function '${functionData.functionName}': ${error.message}`, true, 'error');
      throw error;
    }
  }

  async waitForFunctionUpdateToComplete(functionName) {
    this.debugLog(`Waiting for function update to complete: ${functionName}`);
    const LAMBDA = new this.provider.sdk.Lambda({ region: this.config.region });
    let retries = 0;
    const MAX_RETRIES = 30;

    while (retries < MAX_RETRIES) {
      try {
        const CONFIG = await LAMBDA.getFunctionConfiguration({ FunctionName: functionName }).promise();
        if (CONFIG.LastUpdateStatus === 'Successful') return;
        if (CONFIG.LastUpdateStatus === 'Failed') {
          throw new Error(`Function update failed: ${CONFIG.LastUpdateStatusReason || 'Unknown reason'}`);
        }
        await new Promise((r) => setTimeout(r, 1000));
        retries++;
      } catch (error) {
        if (error.code === 'ResourceNotFoundException') throw error;
        await new Promise((r) => setTimeout(r, 1000));
        retries++;
      }
    }
    throw new Error(`Function update timed out after ${MAX_RETRIES} retries: ${functionName}`);
  }

  async getLatestFunctionVersion(functionName) {
    try {
      this.debugLog(`Getting latest version for function: ${functionName}`);
      const LAMBDA = new this.provider.sdk.Lambda({ region: this.config.region });

      try {
        await LAMBDA.getFunction({ FunctionName: functionName }).promise();
      } catch (funcError) {
        if (funcError.code === 'ResourceNotFoundException') {
          this.debugLog(`Function '${functionName}' not found`, true, 'warning');
          return null;
        }
        throw funcError;
      }

      try {
        const RESULT = await LAMBDA.listVersionsByFunction({ FunctionName: functionName, MaxItems: 20 }).promise();
        const VERSIONS = RESULT.Versions.filter((v) => v.Version !== '$LATEST')
          .sort((a, b) => parseInt(b.Version) - parseInt(a.Version));
        if (VERSIONS.length > 0) return VERSIONS[0].Version;
        this.debugLog(`No numbered versions found for function: ${functionName}, falling back to $LATEST`, false, 'warning');
        return '$LATEST';
      } catch (error) {
        this.debugLog(`Error listing versions for '${functionName}': ${error.message}, falling back to $LATEST`, false, 'warning');
        return '$LATEST';
      }
    } catch (error) {
      this.debugLog(`Error getting latest version for function '${functionName}': ${error.message}`, true, 'error');
      throw error;
    }
  }

  async createOrUpdateAlias(functionName, version) {
    try {
      if (!functionName) throw new Error('Function name is required');
      if (!version) throw new Error('Function version is required');

      const LAMBDA = new this.provider.sdk.Lambda({ region: this.config.region });
      if (version === '$LATEST') {
        this.debugLog(`Using $LATEST version for function '${functionName}' since no published versions found`, false, 'warning');
      }

      try {
        this.debugLog(`Checking if alias '${this.config.alias}' exists for function '${functionName}'`);
        const EXISTING_ALIAS = await LAMBDA.getAlias({ FunctionName: functionName, Name: this.config.alias }).promise();
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
        if (error.code === 'ResourceNotFoundException') {
          this.debugLog(`Creating new alias '${this.config.alias}' for function '${functionName}' pointing to version ${version}`);
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

  // ---- API Gateway (REST) ----

  async updateApiGatewayIntegrations(functions, httpAliases) {
    if (!this.config.restApiId || httpAliases.length === 0) {
      this.debugLog('Skipping API Gateway integration updates (no REST API ID or no HTTP aliases created)', false, 'warning');
      return;
    }

    this.debugLog(`Updating HTTP API Gateway integrations for ${httpAliases.length} functions...`);

    try {
      const RESOURCES = await this.getApiGatewayResources();
      for (const ALIAS of httpAliases) {
        const HTTP_EVENTS = this.getHttpEventsForFunction(ALIAS.name, functions);
        if (HTTP_EVENTS.length === 0) {
          this.debugLog(`No HTTP events found for function '${ALIAS.name}'. Skipping API Gateway integration.`);
          continue;
        }
        for (const EVENT of HTTP_EVENTS) {
          await this.updateApiGatewayIntegration(RESOURCES, ALIAS, EVENT);
        }
      }

      if (this.config.skipApiGateway) {
        this.debugLog('HTTP API Gateway integrations updated, deployment skipped as configured.', false, 'success');
      } else {
        await this.deployApiGateway();
        this.debugLog('HTTP API Gateway deployed and integrations updated successfully.', false, 'success');
      }
    } catch (error) {
      this.debugLog(`Error updating HTTP API Gateway integrations: ${error.message}`, true, 'error');
      throw error;
    }
  }

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

  findResourceByPath(resources, path) {
    const NORMALIZED_PATH = path.startsWith('/') ? path : `/${path}`;
    if (this.config.apiGatewayResourceCache.has(NORMALIZED_PATH)) {
      return this.config.apiGatewayResourceCache.get(NORMALIZED_PATH);
    }
    const RESOURCE = resources.find((resource) => resource.path === NORMALIZED_PATH);
    if (RESOURCE) this.config.apiGatewayResourceCache.set(NORMALIZED_PATH, RESOURCE);
    return RESOURCE;
  }

  async updateApiGatewayIntegration(resources, alias, httpEvent) {
    try {
      const RESOURCE = this.findResourceByPath(resources, httpEvent.path);
      if (!RESOURCE) {
        this.debugLog(`Resource not found for path '${httpEvent.path}'. Skipping integration update.`, false, 'warning');
        return;
      }

      this.debugLog(`Updating integration for path: ${httpEvent.path}, method: ${httpEvent.method}`);
      const API_GATEWAY = new this.provider.sdk.APIGateway({ region: this.config.region });

      // Fetch current integration (optional, for logging)
      try {
        const INTEGRATION = await API_GATEWAY.getIntegration({
          restApiId: this.config.restApiId,
          resourceId: RESOURCE.id,
          httpMethod: httpEvent.method,
        }).promise();
        if (INTEGRATION) {
          this.debugLog(`Current integration: ${JSON.stringify(INTEGRATION, null, 2)}`, false, 'info');
        }
      } catch (e) {
        this.debugLog(`No existing integration found for path: ${httpEvent.path}, method: ${httpEvent.method}`, false, 'warning');
      }

      // Build the integration URI with either global or per-function stage variable
      const stageVarExpr = this.getStageVarExprForFunction(alias.name);
      const LAMBDA_ARN = `arn:aws:lambda:${this.config.region}:${this.config.accountId}:function:${alias.functionName}:${stageVarExpr}`;
      const URI = `arn:aws:apigateway:${this.config.region}:lambda:path/2015-03-31/functions/${LAMBDA_ARN}/invocations`;

      await API_GATEWAY.updateIntegration({
        restApiId: this.config.restApiId,
        resourceId: RESOURCE.id,
        httpMethod: httpEvent.method,
        patchOperations: [{ op: 'replace', path: '/uri', value: URI }],
      }).promise();

      await this.addLambdaPermission(alias, RESOURCE.id, httpEvent.method, httpEvent.path);

      this.debugLog(
        `Successfully updated integration for path: ${httpEvent.path}, method: ${httpEvent.method} to use stage var ${stageVarExpr}`,
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

  async addLambdaPermission(alias, resourceId, method, path) {
    try {
      const LAMBDA = new this.provider.sdk.Lambda({ region: this.config.region });

      // If per-function stage variables are enabled, we grant permission on the UNQUALIFIED function.
      // This allows API Gateway to invoke any alias resolved by the stage variable.
      const QUALIFIED_FUNCTION_NAME = this.config.perFunctionStageVars
        ? alias.functionName
        : `${alias.functionName}:${this.config.alias}`;

      const STAGE_STATEMENT_ID =
        `apigateway-${this.config.restApiId}-${this.config.alias}-${method}-${resourceId}`.replace(/[^a-zA-Z0-9-_]/g, '-');
      const TEST_STATEMENT_ID =
        `apigateway-test-${this.config.restApiId}-${this.config.alias}-${method}-${resourceId}`.replace(/[^a-zA-Z0-9-_]/g, '-');

      const NORMALIZED_PATH = path.startsWith('/') ? path : `/${path}`;
      const SOURCE_ARN = `arn:aws:execute-api:${this.config.region}:${this.config.accountId}:${this.config.restApiId}/*/${method}${NORMALIZED_PATH}`;

      this.debugLog(`Adding permission for API Gateway to invoke Lambda: ${QUALIFIED_FUNCTION_NAME}`);

      try {
        await LAMBDA.removePermission({ FunctionName: QUALIFIED_FUNCTION_NAME, StatementId: STAGE_STATEMENT_ID }).promise();
      } catch (error) {
        if (error.code !== 'ResourceNotFoundException') {
          this.debugLog(`Warning: ${error.message}`, false, 'warning');
        }
      }
      try {
        await LAMBDA.removePermission({ FunctionName: QUALIFIED_FUNCTION_NAME, StatementId: TEST_STATEMENT_ID }).promise();
      } catch (error) {
        if (error.code !== 'ResourceNotFoundException') {
          this.debugLog(`Warning: ${error.message}`, false, 'warning');
        }
      }

      await LAMBDA.addPermission({
        FunctionName: QUALIFIED_FUNCTION_NAME,
        StatementId: STAGE_STATEMENT_ID,
        Action: 'lambda:InvokeFunction',
        Principal: 'apigateway.amazonaws.com',
        SourceArn: SOURCE_ARN,
      }).promise();

      await LAMBDA.addPermission({
        FunctionName: QUALIFIED_FUNCTION_NAME,
        StatementId: TEST_STATEMENT_ID,
        Action: 'lambda:InvokeFunction',
        Principal: 'apigateway.amazonaws.com',
        SourceArn: `arn:aws:execute-api:${this.config.region}:${this.config.accountId}:${this.config.restApiId}/test-invoke-stage/${method}${NORMALIZED_PATH}`,
      }).promise();

      this.debugLog(`Successfully added permission for API Gateway to invoke Lambda: ${QUALIFIED_FUNCTION_NAME}`, false, 'success');
    } catch (error) {
      this.debugLog(`Error adding Lambda permission: ${error.message}`, true, 'error');
      throw error;
    }
  }

  async deployApiGateway() {
    try {
      this.debugLog(`Deploying API Gateway (REST API ID: ${this.config.restApiId})...`);
      const API_GATEWAY = new this.provider.sdk.APIGateway({ region: this.config.region });
      const STAGE = this.provider.getStage();

      const DEPLOYMENT = await API_GATEWAY.createDeployment({
        restApiId: this.config.restApiId,
        stageName: STAGE,
        description: `Deployed by ${PLUGIN_NAME} for alias: ${this.config.alias}`,
      }).promise();

      this.debugLog(`Created deployment with ID: ${DEPLOYMENT.id} for stage: ${STAGE}`);

      // Only set global stage variable when NOT using per-function stage vars
      if (!this.config.skipSetGlobalStageVar) {
        await API_GATEWAY.updateStage({
          restApiId: this.config.restApiId,
          stageName: STAGE,
          patchOperations: [
            { op: 'replace', path: '/variables/alias', value: this.config.alias },
          ],
        }).promise();
        this.debugLog(`Set stage variable 'alias=${this.config.alias}' for stage: ${STAGE}`);
      } else {
        this.debugLog('Skipping setting global stage variable "alias" (perFunctionStageVars=true).', false, 'info');
      }

      const ENDPOINT_URL = `https://${this.config.restApiId}.execute-api.${this.config.region}.amazonaws.com/${STAGE}`;
      this.debugLog(`${PLUGIN_NAME}: API Gateway endpoint: ${ENDPOINT_URL}`, false, 'info');
      this.debugLog(`Successfully deployed API Gateway to stage: ${STAGE}`, false, 'success');
    } catch (error) {
      this.debugLog(`Error deploying API Gateway: ${error.message}`, true, 'error');
      throw error;
    }
  }

  // ---- WebSocket (API Gateway v2) ----

  async updateWebSocketApiIntegrations(functions, websocketAliases) {
    if (!this.config.websocketApiId || websocketAliases.length === 0) {
      this.debugLog('Skipping WebSocket API integration updates (no WebSocket API ID or no WebSocket aliases created)', false, 'warning');
      return;
    }

    this.debugLog(`Updating WebSocket API integrations for ${websocketAliases.length} functions...`);

    try {
      const ROUTES = await this.getWebSocketApiRoutes();
      for (const ALIAS of websocketAliases) {
        const WEBSOCKET_EVENTS = this.getWebSocketEventsForFunction(ALIAS.name, functions);
        if (WEBSOCKET_EVENTS.length === 0) {
          this.debugLog(`No WebSocket events found for function '${ALIAS.name}'. Skipping WebSocket API integration.`);
          continue;
        }
        for (const EVENT of WEBSOCKET_EVENTS) {
          await this.updateWebSocketApiIntegration(ROUTES, ALIAS, EVENT);
        }
      }

      if (this.config.skipWebSocketGateway) {
        this.debugLog('WebSocket API integrations updated, deployment skipped as configured.', false, 'success');
      } else {
        await this.deployWebSocketApi();
        this.debugLog('WebSocket API deployed and integrations updated successfully.', false, 'success');
      }
    } catch (error) {
      this.debugLog(`Error updating WebSocket API integrations: ${error.message}`, true, 'error');
      throw error;
    }
  }

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

  getWebSocketEventsForFunction(functionName, functions) {
    const FUNCTION = functions.find((f) => f.name === functionName);
    if (!FUNCTION) return [];
    return FUNCTION.events
      .filter((event) => event.websocket)
      .map((event) => (typeof event.websocket === 'string' ? { route: event.websocket } : { route: event.websocket.route }));
  }

  async updateWebSocketApiIntegration(routes, alias, websocketEvent) {
    try {
      const ROUTE = routes.find((route) => route.RouteKey === websocketEvent.route);
      if (!ROUTE) {
        this.debugLog(`Route not found for key '${websocketEvent.route}'. Skipping integration update.`, false, 'warning');
        return;
      }
      this.debugLog(`Updating integration for WebSocket route: ${websocketEvent.route}`);

      const API_GATEWAY_V2 = new this.provider.sdk.ApiGatewayV2({ region: this.config.region });
      const INTEGRATIONS = await API_GATEWAY_V2.getIntegrations({ ApiId: this.config.websocketApiId }).promise();
      const ROUTE_INTEGRATION = INTEGRATIONS.Items.find(
        (integration) => integration.ApiId === this.config.websocketApiId && integration.IntegrationId === ROUTE.Target?.split('/').pop(),
      );
      if (!ROUTE_INTEGRATION) {
        this.debugLog(`No integration found for route: ${websocketEvent.route}`, false, 'warning');
        return;
      }

      // Build the integration URI with either global or per-function stage variable
      const stageVarExpr = this.getStageVarExprForFunction(alias.name);
      const LAMBDA_ARN = `arn:aws:lambda:${this.config.region}:${this.config.accountId}:function:${alias.functionName}:${stageVarExpr}`;
      const URI = `arn:aws:apigateway:${this.config.region}:lambda:path/2015-03-31/functions/${LAMBDA_ARN}/invocations`;

      await API_GATEWAY_V2.updateIntegration({
        ApiId: this.config.websocketApiId,
        IntegrationId: ROUTE_INTEGRATION.IntegrationId,
        IntegrationUri: URI,
      }).promise();

      await this.addWebSocketLambdaPermission(alias, ROUTE.RouteId, websocketEvent.route);

      this.debugLog(
        `Successfully updated integration for WebSocket route: ${websocketEvent.route} to use stage var ${stageVarExpr}`,
        false,
        'success',
      );
    } catch (error) {
      this.debugLog(`Error updating WebSocket API integration for route '${websocketEvent.route}': ${error.message}`, true, 'error');
      throw error;
    }
  }

  async addWebSocketLambdaPermission(alias, routeId, routeKey) {
    try {
      const LAMBDA = new this.provider.sdk.Lambda({ region: this.config.region });

      // If per-function stage variables are enabled, grant permission on UNQUALIFIED function.
      const QUALIFIED_FUNCTION_NAME = this.config.perFunctionStageVars
        ? alias.functionName
        : `${alias.functionName}:${this.config.alias}`;

      const STATEMENT_ID = `apigateway-ws-${this.config.websocketApiId}-${this.config.alias}-${routeId}`.replace(/[^a-zA-Z0-9-_]/g, '-');
      const SOURCE_ARN = `arn:aws:execute-api:${this.config.region}:${this.config.accountId}:${this.config.websocketApiId}/*/${routeKey}`;

      this.debugLog(`Adding permission for WebSocket API Gateway to invoke Lambda: ${QUALIFIED_FUNCTION_NAME}`);

      try {
        await LAMBDA.removePermission({ FunctionName: QUALIFIED_FUNCTION_NAME, StatementId: STATEMENT_ID }).promise();
      } catch (error) {
        if (error.code !== 'ResourceNotFoundException') {
          this.debugLog(`Warning: ${error.message}`, false, 'warning');
        }
      }

      await LAMBDA.addPermission({
        FunctionName: QUALIFIED_FUNCTION_NAME,
        StatementId: STATEMENT_ID,
        Action: 'lambda:InvokeFunction',
        Principal: 'apigateway.amazonaws.com',
        SourceArn: SOURCE_ARN,
      }).promise();

      this.debugLog(
        `Successfully added permission for WebSocket API Gateway to invoke Lambda: ${QUALIFIED_FUNCTION_NAME}`,
        false,
        'success',
      );
    } catch (error) {
      this.debugLog(`Error adding WebSocket Lambda permission: ${error.message}`, true, 'error');
      throw error;
    }
  }

  async deployWebSocketApi() {
    try {
      this.debugLog(`Deploying WebSocket API (API ID: ${this.config.websocketApiId})...`);
      const API_GATEWAY_V2 = new this.provider.sdk.ApiGatewayV2({ region: this.config.region });
      const STAGE = this.provider.getStage();

      const DEPLOYMENT = await API_GATEWAY_V2.createDeployment({
        ApiId: this.config.websocketApiId,
        Description: `Deployed by ${PLUGIN_NAME} for alias: ${this.config.alias}`,
      }).promise();
      this.debugLog(`Created deployment with ID: ${DEPLOYMENT.DeploymentId}`);

      try {
        await API_GATEWAY_V2.getStage({ ApiId: this.config.websocketApiId, StageName: STAGE }).promise();
        await API_GATEWAY_V2.updateStage({
          ApiId: this.config.websocketApiId,
          StageName: STAGE,
          DeploymentId: DEPLOYMENT.DeploymentId,
          // Do NOT set global alias variable when perFunctionStageVars is active
          ...(this.config.skipSetGlobalStageVar
            ? {}
            : { StageVariables: { alias: this.config.alias } }),
        }).promise();
        this.debugLog(`Updated existing WebSocket stage: ${STAGE} with new deployment`);
      } catch (error) {
        if (error.code === 'NotFoundException') {
          await API_GATEWAY_V2.createStage({
            ApiId: this.config.websocketApiId,
            StageName: STAGE,
            DeploymentId: DEPLOYMENT.DeploymentId,
            ...(this.config.skipSetGlobalStageVar
              ? {}
              : { StageVariables: { alias: this.config.alias } }),
          }).promise();
          this.debugLog(`Created new WebSocket stage: ${STAGE} with deployment`);
        } else {
          throw error;
        }
      }

      const ENDPOINT_URL = `wss://${this.config.websocketApiId}.execute-api.${this.config.region}.amazonaws.com/${STAGE}`;
      this.debugLog(`${PLUGIN_NAME}: WebSocket API endpoint: ${ENDPOINT_URL}`, false, 'info');
      this.debugLog(`Successfully deployed WebSocket API to stage: ${STAGE}`, false, 'success');
    } catch (error) {
      this.debugLog(`Error deploying WebSocket API: ${error.message}`, true, 'error');
      throw error;
    }
  }
}

module.exports = ServerlessLambdaAliasPlugin;
