import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

if (!process.env.E2E_HTTP_PORT) throw new Error('Run the e2e suite through e2e/run.sh, which sets E2E_HTTP_PORT');
// a production install serves HTTPS on 9926 with a self-signed certificate; run.sh disables verification for this process
const baseURL = `https://127.0.0.1:${process.env.E2E_HTTP_PORT}`;
const composeFile = fileURLToPath(new URL('./docker-compose.yml', import.meta.url));
const compose = (...args) =>
	execFileSync('docker', ['compose', '-p', process.env.E2E_PROJECT ?? 'http-router-e2e', '-f', composeFile, ...args], {
		encoding: 'utf8',
	});
const adminAuth = `Basic ${Buffer.from('admin:e2e-password').toString('base64')}`;

async function request(path, options = {}) {
	const response = await fetch(`${baseURL}${path}`, { redirect: 'manual', ...options });
	const body = await response.text();
	return { status: response.status, headers: response.headers, body };
}

function cacheStatus(response) {
	return [response.headers.get('x-harper-cache'), response.headers.get('x-harperdb-cache')];
}

async function eventually(check, attempts = 40) {
	let lastError;
	for (let attempt = 0; attempt < attempts; attempt++) {
		try {
			return await check();
		} catch (error) {
			lastError = error;
			await delay(250);
		}
	}
	throw lastError;
}

describe('Harper 5 loads the router through the Plugin API', () => {
	it('logs no deprecated extension API warning for the router', () => {
		const logs = compose('logs', 'harper');
		assert.doesNotMatch(logs, /@harperdb\/http-router is using deprecated extension API/);
	});
});

describe('redirects and headers', () => {
	it('returns a permanent redirect', async () => {
		const response = await request('/old-path');
		assert.equal(response.status, 301);
		assert.equal(response.headers.get('location'), '/new-path');
	});

	it('adds response headers to a redirect', async () => {
		const response = await request('/redirect-with-header');
		assert.equal(response.status, 302);
		assert.equal(response.headers.get('x-custom-header'), 'e2e');
	});

	it('passes unmatched requests to the next handler', async () => {
		const response = await request('/no-such-route');
		assert.equal(response.status, 404);
	});
});

describe('method and query matching', () => {
	it('serves HEAD from a GET route', async () => {
		const response = await request('/old-path', { method: 'HEAD' });
		assert.equal(response.status, 301);
	});

	it('does not apply a GET route to POST', async () => {
		const response = await request('/old-path', { method: 'POST' });
		assert.notEqual(response.status, 301);
	});

	it('routes POST to a POST route', async () => {
		const response = await request('/submit', { method: 'POST', body: 'x' });
		assert.equal(response.status, 303);
		assert.equal(response.headers.get('location'), '/submitted');
	});

	it('matches a query condition on the first query parameter', async () => {
		assert.equal((await request('/query-check?mode=fast')).status, 302);
		assert.equal((await request('/query-check?mode=slow')).status, 404);
	});
});

describe('caching through http-cache', () => {
	it('serves a MISS and then a HIT, with both cache status headers', async () => {
		const path = `/content/${Date.now()}`;
		const miss = await request(path);
		assert.equal(miss.status, 200);
		assert.deepEqual(cacheStatus(miss), ['MISS', 'MISS']);
		const hit = await eventually(async () => {
			const response = await request(path);
			assert.deepEqual(cacheStatus(response), ['HIT', 'HIT']);
			return response;
		});
		assert.equal(hit.body, miss.body);
	});

	it('keys the cache by cookie', async () => {
		const path = `/variant/${Date.now()}`;
		const first = await request(path, { headers: { cookie: 'variant=a' } });
		assert.equal(first.status, 200);
		assert.deepEqual(cacheStatus(first), ['MISS', 'MISS']);
		await eventually(async () => {
			assert.deepEqual(cacheStatus(await request(path, { headers: { cookie: 'variant=a' } })), ['HIT', 'HIT']);
		});
		const other = await request(path, { headers: { cookie: 'variant=b' } });
		assert.deepEqual(cacheStatus(other), ['MISS', 'MISS']);
		assert.match(other.body, /variant=b/);
	});

	it('rejects unauthenticated invalidation, and evicts entries for a super user', async () => {
		const path = `/content/invalidate-${Date.now()}`;
		await request(path);
		await eventually(async () => assert.deepEqual(cacheStatus(await request(path)), ['HIT', 'HIT']));
		assert.equal((await request('/invalidate', { method: 'POST' })).status, 401);
		const invalidation = await request('/invalidate', { method: 'POST', headers: { authorization: adminAuth } });
		assert.equal(invalidation.status, 200);
		assert.match(invalidation.body, /Cache invalidation complete/);
		assert.deepEqual(cacheStatus(await request(path)), ['MISS', 'MISS']);
	});
});

describe('static files', () => {
	it('serves a file from the application directory', async () => {
		const response = await request('/static/hello.txt');
		assert.equal(response.status, 200);
		assert.equal(response.body, 'hello from the e2e app\n');
	});
});

describe('proxying to a live HTTPS origin', () => {
	it('rewrites the path, keeps the query, and applies request and response header rules', async () => {
		const response = await request('/api/items/7?x=1');
		assert.equal(response.status, 200);
		const echoed = JSON.parse(response.body);
		assert.equal(echoed.url, '/echo/items/7?x=1');
		assert.equal(echoed.headers.host, 'api.internal');
		assert.equal(echoed.headers['x-from-router'], 'yes');
		assert.match(response.headers.get('x-origin-server'), /^proxied-echo-\d+$/);
	});

	it('caches a proxied response with the configured TTL in seconds', async () => {
		const miss = await request('/ttl');
		assert.equal(miss.status, 200);
		assert.equal(JSON.parse(miss.body).url, '/ttl');
		assert.match(miss.headers.get('cache-control'), /\bs-maxage=3600\b/);
		const hit = await eventually(async () => {
			const response = await request('/ttl');
			assert.deepEqual(cacheStatus(response), ['HIT', 'HIT']);
			return response;
		});
		assert.equal(hit.headers.get('x-origin-server'), miss.headers.get('x-origin-server'));
	});
});

describe('live reload', () => {
	it('picks up an edited routes file without a restart', async () => {
		assert.equal((await request('/routes-version')).headers.get('location'), '/routes-v1');
		compose('exec', '-T', 'harper', 'sed', '-i', 's#/routes-v1#/routes-v2#', '/home/harperdb/app/routes.js');
		await eventually(async () => {
			for (let attempt = 0; attempt < 8; attempt++) {
				assert.equal((await request('/routes-version')).headers.get('location'), '/routes-v2');
			}
		}, 80);
	});
});
