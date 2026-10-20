const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { tmpdir } = require('node:os');
const { setTimeout: delay } = require('node:timers/promises');
const { repositoryRoot, routerState } = require('./helpers/routerHarness.js');

const cacheHandlerCalls = [];
const cacheHandlerOptions = [];
const cachePath = require.resolve('@harperdb/http-cache/extension', { paths: [repositoryRoot] });
const cacheModule = new Module(cachePath);
cacheModule.filename = cachePath;
cacheModule.exports = {
	getCacheHandler(options) {
		cacheHandlerOptions.push(options);
		return (request, handler) => {
			cacheHandlerCalls.push({ request, handler });
			return 'cached response';
		};
	},
};
cacheModule.loaded = true;
require.cache[cachePath] = cacheModule;

const realWatch = fs.watch;
const watches = [];
fs.watch = (watchedPath, options, listener) => {
	const watcher = realWatch(watchedPath, options);
	const record = { path: watchedPath, watcher, listener, closed: false };
	watcher.on('close', () => {
		record.closed = true;
	});
	watches.push(record);
	return watcher;
};

const { handleApplication, suppressHandleApplicationWarning } = require(path.join(repositoryRoot, 'extension.js'));

const nextHandler = () => 'next handler result';

function routesSource(responses) {
	return `module.exports = { onRequest(request, next) {
		const responses = ${JSON.stringify(responses)};
		return request.pathname in responses ? () => responses[request.pathname] : next;
	} };\n`;
}

function createApplication(files) {
	const directory = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'http-router-extension-')));
	for (const [relativePath, contents] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(directory, relativePath)), { recursive: true });
		fs.writeFileSync(path.join(directory, relativePath), contents);
	}
	return directory;
}

function createScope(directory, config, { withImport = false } = {}) {
	const scope = new EventEmitter();
	scope.directory = directory;
	scope.options = new EventEmitter();
	scope.options.getAll = () => config;
	scope.httpHandlers = [];
	scope.server = { http: (listener) => scope.httpHandlers.push(listener) };
	scope.errors = [];
	scope.logger = { error: (...args) => scope.errors.push(args) };
	scope.restarts = 0;
	scope.requestRestart = () => scope.restarts++;
	if (withImport) {
		scope.importedURLs = [];
		scope.import = (url) => {
			scope.importedURLs.push(url);
			return import(url.href);
		};
	}
	return scope;
}

async function startApplication(files, config = { files: '*.js' }, scopeOptions) {
	const directory = createApplication(files);
	const scope = createScope(directory, config, scopeOptions);
	await handleApplication(scope);
	return { directory, scope, request: (requestOptions) => scope.httpHandlers[0](requestOptions, nextHandler) };
}

function watchFor(filePath) {
	return watches.findLast((record) => record.path === filePath && !record.closed);
}

async function waitFor(check) {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (await check()) return;
		await delay(5);
	}
	assert.fail('condition was not met in time');
}

const openScopes = [];
beforeEach(() => {
	routerState.origins.clear();
	cacheHandlerCalls.length = 0;
	cacheHandlerOptions.length = 0;
});
afterEach(() => {
	for (const scope of openScopes.splice(0)) scope.emit('close');
});

async function start(...args) {
	const application = await startApplication(...args);
	openScopes.push(application.scope);
	return application;
}

describe('extension module', () => {
	it('exports only the Plugin API', () => {
		assert.equal(suppressHandleApplicationWarning, true);
		assert.equal(typeof handleApplication, 'function');
	});

	it('builds the cache handler once from the plugin options and registers one HTTP handler', async () => {
		const config = { files: '*.js', additionalCacheDatabaseGroups: ['api'] };
		const { scope } = await start({ 'routes.js': routesSource({}) }, config);
		assert.deepEqual(cacheHandlerOptions, [config]);
		assert.equal(scope.httpHandlers.length, 1);
	});

	it('passes the cache handler an empty options object when the plugin has no options', async () => {
		const directory = createApplication({});
		const scope = createScope(directory, undefined);
		await assert.rejects(handleApplication(scope), /needs a `files` option/);
		assert.deepEqual(cacheHandlerOptions, [{}]);
	});
});

