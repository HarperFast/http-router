/**
 * Integration tests for the @harperdb/http-router plugin.
 *
 * The test apps (fixture/ and second-app/) depend on this repository through `file:../..` with
 * `install-links=true`, so `npm run pretest:integration` installs the branch as npm would publish it. Select the Harper
 * version with HTTP_ROUTER_TEST_HARPER (5, 4.7 or 4.6; default 5).
 *
 * Proxying is not covered: the router sends proxied requests to port 443 of the origin's
 * hostname, which a test cannot bind without elevated privileges.
 */
import { suite, test, before, after } from 'node:test';
import { strictEqual, ok } from 'node:assert/strict';
import {
	setupHarperWithFixture,
	startHarper,
	teardownHarper,
	type ContextWithHarper,
	type HarperContext,
} from '@harperfast/integration-testing';
import { createRequire } from 'node:module';
import { request as httpRequest } from 'node:http';
import { basename, dirname, join, resolve } from 'node:path';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const FIXTURE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'fixture');
const SECOND_APP_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'second-app');

const HARPER_PACKAGES: Record<string, string> = { '5': 'harper', '4.7': 'harperdb-4.7', '4.6': 'harperdb-4.6' };
const harperVersion = process.env.HTTP_ROUTER_TEST_HARPER || '5';
const harperPackage = HARPER_PACKAGES[harperVersion];
ok(harperPackage, `HTTP_ROUTER_TEST_HARPER must be one of ${Object.keys(HARPER_PACKAGES).join(', ')}`);
const isHarper5 = harperPackage === 'harper';
// Neither package exports its CLI, so resolve it from the package's main entry.
const harperBinPath = resolve(dirname(require.resolve(harperPackage)), isHarper5 ? 'bin/harper.js' : 'bin/harperdb.js');
// Harper 4 prompts for the terms and conditions on install unless they are accepted up front.
const harperEnv = { TC_AGREEMENT: 'yes' };

function getWithHost(url: string, host: string): Promise<{ status: number; location: string | undefined }> {
	return new Promise((resolvePromise, reject) => {
		httpRequest(url, { headers: { Host: host } }, (response) => {
			response.resume();
			response.on('end', () =>
				resolvePromise({ status: response.statusCode ?? 0, location: response.headers.location })
			);
		})
			.on('error', reject)
			.end();
	});
}

async function getRedirectLocation(url: string): Promise<string | null> {
	const response = await fetch(url, { redirect: 'manual' });
	await response.arrayBuffer();
	return response.headers.get('location');
}

function routingTests(ctx: ContextWithHarper) {
	test('GET /old-path returns 301 with Location: /new-path', async () => {
		const response = await fetch(`${ctx.harper.httpURL}/old-path`, { redirect: 'manual' });
		await response.arrayBuffer();
		strictEqual(response.status, 301);
		strictEqual(response.headers.get('location'), '/new-path');
	});

	test('GET /temp-redirect returns 302 with Location: /destination', async () => {
		const response = await fetch(`${ctx.harper.httpURL}/temp-redirect`, { redirect: 'manual' });
		await response.arrayBuffer();
		strictEqual(response.status, 302);
		strictEqual(response.headers.get('location'), '/destination');
	});

	test('GET /redirect-with-header includes X-Custom-Header in the redirect response', async () => {
		const response = await fetch(`${ctx.harper.httpURL}/redirect-with-header`, { redirect: 'manual' });
		await response.arrayBuffer();
		strictEqual(response.status, 302);
		strictEqual(response.headers.get('x-custom-header'), 'test-value');
	});

	test('GET /unmatched-route falls through without a server error', async () => {
		const response = await fetch(`${ctx.harper.httpURL}/unmatched-route-xyz`);
		await response.arrayBuffer();
		ok(response.status < 500, `unmatched route should not cause a server error, got ${response.status}`);
	});

	test('origins from edgio.config.js are visible to Router.destination() in routes.js', async () => {
		const matched = await getWithHost(`${ctx.harper.httpURL}/destination-check`, 'api.example.test');
		strictEqual(matched.status, 302);
		strictEqual(matched.location, '/destination-ok');
		const unmatched = await getWithHost(`${ctx.harper.httpURL}/destination-check`, 'other.example.test');
		ok(
			unmatched.status !== 302,
			`a request for another host should not match the destination, got ${unmatched.status}`
		);
	});

	test('serveStatic serves files relative to the application directory', async () => {
		const response = await fetch(`${ctx.harper.httpURL}/static/hello.txt`);
		strictEqual(response.status, 200);
		strictEqual(await response.text(), 'static file served by the router\n');
	});

	test('a cached route is a MISS and then a HIT', async () => {
		const url = `${ctx.harper.httpURL}/content/${Date.now()}`;
		const miss = await fetch(url);
		const missBody = await miss.text();
		strictEqual(miss.status, 200);
		strictEqual(miss.headers.get('x-harperdb-cache'), 'MISS');
		strictEqual(miss.headers.get('x-harper-cache'), 'MISS');

		const hit = await fetch(url);
		strictEqual(hit.status, 200);
		strictEqual(await hit.text(), missBody);
		strictEqual(hit.headers.get('x-harperdb-cache'), 'HIT');
		strictEqual(hit.headers.get('x-harper-cache'), 'HIT');
		strictEqual(hit.headers.get('x-origin-hits'), miss.headers.get('x-origin-hits'));
	});
}

