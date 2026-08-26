const { Readable } = require('node:stream');
const { createBrotliCompress, brotliDecompress, constants } = require('zlib');
const crypto = require('crypto');
/**
 * Setup the caching middleware
 */
exports.start = function (options = {}) {
	const servers = options.server.http(exports.getCacheHandler(options));
};
const KEY_OVERFLOW = 1000;
// make the cache clearing be gradual so we don't cause a cache stampede
const DEFAULT_CLEAR_REST_INTERVAL_COUNT = 50;
const DEFAULT_CLEAR_REST_INTERVAL_MS = 10;

const DEFAULT_CACHE_DB_NAME = 'cache';

const cachesWithSWR = new Map();

const newBlob = async (content, cacheTable) => {
	const blob = await createBlob(content);
	await blob.save(cacheTable);
	return blob;
};

const ensureDatabases = async (groups = []) => {
	logger.info(`Using additional cache database groups: ${groups.join(', ')}`);
	for (const cacheGroupDb of groups) {
		if (!databases[cacheGroupDb]?.HttpCache) {
			logger.warn(`Cache table in ${cacheGroupDb} db doesn't exsist. Creating...`);
			await server.operation({
				operation: 'create_table',
				database: cacheGroupDb,
				table: 'HttpCache',
				primary_key: 'id',
				expiration: 86400,
				attributes: [
					{
						name: 'id',
					},
					{
						name: 'expiresSWRAt',
						type: 'Float',
					},
					{
						name: 'headers',
						type: 'Any',
					},
					{
						name: 'content',
						type: 'Bytes',
					},
				],
			});
		}
	}
};

/**
 * This is the handler that is used to cache the response. It is defined and exported so other middleware can directly
 * use it and set a cacheKey or bypass the cache
 */
