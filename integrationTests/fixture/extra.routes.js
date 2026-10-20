const { Router } = require('@harperdb/http-router');

module.exports = new Router()
	.get('/extra-route', ({ redirect }) => {
		redirect('/extra-ok', 302);
	})
	.get('/shared-route', ({ redirect }) => {
		redirect('/shared-from-extra', 302);
	})
	.use();