function routerSuite(name: string, config?: object) {
	const ctx = { name } as ContextWithHarper;
	suite(name, () => {
		before(async () => {
			await setupHarperWithFixture(ctx, FIXTURE_PATH, { harperBinPath, env: harperEnv, config });
		});

		after(async () => {
			await teardownHarper(ctx);
		});

		routingTests(ctx);

		test('a changed routes.js replaces the active routes', async () => {
			strictEqual(await getRedirectLocation(`${ctx.harper.httpURL}/routes-version`), '/routes-v1');
			const routesPath = join(ctx.harper.dataRootDir, 'components', 'fixture', 'routes.js');
			const routes = await readFile(routesPath, 'utf8');
			await writeFile(routesPath, routes.replace("'/routes-v1'", "'/routes-v2'"));

			let location: string | null = null;
			for (let attempt = 0; attempt < 50 && location !== '/routes-v2'; attempt++) {
				await delay(200);
				location = await getRedirectLocation(`${ctx.harper.httpURL}/routes-version`);
			}
			strictEqual(location, '/routes-v2');
			strictEqual(await getRedirectLocation(`${ctx.harper.httpURL}/old-path`), '/new-path');
		});
	});
}

if (isHarper5) {
	for (const allowedDirectory of ['app', 'any']) {
		routerSuite(`http-router on Harper 5 with applications.allowedDirectory: ${allowedDirectory}`, {
			applications: { allowedDirectory },
		});
	}
} else {
	routerSuite(`http-router on Harper ${harperVersion}`);
}

suite(`two applications with their own router copies on Harper ${harperVersion}`, () => {
	const ctx = { name: 'http-router two applications' } as ContextWithHarper;

	before(async () => {
		const dataRootDir = await mkdtemp(
			join(process.env.HARPER_INTEGRATION_TEST_INSTALL_PARENT_DIR || tmpdir(), 'harper-integration-test-')
		);
		for (const application of [FIXTURE_PATH, SECOND_APP_PATH]) {
			await cp(application, join(dataRootDir, 'components', basename(application)), { recursive: true });
		}
		ctx.harper = { dataRootDir } as HarperContext;
		await startHarper(ctx, { harperBinPath, env: harperEnv });
	});

	after(async () => {
		await teardownHarper(ctx);
	});

	test('each application serves static files from its own directory', async () => {
		const first = await fetch(`${ctx.harper.httpURL}/static/hello.txt`);
		strictEqual(first.status, 200);
		strictEqual(await first.text(), 'static file served by the router\n');
		const second = await fetch(`${ctx.harper.httpURL}/second/static/hello.txt`);
		strictEqual(second.status, 200);
		strictEqual(await second.text(), 'static file served by the second app\n');
	});

	test('each application resolves its own origins', async () => {
		const first = await getWithHost(`${ctx.harper.httpURL}/destination-check`, 'api.example.test');
		strictEqual(first.location, '/destination-ok');
		const second = await getWithHost(`${ctx.harper.httpURL}/second/destination-check`, 'api.second.example.test');
		strictEqual(second.location, '/second-destination-ok');
	});
});