exports.getCacheHandler = function (options) {
	setCacheSource([DEFAULT_CACHE_DB_NAME]);
	ensureDatabases(options?.additionalCacheDatabaseGroups).then(() => {
		setCacheSource(options?.additionalCacheDatabaseGroups ?? []);
	});

	return async (request, nextHandler) => {
		if (request.pathname === '/invalidate') {
			if (!request.user?.role.permission.super_user) {
				let error = new Error('Unauthorized');
				error.statusCode = 401;
				throw error;
			}

			const validTables = [DEFAULT_CACHE_DB_NAME, ...(options?.additionalCacheDatabaseGroups ?? [])];
			const cacheGroup = request.headers?.get('x-cache-group') ?? DEFAULT_CACHE_DB_NAME;

			if (!validTables.includes(cacheGroup)) {
				let error = new Error(
					`Invalid cache group sepcified: ${cacheGroup}. Must be one of: ${validTables.join(', ')}`
				);
				error.statusCode = 400;
				throw error;
			}

			const cacheTable = databases[cacheGroup].HttpCache;

			// invalidate the cache
			let last;
			let count = 0;
			let query_start = request.url.indexOf('?');
			let query = query_start > -1 ? { url: request.url.slice(query_start) } : [];
			if (request.method === 'POST') {
				const clearRestIntervalCount = options.clearRestIntervalCount ?? DEFAULT_CLEAR_REST_INTERVAL_COUNT;
				const clearRestIntervalMs = options.clearRestIntervalMs ?? DEFAULT_CLEAR_REST_INTERVAL_MS;
				// do this before entering the async function in case it throws
				const searchResults = cacheTable.search(query, { onlyIfCached: true, noCacheStore: true });
				let finished, lastKey;
				(async () => {
					for await (let entry of searchResults) {
						lastKey = entry.id;
						last = cacheTable.delete(entry.id); // no context/transaction, should be non-transactional/incremental
						if (count++ % clearRestIntervalCount === 0) {
							await last;
							if (clearRestIntervalMs) await new Promise((resolve) => setTimeout(resolve, clearRestIntervalMs));
						}
					}
					finished = true;
				})();
				return {
					status: 200,
					headers: {},
					body: (async function* () {
						yield 'Invalidating cache...\n';
						while (!finished) {
							yield `Invalidated ${count} entries, last deleted ${lastKey}\n`;
							await new Promise((resolve) => setTimeout(resolve, 1000));
						}
						yield `Cache invalidation complete, deleted ${count} entries\n`;
					})(),
				};
			} else if (request.method === 'GET') {
				let keyStart = new URLSearchParams(query.url).get('key');
				let searchResults = cacheTable.primaryStore.getRange({
					start: keyStart ?? ' ',
					versions: true,
					limit: 10,
					lazy: true,
				});
				searchResults = Array.from(searchResults);
				return {
					status: 200,
					headers: {},
					body: searchResults
						.map(
							(entry) =>
								`id: ${entry.key}\nexists: ${!!entry.value} updated: ${new Date(entry.version).toUTCString()}, expiresAt: ${new Date(entry.expiresAt).toUTCString()}`
						)
						.join('\n'),
				};
			}
		}
		// check if the request is cacheable
		if (request.method === 'GET') {
			const cacheTable = databases[request.cacheGroup]?.HttpCache ?? databases.cache.HttpCache;

			// assign the nextHandler so it can be used within the cache resolver
			request.cacheNextHandler = nextHandler;
			let startTime = performance.now();
			request.startTime = startTime;
			// if there is a scheduled full cache clear, set it as the next expiration
			if (options.scheduledFullCacheClearTime) {
				// for 5:45am EST it would 10.75
				let now = new Date();
				// determine the scheduled time for the full cache clear, set it as the expiration if it is sooner
				let scheduled = new Date();
				scheduled.setUTCHours(options.scheduledFullCacheClearTime);
				scheduled.setUTCMinutes((options.scheduledFullCacheClearTime % 1) * 60);
				if (scheduled < now) scheduled.setDate(scheduled.getDate() + 1);
				request.maxAgeSeconds = Math.min(
					(scheduled.getTime() - now.getTime()) / 1000,
					request.maxAgeSeconds ?? Infinity
				);
			}
			let cacheKey = request.cacheKey ?? request.url;
			if (cacheKey.length > KEY_OVERFLOW) {
				// Harper's max key size is 1936 bytes, so we need to hash the key if it is too long
				cacheKey = cacheKey.slice(0, KEY_OVERFLOW) + ':' + crypto.createHash('md5').update(cacheKey).digest('hex');
			}
			// use our cache table, using the cacheKey if provided, otherwise use the URL/path
			const cacheWithSWR = cachesWithSWR.get(request.cacheGroup ?? DEFAULT_CACHE_DB_NAME);
			let response = await cacheWithSWR.get(cacheKey, request);
			// if it is a cache miss, we let the handler actually directly write to the node response object
			// and stream the results to the client, so we don't need to return anything here
			if (!request._nodeResponse.writableEnded) {
				// but if we have a cache hit, we can return the cached response
				let ifNoneMatch = request.headers.get('If-None-Match');
				let headers = response.headers.toJSON();
				const etag = headers.etag;
				let status = response.status ?? 200;
				let body;
				let age = Math.round((Date.now() - response.getUpdatedTime()) / 1000);
				headers = { ...headers, 'X-HarperDB-Cache': 'HIT', 'Age': age };
				delete headers['x-harperdb-cache'];
				delete headers['content-length'];
				if (ifNoneMatch && ifNoneMatch === etag) {
					status = 304;
				} else {
					body = response.content;
					if (body.bytes) {
						try {
							// attempt to convert it from a blob to a buffer
							body = await body.bytes();
						} catch (_e) {
							try {
								await cacheTable.delete(cacheKey); // if we can't read the blob, delete it from the cache
							} finally {
								return nextHandler(request);
							}
						}
					}
					if (headers['content-encoding'] === 'br' && !request.headers.get('Accept-Encoding').includes('br')) {
						// if the client doesn't support brotli, we need to decompress the response
						body = await new Promise((resolve) =>
							brotliDecompress(body, (err, result) => {
								if (err) reject(err);
								else resolve(result);
							})
						);
						delete headers['content-encoding'];
					}
					headers['Content-Length'] = body.length;
				}
				// for now, everything is being handled by the next.js server that writes to the node response object,
				// so can just assume that and not try to branch (and have to worry about testing the other branch)
				//if (request._nodeResponse.wroteHeaders) {
				request._nodeResponse.writeHead(status, headers);
				request._nodeResponse.end(body);
				let pathStart = request.pathname.match(/^.\w*/)?.[0] ?? request.pathname;
				server.recordAnalytics(performance.now() - startTime, 'http-cache-hit', pathStart);
				/*} else {
					return {
						status,
						headers,
						body,
					};
				}*/
			}
		} else {
			// else we just let the handler write to the node response object
			return nextHandler(request);
		}
	};
};

