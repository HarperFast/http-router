const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createRequest, extension, loadRouterModule, nextHandler } = require('./helpers/routerHarness.js');

const { Router, or, nextRoutes } = loadRouterModule();

function probeRedirect(router) {
	return router.always(({ redirect }) => redirect('/probe', 307));
}

async function responseHeadersFor(router, request) {
	const handler = await probeRedirect(router).onRequest(request, nextHandler);
	return handler().headers;
}

function marker(name) {
	return { headers: { set_response_headers: { 'x-matched': name } } };
}

async function matchedMarker(router, requestOptions) {
	const headers = await responseHeadersFor(router, createRequest(requestOptions));
	return headers['x-matched'];
}

beforeEach(() => {
	extension.origins.clear();
});

describe('Router methods', () => {
	it('get matches a path string and a { path } object', async () => {
		const router = new Router().get('/string', marker('string')).get({ path: '/object' }, marker('object'));
		assert.equal(await matchedMarker(router, { url: '/string' }), 'string');
		assert.equal(await matchedMarker(router, { url: '/object' }), 'object');
		assert.equal(await matchedMarker(router, { url: '/other' }), undefined);
	});

	it('post matches a path string and a { path } object', async () => {
		const router = new Router().post('/string', marker('string')).post({ path: '/object' }, marker('object'));
		assert.equal(await matchedMarker(router, { url: '/string', method: 'POST' }), 'string');
		assert.equal(await matchedMarker(router, { url: '/object', method: 'POST' }), 'object');
	});

	it('get matches GET and HEAD but not POST', async () => {
		const router = new Router().get('/only-get', marker('get'));
		assert.equal(await matchedMarker(router, { url: '/only-get', method: 'HEAD' }), 'get');
		assert.equal(await matchedMarker(router, { url: '/only-get', method: 'POST' }), undefined);
	});

	it('post matches only POST', async () => {
		const router = new Router().post('/only-post', marker('post'));
		assert.equal(await matchedMarker(router, { url: '/only-post', method: 'GET' }), undefined);
		assert.equal(await matchedMarker(router, { url: '/only-post', method: 'HEAD' }), undefined);
	});

	it('returns the router from every builder method for chaining', () => {
		const router = new Router();
		assert.equal(router.get('/a', {}), router);
		assert.equal(router.post('/a', {}), router);
		assert.equal(router.use(), router);
		assert.equal(router.match('/a', {}), router);
		assert.equal(router.matchAny(['/a'], {}), router);
		assert.equal(router.fallback({}), router);
		assert.equal(router.always({}), router);
		assert.equal(
			router.catch(404, () => {}),
			router
		);
		assert.equal(router.if('/a'), router);
	});

	it('use adds an unconditional rule that defers to the next handler', async () => {
		const router = new Router().use();
		assert.equal(router.rules.length, 1);
		assert.equal(router.rules[0].condition, null);
		assert.equal(router.rules[0].actions.useNext, true);
		const request = createRequest({ url: '/not-in-manifest' });
		assert.equal(await router.onRequest(request, nextHandler), nextHandler);
		assert.deepEqual(request._nodeResponse.headersSet, {});
	});

	it('matchAny adds one rule per condition', async () => {
		const router = new Router().matchAny(['/first', '/second'], marker('any'));
		assert.equal(router.rules.length, 2);
		assert.equal(await matchedMarker(router, { url: '/first' }), 'any');
		assert.equal(await matchedMarker(router, { url: '/second' }), 'any');
		assert.equal(await matchedMarker(router, { url: '/third' }), undefined);
	});

	it('fallback and always match every request', async () => {
		assert.equal(await matchedMarker(new Router().fallback(marker('fallback')), { url: '/x' }), 'fallback');
		assert.equal(await matchedMarker(new Router().always(marker('always')), { url: '/y' }), 'always');
	});

	it('fallback applies only when no earlier rule matched', async () => {
		const router = new Router().get('/page', marker('page')).fallback(marker('fallback'));
		assert.equal(router.rules[1].isFallback, true);
		assert.equal(await matchedMarker(router, { url: '/page' }), 'page');
		assert.equal(await matchedMarker(router, { url: '/other' }), 'fallback');
	});

	it('fallback inside if() is flagged on the nested router', async () => {
		const router = new Router().if('/section/:rest*').match('/section/known', marker('known'));
		router.fallback(marker('section fallback'));
		assert.equal(router.currentRouter.rules[1].isFallback, true);
		assert.equal(await matchedMarker(router, { url: '/section/known' }), 'known');
		assert.equal(await matchedMarker(router, { url: '/section/other' }), 'section fallback');
	});

	it('destination routes by the origin hostname as the Host header', async () => {
		extension.origins.set('backend', { hostname: 'backend.example.com' });
		const destinationRouter = probeRedirect(new Router().always(marker('destination')));
		const router = new Router().destination('backend', destinationRouter);
		assert.equal(router.rules[0].router, destinationRouter);
		const matchedRequest = createRequest({ url: '/a', headers: { host: 'backend.example.com' } });
		const handler = await router.onRequest(matchedRequest, nextHandler);
		assert.equal(handler().headers['x-matched'], 'destination');
		const otherRequest = createRequest({ url: '/a', headers: { host: 'other.example.com' } });
		assert.equal(await router.onRequest(otherRequest, nextHandler), nextHandler);
	});

	it('destination without an origin hostname matches every request', async () => {
		const destinationRouter = probeRedirect(new Router().always(marker('pwa')));
		const router = new Router().destination('pwa', destinationRouter);
		assert.equal(router.rules[0].condition, null);
		const handler = await router.onRequest(createRequest({ url: '/anything' }), nextHandler);
		assert.equal(handler().headers['x-matched'], 'pwa');
	});

	it('destination rejects a missing or unknown origin name', () => {
		assert.throws(() => new Router().destination(undefined, new Router()), /No origin name provided/);
		assert.throws(() => new Router().destination('unknown', new Router()), /Origin "unknown" not found/);
	});

	it('catch registers no rule', () => {
		const router = new Router().catch(404, () => {});
		assert.deepEqual(router.rules, []);
	});

	it('if sends later match calls to a nested router', async () => {
		const router = new Router().if({ headers: { 'x-beta': '1' } }).match('/feature', marker('beta'));
		assert.equal(router.rules.length, 1);
		assert.equal(router.rules[0].router, router.currentRouter);
		assert.equal(router.currentRouter.rules.length, 1);
		probeRedirect(router);
		const betaRequest = createRequest({ url: '/feature', headers: { 'x-beta': '1' } });
		assert.equal((await router.onRequest(betaRequest, nextHandler))().headers['x-matched'], 'beta');
		const regularRequest = createRequest({ url: '/feature', headers: { 'x-beta': '0' } });
		assert.equal(await router.onRequest(regularRequest, nextHandler), nextHandler);
	});

	it('if supports nesting another if', async () => {
		const router = new Router().if('/outer/:rest*');
		router.currentRouter.if({ headers: { 'x-inner': 'yes' } }).match('/outer/:rest*', marker('inner'));
		probeRedirect(router.currentRouter);
		const innerRequest = createRequest({ url: '/outer/page', headers: { 'x-inner': 'yes' } });
		assert.equal((await router.onRequest(innerRequest, nextHandler))().headers['x-matched'], 'inner');
		const outerOnlyRequest = createRequest({ url: '/outer/page' });
		assert.equal(await router.onRequest(outerOnlyRequest, nextHandler), nextHandler);
	});

	it('returns the next handler when no rule matches', async () => {
		const router = new Router().get('/a', marker('a'));
		assert.equal(await router.onRequest(createRequest({ url: '/b' }), nextHandler), nextHandler);
	});

	it('accepts a Router as rule options', async () => {
		const nestedRouter = probeRedirect(new Router().always(marker('nested')));
		const router = new Router().match('/nested/:rest*', nestedRouter);
		const handler = await router.onRequest(createRequest({ url: '/nested/a' }), nextHandler);
		assert.equal(handler().headers['x-matched'], 'nested');
	});

	it('exports an empty nextRoutes object', () => {
		assert.deepEqual(nextRoutes, {});
	});
});

