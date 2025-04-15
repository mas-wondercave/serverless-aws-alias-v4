<div align="center">

# `serverless-aws-alias-v4`

[![npm.badge]][npm] [![download.badge]][download] [![contribution.badge]][contribution]

Serverless framework plugin to manage AWS Lambda aliases and API Gateway integrations
</div>

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

## Debugging

By default, only error messages are displayed. To view detailed logs, use one of these methods:

- Set the environment variable `SLS_DEBUG=*`
- Use the `--verbose` flag when deploying: `sls deploy --verbose`
- Enable verbose logging in your alias configuration:

```yaml
custom:
  alias:
    name: dev
    verbose: true
# or (will fallback to provider stage)
  alias:
    verbose: true
```

[npm]: https://www.npmjs.com/package/serverless-aws-alias-v4
[npm.badge]: https://img.shields.io/npm/v/serverless-aws-alias-v4
[download]: https://www.npmjs.com/package/serverless-aws-alias-v4
[download.badge]: https://img.shields.io/npm/d18m/serverless-aws-alias-v4
[contribution]: https://github.com/Castlenine/serverless-aws-alias-v4
[contribution.badge]: https://img.shields.io/badge/contributions-welcome-green