/**
 * Source the Next.js cache from request resolution using the passed in Next.js request handler,
 * and intercepting the response to cache it.
 */

const setCacheSource = (cacheDbNames) => {
	cacheDbNames.forEach((dbName) => {
		const cacheDB = databases[dbName];

		logger.info(`Establishing cache source for database: ${dbName}`);

		cacheDB.HttpCache.sourcedFrom({
			async get(path, context) {
				const request = context.requestContext;
				if (request.maxAgeSeconds) context.expiresAt = request.maxAgeSeconds * 1000 + Date.now();
				let expiresSWRAt;
				if (request.staleWhileRevalidateSeconds) {
					// this is the time at which the response can be served stale while revalidating, after the main expiresAt time
					expiresSWRAt = request.staleWhileRevalidateSeconds * 1000 + (context.expiresAt ?? Date.now());
				}
				return new Promise((resolve, reject) => {
					const nodeResponse = request._nodeResponse;
					if (!nodeResponse) return;
					// intercept the main methods to get and cache the response if the node response is directly used
					const writeHead = nodeResponse.writeHead;
					let encoder;
					nodeResponse.writeHead = (status, messageOrHeaders, headers) => {
						nodeResponse.setHeader('X-HarperDB-Cache', 'MISS');
						let headersObject = headers ?? messageOrHeaders;
						getEncoder(headers?.['content-encoding']); // ensure the encoder is created, and Content-Encoding is set as
						// needed
						if (Array.isArray(messageOrHeaders?.[0])) {
							messageOrHeaders = messageOrHeaders.reduce((acc, [key, value]) => {
								acc[key] = value;
								return acc;
							}, {});
						}
						writeHead.call(nodeResponse, status, messageOrHeaders, headers);
					};
					let acceptEncoding = request.headers.get('Accept-Encoding');
					let acceptsBrotli = false;
					if (acceptEncoding) {
						// we can only cache brotli responses, so we need to ensure that we are only accepting brotli (or nothing)
						if (acceptEncoding.includes('br')) {
							request.headers.set('Accept-Encoding', 'br');
							acceptsBrotli = true;
						} else request.headers.delete('Accept-Encoding');
					}
					function getEncoder() {
						if (encoder) return encoder;
						let encoding = nodeResponse.getHeader('Content-Encoding');
						let contentType = nodeResponse.getHeader('Content-Type') ?? '';
						const alreadyEncoded = encoding === 'br';
						if (acceptsBrotli && !alreadyEncoded) {
							// if the client accepts brotli, and it wasn't returned to us in Brotli, we can provide the compression here
							nodeResponse.setHeader('Content-Encoding', 'br');
							nodeResponse.removeHeader('Content-Length');
							encoder = createBrotliCompress({
								params: {
									[constants.BROTLI_PARAM_MODE]:
										contentType.includes('json') || contentType.includes('text')
											? constants.BROTLI_MODE_TEXT
											: constants.BROTLI_MODE_GENERIC,
									[constants.BROTLI_PARAM_QUALITY]: 2, // go fast
								},
							});
							encoder.on('data', writeOut);
							encoder.on('end', endOut);
						} else {
							encoder = {
								// default direct encoder
								write: writeOut,
								end: endOut,
							};
						}
						return encoder;
					}
					const blocks = []; // collect the blocks of response data to cache
					const writeResponse = nodeResponse.write;
					const endResponse = nodeResponse.end;
					function writeOut(block) {
						if (typeof block === 'string') block = Buffer.from(block);
						blocks.push(block);
						writeResponse.call(nodeResponse, block);
					}
					async function endOut(block) {
						if (block) {
							if (typeof block === 'string') block = Buffer.from(block);
							blocks.push(block);
						}
						endResponse.call(nodeResponse, block);
						const headers = Object.assign({}, nodeResponse.getHeaders());
						delete headers['x-harperdb-cache'];
						delete headers.connection;
						let etag = headers.etag;
						if (!etag) headers.etag = Date.now().toString(32);
						// cache the response, with the headers and content
						const content = blocks.length > 1 ? Buffer.concat(blocks) : blocks[0];
						resolve({
							id: path,
							expiresSWRAt,
							headers,
							content: typeof createBlob === 'function' ? await newBlob(content, cacheDB.HttpCache) : content,
						});
						let pathStart = request.pathname.match(/^.\w*/)?.[0] ?? request.pathname;
						server.recordAnalytics(performance.now() - request.startTime, 'http-cache-miss', pathStart);
					}
					nodeResponse.write = (block) => {
						getEncoder().write(block);
					};
					nodeResponse.end = (block) => {
						// if the downstream handler is directly writing to the node response object, we need to capture and cache the
						// response
						if (nodeResponse.statusCode !== 200) {
							context.noCacheStore = true;
						}
						if (block instanceof ReadableStream) {
							const piped = Readable.fromWeb(block).pipe(encoder);
							piped.on('finish', () => {
								resolve({
									id: path,
									headers: nodeResponse.getHeaders(),
									//content: blocks.length > 1 ? Buffer.concat(blocks) : blocks[0],
								});
							});
							return;
						}
						getEncoder().end(block);
					};
					if (!request.cacheNextHandler) {
						return resolve();
					}
					let response = request.cacheNextHandler(request);
					if (response?.then) {
						response.then(forResponse);
					} else forResponse(response);
					async function forResponse(response) {
						if (!response) return;
						if (response.status !== 200) context.noCacheStore = true;
						let headersObject = {};
						for (let [key, value] of response.headers) {
							headersObject[key] = value;
						}
						let cacheControl = response.headers.get('cache-control');
						exports.parseHeaderValue(cacheControl).forEach((part) => {
							if (part.name === 'no-store') context.noCacheStore = true;
							if (part.name === 'no-cache') context.noCache = true;
							if (part.name === 'max-age') context.expiresAt = part.value * 1000 + Date.now();
						});
						let etag = response.headers.get('ETag') || response.headers.get('Last-Modified');
						if (!etag) headersObject.ETag = Date.now().toString(32);
						// TODO: handle streaming responses
						let content = response.body;
						resolve({
							id: path,
							expiresSWRAt,
							headers: headersObject,
							content: typeof createBlob === 'function' ? await newBlob(content, cacheDB.HttpCache) : content, // utilize blobs if they are available
						});
					}
				});
			},
			name: `${dbName} DB http cache resolver`,
		});

		class HttpCacheWithSWR extends cacheDB.HttpCache {
			// use directly URL paths for ids
			static parsePath(path) {
				return decodeURIComponent(path);
			}
			allowStaleWhileRevalidate(entry, id) {
				return entry.value?.expiresSWRAt > Date.now();
			}
		}

		cachesWithSWR.set(dbName, HttpCacheWithSWR);
	});
};

/**
 * This parser is used to parse header values.
 *
 * It is used within this file for parsing the `Cache-Control` header.
 *
 * @param value
 */
exports.parseHeaderValue = function (value) {
	return value
		.trim()
		.split(',')
		.map((part) => {
			let parsed;
			const components = part.trim().split(';');
			let component;
			while ((component = components.pop())) {
				if (component.includes('=')) {
					let [name, value] = component.trim().split('=');
					name = name.trim();
					if (value) value = value.trim();
					parsed = {
						name: name.toLowerCase(),
						value,
						next: parsed,
					};
				} else {
					parsed = {
						name: component.toLowerCase(),
						next: parsed,
					};
				}
			}
			return parsed;
		});
};

if (process.env.HTTP_CACHE_LOAD_TEST) {
	const { loadTest } = require('./test/loadTest');
	loadTest();
}
