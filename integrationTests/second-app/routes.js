const { Router } = require('@harperdb/http-router');

module.exports = new Router()
	.get('/second/static/:path*', ({ serveStatic }) => {
		serveStatic('public/:path*');
	})
	.destination(
		'second-api',
		new Router().get('/second/destination-check', ({ redirect }) => {
			redirect('/second-destination-ok', 302);
		})
	)
	.use();
