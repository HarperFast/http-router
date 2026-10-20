# http-router on Harper v5: Plugin API migration

## Intent

Make `@harperdb/http-router` run on Harper v5 without the deprecated Extension API, while staying compatible with Harper 4.x from **4.6.1** onward. Fix the v5 breakages in the `@harperdb/http-cache` dependency (HarperFast/http-cache#7) without breaking v4. Replace the committed integration-test fixture `node_modules` with an install step, and cover the router with unit and integration tests on both Harper 4.x and 5.x.

## Facts this design rests on (code-traced)

- `pluginModule` config key and `handleApplication` exports load from Harper **4.6.1** (absent in 4.6.0; present in every 4.6.x/4.7.x tag after it). Harper ≤4.6.0 only reads `extensionModule`.
- Harper 4.7 and 5.2 load `config.extensionModule || config.pluginModule` and choose the API from the module's exports; a module exporting both `handleApplication` and `start`/`handleFile` is rejected (`componentLoader.js:631`).
- Harper 5.2.1 still loads the Extension API with a deprecation warning (`componentLoader.js:682`).
- `@harperfast/integration-testing` copies the fixture directory verbatim into `components/` and never installs dependencies (`harperLifecycle.js:209`).
- Harper 5.2.1 gives a package component used by an application the application's own `ApplicationScope` (`componentLoader.js:542`); only components declared in the root config get a separate scope whose `allowedPath` is the component directory (`componentLoader.js:580`). So `applications.allowedDirectory: app` does not stop the router from importing the application's `routes.js`.
- Harper 5.2.1 loads the plugin module by its unresolved path (`<app>/node_modules/@harperdb/http-router/extension.js`), while `require('@harperdb/http-router')` from the app resolves real paths, and the VM loader caches modules by URL. When the paths differ (macOS `/var` -> `/private/var`), or when one copy is loaded natively, the app's routes get a second copy of `index.js`/`extension.js`. The integration test reproduced this on macOS: before the registry, routes failed with `Origin "api" not found` on 5.2.1. The same code passed on Linux, where the paths match. Harper 4.6.1 and 4.7 import the plugin natively and showed no split.
- `scope.import()` exists only in Harper 5. A plugin loaded by the 5.x VM loader has no `require.cache` to clear, so re-importing a changed CommonJS `routes.js` with plain `import()` returns the stale module; `scope.import()` with a new query string re-evaluates it.
- Harper 4.7.x symlinks `<app>/node_modules/harperdb` to its own package (`symlinkHarperModule`, every non-root component) and its `EntryHandler` watches the `files` glob's base directory recursively with chokidar defaults (follows symlinks, does not skip `node_modules`). A plugin with `files: '*.js'` therefore watches the whole Harper install; on macOS the router's integration suite dies at startup with `EMFILE: too many open files, watch` on 4.7.42, while it passes on Linux. Harper 5.2.1 skips `node_modules` and does not follow symlinks.
- http-cache 1.2.1 breaks on v5 in two places: `blob.save()` was removed (cache-miss store throws) and `get()` now returns a frozen plain record whose nested `headers` has no `toJSON()` (cache-hit throws). `saveBeforeCommit` exists from Harper 4.6.9; on 4.7 `save()` only sets that flag.

## Approaches considered

| Axis                                | Options                                                                                                                                                                                                     | Chosen                                                                                                                                                  |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Component API                       | (a) keep Extension API on all versions; (b) Plugin API only, floor 4.6.1; (c) one module that exports either API based on detected Harper version                                                           | **(b)** — user decision. (a) leaves a v5 deprecation warning; (c) has no reliable runtime version signal.                                               |
| Where v5 fixes live                 | (a) patch around http-cache inside the router; (b) fix http-cache#7 and depend on its release                                                                                                               | **(b)** — the defects are in http-cache; the router consumes it.                                                                                        |
| Fixture dependencies                | (a) committed `node_modules` + overlay of repo files; (b) fixture depends on `file:../..` with `install-links=true`, installed before tests; (c) stage the fixture at test time by copying the repo into it | **(b)** — exercises the branch code as npm would install it, no vendored files, no overlay drift. Fallback (c) only if (b) can't work with the harness. |
| Version compatibility in http-cache | (a) require v5; (b) feature-detect (`saveBeforeCommit` option + `blob.save` fallback; `headers.toJSON` fallback)                                                                                            | **(b)** — runs on 4.x and 5.x.                                                                                                                          |

## Design

### Router plugin module

- `config.yaml`: `pluginModule: ./extension.js` replaces `extensionModule`. `extension.js` exports `handleApplication(scope)` and nothing from the Extension API.
- `handleApplication` registers **one** `scope.server.http` handler. Route definitions and origin configs are loaded from the application's entries (`edgio.config.*`, `layer0.config.*`, `routes.*`) through the scope's entry handler; reloading a `routes.*` file swaps the active routes instead of registering another HTTP handler.
- The cache handler is created once from the plugin's options (`scope.options`), keeping the existing option names (`additionalCacheDatabaseGroups`, etc.).
- Entries are collected during the initial scan and loaded after `EntryHandler.ready`: origin configs first, then routes, because `Router.destination()` resolves an origin while `routes.js` is evaluated. After that, a changed origin config reloads the origins and then the routes; a changed routes file reloads the routes. Each load imports the file with a new query string (through `scope.import()` when it exists) so the changed module is evaluated again.
- Requests that arrive before the initial load finishes wait for it; with no routes file they pass through to the next handler.
- `origins` and `baseDir` live in `routerState.js`, a registry on `globalThis[Symbol.for('@harperdb/http-router/state')]` keyed by the real path of the package directory, so every copy of the package loaded from one install shares them and separate installs stay separate. `index.js` no longer requires `extension.js`.

### http-cache (#7)

- `newBlob`: `createBlob(content, { saveBeforeCommit: true })`, then call `blob.save(table)` only when it exists and the flag did not take (Harper <4.6.9).
- Cache hit: `typeof headers.toJSON === 'function' ? headers.toJSON() : { ...headers }`.
- Emit both `X-HarperDB-Cache` and `X-Harper-Cache` (user decision), and strip both before storing.
- `harper` moves from `dependencies` to `devDependencies`; `package.json` keeps tab formatting.

### Compatibility floor

The router's README and release notes state Harper ≥4.6.1. CI runs the integration suite against Harper 4.6.x, 4.7.x and 5.x.

## Verification route

- Unit tests (node:test) for `index.js` routing, cache-key construction, header actions, `CustomCacheKey`, `parseCookies`, and the plugin's entry handling.
- Integration tests on each Harper version: redirects, response headers, fallback, origins visible to `Router.destination()`, cache MISS→HIT (both headers), `serveStatic`, and a routes-file reload. On Harper 5 the suite runs with `applications.allowedDirectory` set to `app` and to `any`. The fixture's `content.js` is the downstream content source the cache stores.
- Proxying is not covered end to end: the router sends proxied requests to port 443 of the origin's hostname, which a test cannot bind without elevated privileges. Unit tests cover it with a mocked `https.request`.
