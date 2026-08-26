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


## config.yaml extension options

- clearRestIntervalCount - Number of records to invalidate prior to pausing when /invalidate endpoint is called
- clearRestIntervalMs - Duration of pause in milliseconds when /invalidate endpoint is called
- scheduledFullCacheClearTime - Time of day to perform a full cache clear (Expressed as hours in 24-hour format UTC time, i.e. 10.33 = 10:20 AM UTC)
- additionalCacheDatabaseGroups - Array of additional database groups to use for caching. Each group will create a new database to store cached records.

Example usage:


```yaml
'@harperdb/http-router':
  package: '@harperdb/http-router'
  files: '*.*js'
  clearRestIntervalCount: 1000
  clearRestIntervalMs: 10
  scheduledFullCacheClearTime: 10.33
  additionalCacheDatabaseGroups:
    - 'api'
```

## Multi DB Caching

By default, the cache will use a database named `cache` to store cached records. You can specify additional database groups to use for caching via the `additionalCacheDatabaseGroups` configuration option in the `config.yaml` file.
Each additional database group will create a new database to store cached records. The database group name can optionally be passed as the `cacheGroup` paramater as part of the `edge` caching configuration within the request actions.

i.e.

```js
cache({
    edge: {
      maxAgeSeconds: 10000,
      staleWhileRevalidateSeconds: 3600,
      cacheGroup: 'api'
    }
})
```

## Invalidation

Cache can be invalidated via a POST request to /invalidate

This will invalidate records from the default `cache` database. To invalidate records from an additional cache database, use the `x-cache-group` request header to specify the database group name.

i.e.

```
POST /invalidate
HEADER: 'x-cache-group: api'
```
