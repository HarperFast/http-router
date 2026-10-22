const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { CustomCacheKey } = require('../../CustomCacheKey.js');
const { loadRouterModule } = require('./helpers/routerHarness.js');

describe('CustomCacheKey', () => {
	it('is re-exported by the router module', () => {
		assert.equal(loadRouterModule().CustomCacheKey, CustomCacheKey);
	});

	it('replaces the query parameter whitelist on each call and chains', () => {
		const key = new CustomCacheKey();
		assert.equal(key.excludeAllQueryParametersExcept('page', 'sort'), key);
		assert.deepEqual(key.include_query_params, ['page', 'sort']);
		key.excludeAllQueryParametersExcept('q');
		assert.deepEqual(key.include_query_params, ['q']);
		key.excludeAllQueryParametersExcept();
		assert.deepEqual(key.include_query_params, []);
	});

	it('accumulates cookies and chains', () => {
		const key = new CustomCacheKey();
		assert.equal(key.include_cookies, undefined);
		assert.equal(key.addCookie('session').addCookie('ab_test'), key);
		assert.deepEqual(key.include_cookies, ['session', 'ab_test']);
	});
});
