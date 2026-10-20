const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const {
	clearLoggedMessages,
	createRequest,
	loadRouterModule,
	loggedMessages,
	nextHandler,
} = require('./helpers/routerHarness.js');

const { Router, CustomCacheKey } = loadRouterModule();

async function routeWithCache(cacheOptions, requestOptions) {
	const request = createRequest(requestOptions);
	const router = new Router()
		.always(({ cache }) => cache(cacheOptions))
		.always(({ redirect }) => redirect('/probe', 307));
	const handler = await router.onRequest(request, nextHandler);
	return { request, responseHeaders: handler().headers };
}

async function cacheKeyFor(cacheOptions, requestOptions) {
	const { request } = await routeWithCache(cacheOptions, requestOptions);
	return JSON.parse(request.cacheKey);
}

const edgeMinute = { edge: { maxAgeSeconds: 60 } };

beforeEach(() => {
	clearLoggedMessages();
});

describe('cache key construction', () => {
	it('builds a key from pathname, method, query, default headers, and cookies', async () => {
		const cacheKey = await cacheKeyFor(edgeMinute, {
			url: '/products?b=2&a=1',
			method: 'GET',
			headers: { 'host': 'shop.example.com', 'accept-encoding': 'br', 'x-ignored': 'value' },
		});
		assert.deepEqual(cacheKey, {
			pathname: '/products',
			method: 'get',
			query: [
				['a', '1'],
				['b', '2'],
			],
			headers: [
				['accept-encoding', 'br'],
				['host', 'shop.example.com'],
			],
			cookies: [],
		});
	});

	it('produces the same key regardless of query and header order', async () => {
		const key = new CustomCacheKey().addCookie('z').addCookie('a');
		const cacheOptions = { ...edgeMinute, key: { ...key, include_headers: ['x-b', 'x-a'] } };
		const first = await routeWithCache(cacheOptions, {
			url: '/page?b=2&a=1',
			headers: { 'x-a': '1', 'x-b': '2', 'cookie': 'z=26; a=1' },
		});
		const second = await routeWithCache(cacheOptions, {
			url: '/page?a=1&b=2',
			headers: { 'cookie': 'a=1; z=26', 'x-b': '2', 'x-a': '1' },
		});
		assert.equal(first.request.cacheKey, second.request.cacheKey);
	});

	it('keeps only whitelisted query parameters', async () => {
		const key = new CustomCacheKey().excludeAllQueryParametersExcept('page', 'sort');
		const cacheKey = await cacheKeyFor({ ...edgeMinute, key }, { url: '/list?utm_source=ad&sort=asc&page=2' });
		assert.deepEqual(cacheKey.query, [
			['page', '2'],
			['sort', 'asc'],
		]);
	});

	it('includes requested headers that are present', async () => {
		const cacheKey = await cacheKeyFor(
			{ ...edgeMinute, key: { include_headers: ['x-region', 'x-device', 'x-missing'] } },
			{ url: '/', headers: { 'x-device': 'mobile', 'x-region': 'eu' } }
		);
		assert.deepEqual(cacheKey.headers, [
			['x-device', 'mobile'],
			['x-region', 'eu'],
		]);
	});

	it('includes requested cookies that are present and ignores the rest', async () => {
		const key = new CustomCacheKey().addCookie('session').addCookie('ab_test').addCookie('missing');
		const cacheKey = await cacheKeyFor(
			{ ...edgeMinute, key },
			{ url: '/', headers: { cookie: 'session=abc=def; tracking=1; ab_test=b' } }
		);
		assert.deepEqual(cacheKey.cookies, [
			['ab_test', 'b'],
			['session', 'abc=def'],
		]);
	});

	it('skips cookies when the request has no cookie header', async () => {
		const key = new CustomCacheKey().addCookie('session');
		const cacheKey = await cacheKeyFor({ ...edgeMinute, key }, { url: '/' });
		assert.deepEqual(cacheKey.cookies, []);
	});

	it('omits host and accept-encoding when absent', async () => {
		const cacheKey = await cacheKeyFor(edgeMinute, { url: '/' });
		assert.deepEqual(cacheKey.headers, []);
	});

	it('sorts repeated query parameter values', async () => {
		const cacheKey = await cacheKeyFor(edgeMinute, { url: '/search?tag=b&tag=a&q=x' });
		assert.deepEqual(cacheKey.query, [
			['q', 'x'],
			['tag', ['a', 'b']],
		]);
	});

	it('drops empty query values from the key', async () => {
		const cacheKey = await cacheKeyFor(edgeMinute, { url: '/search?empty=&q=x' });
		assert.deepEqual(cacheKey.query, [['q', 'x']]);
	});

	it('prefers request.query over the URL query string', async () => {
		const cacheKey = await cacheKeyFor(edgeMinute, { url: '/search?ignored=1', query: { z: '26', a: ['2', '1'] } });
		assert.deepEqual(cacheKey.query, [
			['a', ['1', '2']],
			['z', '26'],
		]);
	});

	it('falls back to URL parsing when request.query is not an object', async () => {
		const cacheKey = await cacheKeyFor(edgeMinute, { url: '/search?q=x', query: 'q=ignored' });
		assert.deepEqual(cacheKey.query, [['q', 'x']]);
	});

	it('defaults the method to get', async () => {
		const cacheKey = await cacheKeyFor(edgeMinute, { url: '/', method: null });
		assert.equal(cacheKey.method, 'get');
	});

	it('logs and falls back to the URL path when the key serializes empty', async (t) => {
		const request = createRequest({ url: '/fallback?q=1' });
		const router = new Router().always(({ cache }) => cache(edgeMinute));
		t.mock.method(JSON, 'stringify', () => '{}');
		await router.onRequest(request, nextHandler);
		t.mock.restoreAll();
		assert.equal(request.cacheKey, '/fallback');
		assert.equal(loggedMessages.error.length, 1);
		const [message, details] = loggedMessages.error[0];
		assert.equal(message, '[CACHE KEY ERROR] Invalid cache key generated:');
		assert.equal(details.url, '/fallback?q=1');
		assert.equal(details.pathname, '/fallback');
	});

	it('falls back to the whole URL when an empty-serializing key has no URL path', async (t) => {
		const request = createRequest({ url: '?q=1', pathname: '' });
		const router = new Router().always(({ cache }) => cache(edgeMinute));
		t.mock.method(JSON, 'stringify', () => '');
		await router.onRequest(request, nextHandler);
		t.mock.restoreAll();
		assert.equal(request.cacheKey, '?q=1');
	});

	it('derives the pathname from the URL when request.pathname is empty', async () => {
		const cacheKey = await cacheKeyFor(edgeMinute, { url: '/from-url?x=1', pathname: '', headers: { host: 'h' } });
		assert.equal(cacheKey.pathname, '/from-url');
		assert.equal(loggedMessages.warn.length, 0);
	});

	it('warns and uses the raw URL path when no pathname can be derived', async () => {
		const cacheKey = await cacheKeyFor(edgeMinute, { url: 'opaque:?x=1', pathname: '' });
		assert.equal(cacheKey.pathname, 'opaque:');
		assert.deepEqual(loggedMessages.warn, [['[CACHE KEY WARNING] Empty pathname, using URL path:', '']]);
	});

	describe('with DEBUG_CACHE_KEYS', () => {
		let previousDebugCacheKeys;
		beforeEach(() => {
			previousDebugCacheKeys = process.env.DEBUG_CACHE_KEYS;
			process.env.DEBUG_CACHE_KEYS = 'true';
		});
		afterEach(() => {
			if (previousDebugCacheKeys === undefined) delete process.env.DEBUG_CACHE_KEYS;
			else process.env.DEBUG_CACHE_KEYS = previousDebugCacheKeys;
		});

		it('logs the key and exposes it in X-Debug-Cache-Key', async () => {
			const { request, responseHeaders } = await routeWithCache(edgeMinute, { url: '/debug?q=1' });
			assert.equal(responseHeaders['X-Debug-Cache-Key'], request.cacheKey);
			assert.equal(loggedMessages.info.length, 1);
			const [label, details] = loggedMessages.info[0];
			assert.equal(label, '[CACHE KEY]');
			assert.equal(details.url, '/debug?q=1');
			assert.equal(details.cacheKey, request.cacheKey);
			assert.equal(details.cacheKeyLength, request.cacheKey.length);
		});
	});

	it('builds a key from stale-while-revalidate alone', async () => {
		const { request, responseHeaders } = await routeWithCache(
			{ edge: { staleWhileRevalidateSeconds: 30 } },
			{ url: '/swr' }
		);
		assert.equal(JSON.parse(request.cacheKey).pathname, '/swr');
		assert.equal(request.maxAgeSeconds, undefined);
		assert.equal('Cache-Control' in responseHeaders, false);
	});

	it('leaves the key unset when no edge lifetime is configured', async () => {
		const { request } = await routeWithCache({ browser: { maxAgeSeconds: 10 } }, { url: '/' });
		assert.equal(request.cacheKey, undefined);
	});

	it('clears an existing cache key when edge caching is disabled', async () => {
		const request = createRequest({ url: '/' });
		request.cacheKey = 'previous';
		await new Router().always(({ cache }) => cache({ edge: false })).onRequest(request, nextHandler);
		assert.equal(request.cacheKey, undefined);
	});

	it('records the cache group and edge lifetime on the request', async () => {
		const { request } = await routeWithCache({ edge: { maxAgeSeconds: 90, cacheGroup: 'api' } }, { url: '/' });
		assert.equal(request.maxAgeSeconds, 90);
		assert.equal(request.cacheGroup, 'api');
	});
});

