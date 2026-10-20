const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const {
	clearLoggedMessages,
	createRequest,
	extension,
	loadRouterModule,
	loggedMessages,
	nextHandler,
	proxyStub,
} = require('./helpers/routerHarness.js');

const { Router } = loadRouterModule();

beforeEach(() => {
	proxyStub.requests.length = 0;
	proxyStub.nextThrow = null;
	clearLoggedMessages();
	extension.origins.clear();
	extension.origins.set('plain', { hostname: 'plain.example.com', rejectUnauthorized: true });
	extension.origins.set('backend', {
		hostname: 'backend.example.com',
		rejectUnauthorized: false,
		servername: 'sni.example.com',
		hostHeader: 'www.example.com',
	});
	extension.origins.set('hostless', { rejectUnauthorized: true });
});

async function startProxy(router, requestOptions) {
	const request = createRequest(requestOptions);
	const handler = await router.onRequest(request, nextHandler);
	assert.notEqual(handler, nextHandler);
	const completion = handler();
	assert.equal(proxyStub.requests.length, 1);
	return { request, completion, clientRequest: proxyStub.requests[0] };
}

async function proxyAndRespond(router, requestOptions, response) {
	const proxy = await startProxy(router, requestOptions);
	proxy.clientRequest.respond(response);
	await proxy.completion;
	return proxy;
}

