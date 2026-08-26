# @harperdb/http-cache

A [HarperDB Component](https://docs.harperdb.io/docs/developers/components) for caching HTTP requests/responses from other components.

![NPM Version](https://img.shields.io/npm/v/%40harperdb%2Fhttp-cache)

## Installation

Go into the HarperDB application you would building and install this package and add it to the `config.yaml` file:

1. Install:

```sh
npm install @harperdb/http-cache
```

2. Add to `config.yaml`:

```yaml
'@harperdb/http-cache':
  package: '@harperdb/http-cache'
  files: '/*'
```

## Options

> All configuration options are optional

### `port: number`

Specify a port for the caching server. Defaults to `9926`.

## Cache handler options

- clearRestIntervalCount - Number of records to invalidate prior to pausing when /invalidate endpoint is called
- clearRestIntervalMs - Duration of pause in milliseconds when /invalidate endpoint is called
- scheduledFullCacheClearTime - Time of day to perform a full cache clear (Expressed as hours in 24-hour format UTC time, i.e. 10.33 = 10:20 AM UTC)
- additionalCacheDatabaseGroups - Array of additional database groups to use for caching. Each group will create a new database to store cached records.

## Invalidation

Cache can be invalidated via a POST request to /invalidate

This will invalidate records from the default `cache` database. To invalidate records from an additional cache database, use the `x-cache-group` request header to specify the database group name.

i.e.

```
POST /invalidate
HEADER: 'x-cache-group: api'
```
