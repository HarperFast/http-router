const { URLSearchParams } = require('node:url');
const entryModule = require('./extension.js');
const { origins } = entryModule;
const { request: httpsRequest } = require('node:https');
const { join } = require('node:path');
const send = require('send');
/**
 * The main router class for defining a set of routes and their handlers.
 */
class Router {
	rules = [];
	get(path, options) {
		this.rules.push(new Rule({ path, method: 'GET' }, options));
		return this;
	}
	post(path, options) {
		this.rules.push(new Rule({ path, method: 'POST' }, options));
		return this;
	}
	use() {
		// I think this was just for setting the default route
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
		const fallback = new Rule(null, options);
		fallback.isFallback = true;
		this.rules.push(fallback);
		return this;
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
	onRequest(request, nextHandler) {
		let foundRule = false;
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
				if (actions.redirecting) {
					return () => ({ status: actions.redirecting.status, headers: { Location: actions.redirecting.location } });
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
					if (originConfig.hostHeader) headers.Host = originConfig.hostHeader;
					const requestOptions = {
						hostname: originHostname,
						path: url,
						method: request.method,
						headers: request.headers.asObject,
					};
					requestOptions.rejectUnauthorized = originConfig.rejectUnauthorized;
					if (originConfig.hostHeader) requestOptions.headers.host = originConfig.hostHeader;
					if (originConfig.servername) requestOptions.servername = originConfig.servername;
					const nodeResponse = request._nodeResponse;
					return () => {
						return new Promise((resolve, reject) => {
							let proxiedRequest = httpsRequest(requestOptions, (response) => {
								nodeResponse.writeHead(response.statusCode, response.statusMessage, response.headers);
								response
									.pipe(nodeResponse)
									.on('finish', () => {
										resolve();
									})
									.on('error', reject);
							}).on('error', (error) => {
								reject(error);
							});
							if (request.method !== 'GET' && request.method !== 'HEAD') {
								request._nodeRequest.pipe(proxiedRequest);
							} else proxiedRequest.end();
						});
					};
				}
				const headers = actions.headers;
				if (headers) {
					if (headers.set_response_headers) {
						for (let key in headers.set_response_headers) {
							let value = headers.set_response_headers[key];
							request._nodeResponse.setHeader(key, value);
						}
					}
					if (headers.add_response_headers) {
						for (let key in headers.add_response_headers) {
							let value = headers.add_response_headers[key];
							request._nodeResponse.setHeader(key, value);
						}
					}
					if (headers.remove_response_headers) {
						for (let key in headers.remove_response_headers) {
							request._nodeResponse.removeHeader(key);
						}
					}
					if (headers.set_client_ip_custom_header) {
						request._nodeResponse.setHeader(headers.set_client_ip_custom_header, request.ip);
					}
				}
				if (actions.caching) {
					const caching = actions.caching;
					if (caching.maxAgeSeconds || caching.staleWhileRevalidateSeconds) {
						// enable caching, set a cache key
						let additionalParts;
						if (caching.cache_key?.include_query_params) {
							additionalParts = [];
							new URLSearchParams(request.url).forEach((value, key) => {
								if (rule.caching.cache_key.include_query_params.includes(key)) {
									additionalParts.push(`${key}=${value}`);
								}
							});
						}
						if (caching.cache_key?.include_headers) {
							additionalParts = additionalParts ?? [];
							for (let header of caching.cache_key?.include_headers) {
								additionalParts.push(`${header}=${request.headers.get('header')}`);
							}
						}
						if (caching.cache_key?.include_cookies) {
							additionalParts = additionalParts ?? [];
							for (let cookie of caching.cache_key?.include_cookies) {
								additionalParts.push(`${cookie}=${request.headers.get('cookie')}`);
							}
						}
						request.maxAgeSeconds = caching.maxAgeSeconds;
						request.staleWhileRevalidateSeconds = caching.staleWhileRevalidateSeconds;
						request.cacheKey = request.pathname + (additionalParts ? '?' + additionalParts.join('&') : '');
						// let the caching layer handle the headers
					}
					if (caching.clientMaxAgeSeconds) {
						request._nodeResponse.setHeader('Cache-Control', `max-age=${caching.clientMaxAgeSeconds}`);
					}
				}
				if (actions.servingStaticPath) {
					return () =>
						new Promise((resolve, reject) => {
							send(request, join(entryModule.baseDir, actions.servingStaticPath), {
								dotfiles: 'allow',
							})
								.pipe(request._nodeResponse)
								.on('finish', () => resolve())
								.on('error', reject);
						});
				}
			}
		}
		return nextHandler;
	}
}
exports.Router = Router;
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
		const nodeResponse = this.request._nodeResponse;
		return (key, value) => {
			nodeResponse.wroteHeaders = true;
			nodeResponse.setHeader(key, value);
		};
	}
	get cache() {
		let actions = this;
		return (options) => {
			if (options.edge) {
				actions.caching = {
					maxAgeSeconds: options.edge.maxAgeSeconds,
					staleWhileRevalidateSeconds: options.edge.staleWhileRevalidateSeconds,
				};
			}
			if (options.browser) {
				if (options.browser.maxAgeSeconds != null) {
					const nodeResponse = this.request._nodeResponse;
					nodeResponse.wroteHeaders = true;
					nodeResponse.setHeader('Cache-Control', `max-age=${options.browser.maxAgeSeconds}`);
				}
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
		if (caching.max_age) caching.maxAgeSeconds = convertToMS(caching.max_age);
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
		return (key, value) => {
			// ??
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