describe('proxying', () => {
	it('forwards a GET request to the origin and streams the response back', async () => {
		const router = new Router()
			.always({ headers: { set_response_headers: { 'x-edge': 'router', 'x-overridden': 'router' } } })
			.match('/page', { origin: 'plain' });
		const { request, clientRequest } = await proxyAndRespond(
			router,
			{ url: '/page?q=1', headers: { host: 'edge.example.com', accept: 'text/html' } },
			{
				statusCode: 201,
				statusMessage: 'Created',
				headers: { 'connection': 'keep-alive', 'content-type': 'text/html', 'x-overridden': 'origin' },
				body: 'origin body',
			}
		);
		assert.deepEqual(clientRequest.options, {
			timeout: 60000,
			hostname: 'plain.example.com',
			path: '/page?q=1',
			method: 'GET',
			headers: { accept: 'text/html' },
			rejectUnauthorized: true,
		});
		assert.equal(clientRequest.body, undefined);
		const nodeResponse = request._nodeResponse;
		assert.equal(nodeResponse.statusCode, 201);
		assert.equal(nodeResponse.statusMessage, 'Created');
		assert.deepEqual(nodeResponse.headersWritten, {
			'x-edge': 'router',
			'x-overridden': 'origin',
			'content-type': 'text/html',
		});
		assert.equal(nodeResponse.body, 'origin body');
		assert.ok(loggedMessages.info.some(([message]) => message === 'Finished proxied response for /page?q=1'));
	});

	it('resolves the origin from set_origin and origin objects', async () => {
		await proxyAndRespond(new Router().always({ origin: { set_origin: 'plain' } }), { url: '/a' });
		assert.equal(proxyStub.requests[0].options.hostname, 'plain.example.com');
		proxyStub.requests.length = 0;
		await proxyAndRespond(new Router().always({ origin: { origin: 'backend' } }), { url: '/b' });
		assert.equal(proxyStub.requests[0].options.hostname, 'backend.example.com');
	});

	it('applies the origin Host header, TLS verification, and SNI servername', async () => {
		const { clientRequest } = await proxyAndRespond(new Router().always({ origin: 'backend' }), {
			url: '/',
			headers: { host: 'edge.example.com' },
		});
		assert.equal(clientRequest.options.headers.Host, 'www.example.com');
		assert.equal(clientRequest.options.headers.host, undefined);
		assert.equal(clientRequest.options.rejectUnauthorized, false);
		assert.equal(clientRequest.options.servername, 'sni.example.com');
	});

	it('rewrites the URL with regexp url_rewrite rules only', async () => {
		const router = new Router().always({
			origin: 'plain',
			url: {
				url_rewrite: [
					{ syntax: 'regexp', source: '^/old/(.*)$', destination: '/new/$1' },
					{ syntax: 'path-to-regexp', source: '/new/:rest*', destination: '/ignored' },
					{ syntax: 'regexp', source: '/new/', destination: '/newer/' },
				],
			},
		});
		const { clientRequest } = await proxyAndRespond(router, { url: '/old/item?id=3' });
		assert.equal(clientRequest.options.path, '/newer/item?id=3');
	});

	it('substitutes the matched path parameter into the proxy path', async () => {
		const router = new Router().get('/proxy/:path*', ({ proxy }) => proxy('plain', { path: '/api/:path*' }));
		const { clientRequest } = await proxyAndRespond(router, { url: '/proxy/users/1?expand=true' });
		assert.equal(clientRequest.options.path, '/api/users/1?expand=true');
	});

	it('overrides request headers set by the handler', async () => {
		const router = new Router().always(({ proxy, setRequestHeader }) => {
			setRequestHeader('X-Forwarded-Proto', 'https');
			setRequestHeader('Accept', 'application/json');
			proxy('plain');
		});
		const { clientRequest } = await proxyAndRespond(router, { url: '/', headers: { accept: 'text/html' } });
		assert.deepEqual(clientRequest.options.headers, { 'accept': 'application/json', 'x-forwarded-proto': 'https' });
	});

	it('proxies to the origin returned by a handler', async () => {
		const { clientRequest } = await proxyAndRespond(
			new Router().always(() => ({ origin: 'plain' })),
			{ url: '/' }
		);
		assert.equal(clientRequest.options.hostname, 'plain.example.com');
	});

	it('rewrites origin response headers with updateResponseHeader', async () => {
		const router = new Router().always(({ proxy, updateResponseHeader }) => {
			updateResponseHeader('location', /plain\.example\.com/, 'www.example.com');
			updateResponseHeader('location', 'http:', 'https:');
			updateResponseHeader('x-absent', 'a', 'b');
			proxy('plain');
		});
		const { request } = await proxyAndRespond(
			router,
			{ url: '/' },
			{
				statusCode: 302,
				headers: { location: 'http://plain.example.com/next' },
			}
		);
		assert.equal(request._nodeResponse.headersWritten.location, 'https://www.example.com/next');
		assert.equal('x-absent' in request._nodeResponse.headersWritten, false);
	});

	it('buffers the request body for non-GET requests', async () => {
		const proxy = await startProxy(new Router().always({ origin: 'plain' }), {
			url: '/submit',
			method: 'POST',
			body: 'payload',
		});
		const body = await proxy.clientRequest.ended;
		assert.equal(body.toString(), 'payload');
		assert.equal(proxy.clientRequest.options.method, 'POST');
		proxy.clientRequest.respond();
		await proxy.completion;
	});

	it('sends no body for HEAD requests', async () => {
		const { clientRequest } = await proxyAndRespond(new Router().always({ origin: 'plain' }), {
			url: '/',
			method: 'HEAD',
		});
		assert.equal(clientRequest.body, undefined);
	});

	it('rejects when the proxied request fails', async () => {
		const { completion, clientRequest } = await startProxy(new Router().always({ origin: 'plain' }), { url: '/' });
		const requestError = new Error('ECONNREFUSED');
		clientRequest.emit('error', requestError);
		await assert.rejects(completion, requestError);
		assert.ok(loggedMessages.warn.some(([message]) => message === 'Error in proxying request /'));
	});

	it('rejects when streaming the proxied body fails', async () => {
		const { request, completion, clientRequest } = await startProxy(new Router().always({ origin: 'plain' }), {
			url: '/',
		});
		const response = Readable.from([]);
		response.statusCode = 200;
		response.headers = {};
		clientRequest.onResponse(response);
		const pipeError = new Error('socket hang up');
		request._nodeResponse.destroy(pipeError);
		await assert.rejects(completion, pipeError);
		assert.ok(loggedMessages.warn.some(([message]) => message === 'Error in sending proxied body /'));
	});

	it('rejects when preparing the proxied request throws', async () => {
		const router = new Router().always({ origin: 'plain' });
		const handler = await router.onRequest(createRequest({ url: '/' }), nextHandler);
		const preparationError = new Error('invalid header');
		proxyStub.nextThrow = preparationError;
		await assert.rejects(handler(), preparationError);
		assert.ok(loggedMessages.warn.some(([message]) => message === 'Error preparing proxying request /'));
	});

	it('rejects and aborts the proxied request when reading the request body fails', async () => {
		const request = createRequest({ url: '/upload', method: 'POST' });
		const bodyError = new Error('client aborted');
		request._nodeRequest = new Readable({
			read() {
				this.destroy(bodyError);
			},
		});
		const handler = await new Router().always({ origin: 'plain' }).onRequest(request, nextHandler);
		await assert.rejects(handler(), bodyError);
		assert.equal(proxyStub.requests[0].destroyedWith, bodyError);
		assert.ok(loggedMessages.warn.some(([message]) => message === 'Error reading request body to proxy /upload'));
	});

	it('rejects an unknown origin', async () => {
		const router = new Router().always({ origin: 'unknown' });
		await assert.rejects(router.onRequest(createRequest(), nextHandler), /Origin "unknown" not found/);
	});

	it('rejects the pwa catch-all origin because it has no hostname', async () => {
		const router = new Router().always({ origin: 'pwa' });
		await assert.rejects(router.onRequest(createRequest(), nextHandler), /No hostname found for origin/);
	});

	it('rejects an origin configured without a hostname', async () => {
		const router = new Router().always({ origin: 'hostless' });
		await assert.rejects(router.onRequest(createRequest(), nextHandler), /No hostname found for origin/);
	});
});
