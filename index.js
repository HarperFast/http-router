const { URLSearchParams } = require('node:url');
const entryModule = require('./extension.js');
const { origins } = entryModule;
const { request: httpsRequest } = require('node:https');
const { join } = require('node:path');
const { CustomCacheKey } = require('./CustomCacheKey'); // to re-export
const send = require('send');
const { readFileSync, existsSync } = require('node:fs');
const { Readable } = require('stream');

const manifest = new Map();

// Handle route manifest first since it contains the dynamic routes in Next.js v9
const ROUTE_MANIFEST = '.next/routes-manifest.json';

try {
	if (existsSync(ROUTE_MANIFEST)) {
		const routesManifest = JSON.parse(readFileSync(ROUTE_MANIFEST, 'utf8'));

		for (const route of routesManifest.dynamicRoutes ?? []) {
			manifest.set(route.page, new RegExp(route.regex));
		}

		// Later Next.js versions also have static routes in the route manifest
		for (const route of routesManifest.staticRoutes ?? []) {
			manifest.set(route.page, new RegExp(route.regex));
		}
	}
} catch (error) {
	console.error('Could not read routes manifest', error);
}

// Anything not in the route manifest will be in the pages manifest
const PATHS_TO_PATHS_FILES = ['.next/serverless/pages-manifest.json', '.next/server/app-paths-routes-manifest.json'];

for (let path of PATHS_TO_PATHS_FILES) {
	try {
		if (!existsSync(path)) continue;
		const pagesManifest = JSON.parse(readFileSync(path, 'utf8'));
		for (let key in pagesManifest) {
			if (!manifest.has(key)) {
				manifest.set(key, new RegExp(`^${key}$`));
			}
		}
	} catch (error) {
		console.error(`Could not read ${path} manifest`, error);
	}
}

/**
 * The main router class for defining a set of routes and their handlers.
 */
class Router {
	rules = [];
	get(path, options) {
		if (path.path) path = path.path;
		this.rules.push(new Rule({ path, method: 'GET' }, options));
		return this;
	}
	post(path, options) {
		if (path.path) path = path.path;
		this.rules.push(new Rule({ path, method: 'POST' }, options));
		return this;
	}
	use() {
		this.rules.push(new Rule(null, { useNext: true }));
		return this;
	}

	match(match, options) {
		let router = this.currentRouter || this;
		router.rules.push(new Rule(match, options));
		return this;
	}
	matchAny(matches, options) {
		for (let match of matches) {
			this.rules.push(new Rule(match, options));
		}
		return this;
	}
	fallback(options) {
		return this.match(null, options);
	}
	always(options) {
		return this.match(null, options);
	}
	destination(originName, router) {
		const originConfig = getOriginConfig(originName);
		return this.match(
			originConfig.hostname
				? {
						headers: {
							Host: originConfig.hostname,
						},
					}
				: null,
			router
		);
	}
	catch(statusCode, handler) {
		// TODO: Define status code handlers
		return this;
	}
	if(condition, handler) {
		let conditionalRouter = new Router();
		this.rules.push(new Rule(condition, conditionalRouter));
		this.currentRouter = conditionalRouter;
		return this;
	}