describe('entry discovery', () => {
	it('loads only origin configs and routes files that match the files option', async () => {
		const { request } = await start({
			'routes.js': routesSource({ '/root': 'root routes' }),
			'other.js': 'throw new Error("must not load");',
			'routes.json': '{}',
			'sub/routes.js': routesSource({ '/sub': 'sub routes' }),
		});
		assert.equal(await request({ pathname: '/root' }), 'root routes');
		assert.equal(await request({ pathname: '/sub' }), 'next handler result');
	});

	it('never descends into node_modules or dot directories', async () => {
		const { request } = await start(
			{
				'node_modules/package/routes.js': routesSource({ '/modules': 'from node_modules' }),
				'.next/routes.js': routesSource({ '/hidden': 'from .next' }),
				'src/deep/routes.js': routesSource({ '/deep': 'deep routes' }),
			},
			{ files: '**/*.js' }
		);
		assert.equal(await request({ pathname: '/modules' }), 'next handler result');
		assert.equal(await request({ pathname: '/hidden' }), 'next handler result');
		assert.equal(await request({ pathname: '/deep' }), 'deep routes');
	});

	it('walks only the directories a pattern can match', async () => {
		const { request } = await start(
			{
				'src/routes.js': routesSource({ '/src': 'src routes' }),
				'src/nested/routes.js': routesSource({ '/nested': 'nested routes' }),
				'other/routes.js': routesSource({ '/other': 'other routes' }),
			},
			{ files: ['./src/*.js'] }
		);
		assert.equal(await request({ pathname: '/src' }), 'src routes');
		assert.equal(await request({ pathname: '/nested' }), 'next handler result');
		assert.equal(await request({ pathname: '/other' }), 'next handler result');
	});

	it('supports source and ignore in the object form, and "." for every file', async () => {
		const { request } = await start(
			{
				'routes.js': routesSource({ '/kept': 'kept routes' }),
				'ignored/routes.js': routesSource({ '/ignored': 'ignored routes' }),
			},
			{ files: { source: '.', ignore: 'ignored/**' } }
		);
		assert.equal(await request({ pathname: '/kept' }), 'kept routes');
		assert.equal(await request({ pathname: '/ignored' }), 'next handler result');
	});

	it('accepts an object form without ignore', async () => {
		const { request } = await start({ 'routes.js': routesSource({ '/a': 'a' }) }, { files: { source: ['*.js'] } });
		assert.equal(await request({ pathname: '/a' }), 'a');
	});

	it('rejects a missing files option and patterns outside the application', async () => {
		for (const config of [{}, { files: '../*.js' }, { files: '/*.js' }]) {
			const scope = createScope(createApplication({}), config);
			await assert.rejects(handleApplication(scope), /files/);
		}
	});

	it('passes requests through when no routes file exists', async () => {
		const { request } = await start({ 'index.js': '' });
		assert.equal(await request({ pathname: '/invalidate' }), 'next handler result');
		assert.equal(cacheHandlerCalls.length, 0);
	});
});

