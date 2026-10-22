# Live end-to-end tests

`npm run test:e2e` packs this branch, installs it into a barebones Harper application (`app/`), and runs that application in the `harperfast/harper` Docker image next to a live HTTPS origin (`origin/`). `e2e.test.mjs` then sends real requests to it.

Requires Docker with Compose v2 and Node 22+.

- The Harper container runs a production install, so it serves HTTPS on 9926 with a self-signed certificate and enforces `applications.allowedDirectory: app`. The host port is picked by Docker and printed at start.
- The origin listens on 443 inside the Compose network, which is what the router's proxying needs and what the integration tests cannot provide.
- `KEEP=1 npm run test:e2e` leaves the containers running afterwards. `HARPER_IMAGE=harperfast/harper:<tag> npm run test:e2e` tests another Harper 5 image.

What it covers: Plugin API loading without the deprecated-API warning, redirects and response headers, method and query matching, caching (MISS/HIT with both status headers, cookie cache keys, `/invalidate` auth), static files, proxying with path rewrite and header rules, proxied responses cached with their TTL, and live reload of an edited `routes.js`.
