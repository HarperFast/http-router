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
  package: '@harperdb/http-router'
  files: '/router.js'
```

And then you can build a `router.js` file in the root of your application that looks like this:

```js
const { Router } = require('@harperdb/http-router');
module.exports = new Router().get('/some-path', ({ cache, proxy }) => {
	// handle the request here
})
```

## Options

> All configuration options are optional

### `port: number`

Specify a port for the caching server. Defaults to `9926`.