describe('origin configs', () => {
	it('loads edgio and layer0 origins before evaluating routes', async () => {
		const routerStatePath = JSON.stringify(path.join(repositoryRoot, 'routerState.js'));
		const { directory, request } = await start({
			'a.routes.js': `const { origins } = require(${routerStatePath}).getRouterState(${JSON.stringify(repositoryRoot)});
				const seen = [...origins.keys()].sort().join(',');
				module.exports = { onRequest: (request, next) => () => seen };\n`,
			'edgio.config.js': `module.exports = { origins: [
				{ name: 'api', hosts: [{ location: [{ hostname: 'api.example.com' }] }], override_host_header: 'api.internal',
					tls_verify: { allow_self_signed_certs: true, sni_hint_and_strict_san_check: 'sni.example.com' } },
				{ name: 'legacy', hosts: [{ location: 'legacy.example.com' }] },
			] };\n`,
			'layer0.config.js': `module.exports = { backends: {
				backend: { domainOrIp: 'backend.example.com', hostHeader: 'backend.internal', disableCheckCert: true },
			} };\n`,
		});
		assert.equal(await request({ pathname: '/' }), 'api,backend,legacy');
		assert.deepEqual(routerState.origins.get('api'), {
			hostname: 'api.example.com',
			rejectUnauthorized: false,
			servername: 'sni.example.com',
			hostHeader: 'api.internal',
		});
		assert.deepEqual(routerState.origins.get('legacy'), {
			hostname: 'legacy.example.com',
			rejectUnauthorized: true,
			servername: undefined,
			hostHeader: undefined,
		});
		assert.deepEqual(routerState.origins.get('backend'), {
			hostname: 'backend.example.com',
			hostHeader: 'backend.internal',
			rejectUnauthorized: false,
		});
		assert.equal(routerState.baseDir, directory);
	});

	it('accepts configs without origins or backends', async () => {
		await start({ 'edgio.config.js': 'module.exports = {};', 'layer0.config.js': 'module.exports = {};' });
		assert.equal(routerState.origins.size, 0);
	});

	it('logs an origin config that fails to load and still loads the routes', async () => {
		const { scope, request } = await start({
			'edgio.config.js': 'throw new Error("broken config");',
			'routes.js': routesSource({ '/a': 'a' }),
		});
		assert.match(scope.errors[0][0], /Failed to load http-router origins from .*edgio\.config\.js/);
		assert.equal(await request({ pathname: '/a' }), 'a');
	});
});

describe('routes files', () => {
	it('tries every routes file in path order, falling through to the next handler', async () => {
		const { request } = await start({
			'b.routes.js': routesSource({ '/shared': 'from b', '/b': 'only b' }),
			'routes.js': routesSource({ '/shared': 'from routes', '/c': 'only routes' }),
			'a.routes.js': routesSource({ '/a': 'only a' }),
		});
		assert.equal(await request({ pathname: '/shared' }), 'from b');
		assert.equal(await request({ pathname: '/a' }), 'only a');
		assert.equal(await request({ pathname: '/b' }), 'only b');
		assert.equal(await request({ pathname: '/c' }), 'only routes');
		assert.equal(await request({ pathname: '/none' }), 'next handler result');
	});

	it('calls a routes module that exports a function', async () => {
		const { request } = await start({
			'routes.js': `module.exports = () => ({ onRequest: (request, next) => () => 'from factory' });\n`,
		});
		assert.equal(await request({ pathname: '/' }), 'from factory');
	});

	it('hands requests with a cache key, and /invalidate, to the cache handler', async () => {
		const { request } = await start({
			'routes.js': `module.exports = { onRequest(request, next) {
				if (request.pathname === '/cached') request.cacheKey = 'key';
				return next;
			} };\n`,
		});
		assert.equal(await request({ pathname: '/cached' }), 'cached response');
		assert.equal(await request({ pathname: '/invalidate' }), 'cached response');
		assert.equal(await request({ pathname: '/plain' }), 'next handler result');
		assert.deepEqual(
			cacheHandlerCalls.map(({ request, handler }) => [request.pathname, handler]),
			[
				['/cached', nextHandler],
				['/invalidate', nextHandler],
			]
		);
	});

	it('logs a routes file that fails to load and keeps the other routes', async () => {
		const { scope, request } = await start({
			'a.routes.js': 'throw new Error("broken routes");',
			'routes.js': routesSource({ '/a': 'a' }),
		});
		assert.match(scope.errors[0][0], /Failed to load http-router routes from .*a\.routes\.js/);
		assert.equal(await request({ pathname: '/a' }), 'a');
	});

	it('imports through scope.import when it exists', async () => {
		const { scope, request } = await start(
			{ 'routes.js': routesSource({ '/a': 'a' }) },
			{ files: '*.js' },
			{
				withImport: true,
			}
		);
		assert.equal(await request({ pathname: '/a' }), 'a');
		assert.equal(scope.importedURLs.length, 1);
		assert.match(scope.importedURLs[0].href, /\/routes\.js\?v=\d+$/);
	});
});

