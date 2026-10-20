const { getCacheHandler } = require('@harperdb/http-cache/extension');
const { basename, dirname, join, matchesGlob } = require('node:path');
const { existsSync, realpathSync, watch } = require('node:fs');
const { readdir } = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const { getRouterState } = require('./routerState.js');

exports.suppressHandleApplicationWarning = true;

exports.handleApplication = async function (scope) {
	const state = getRouterState(__dirname);
	const cacheHandler = getCacheHandler(scope.options.getAll() ?? {});
	const watchers = new Map();
	const originConfigPaths = new Set();
	const routesPaths = new Set();
	const loadedRoutes = new Map();
	const pendingOriginConfigs = new Set();
	const pendingRoutes = new Set();
	let activeRoutes = [];
	let importCount = 0;
	let reloadQueued = false;
	let loading = Promise.resolve();

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
		if (basename(path).includes('edgio.config.')) {
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

	async function loadRoutes(path) {
		let routes = await importEntry(path);
		if (typeof routes === 'function') routes = routes();
		loadedRoutes.set(path, routes);
	}

	async function loadPending() {
		reloadQueued = false;
		for (const path of [...pendingOriginConfigs].sort()) {
			pendingOriginConfigs.delete(path);
			try {
				await loadOriginConfig(path);
				for (const routesPath of routesPaths) pendingRoutes.add(routesPath);
			} catch (error) {
				scope.logger.error(`Failed to load http-router origins from ${path}`, error);
			}
		}
		for (const path of [...pendingRoutes].sort()) {
			pendingRoutes.delete(path);
			if (!routesPaths.has(path)) continue;
			try {
				await loadRoutes(path);
			} catch (error) {
				scope.logger.error(`Failed to load http-router routes from ${path}`, error);
			}
		}
		activeRoutes = [...loadedRoutes.keys()].sort().map((path) => loadedRoutes.get(path));
	}

	function reload() {
		if (!reloadQueued) {
			reloadQueued = true;
			loading = loading.then(loadPending);
		}
		return loading;
	}

	function markChanged(path) {
		if (originConfigPaths.has(path)) pendingOriginConfigs.add(path);
		else pendingRoutes.add(path);
	}

	function forget(path) {
		originConfigPaths.delete(path);
		routesPaths.delete(path);
		loadedRoutes.delete(path);
	}

	function watchEntry(path) {
		const watcher = watch(path, { persistent: false }, (eventType) => {
			if (eventType === 'rename') {
				watcher.close();
				watchers.delete(path);
				if (!existsSync(path)) {
					forget(path);
					reload();
					return;
				}
				watchEntry(path);
			}
			markChanged(path);
			reload();
		});
		watcher.on('error', (error) => scope.logger.error(`http-router stopped watching ${path}`, error));
		watchers.set(path, watcher);
	}

	scope.on('close', () => {
		for (const watcher of watchers.values()) watcher.close();
		watchers.clear();
	});
	scope.options.on('change', () => scope.requestRestart());

	for (const entry of await findEntries(scope.directory, scope.options.getAll()?.files)) {
		(entry.isOriginConfig ? originConfigPaths : routesPaths).add(entry.path);
		markChanged(entry.path);
		watchEntry(entry.path);
	}
	await reload();

	scope.server.http(async (request, nextHandler) => {
		let handler = nextHandler;
		for (const routes of activeRoutes) {
			handler = await routes.onRequest(request, nextHandler);
			if (handler !== nextHandler) break;
		}
		if (request.cacheKey || (activeRoutes.length > 0 && request.pathname === '/invalidate')) {
			return cacheHandler(request, handler);
		}
		return handler(request);
	});
};

function classifyEntry(name) {
	if (name.includes('edgio.config.') || name.includes('layer0.config.')) return { isOriginConfig: true };
	if (name.includes('routes.')) return { isOriginConfig: false };
}

function normalizeFilesOption(files) {
	if (files === undefined || files === null) {
		throw new Error('@harperdb/http-router needs a `files` option in config.yaml, for example `files: "*.js"`');
	}
	const isObject = typeof files === 'object' && !Array.isArray(files);
	return {
		source: [isObject ? files.source : files].flat().map((pattern) => {
			if (pattern.includes('..') || pattern.startsWith('/')) {
				throw new Error(`@harperdb/http-router files pattern "${pattern}" must be relative to the application`);
			}
			if (pattern === '.' || pattern === './') return '**/*';
			return pattern.startsWith('./') ? pattern.slice(2) : pattern;
		}),
		ignore: isObject ? [files.ignore ?? []].flat() : [],
	};
}

function mayContainMatches(directorySegments, pattern) {
	const patternSegments = pattern.split('/');
	for (let index = 0; index < directorySegments.length; index++) {
		const patternSegment = patternSegments[index];
		if (patternSegment === '**') return !directorySegments.slice(index).some((segment) => segment.startsWith('.'));
		if (patternSegment === undefined || !matchesGlob(directorySegments[index], patternSegment)) return false;
	}
	return patternSegments.length > directorySegments.length;
}

async function findEntries(directory, files) {
	const { source, ignore } = normalizeFilesOption(files);
	const entries = [];
	async function walk(relativeDirectory) {
		const directorySegments = relativeDirectory ? relativeDirectory.split('/') : [];
		for (const dirent of await readdir(join(directory, relativeDirectory), { withFileTypes: true })) {
			const relativePath = relativeDirectory ? `${relativeDirectory}/${dirent.name}` : dirent.name;
			if (dirent.isDirectory()) {
				const segments = [...directorySegments, dirent.name];
				if (dirent.name !== 'node_modules' && source.some((pattern) => mayContainMatches(segments, pattern))) {
					await walk(relativePath);
				}
				continue;
			}
			const kind = classifyEntry(dirent.name);
			if (
				kind &&
				source.some((pattern) => matchesGlob(relativePath, pattern)) &&
				!ignore.some((pattern) => matchesGlob(relativePath, pattern))
			) {
				entries.push({ path: join(directory, relativePath), ...kind });
			}
		}
	}
	await walk('');
	return entries;
}