	/**
	 * For each incoming request, perform routing based on the defined rules, returning a function that can be called
	 * to process the request. This will determine if and what the cache key is, so that caching can be attempted
	 * before routing to the main handler function.
	 * @param request
	 */
	async onRequest(request, nextHandler) {
		let foundRule = false;
		const nodeResponse = request._nodeResponse;
		let responseHeaders = {};
		for (let rule of this.rules) {
			if (rule.match(request)) {
				if (rule.isFallback && foundRule) continue;
				foundRule = true;
				if (rule.router) {
					return rule.router.onRequest(request, nextHandler);
				}
				let actions;
				if (rule.handler) {
					actions = new RequestActions(request);
					// I believe the handler is supposed to be executed on each request, but not sure
					let result = rule.handler(actions);
					if (result) {
						if (result.caching) actions.setCaching(result.caching);
						if (result.origin) actions.setProxying(result.origin);
					}
				} else {
					actions = rule.actions;
				}
				const headers = actions.headers;
				if (headers) {
					if (headers.set_response_headers) {
						for (let key in headers.set_response_headers) {
							let value = headers.set_response_headers[key];
							responseHeaders[key] = value;
						}
					}
					if (headers.add_response_headers) {
						for (let key in headers.add_response_headers) {
							let value = headers.add_response_headers[key];
							responseHeaders[key] = value;
						}
					}
					if (headers.remove_response_headers) {
						for (let key in headers.remove_response_headers) {
							delete responseHeaders[key];
						}
					}
					if (headers.set_client_ip_custom_header) {
						responseHeaders[headers.set_client_ip_custom_header] = request.ip;
					}
				}
				if (actions.redirecting) {
					return () => ({
						status: actions.redirecting.status,
						headers: { ...responseHeaders, Location: actions.redirecting.location },
					});
				}
				if (actions.caching) {
					const caching = actions.caching;
					let cacheControlDirectives = [];
					if (caching.maxAgeSeconds || caching.staleWhileRevalidateSeconds) {
						// enable caching, set a cache key
						let keyParts = [request.pathname];
						if (caching.cache_key?.include_query_params) {
							const queryStart = request.url.indexOf('?');
							if (queryStart !== -1) {
								const query = request.url.slice(queryStart + 1);
								new URLSearchParams(query).forEach((value, key) => {
									if (caching.cache_key.include_query_params.includes(key)) {
										keyParts.push(`${key}=${value}`);
									}
								});
							}
						} else {
							// this is a bit of a mystery to me, do we include the query params in the cache key or not if
							// they're not specified? (using request.url instead of request.pathname will include the query params)
							keyParts = [request.url];
						}
						if (caching.cache_key?.include_headers) {
							keyParts = keyParts ?? [];
							for (let header of caching.cache_key?.include_headers) {
								keyParts.push(`${header}=${request.headers.get(header)}`);
							}
						}
						if (caching.cache_key?.include_cookies) {
							keyParts = keyParts ?? [];
							const cookie = request.headers.get('cookie');
							const cookies = cookie?.split(/;\s+/) || [];
							for (const cookie of cookies || []) {
								const [name, value] = cookie.split('=');
								if (caching.cache_key.include_cookies.includes(name)) {
									keyParts.push(`${name}=${value}`);
								}
							}
						}
						request.maxAgeSeconds = caching.maxAgeSeconds;
						// disable SWR for now
						// request.staleWhileRevalidateSeconds = caching.staleWhileRevalidateSeconds;
						if (caching.maxAgeSeconds) cacheControlDirectives.push(`s-maxage=${caching.maxAgeSeconds}`);
						request.cacheKey = keyParts.join('&');
						// let the caching layer handle the headers
					}
					if (caching.forcePrivateCaching) cacheControlDirectives.push('private');
					if (caching.clientMaxAgeSeconds !== undefined) {
						if (!caching.clientMaxAgeSeconds && !caching.maxAgeSeconds)
							cacheControlDirectives.push('no-store', 'no-cache', 'must-revalidate');
						else cacheControlDirectives.push(`max-age=${caching.clientMaxAgeSeconds}`);
					}
					responseHeaders['Cache-Control'] = cacheControlDirectives.join(', ');
				} else if (actions.caching === false) {
					request.cacheKey = undefined;
				}
				const proxying = actions.proxying;
				if (proxying) {
					// proxy the request, first get the origin hostname
					const originName = typeof proxying === 'string' ? proxying : (proxying.set_origin ?? proxying.origin);
					const originConfig = getOriginConfig(originName);
					const originHostname = originConfig.hostname;
					if (!originHostname) throw new Error('No hostname found for origin');
					let url = request.url;
					if (actions.url?.url_rewrite) {
						for (let rewrite of actions.url.url_rewrite) {
							if (rewrite.syntax === 'regexp') {
								url = url.replace(new RegExp(rewrite.source), rewrite.destination);
							}
						}
					} else if (proxying.path) {
						const param = rule.condition.path.exec(request.pathname)[1];
						url = proxying.path.replace(/:[\w\*\+]+/, param) + request.url.slice(request.pathname.length);
					}
					const headers = request.headers.asObject;
					delete headers.host;
					delete headers.Host;
					if (originConfig.hostHeader) headers.Host = originConfig.hostHeader;
					const requestOptions = {
						timeout: 60000,
						hostname: originHostname,
						path: url,
						method: request.method,
						headers,
					};
					requestOptions.rejectUnauthorized = originConfig.rejectUnauthorized;
					if (originConfig.servername) requestOptions.servername = originConfig.servername;
					return () => {
						return new Promise((resolve, reject) => {
							try {
								let proxiedRequest = httpsRequest(requestOptions, (response) => {
									logger.info(
										'Received proxied response for',
										request.url,
										response.statusCode,
										JSON.stringify(response.headers)
									);
									if (actions.update_response_headers) {
										// this is a series of regular expression replacements, applied successively
										for (let { name, match, replacement } of actions.update_response_headers || []) {
											if (!(match instanceof RegExp)) match = new RegExp(match);
											let previousValue = response.headers[name];
											if (previousValue) {
												response.headers[name] = previousValue.replace(match, replacement);
											}
										}
									}
									const headers = {
										...responseHeaders,
										...response.headers,
									};
									delete headers.connection;
									logger.info(
										`Returning proxied response for ${request.url} from ${originHostname}`,
										JSON.stringify(headers)
									);
									nodeResponse.writeHead(response.statusCode, response.statusMessage, headers);
									response
										.pipe(nodeResponse)
										.on('finish', () => {
											resolve();
											logger.info(`Finished proxied response for ${request.url}`);
										})
										.on('error', (error) => {
											logger.warn(`Error in sending proxied body ${request.url}`, error);
											reject(error);
										});
								}).on('error', (error) => {
									logger.warn(`Error in proxying request ${request.url}`, error);
									reject(error);
								});
								logger.info(`Sending proxied request for ${request.url} to ${originHostname}`);
								if (request.method !== 'GET' && request.method !== 'HEAD') {
									streamToBuffer(request._nodeRequest).then((buffer) => {
										proxiedRequest.end(buffer);
									});
								} else proxiedRequest.end();
							} catch (error) {
								logger.warn(`Error preparing proxying request ${request.url}`, error);
								reject(error);
							}
						});
					};
				}

				if (actions.servingStaticPath) {
					return () =>
						new Promise((resolve, reject) => {
							const param = rule.condition.path.exec(request.pathname)[1];
							let path = decodeURIComponent(actions.servingStaticPath.replace(/:[\w\*\+]+/, param));
							for (let key in responseHeaders) {
								nodeResponse.setHeader(key, responseHeaders[key]);
							}
							send(request, path, {
								dotfiles: 'allow',
								root: entryModule.baseDir,
							})
								.pipe(nodeResponse)
								.on('finish', () => resolve())
								.on('error', reject);
						});
				}
				if (actions.useNext) {
					if (Array.from(manifest.values()).some((path) => path.test(request.pathname))) {
						for (let key in responseHeaders) {
							nodeResponse.setHeader(key, responseHeaders[key]);
						}
						return nextHandler;
					}
				}
			}
		}
		return nextHandler;
	}
}
exports.Router = Router;
exports.CustomCacheKey = CustomCacheKey;
class Rule {
	condition = {};
	actions = new RequestActions();
	constructor(condition, options) {
		if (condition == null) this.condition = null;
		else if (typeof condition === 'string' || condition instanceof RegExp || condition?.not) {
			this.condition.path = stringToRegex(condition);
		} else {
			let path = condition.path;
			if (path) {
				this.condition.path = stringToRegex(path);
			}
			if (condition.query) {
				for (let name in condition.query) {
					condition.query[name] = stringToRegex(condition.query[name]);
				}
				this.condition.query = condition.query;
			}
			if (condition.headers) {
				for (let name in condition.headers) {
					condition.headers[name] = stringToRegex(condition.headers[name]);
				}
				this.condition.headers = condition.headers;
			}
		}
		if (options instanceof Router) {
			this.router = options;
			return;
		}
		if (options.caching) {
			this.actions.setCaching(options.caching);
		}
		if (options.origin) {
			this.actions.setProxying(options.origin);
		}
		if (options.headers) this.actions.headers = options.headers;

		if (typeof options === 'function') {
			this.handler = options;
		} else {
			Object.assign(this.actions, options);
		}
	}