describe('cache()', () => {
	async function cachingFor(cacheOptions) {
		let capturedActions;
		await new Router()
			.always((actions) => {
				capturedActions = actions;
				actions.cache(cacheOptions);
			})
			.onRequest(createRequest(), nextHandler);
		return capturedActions.caching;
	}

	it('copies every edge setting', async () => {
		assert.deepEqual(
			await cachingFor({
				edge: { maxAgeSeconds: 60, staleWhileRevalidateSeconds: 30, forcePrivateCaching: true, cacheGroup: 'g' },
			}),
			{ maxAgeSeconds: 60, staleWhileRevalidateSeconds: 30, forcePrivateCaching: true, cacheGroup: 'g' }
		);
	});

	it('sets the browser lifetime only when maxAgeSeconds is provided', async () => {
		assert.deepEqual(await cachingFor({ browser: { maxAgeSeconds: 0 } }), { clientMaxAgeSeconds: 0 });
		assert.deepEqual(await cachingFor({ browser: {} }), {});
	});

	it('treats browser: false as a zero browser lifetime', async () => {
		assert.deepEqual(await cachingFor({ browser: false }), { clientMaxAgeSeconds: 0 });
	});

	it('disables caching with edge: false', async () => {
		assert.equal(await cachingFor({ edge: false }), false);
	});

	it('attaches the cache key to existing or disabled caching', async () => {
		const key = new CustomCacheKey().excludeAllQueryParametersExcept('q');
		assert.deepEqual(await cachingFor({ edge: { maxAgeSeconds: 5 }, key }), {
			maxAgeSeconds: 5,
			staleWhileRevalidateSeconds: undefined,
			forcePrivateCaching: undefined,
			cacheGroup: undefined,
			cache_key: key,
		});
		assert.deepEqual(await cachingFor({ edge: false, key }), { cache_key: key });
	});
});

