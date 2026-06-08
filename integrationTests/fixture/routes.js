/**
 * Integration test routes for @harperdb/http-router.
 * Tests: redirects, caching headers, custom response headers, and fallback.
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
	// Route with edge caching configured
	.get('/cached-resource', ({ cache }) => {
		cache({ edge: { maxAgeSeconds: 60 } });
	})
	// Route with custom response header
	.get('/with-header', ({ setResponseHeader }) => {
		setResponseHeader('X-Custom-Header', 'test-value');
	})
	// Fallback — pass through to next handler
	.use();
