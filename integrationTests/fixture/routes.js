/**
 * Integration test routes for @harperdb/http-router.
 * Tests: redirects (with response headers), caching config, and fallback.
 *
 * Note: response headers set via setResponseHeader() are only applied
 * when the router returns an explicit response (redirect, proxy, static).
 * They are NOT applied when the request passes through to nextHandler,
 * because the router does not wrap the next handler's response.
 * Tests for header injection therefore use a redirect route that also
 * sets a response header (headers are merged into the redirect response).
 */
const { Router } = require('@harperdb/http-router');

module.exports = new Router()
	// Permanent redirect
	.get('/old-path', ({ redirect }) => {
		redirect('/new-path', 301);
	})
	// Temporary redirect
	.get('/temp-redirect', ({ redirect }) => {
		redirect('/destination', 302);
	})
	// Redirect with a custom response header (tests header injection on redirect responses)
	.get('/redirect-with-header', ({ redirect, setResponseHeader }) => {
		setResponseHeader('X-Custom-Header', 'test-value');
		redirect('/destination', 302);
	})
	// Route with edge caching configured — sets request.cacheKey so the cache
	// middleware intercepts. Requires a downstream response handler to complete.
	.get('/cached-resource', ({ cache }) => {
		cache({ edge: { maxAgeSeconds: 60 } });
	})
	// Fallback — pass through to next handler
	.use();
