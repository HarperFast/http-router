const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { createRequest, loadRouterModule, nextHandler } = require('./helpers/routerHarness.js');

const ROUTES_MANIFEST = '.next/routes-manifest.json';
const PAGES_MANIFEST = '.next/serverless/pages-manifest.json';
const APP_PATHS_MANIFEST = '.next/server/app-paths-routes-manifest.json';

let originalDirectory;
let applicationDirectory;

beforeEach(() => {
	originalDirectory = process.cwd();
	applicationDirectory = mkdtempSync(path.join(tmpdir(), 'http-router-manifest-'));
});

afterEach(() => {
	process.chdir(originalDirectory);
	rmSync(applicationDirectory, { recursive: true, force: true });
});

function writeManifest(relativePath, contents) {
	const manifestPath = path.join(applicationDirectory, relativePath);
	mkdirSync(path.dirname(manifestPath), { recursive: true });
	writeFileSync(manifestPath, typeof contents === 'string' ? contents : JSON.stringify(contents));
}

function loadRouterFromApplication() {
	process.chdir(applicationDirectory);
	return loadRouterModule().Router;
}

async function servedByNext(Router, pathname) {
	const router = new Router().always({ headers: { set_response_headers: { 'x-next-page': pathname } } }).use();
	const request = createRequest({ url: pathname });
	assert.equal(await router.onRequest(request, nextHandler), nextHandler);
	return request._nodeResponse.headersSet['x-next-page'] === pathname;
}

describe('Next.js manifests', () => {
	it('defers to Next.js for dynamic and static routes from the routes manifest', async (t) => {
		const consoleError = t.mock.method(console, 'error', () => {});
		writeManifest(ROUTES_MANIFEST, {
			dynamicRoutes: [{ page: '/blog/[slug]', regex: '^/blog/([^/]+?)(?:/)?$' }],
			staticRoutes: [{ page: '/about', regex: '^/about(?:/)?$' }],
		});
		const Router = loadRouterFromApplication();
		assert.equal(await servedByNext(Router, '/blog/hello'), true);
		assert.equal(await servedByNext(Router, '/about'), true);
		assert.equal(await servedByNext(Router, '/missing'), false);
		assert.equal(consoleError.mock.callCount(), 0);
	});

	it('accepts a routes manifest without route lists', async () => {
		writeManifest(ROUTES_MANIFEST, {});
		const Router = loadRouterFromApplication();
		assert.equal(await servedByNext(Router, '/about'), false);
	});

	it('adds pages and app paths without replacing routes-manifest entries', async () => {
		writeManifest(ROUTES_MANIFEST, { dynamicRoutes: [{ page: '/posts/[id]', regex: '^/posts/(\\d+)$' }] });
		writeManifest(PAGES_MANIFEST, { '/posts/[id]': 'pages/posts/[id].js', '/terms': 'pages/terms.js' });
		writeManifest(APP_PATHS_MANIFEST, { '/dashboard': 'app/dashboard/page.js' });
		const Router = loadRouterFromApplication();
		assert.equal(await servedByNext(Router, '/posts/12'), true);
		assert.equal(await servedByNext(Router, '/posts/i'), false);
		assert.equal(await servedByNext(Router, '/terms'), true);
		assert.equal(await servedByNext(Router, '/dashboard'), true);
	});

	it('logs a malformed routes manifest and still reads the pages manifest', async (t) => {
		const consoleError = t.mock.method(console, 'error', () => {});
		writeManifest(ROUTES_MANIFEST, '{ not json');
		writeManifest(PAGES_MANIFEST, { '/contact': 'pages/contact.js' });
		const Router = loadRouterFromApplication();
		assert.equal(consoleError.mock.callCount(), 1);
		const [message, error] = consoleError.mock.calls[0].arguments;
		assert.equal(message, 'Could not read routes manifest');
		assert.ok(error instanceof SyntaxError);
		assert.equal(await servedByNext(Router, '/contact'), true);
	});

	it('logs a malformed pages manifest and still reads the app paths manifest', async (t) => {
		const consoleError = t.mock.method(console, 'error', () => {});
		writeManifest(PAGES_MANIFEST, 'not json');
		writeManifest(APP_PATHS_MANIFEST, { '/settings': 'app/settings/page.js' });
		const Router = loadRouterFromApplication();
		assert.equal(consoleError.mock.callCount(), 1);
		const [message, error] = consoleError.mock.calls[0].arguments;
		assert.equal(message, `Could not read ${PAGES_MANIFEST} manifest`);
		assert.ok(error instanceof SyntaxError);
		assert.equal(await servedByNext(Router, '/settings'), true);
	});

	it('loads with no manifests present', async (t) => {
		const consoleError = t.mock.method(console, 'error', () => {});
		const Router = loadRouterFromApplication();
		assert.equal(await servedByNext(Router, '/'), false);
		assert.equal(consoleError.mock.callCount(), 0);
	});
});
