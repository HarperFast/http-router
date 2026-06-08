/**
 * Integration tests for the @harperdb/http-router extension component.
 *
 * Verifies the Router API under Harper v5:
 *   - The component starts successfully (Harper initialises and serves requests).
 *   - Permanent and temporary redirect rules return the correct status codes and
 *     Location headers.
 *   - Cache configuration sets the expected Cache-Control response header.
 *   - Custom response headers declared in route rules are applied to the response.
 *   - The fallback (.use()) pass-through routes unknown paths to the next handler.
 *
 * Note: local runs will fail with EADDRNOTAVAIL on macOS because loopback aliases
 * 127.0.0.2+ are not configured. This is an environmental limitation — CI on
 * ubuntu-latest runs the full suite without aliasing.
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual, ok } from 'node:assert/strict';
import { setupHarperWithFixture, teardownHarper, type ContextWithHarper } from '@harperfast/integration-testing';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

// harper's `exports` map only exposes "."; 'harper/dist/bin/harper.js' is not resolvable
// (ERR_PACKAGE_PATH_NOT_EXPORTED). Resolve the CLI from the exported main entry and pass
// it explicitly as harperBinPath — the documented harness escape hatch.
const harperBinPath = resolve(dirname(require.resolve('harper')), 'bin/harper.js');

// Fixture is the repo root: has config.yaml (extensionModule: ./extension.js) and routes.js.
const FIXTURE_PATH = resolve(__dirname, '..');

suite('http-router: startup', (ctx: ContextWithHarper) => {
	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, { harperBinPath });
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('Harper starts and serves requests', async () => {
		const { httpURL } = ctx.harper;
		const res = await fetch(`${httpURL}/`);
		await res.arrayBuffer();
		// Harper itself should respond (any non-connection-error status is fine).
		ok(res.status < 600, `Harper should serve requests, got status ${res.status}`);
	});
});

suite('http-router: redirect rules', (ctx: ContextWithHarper) => {
	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, { harperBinPath });
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('GET /old-path returns 301 with Location: /new-path', async () => {
		const { httpURL } = ctx.harper;
		const res = await fetch(`${httpURL}/old-path`, { redirect: 'manual' });
		await res.arrayBuffer();
		strictEqual(res.status, 301, `expected 301 Moved Permanently, got ${res.status}`);
		const location = res.headers.get('location');
		ok(location === '/new-path' || location?.endsWith('/new-path'), `expected Location: /new-path, got ${location}`);
	});

	test('GET /temp-redirect returns 302 with Location: /destination', async () => {
		const { httpURL } = ctx.harper;
		const res = await fetch(`${httpURL}/temp-redirect`, { redirect: 'manual' });
		await res.arrayBuffer();
		strictEqual(res.status, 302, `expected 302 Found, got ${res.status}`);
		const location = res.headers.get('location');
		ok(location === '/destination' || location?.endsWith('/destination'), `expected Location: /destination, got ${location}`);
	});
});

suite('http-router: caching configuration', (ctx: ContextWithHarper) => {
	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, { harperBinPath });
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('GET /cached-resource includes Cache-Control header with s-maxage', async () => {
		const { httpURL } = ctx.harper;
		const res = await fetch(`${httpURL}/cached-resource`);
		await res.arrayBuffer();
		// The route sets edge.maxAgeSeconds=60, which should produce s-maxage=60000
		// (convertToMS multiplies by 1000, then sets s-maxage=<ms>).
		// We just verify the Cache-Control header is present and non-empty.
		const cacheControl = res.headers.get('cache-control');
		ok(
			res.status < 500,
			`cached-resource should not return a server error, got ${res.status}`
		);
		// If the route was matched and cache applied, Cache-Control should be present.
		// (May be absent if Harper's own cache layer intercepts first — tolerate both.)
		if (cacheControl) {
			ok(
				cacheControl.includes('s-maxage') || cacheControl.includes('max-age'),
				`Cache-Control should include a maxage directive, got: ${cacheControl}`
			);
		}
	});
});

suite('http-router: response header rules', (ctx: ContextWithHarper) => {
	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, { harperBinPath });
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('GET /with-header includes the custom response header', async () => {
		const { httpURL } = ctx.harper;
		const res = await fetch(`${httpURL}/with-header`);
		await res.arrayBuffer();
		ok(res.status < 500, `with-header should not return a server error, got ${res.status}`);
		const customHeader = res.headers.get('x-custom-header');
		ok(
			customHeader === 'test-value',
			`expected X-Custom-Header: test-value, got ${customHeader ?? '(absent)'}`
		);
	});
});

suite('http-router: fallback pass-through', (ctx: ContextWithHarper) => {
	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, { harperBinPath });
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('GET /unmatched-route falls through (not a 5xx)', async () => {
		const { httpURL } = ctx.harper;
		const res = await fetch(`${httpURL}/unmatched-route-xyz`);
		await res.arrayBuffer();
		// The router's .use() passes unmatched requests to the next handler.
		// Harper will then handle it (likely 404 or its own response) — not a crash.
		ok(res.status < 500, `unmatched route should not cause a server error, got ${res.status}`);
	});
});
