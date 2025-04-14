# serverless-aws-alias-v4

Serverless framework plugin to manage AWS Lambda aliases and API Gateway integrations

## RELEASE CANDIDATE. USE AT YOUR OWN RISK

This plugin facilitates the management of multiple Lambda function versions and seamlessly updates API Gateway endpoints to reference the appropriate alias.

Key features:

- Automatically creates and maintains Lambda aliases corresponding to deployment stages.
- Redirects API Gateway integrations to the appropriate Lambda function aliases.
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

When using the `serverless-plugin-warmup` plugin, ensure you add the following exclusion to your configuration:

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

To handle AWS rate limits, the plugin implements a retry mechanism. By default, it will retry operations up to 3 times if a rate limit is encountered. You can customize the number of retries in your configuration:

```yaml
custom:
  alias:
    maxRetries: 5

custom:
  alias:
    name: dev
    maxRetries: 5
# or (will fallback to provider stage)
  alias:
    maxRetries: 5
```

## Debugging

By default, only error messages are displayed. To view detailed logs, use one of these methods:

- Set the environment variable `SLS_DEBUG=*`
- Use the `--verbose` flag when deploying: `sls deploy --verbose`
