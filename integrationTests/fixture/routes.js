const { Router } = require('@harperdb/http-router');

module.exports = new Router()
	.get('/old-path', ({ redirect }) => {
		redirect('/new-path', 301);
	})
	.get('/temp-redirect', ({ redirect }) => {
		redirect('/destination', 302);
	})
	.get('/redirect-with-header', ({ redirect, setResponseHeader }) => {
		setResponseHeader('X-Custom-Header', 'test-value');
		redirect('/destination', 302);
	})
	.get('/routes-version', ({ redirect }) => {
		redirect('/routes-v1', 302);
	})
	.get('/shared-route', ({ redirect }) => {
		redirect('/shared-from-routes', 302);
	})
	.get('/content/:id', ({ cache }) => {
		cache({ edge: { maxAgeSeconds: 60 } });
	})
	.get('/static/:path*', ({ serveStatic }) => {
		serveStatic('public/:path*');
	})
	.destination(
		'api',
		new Router().get('/destination-check', ({ redirect }) => {
			redirect('/destination-ok', 302);
		})
	)
	.use();
