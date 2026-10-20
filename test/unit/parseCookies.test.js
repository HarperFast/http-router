const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { loadParseCookies, parseCookiesPath } = require('./helpers/routerHarness.js');

const parseCookies = loadParseCookies();

describe('parseCookies', () => {
	it(
		'is exported from utils/parseCookies.js',
		{ todo: 'the module never assigns module.exports (utils/parseCookies.js:32)' },
		() => {
			delete require.cache[parseCookiesPath];
			assert.equal(typeof require(parseCookiesPath).parseCookies, 'function');
		}
	);

	it('returns an empty object for a missing or empty header', () => {
		assert.deepEqual(parseCookies(undefined), {});
		assert.deepEqual(parseCookies(''), {});
	});

	it('parses name=value pairs and trims whitespace', () => {
		assert.deepEqual(parseCookies(' session = abc ;theme=dark'), { session: 'abc', theme: 'dark' });
	});

	it('keeps every = after the first in the value', () => {
		assert.deepEqual(parseCookies('token=a=b==; empty='), { token: 'a=b==', empty: '' });
	});

	it('skips empty segments, segments without =, and empty names', () => {
		assert.deepEqual(parseCookies(';; flag; =orphan; kept=1;'), { kept: '1' });
	});

	it('keeps the last value of a repeated name', () => {
		assert.deepEqual(parseCookies('id=1; id=2'), { id: '2' });
	});
});
