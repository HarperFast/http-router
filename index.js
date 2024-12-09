const { URLSearchParams } = require('node:url');
const { origins } = require('./extension.js');
const { request: httpsRequest } = require('node:https');
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
		this.rules.push(new Rule(match, options));
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

	/**
	 * For each incoming request, perform routing based on the defined rules, returning a function that can be called
	 * to process the request. This will determine if and what the cache key is, so that caching can be attempted
	 * before routing to the main handler function.
	 * @param request
	 */
	onRequest(request, nextHandler) {
		for (let rule of this.rules) {
			if (rule.match(request)) {
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
				if (actions.proxying) {
					// proxy the request, first get the origin hostname
					const originName =
						typeof actions.proxying === 'string'
							? actions.proxying
							: (actions.proxying.origin?.set_origin ?? actions.proxying.origin);
					const originConfig = getOriginConfig(originName);
					const originHostname = originConfig.hostname;
					if (!originHostname) throw new Error('No hostname found for origin');
					const requestOptions = {
						hostname: originHostname,
						path: request.url,
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

				if (rule.headers?.set_response_headers) {
					for (let key in rule.headers.set_response_headers) {
						let value = rule.headers.set_response_headers[key];
						request._nodeResponse.setHeader(key, value);
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
		else if (typeof condition === 'string') {
			this.condition.path = stringToRegex(condition);
		} else if ((typeof condition) instanceof RegExp) {
			this.condition.path = condition;
		} else {
			if (condition.path) {
				this.condition.path = stringToRegex(condition.path);
			}
			if (condition.query) this.condition.query = condition.query;
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

		if (typeof options === 'function') {
			this.handler = options;
		} else {
			Object.assign(this.actions, options);
		}
	}
	match(request) {
		if (this.condition == null) return true;
		if (this.condition.path) {
			if (!this.condition.path.test(request.url)) {
				return false;
			}
		}
		if (this.condition.query) {
			let query = new URLSearchParams(request.url);
			for (let key in this.condition.query) {
				if (query.get(key) !== this.condition.query[key]) {
					return false;
				}
			}
		}
		if (this.condition.headers) {
			for (let key in this.condition.headers) {
				if (request.headers.get(key) !== this.condition.headers[key]) {
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
	setCaching(caching) {
		if (caching.max_age) caching.maxAgeSeconds = convertToMS(options.caching.max_age);
		if (caching.client_max_age) caching.clientMaxAgeSeconds = convertToMS(options.caching.client_max_age);
		if (caching.stale_while_revalidate)
			caching.staleWhileRevalidateSeconds = convertToMS(options.caching.stale_while_revalidate);
		this.caching = caching;
	}
	setProxying(origin) {
		this.proxying = {
			origin: origin.set_origin,
		};
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
