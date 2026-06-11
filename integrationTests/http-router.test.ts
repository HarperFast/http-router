/**
 * Integration tests for the @harperdb/http-router extension component.
 *
 * Verifies the Router API under Harper v5:
 *   - The component starts and Harper initialises correctly.
 *   - Permanent and temporary redirect rules return the correct status codes and
 *     Location headers.
 *   - Response headers set in route rules are included in redirect responses (the
 *     router merges responseHeaders into { ...responseHeaders, Location } on the
 *     redirect branch — the only code path that applies them directly).
 *   - The fallback (.use()) pass-through routes unknown paths to the next handler
 *     without crashing Harper.
 *
 * Note on scope: tests run the http-router extension in isolation (no downstream
 * response-generating component). Routes that only set cache parameters and pass
 * through to nextHandler are not exercised here because the cache middleware
 * requires an actual upstream response to process. Those paths work correctly in
 * production where a content component (e.g. @harperdb/nextjs) provides responses.
 *
 * Note on local runs: macOS loopback aliases 127.0.0.2+ are not configured, so
 * local runs will fail with EADDRNOTAVAIL. CI on ubuntu-latest is the gate.
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

// Fixture is a self-contained Harper app in integrationTests/fixture/.
// It has config.yaml listing @harperdb/http-router as a component (with files: '*.js'),
// a routes.js that exercises the Router API, and pre-installed node_modules
// (committed so CI can use npm ci without a separate install step).
const FIXTURE_PATH = resolve(__dirname, 'fixture');

suite('http-router: startup', (ctx: ContextWithHarper) => {
	before(async () => {
		await setupHarperWithFixture(ctx, FIXTURE_PATH, { harperBinPath });
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('Harper starts and the router component loads', async () => {
		const { httpURL } = ctx.harper;
		const res = await fetch(`${httpURL}/`);
		await res.arrayBuffer();
		ok(res.status < 500, `Harper should serve requests, got status ${res.status}`);
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
		ok(
			location === '/new-path' || location?.endsWith('/new-path'),
			`expected Location: /new-path, got ${location}`
		);
	});

	test('GET /temp-redirect returns 302 with Location: /destination', async () => {
		const { httpURL } = ctx.harper;
		const res = await fetch(`${httpURL}/temp-redirect`, { redirect: 'manual' });
		await res.arrayBuffer();
		strictEqual(res.status, 302, `expected 302 Found, got ${res.status}`);
		const location = res.headers.get('location');
		ok(
			location === '/destination' || location?.endsWith('/destination'),
			`expected Location: /destination, got ${location}`
		);
	});

	test('GET /redirect-with-header includes X-Custom-Header in the redirect response', async () => {
		const { httpURL } = ctx.harper;
		// The router merges responseHeaders into redirect responses:
		// return () => ({ status, headers: { ...responseHeaders, Location } })
		const res = await fetch(`${httpURL}/redirect-with-header`, { redirect: 'manual' });
		await res.arrayBuffer();
		strictEqual(res.status, 302, `expected 302 redirect, got ${res.status}`);
		const customHeader = res.headers.get('x-custom-header');
		ok(
			customHeader === 'test-value',
			`expected X-Custom-Header: test-value on redirect response, got ${customHeader ?? '(absent)'}`
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

	test('GET /unmatched-route falls through without a server error', async () => {
		const { httpURL } = ctx.harper;
		const res = await fetch(`${httpURL}/unmatched-route-xyz`);
		await res.arrayBuffer();
		// The router's .use() passes unmatched requests to the next handler.
		// Harper handles it (typically 404) without crashing.
		ok(res.status < 500, `unmatched route should not cause a server error, got ${res.status}`);
	});
});