describe('Cache-Control directives', () => {
	async function cacheControlFor(cacheOptions) {
		const { responseHeaders } = await routeWithCache(cacheOptions, { url: '/' });
		return responseHeaders['Cache-Control'];
	}

	it('emits s-maxage, private, and max-age', async () => {
		assert.equal(
			await cacheControlFor({ edge: { maxAgeSeconds: 60, forcePrivateCaching: true }, browser: { maxAgeSeconds: 10 } }),
			's-maxage=60, private, max-age=10'
		);
	});

	it('emits max-age=0 when only the edge caches', async () => {
		assert.equal(await cacheControlFor({ edge: { maxAgeSeconds: 60 }, browser: false }), 's-maxage=60, max-age=0');
	});

	it('forbids caching when neither the edge nor the browser may cache', async () => {
		assert.equal(await cacheControlFor({ browser: false }), 'no-store, no-cache, must-revalidate');
	});

	it('omits Cache-Control when caching has no directives', async () => {
		const { responseHeaders } = await routeWithCache({ key: new CustomCacheKey() }, { url: '/' });
		assert.equal('Cache-Control' in responseHeaders, false);
	});

	it('emits private alone', async () => {
		assert.equal(await cacheControlFor({ edge: { forcePrivateCaching: true } }), 'private');
	});
});

