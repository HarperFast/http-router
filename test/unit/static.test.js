const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough, Readable } = require('node:stream');
const { createRequest, routerState, loadRouterModule, nextHandler, sendStub } = require('./helpers/routerHarness.js');

const { Router } = loadRouterModule();

beforeEach(() => {
	sendStub.calls.length = 0;
	sendStub.createStream = () => Readable.from(['static body']);
});

describe('serveStatic', () => {
	it('sends the file for the matched path parameter with the response headers', async () => {
		const router = new Router().get('/assets/:file*', ({ serveStatic, setResponseHeader }) => {
			setResponseHeader('x-static', 'yes');
			serveStatic('public/:file*');
		});
		const request = createRequest({ url: '/assets/css/my%20site.css?v=2' });
		const handler = await router.onRequest(request, nextHandler);
		await handler();
		assert.equal(sendStub.calls.length, 1);
		const [sendCall] = sendStub.calls;
		assert.equal(sendCall.request, request);
		assert.equal(sendCall.filePath, 'public/css/my site.css');
		assert.deepEqual(sendCall.options, { dotfiles: 'allow', root: routerState.baseDir });
		assert.deepEqual(request._nodeResponse.headersSet, { 'x-static': 'yes' });
		assert.equal(request._nodeResponse.body, 'static body');
	});

	it('serves a fixed path unchanged', async () => {
		const router = new Router().get('/:page', ({ serveStatic }) => serveStatic('public/index.html'));
		const handler = await router.onRequest(createRequest({ url: '/home' }), nextHandler);
		await handler();
		assert.equal(sendStub.calls[0].filePath, 'public/index.html');
	});

	it('rejects when sending the file fails', async () => {
		const sendError = new Error('ENOENT');
		const request = createRequest({ url: '/assets/missing.css' });
		sendStub.createStream = () => {
			const stream = new PassThrough();
			process.nextTick(() => request._nodeResponse.destroy(sendError));
			return stream;
		};
		const router = new Router().get('/assets/:file*', ({ serveStatic }) => serveStatic('public/:file*'));
		const handler = await router.onRequest(request, nextHandler);
		await assert.rejects(handler(), sendError);
	});
});