describe('Rule matching', () => {
	it('matches a :param segment but not across slashes', async () => {
		const router = new Router().match('/users/:id', marker('user'));
		assert.equal(await matchedMarker(router, { url: '/users/42' }), 'user');
		assert.equal(await matchedMarker(router, { url: '/users/42/posts' }), undefined);
		assert.equal(await matchedMarker(router, { url: '/users/' }), undefined);
	});

	it('matches a :param* segment across slashes', async () => {
		const router = new Router().match('/assets/:path*', marker('asset'));
		assert.equal(await matchedMarker(router, { url: '/assets/css/site.css' }), 'asset');
		assert.equal(await matchedMarker(router, { url: '/assets/' }), 'asset');
		assert.equal(await matchedMarker(router, { url: '/other/site.css' }), undefined);
	});

	it('matches a RegExp condition directly and as a path', async () => {
		const router = new Router()
			.match(/^\/regex\/\d+$/, marker('regex'))
			.match({ path: /^\/path-regex$/ }, marker('path'));
		assert.equal(await matchedMarker(router, { url: '/regex/7' }), 'regex');
		assert.equal(await matchedMarker(router, { url: '/regex/x' }), undefined);
		assert.equal(await matchedMarker(router, { url: '/path-regex' }), 'path');
	});

	it('matches a { not } condition when the path does not match', async () => {
		const router = new Router().match({ not: '/admin/:rest*' }, marker('public'));
		assert.equal(await matchedMarker(router, { url: '/home' }), 'public');
		assert.equal(await matchedMarker(router, { url: '/admin/users' }), undefined);
	});

	it('matches a { not } condition wrapping a RegExp', async () => {
		const router = new Router().match({ not: /^\/private/ }, marker('public'));
		assert.equal(await matchedMarker(router, { url: '/home' }), 'public');
		assert.equal(await matchedMarker(router, { url: '/private/x' }), undefined);
	});

	it(
		'matches a nested { not } condition as the positive path',
		{ todo: 'not-matcher re-runs stringToRegex on an already-built matcher (index.js:697)' },
		async () => {
			const router = new Router().match({ not: { not: '/kept' } }, marker('kept'));
			assert.equal(await matchedMarker(router, { url: '/kept' }), 'kept');
			assert.equal(await matchedMarker(router, { url: '/dropped' }), undefined);
		}
	);

	it('matches query conditions after the first query parameter', async () => {
		const router = new Router().match({ path: '/page', query: { preview: 'true' } }, marker('preview'));
		assert.equal(await matchedMarker(router, { url: '/page?lang=en&preview=true' }), 'preview');
		assert.equal(await matchedMarker(router, { url: '/page?lang=en&preview=false' }), undefined);
		assert.equal(await matchedMarker(router, { url: '/page' }), undefined);
		assert.equal(await matchedMarker(router, { url: '/elsewhere?lang=en&preview=true' }), undefined);
	});

	it('matches a query condition on the first query parameter', async () => {
		const router = new Router().match({ query: { preview: 'true' } }, marker('preview'));
		assert.equal(await matchedMarker(router, { url: '/page?preview=true' }), 'preview');
		assert.equal(await matchedMarker(router, { url: '/preview=true' }), undefined);
	});

	it('matches header conditions', async () => {
		const router = new Router().match({ headers: { 'x-device': 'mobile' } }, marker('mobile'));
		assert.equal(await matchedMarker(router, { url: '/', headers: { 'x-device': 'mobile' } }), 'mobile');
		assert.equal(await matchedMarker(router, { url: '/', headers: { 'x-device': 'desktop' } }), undefined);
		assert.equal(await matchedMarker(router, { url: '/' }), undefined);
	});

	it('matches every request when the object condition has no criteria', async () => {
		const router = new Router().match({}, marker('empty'));
		assert.deepEqual(router.rules[0].condition, {});
		assert.equal(await matchedMarker(router, { url: '/anything' }), 'empty');
	});

	it('throws a TypeError for a criterion that is not a string, RegExp, or { not }', () => {
		assert.throws(() => new Router().match({ path: 42 }, {}), {
			name: 'TypeError',
			message: 'Unknown type of matching requests 42',
		});
		assert.throws(() => new Router().match({ headers: { 'x-a': {} } }, {}), TypeError);
	});
});

