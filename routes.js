/**
 * Test routes configuration for integration testing.
 * Exercises the core Router API features: redirects, caching config,
 * header manipulation, and fallback handling.
 */
const { Router } = require('./index.js');

module.exports = new Router()
	// Permanent redirect
	.get('/old-path', ({ redirect }) => {
		redirect('/new-path', 301);
	})
	// Temporary redirect
	.get('/temp-redirect', ({ redirect }) => {
		redirect('/destination', 302);
	})
	// Route with edge caching configured (sets cache headers on response)
	.get('/cached-resource', ({ cache }) => {
		cache({ edge: { maxAgeSeconds: 60 } });
	})
	// Route with response header set
	.get('/with-header', ({ setResponseHeader }) => {
		setResponseHeader('X-Custom-Header', 'test-value');
	})
	// Fallback — pass through to next handler
	.use();
