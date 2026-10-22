const { Router, CustomCacheKey } = require('@harperdb/http-router');

module.exports = new Router()
	.get('/old-path', ({ redirect }) => redirect('/new-path', 301))
	.get('/redirect-with-header', ({ redirect, setResponseHeader }) => {
		setResponseHeader('X-Custom-Header', 'e2e');
		redirect('/destination', 302);
	})
	.post('/submit', ({ redirect }) => redirect('/submitted', 303))
	.match({ path: '/query-check', query: { mode: 'fast' } }, ({ redirect }) => redirect('/fast-mode', 302))
	.get('/content/:id', ({ cache }) => cache({ edge: { maxAgeSeconds: 60 } }))
	.get('/variant/:id', ({ cache }) =>
		cache({ edge: { maxAgeSeconds: 60 }, key: new CustomCacheKey().addCookie('variant') })
	)
	.get('/static/:path*', ({ serveStatic }) => serveStatic('public/:path*'))
	.get('/api/:path*', ({ proxy, setRequestHeader, updateResponseHeader }) => {
		setRequestHeader('X-From-Router', 'yes');
		updateResponseHeader('x-origin-server', /^echo/, 'proxied-echo');
		proxy('origin', { path: '/echo/:path*' });
	})
	.get('/ttl', { caching: { max_age: '1h' }, origin: { set_origin: 'origin' } })
	.get('/routes-version', ({ redirect }) => redirect('/routes-v1', 302))
	.use();