describe('or', () => {
	it('matches when any condition matches', () => {
		const firstCondition = { match: (request) => request.pathname === '/a' };
		const secondCondition = { match: (request) => request.pathname === '/b' };
		const orRule = or(firstCondition, secondCondition);
		assert.deepEqual(orRule.conditions, [firstCondition, secondCondition]);
		assert.equal(orRule.match(createRequest({ url: '/a' })), true);
		assert.equal(orRule.match(createRequest({ url: '/b' })), true);
		assert.ok(!orRule.match(createRequest({ url: '/c' })));
	});

	it(
		'limits a router rule to the or-ed paths',
		{ todo: 'Rule treats an OrRule condition as an empty object condition that matches everything (index.js:467-486)' },
		async () => {
			const router = new Router().match(or('/a', '/b'), marker('or'));
			assert.equal(await matchedMarker(router, { url: '/a' }), 'or');
			assert.equal(await matchedMarker(router, { url: '/c' }), undefined);
		}
	);
});

describe('Header directives', () => {
	it('applies set, add, and remove response headers in order', async () => {
		const router = new Router().always({
			headers: {
				set_response_headers: { 'x-set': 'set', 'x-replaced': 'first', 'x-removed': 'gone' },
				add_response_headers: { 'x-added': 'added', 'x-replaced': 'second' },
				remove_response_headers: { 'x-removed': true },
			},
		});
		const headers = await responseHeadersFor(router, createRequest());
		assert.deepEqual(headers, { 'x-set': 'set', 'x-replaced': 'second', 'x-added': 'added', 'Location': '/probe' });
	});

	it('sets a custom header to the client ip', async () => {
		const router = new Router().always({ headers: { set_client_ip_custom_header: 'x-client-ip' } });
		const headers = await responseHeadersFor(router, createRequest({ ip: '198.51.100.4' }));
		assert.equal(headers['x-client-ip'], '198.51.100.4');
	});

	it('accumulates headers across every matching rule', async () => {
		const router = new Router()
			.match('/a', { headers: { set_response_headers: { 'x-first': '1' } } })
			.always({ headers: { add_response_headers: { 'x-second': '2' } } });
		const headers = await responseHeadersFor(router, createRequest({ url: '/a' }));
		assert.equal(headers['x-first'], '1');
		assert.equal(headers['x-second'], '2');
	});
});

