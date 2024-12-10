# @harperdb/http-router

A [HarperDB Component](https://docs.harperdb.io/docs/developers/components) for routing requests to other components that is inspired by the Edgio router API: https://docs.edg.io/applications/v4/routing.

![NPM Version](https://img.shields.io/npm/v/%40harperdb%2Fhttp-router)

## Installation
Go into the HarperDB application you would building and install this package and add it to the `config.yaml` file:

1. Install:

```sh
npm install @harperdb/http-router
```

2. Add to `config.yaml`:

```yaml
'@harperdb/http-router':
  package: '@harperdb/http-router' # this can include a @version number if desired
  files: '*.*js' # Load js files so it can find the router.js file and config
# The router comes before the other main framework adapter in the pipeline
'@harperdb/nextjs':
  package: '@harperdb/nextjs'
  files: '/*'
  prebuilt: true
```

And then you can build a `router.js` file in the root of your application that looks like this:

```js
const { Router, or, nextRoutes } = require('@harperdb/http-router');
module.exports = new Router().get('/some-path', ({ cache, proxy }) => {
	// handle the request here
})
```

## Options

> All configuration options are optional

### `port: number`

Specify a port for the caching server. Defaults to `9926`.

### `files: String`

Used to load the necessary JS files.