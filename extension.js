const { getCacheHandler } = require('@harperdb/http-cache/extension');
const { dirname } = require('node:path');
const { realpathSync } = require('node:fs');
const { pathToFileURL } = require('node:url');
const { getRouterState } = require('./routerState.js');

exports.suppressHandleApplicationWarning = true;

exports.handleApplication = function (scope) {
	const state = getRouterState(__dirname);
	const cacheHandler = getCacheHandler(scope.options.getAll() ?? {});
	const pendingOriginConfigs = new Set();
	let routesPath;
	let routes;
	let importCount = 0;
	let initialScanComplete = false;
	let initialLoadComplete = false;
	let loading = Promise.resolve();
	let initialLoad;

	scope.server.http(async (request, nextHandler) => {
		if (!initialLoadComplete) await initialLoad;
		const activeRoutes = routes;
		if (!activeRoutes) return nextHandler(request);
		const handler = await activeRoutes.onRequest(request, nextHandler);
		if (request.cacheKey || request.pathname === '/invalidate') {
			return cacheHandler(request, handler);
		}
		return handler(request);
	});

	async function importEntry(path) {
		const url = pathToFileURL(path);
		url.search = `v=${++importCount}`;
		if (require.cache) delete require.cache[realpathSync(path)];
		const moduleExports = typeof scope.import === 'function' ? await scope.import(url) : await import(url.href);
		state.baseDir = dirname(path);
		return moduleExports.default;
	}

	async function loadOriginConfig(path) {
		const config = await importEntry(path);
		if (path.includes('edgio.config.')) {
			for (let origin of config.origins || []) {
				state.origins.set(origin.name, {
					hostname: origin.hosts?.[0]?.location?.[0]?.hostname ?? origin.hosts?.[0]?.location,
					rejectUnauthorized: !origin.tls_verify?.allow_self_signed_certs,
					servername: origin.tls_verify?.sni_hint_and_strict_san_check,
					hostHeader: origin.override_host_header,
				});
			}
			return;
		}
		for (let originName in config.backends) {
			const origin = config.backends[originName];
			state.origins.set(originName, {
				hostname: origin.domainOrIp,
				hostHeader: origin.hostHeader,
				rejectUnauthorized: !origin.disableCheckCert,
			});
		}
	}

	async function loadEntries() {
		for (const path of pendingOriginConfigs) {
			pendingOriginConfigs.delete(path);
			try {
				await loadOriginConfig(path);
			} catch (error) {
				scope.logger.error(`Failed to load http-router origins from ${path}`, error);
			}
		}
		if (!routesPath) {
			routes = undefined;
			return;
		}
		let loadedRoutes = await importEntry(routesPath);
		if (typeof loadedRoutes === 'function') loadedRoutes = loadedRoutes();
		routes = loadedRoutes;
	}

	function reload() {
		loading = loading.then(loadEntries).catch((error) => {
			scope.logger.error(`Failed to load http-router routes from ${routesPath}`, error);
		});
		return loading;
	}

	const entryHandler = scope.handleEntry((entry) => {
		if (entry.entryType !== 'file') return;
		const path = entry.absolutePath;
		const isOriginConfig = path.includes('edgio.config.') || path.includes('layer0.config.');
		if (!isOriginConfig && !path.includes('routes.')) return;
		if (entry.eventType === 'unlink') {
			if (path !== routesPath) return;
			routesPath = undefined;
		} else if (isOriginConfig) {
			pendingOriginConfigs.add(path);
		} else {
			routesPath = path;
		}
		return initialScanComplete ? reload() : initialLoad;
	});

	initialLoad = entryHandler.ready
		.catch((error) => {
			scope.logger.error('http-router could not watch its entries', error);
		})
		.then(() => {
			initialScanComplete = true;
			return reload();
		})
		.finally(() => {
			initialLoadComplete = true;
		});
};