	/**
	 * Determine if the rule matches the request
	 * @param request
	 * @return {boolean}
	 */
	match(request) {
		if (this.condition == null) return true;
		if (this.condition.path) {
			if (!this.condition.path.test(request.pathname)) {
				return false;
			}
		}
		const query = this.condition.query;
		if (query) {
			let requestQuery = new URLSearchParams(request.url);
			for (let key in query) {
				if (!query[key].test(requestQuery.get(key))) {
					return false;
				}
			}
		}
		const headers = this.condition.headers;
		if (headers) {
			for (let key in headers) {
				if (!headers[key].test(request.headers.get(key))) {
					return false;
				}
			}
		}
		return true;
	}
}

class RequestActions {
	constructor(request) {
		this.request = request;
	}
	// we do theses as a getters, because the function is accessed through destructuring and called without its
	// context/this
	get setResponseHeader() {
		// This should also work with middleware that returns a response object, but that's not how the
		// next.js middleware works
		let actions = this;
		return (key, value) => {
			const headers = actions.headers || (actions.headers = {});
			if (headers) {
				if (!headers.set_response_headers) headers.set_response_headers = {};
				headers.set_response_headers[key] = value;
			}
		};
	}
	get cache() {
		let actions = this;
		return (options) => {
			let caching = actions.caching ?? (actions.caching = {});
			if (options.edge) {
				caching.maxAgeSeconds = options.edge.maxAgeSeconds;
				caching.staleWhileRevalidateSeconds = options.edge.staleWhileRevalidateSeconds;
				caching.forcePrivateCaching = options.edge.forcePrivateCaching;
			} else if (options.edge === false) actions.caching = false;
			if (options.browser) {
				if (options.browser.maxAgeSeconds != null) {
					caching.clientMaxAgeSeconds = options.browser.maxAgeSeconds;
				}
			} else if (options.browser === false) {
				caching.clientMaxAgeSeconds = 0;
			}
			if (options.key) {
				if (!actions.caching) actions.caching = {};
				actions.caching.cache_key = options.key;
			}
		};
	}
	get serveStatic() {
		let actions = this;
		return (path) => {
			actions.servingStaticPath = path;
		};
	}
	setCaching(caching) {
		if (caching.max_age)
			caching.maxAgeSeconds = convertToMS(
				typeof caching.max_age === 'object' ? caching.max_age['200'] : caching.max_age
			);
		if (caching.client_max_age) caching.clientMaxAgeSeconds = convertToMS(caching.client_max_age);
		if (caching.stale_while_revalidate)
			caching.staleWhileRevalidateSeconds = convertToMS(caching.stale_while_revalidate);
		this.caching = caching;
	}
	setProxying(origin) {
		this.proxying = origin;
	}
	get proxy() {
		let actions = this;
		return (path, options) => {
			actions.proxying = {
				origin: path,
				...options,
			};
		};
	}
	get redirect() {
		let actions = this;
		return (location, status) => {
			actions.redirecting = { location, status };
		};
	}
	get updateResponseHeader() {
		let actions = this;
		return (name, match, replacement) => {
			actions.update_response_headers = actions.update_response_headers || [];
			actions.update_response_headers.push({ name, match, replacement });
		};
	}
	async run(handler) {
		if (this.redirect) {
			return {
				status: this.redirect.status,
				headers: { Location: this.redirect.location },
			};
		}
		let response = await handler(this.request);
		if (response) {
			if (this.responseHeaders) {
				for (let [key, value] of this.responseHeaders) {
					response.headers.set(key, value);
				}
			}
			if (this.maxAgeSeconds) {
				response.headers.set('Cache-Control', `max-age=${this.maxAgeSeconds}`);
			}
		}
		return response;
	}
}