describe('reloading', () => {
	it('watches each entry file and replaces only the changed routes', async () => {
		const { directory, request } = await start({
			'routes.js': routesSource({ '/a': 'first' }),
			'other.routes.js': routesSource({ '/b': 'other' }),
		});
		const routesPath = path.join(directory, 'routes.js');
		fs.writeFileSync(routesPath, routesSource({ '/a': 'second' }));
		watchFor(routesPath).listener('change');
		await waitFor(async () => (await request({ pathname: '/a' })) === 'second');
		assert.equal(await request({ pathname: '/b' }), 'other');
	});

	it('reloads the origins and then every routes file when an origin config changes', async () => {
		const routerStatePath = JSON.stringify(path.join(repositoryRoot, 'routerState.js'));
		const { directory, request } = await start({
			'edgio.config.js': `module.exports = { origins: [{ name: 'one', hosts: [{ location: 'one.example.com' }] }] };\n`,
			'routes.js': `const { origins } = require(${routerStatePath}).getRouterState(${JSON.stringify(repositoryRoot)});
				const seen = [...origins.keys()].sort().join(',');
				module.exports = { onRequest: (request, next) => () => seen };\n`,
		});
		assert.equal(await request({ pathname: '/' }), 'one');
		const configPath = path.join(directory, 'edgio.config.js');
		fs.writeFileSync(
			configPath,
			`module.exports = { origins: [{ name: 'two', hosts: [{ location: 'two.example.com' }] }] };\n`
		);
		watchFor(configPath).listener('change');
		await waitFor(async () => (await request({ pathname: '/' })) === 'one,two');
	});

	it('coalesces events that arrive before a reload starts', async () => {
		const { directory, request } = await start({ 'routes.js': routesSource({ '/a': 'first' }) });
		const routesPath = path.join(directory, 'routes.js');
		fs.writeFileSync(routesPath, routesSource({ '/a': 'second' }));
		const { listener } = watchFor(routesPath);
		listener('change');
		listener('change');
		await waitFor(async () => (await request({ pathname: '/a' })) === 'second');
	});

	it('keeps watching a file that was replaced, and drops a file that was removed', async () => {
		const { directory, request } = await start({
			'routes.js': routesSource({ '/a': 'first' }),
			'b.routes.js': routesSource({ '/b': 'b' }),
		});
		const routesPath = path.join(directory, 'routes.js');
		const replacement = path.join(directory, 'routes.tmp');
		fs.writeFileSync(replacement, routesSource({ '/a': 'replaced' }));
		fs.renameSync(replacement, routesPath);
		const replacedWatch = watchFor(routesPath);
		replacedWatch.listener('rename');
		await waitFor(async () => (await request({ pathname: '/a' })) === 'replaced');
		assert.equal(replacedWatch.closed, true);
		assert.ok(watchFor(routesPath), 'the replaced file is watched again');

		const removedPath = path.join(directory, 'b.routes.js');
		fs.rmSync(removedPath);
		watchFor(removedPath).listener('rename');
		await waitFor(async () => (await request({ pathname: '/b' })) === 'next handler result');
		assert.equal(watchFor(removedPath), undefined);
	});

	it('logs watcher errors', async () => {
		const { directory, scope } = await start({ 'routes.js': routesSource({}) });
		const error = new Error('watch failed');
		watchFor(path.join(directory, 'routes.js')).watcher.emit('error', error);
		assert.deepEqual(scope.errors.at(-1), [`http-router stopped watching ${path.join(directory, 'routes.js')}`, error]);
	});

	it('closes every watcher when the scope closes', async () => {
		const { directory, scope } = await startApplication({
			'routes.js': routesSource({}),
			'edgio.config.js': 'module.exports = {};',
		});
		const records = [watchFor(path.join(directory, 'routes.js')), watchFor(path.join(directory, 'edgio.config.js'))];
		scope.emit('close');
		await waitFor(() => records.every((record) => record.closed));
	});

	it('requests a restart when the plugin options change', async () => {
		const { scope } = await start({ 'routes.js': routesSource({}) });
		scope.options.emit('change', ['files'], '*.mjs');
		assert.equal(scope.restarts, 1);
	});
});