describe('setCaching', () => {
	async function routeWithCaching(caching) {
		const request = createRequest({ url: '/' });
		const router = new Router().always({ caching }).always(({ redirect }) => redirect('/probe', 307));
		const handler = await router.onRequest(request, nextHandler);
		return { request, responseHeaders: handler().headers };
	}

	async function edgeLifetimeFor(maxAge) {
		const { request } = await routeWithCaching({ max_age: maxAge });
		return request.maxAgeSeconds;
	}

	it('converts each interval unit to seconds', async () => {
		assert.equal(await edgeLifetimeFor('2M'), 2 * 30 * 86400);
		assert.equal(await edgeLifetimeFor('2D'), 2 * 86400);
		assert.equal(await edgeLifetimeFor('2d'), 2 * 86400);
		assert.equal(await edgeLifetimeFor('2H'), 2 * 3600);
		assert.equal(await edgeLifetimeFor('2h'), 2 * 3600);
		assert.equal(await edgeLifetimeFor('2m'), 2 * 60);
		assert.equal(await edgeLifetimeFor('2s'), 2);
		assert.equal(await edgeLifetimeFor('2'), 2);
		assert.equal(await edgeLifetimeFor(90), 90);
		assert.equal(await edgeLifetimeFor(1.5), 1.5);
	});

	it('reads the 200 entry of an object max_age', async () => {
		assert.equal(await edgeLifetimeFor({ 200: '1h', 404: '1m' }), await edgeLifetimeFor('1h'));
	});

	it('treats an object max_age without a 200 entry as zero', async () => {
		const caching = { max_age: { 404: '1m' } };
		const { request } = await routeWithCaching(caching);
		assert.equal(caching.maxAgeSeconds, 0);
		assert.equal(request.cacheKey, undefined);
	});

	it('converts client_max_age and stale_while_revalidate to seconds', async () => {
		const caching = { client_max_age: '1m', stale_while_revalidate: '2m' };
		await routeWithCaching(caching);
		assert.equal(caching.clientMaxAgeSeconds, 60);
		assert.equal(caching.staleWhileRevalidateSeconds, 120);
	});

	it('emits the same Cache-Control as cache() with the equivalent seconds', async () => {
		const { request, responseHeaders } = await routeWithCaching({ max_age: '1h', client_max_age: '1m' });
		const viaCache = await routeWithCache(
			{ edge: { maxAgeSeconds: 3600 }, browser: { maxAgeSeconds: 60 } },
			{ url: '/' }
		);
		assert.equal(request.maxAgeSeconds, 3600);
		assert.equal(responseHeaders['Cache-Control'], 's-maxage=3600, max-age=60');
		assert.equal(responseHeaders['Cache-Control'], viaCache.responseHeaders['Cache-Control']);
		assert.equal(request.maxAgeSeconds, viaCache.request.maxAgeSeconds);
	});

	it('applies caching returned by a handler', async () => {
		const caching = { max_age: '1h' };
		const request = createRequest({ url: '/' });
		await new Router().always(() => ({ caching })).onRequest(request, nextHandler);
		assert.equal(request.maxAgeSeconds, 3600);
		assert.ok(request.cacheKey);
	});
});