exports.or = function (...conditions) {
	return new OrRule(conditions);
};
exports.nextRoutes = {}; // I think this is for the next.js routes
class OrRule {
	constructor(conditions) {
		this.conditions = conditions;
	}
	match(request) {
		for (let condition of this.conditions) {
			if (condition.match(request)) {
				return true;
			}
		}
	}
}

function getOriginConfig(origin_name) {
	if (!origin_name) throw new Error('No origin name provided');
	const origin_config = origins.get(origin_name);
	if (!origin_config && origin_name === 'pwa') return {}; // special catchall to go the local origin, I guess?
	if (!origin_config) throw new Error(`Origin "${origin_name}" not found`);
	return origin_config;
}

function stringToRegex(str) {
	if (str instanceof RegExp) return str;
	if (typeof str === 'string') {
		return new RegExp(
			'^' +
				str.replace(/:[^/]+\*?/g, (match) => {
					if (match.endsWith('*')) {
						return '(.*)';
					} else {
						return '([^/]+)';
					}
				}) +
				'$'
		);
	} else if (str.not) {
		const regex = stringToRegex(str.not);
		return {
			test(value) {
				return !stringToRegex(regex).test(value);
			},
		};
	} else throw new TypeError('Unknown type of matching requests ' + str);
}

function convertToMS(interval) {
	let seconds = 0;
	if (typeof interval === 'number') seconds = interval;
	if (typeof interval === 'string') {
		seconds = parseFloat(interval);
		switch (interval.slice(-1)) {
			case 'M':
				seconds *= 86400 * 30;
				break;
			case 'D':
			case 'd':
				seconds *= 86400;
				break;
			case 'H':
			case 'h':
				seconds *= 3600;
				break;
			case 'm':
				seconds *= 60;
				break;
		}
	}
	return seconds * 1000;
}

function streamToBuffer(stream) {
	return new Promise((resolve, reject) => {
		const buffers = [];
		stream.on('data', (data) => buffers.push(data));
		stream.on('end', () => resolve(Buffer.concat(buffers)));
		stream.on('error', reject);
	});
}