describe('Handler actions', () => {
	it('setResponseHeader adds response headers', async () => {
		const router = new Router().always(({ setResponseHeader }) => {
			setResponseHeader('x-one', '1');
			setResponseHeader('x-two', '2');
		});
		const headers = await responseHeadersFor(router, createRequest());
		assert.equal(headers['x-one'], '1');
		assert.equal(headers['x-two'], '2');
	});

	it('setRequestHeader stores lower-cased request header overrides', async () => {
		let capturedActions;
		const router = new Router().always((actions) => {
			capturedActions = actions;
			actions.setRequestHeader('X-Forwarded-Proto', 'https');
			actions.setRequestHeader('X-Other', 'value');
		});
		await router.onRequest(createRequest(), nextHandler);
		assert.deepEqual(capturedActions.request_headers, { 'x-forwarded-proto': 'https', 'x-other': 'value' });
	});

	it('exposes the request to the handler', async () => {
		const request = createRequest();
		let handlerRequest;
		await new Router().always(({ request }) => (handlerRequest = request)).onRequest(request, nextHandler);
		assert.equal(handlerRequest, request);
	});

	it('redirect returns a handler producing the status and Location', async () => {
		const router = new Router()
			.always({ headers: { set_response_headers: { 'x-before': 'kept' } } })
			.match('/old', ({ redirect }) => redirect('/new', 301));
		const handler = await router.onRequest(createRequest({ url: '/old' }), nextHandler);
		assert.deepEqual(handler(), { status: 301, headers: { 'x-before': 'kept', 'Location': '/new' } });
	});

	it('updateResponseHeader records successive replacements', async () => {
		let capturedActions;
		await new Router()
			.always((actions) => {
				capturedActions = actions;
				actions.updateResponseHeader('location', /origin/, 'edge');
				actions.updateResponseHeader('set-cookie', 'Domain=origin', 'Domain=edge');
			})
			.onRequest(createRequest(), nextHandler);
		assert.deepEqual(capturedActions.update_response_headers, [
			{ name: 'location', match: /origin/, replacement: 'edge' },
			{ name: 'set-cookie', match: 'Domain=origin', replacement: 'Domain=edge' },
		]);
	});

	it('runs the handler on every request with fresh actions', async () => {
		let calls = 0;
		const router = new Router().always(({ setResponseHeader }) => setResponseHeader('x-call', String(++calls)));
		assert.equal((await responseHeadersFor(router, createRequest()))['x-call'], '1');
		assert.equal((await router.onRequest(createRequest(), nextHandler))().headers['x-call'], '2');
	});

	it('ignores a falsy handler return value', async () => {
		const router = new Router().always(() => null);
		assert.equal(await router.onRequest(createRequest(), nextHandler), nextHandler);
	});
});

