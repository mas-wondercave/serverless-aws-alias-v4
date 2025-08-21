<div align="center">

# `serverless-aws-alias-v4`

[![npm.badge]][npm] [![download.badge]][download] [![contribution.badge]][contribution]

Serverless framework plugin to manage AWS Lambda aliases and API Gateway integrations
</div>

This plugin facilitates the management of multiple Lambda function versions and seamlessly updates API Gateway endpoints to reference the appropriate alias.

Key features:

- Automatically creates and maintains Lambda aliases corresponding to deployment stages.
- Redirects API Gateway integrations to the appropriate Lambda function aliases.
- Supports both HTTP (REST API) and WebSocket API Gateway events.
- Handles mixed services with both HTTP and WebSocket events simultaneously.
- Handles Lambda permission configuration for API Gateway invocations.
- Ensures API Gateway method settings are properly validated.

## Installation

```bash
npm install --save-dev serverless-aws-alias-v4
```

## Usage

Add the plugin to your `serverless.yml` file:

```yaml
plugins:
  - serverless-aws-alias-v4
```

Configure the plugin in your `serverless.yml` file:

```yaml
custom:
  alias: dev
```

If the `alias` property is not defined, the plugin will use the stage name specified in the provider section as a fallback.

```yaml
provider:
  stage: dev
```

### Complete Configuration Example

Here's a comprehensive example showing all available configuration options:

```yaml
custom:
  alias:
    name: ${opt:stage, 'dev'}        # Alias name (defaults to stage)
    excludedFunctions:               # Functions to exclude from alias management
      - warmUpPluginDefault
      - some-other-function
    skipApiGateway: false           # Skip HTTP API Gateway deployment (default: false)
    skipWebSocketGateway: false     # Skip WebSocket API Gateway deployment (default: false)
    verbose: true                   # Enable detailed logging (default: false)
```

### API Gateway Configuration

This plugin supports both HTTP (REST API) and WebSocket event types:

#### HTTP API Gateway

```yaml
functions:
  hello:
    handler: handler.hello
    events:
      - http:
          path: hello
          method: GET
```

For HTTP APIs, you can specify a REST API ID in your provider configuration:

```yaml
provider:
  apiGateway:
    restApiId: abcdef123456
```

#### WebSocket API Gateway

```yaml
functions:
  connect:
    handler: handler.connect
    events:
      - websocket: $connect

  disconnect:
    handler: handler.disconnect
    events:
      - websocket: $disconnect

  default:
    handler: handler.default
    events:
      - websocket: $default

  # Custom route
  message:
    handler: handler.message
    events:
      - websocket:
          route: sendMessage
```

For WebSocket APIs, you can specify a WebSocket API ID in your provider configuration:

```yaml
provider:
  websocketApiId: wxyz987654
```

You can mix both HTTP and WebSocket events in the same service, and the plugin will handle both types correctly.

### Excluding Functions

To exclude specific functions from alias management:

```yaml
custom:
  alias:
    name: dev
    excludedFunctions:
      - some-function
# or (will fallback to provider stage)
  alias:
    excludedFunctions:
      - some-function
```

If you're using the `serverless-plugin-warmup` plugin alongside this plugin and don't want to create an alias for the warmup function, make sure to add it to your excluded functions configuration:

```yaml
custom:
  alias:
    name: dev
    excludedFunctions:
      - warmUpPluginDefault
# or (will fallback to provider stage)
  alias:
    excludedFunctions:
      - warmUpPluginDefault
```

### Skipping API Gateway Deployments

By default, the plugin automatically deploys both HTTP API Gateway and WebSocket API Gateway after updating integrations. You can control this behavior using configuration options to skip deployments when needed.

#### Skip HTTP API Gateway Deployment

To skip HTTP API Gateway deployment and only update integrations:

```yaml
custom:
  alias:
    name: dev
    skipApiGateway: true
```

#### Skip WebSocket API Gateway Deployment

To skip WebSocket API Gateway deployment and only update integrations:

```yaml
custom:
  alias:
    name: dev
    skipWebSocketGateway: true
```

#### Skip Both API Gateways

You can skip both types of deployments:

```yaml
custom:
  alias:
    name: dev
    skipApiGateway: true
    skipWebSocketGateway: true
```

#### Use Cases for Skipping Deployments

Skipping API Gateway deployments can be useful in scenarios such as:

- **Development workflows**: When you want to update function aliases without triggering API Gateway deployments
- **Blue-Green deployments**: When Blue-Green API Gateway deployments are handled separately in your CI/CD pipeline
- **Testing environments**: When you need to update function integrations without affecting live API endpoints

## Plugin Compatibility and Limitations

When using this plugin, be aware of the following compatibility considerations:

- **Incompatible Plugin**: This plugin is **not compatible** with the [serverless-iam-roles-per-function](https://www.serverless.com/plugins/serverless-iam-roles-per-function) plugin.
- **Alternative Recommendation**: If you need custom IAM roles, we recommend using [serverless-iam-roles-per-function-v4](https://github.com/Castlenine/serverless-iam-roles-per-function-v4), which works seamlessly with this plugin.

## Debugging

By default, only error messages are displayed. To view detailed logs, use one of these methods:

- Set the environment variable `SLS_DEBUG=*`
- Use the `--verbose` or `-v` flag when deploying: `sls deploy --verbose`
- Enable verbose logging in your custom configuration:

```yaml
custom:
  alias:
    name: dev
    verbose: true
# or (will fallback to provider stage)
  alias:
    verbose: true
```

## License

This project is licensed under the MIT License - see the [LICENSE.md](./LICENSE.md) file for details.

## Contributing

Contributions are welcome! Feel free to submit a pull request or open an issue.

[npm]: https://www.npmjs.com/package/serverless-aws-alias-v4
[npm.badge]: https://img.shields.io/npm/v/serverless-aws-alias-v4
[download]: https://www.npmjs.com/package/serverless-aws-alias-v4
[download.badge]: https://img.shields.io/npm/d18m/serverless-aws-alias-v4
[contribution]: https://github.com/Castlenine/serverless-aws-alias-v4
[contribution.badge]: https://img.shields.io/badge/contributions-welcome-green