describe('RequestActions.run', () => {
	async function captureActions(request, configure = () => {}) {
		let capturedActions;
		await new Router()
			.always((actions) => {
				capturedActions = actions;
				configure(actions);
			})
			.onRequest(request, nextHandler);
		return capturedActions;
	}

	function createResponse() {
		const headers = new Map();
		return { headers: { set: (name, value) => headers.set(name, value), values: headers } };
	}

	it('decorates the handler response with response headers and max-age', async () => {
		const request = createRequest();
		const actions = await captureActions(request);
		Object.defineProperty(actions, 'redirect', { value: undefined });
		actions.responseHeaders = new Map([['x-run', 'yes']]);
		actions.maxAgeSeconds = 120;
		const response = createResponse();
		let handlerRequest;
		const result = await actions.run(async (receivedRequest) => {
			handlerRequest = receivedRequest;
			return response;
		});
		assert.equal(result, response);
		assert.equal(handlerRequest, request);
		assert.deepEqual(Object.fromEntries(response.headers.values), { 'x-run': 'yes', 'Cache-Control': 'max-age=120' });
	});

	it('returns an undecorated response and passes through an empty one', async () => {
		const actions = await captureActions(createRequest());
		Object.defineProperty(actions, 'redirect', { value: undefined });
		const response = createResponse();
		assert.equal(await actions.run(() => response), response);
		assert.equal(response.headers.values.size, 0);
		assert.equal(await actions.run(() => undefined), undefined);
	});

	it(
		'calls the handler when no redirect is pending',
		{ todo: 'run checks the always-truthy redirect getter instead of redirecting (index.js:633)' },
		async () => {
			const actions = await captureActions(createRequest());
			const response = createResponse();
			assert.equal(await actions.run(() => response), response);
		}
	);

	it(
		'returns the pending redirect',
		{ todo: 'run reads status and location from the redirect getter instead of redirecting (index.js:633-636)' },
		async () => {
			const actions = await captureActions(createRequest(), ({ redirect }) => redirect('/moved', 308));
			assert.deepEqual(await actions.run(() => createResponse()), { status: 308, headers: { Location: '/moved' } });
		}
	);
});
