/**
 * The main router class for defining a set of routes and their handlers.
 */
export class Router {
	rules = [];
	get(path, options) {
		this.rules.push(new Rule({ path, method: 'GET' }));
		return this;
	}
	use() {
		// I think this was just for setting the default route
		return this;
	}

	/**
	 * Determine the cache key for a request based on any defined rules that define it
	 * Return undefined is caching is not enabled for the request
	 * @param request
	 * @return {*|string}
	 */
	getCacheKey(request) {
		let additionalParts;
		for (let rule of this.rules) {
			if (rule.match(request)) {
				if (rule.caching?.cache_key?.include_query_params) {
					additionalParts = [];
					new URLSearchParams(request.url).forEach((value, key) => {
						if (rule.caching.cache_key.include_query_params.includes(key)) {
							additionalParts.push(`${key}=${value}`);
						}
					});
				}
			}
		}
		return request.url + (additionalParts ? '?' + additionalParts.join('&') : '');
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

	/**
	 * For each incoming request, perform routing based on the defined rules, returning a function that can be called
	 * to process the request. This will determine if and what the cache key is, so that caching can be attempted
	 * before routing to the main handler function.
	 * @param request
	 */
	onRequest(request, nextHandler) {
		for (let rule of this.rules) {
			if (rule.match(request)) {
				let caching = rule.caching;
				if (rule.handler) {
					// I believe the handler is supposed to be executed on each request, but not sure
					let actions = new RequestActions(request);
					rule.handler(actions);
					if (actions.redirect) {
						return () => ({ status: actions.redirect.status, headers: { Location: actions.redirect.location } });
					}
					if (actions.proxy) {
						// proxy the request
					}
					if (actions.cache) caching = actions.cache;
				}
				if (rule.headers?.set_response_headers) {
					for (let key in rule.headers.set_response_headers) {
						let value = rule.headers.set_response_headers[key];
						request._nodeResponse.setHeader(key, value);
					}
				}
				if (caching?.maxAgeSeconds) {
					if (caching.edge) {
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

						request.maxAgeSeconds = caching.maxAgeSeconds;
						request.cacheKey = request.pathname + (additionalParts ? '?' + additionalParts.join('&') : '');
						// let the caching layer handle the headers
					} else if (caching.browser) {
						request._nodeResponse.setHeader('Cache-Control', `max-age=${caching.maxAgeSeconds}`);
					}
				}
			}
		}
		return nextHandler;
	}
}
class Rule {
	condition = {};
	constructor(condition, options) {
		if (typeof condition === 'string') {
			this.condition.path = stringToRegex(condition);
		} else if ((typeof condition) instanceof RegExp) {
			this.condition.path = condition;
		} else {
			if (condition.path) {
				this.condition.path = stringToRegex(condition.path);
			}
			if (condition.query) this.condition.query = condition.query;
		}
		if (options.caching) {
			if (options.caching.max_age) options.caching.maxAgeSeconds = convertToMS(options.caching.max_age);
		}
		if (typeof options === 'function') {
			this.handler = options;
		} else {
			Object.assign(this, options);
		}
	}
	match(request) {
		if (this.condition.path) {
			if (this.condition.path.test(request.url)) {
				return true;
			}
		}
		if (this.condition.query) {
			let query = new URLSearchParams(request.url);
			for (let key in this.condition.query) {
				if (query.get(key) !== this.condition.query[key]) {
					return false;
				}
			}
			return true;
		}
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
			if (options.edge?.maxAgeSeconds) {
				actions.cache = { maxAgeSeconds: options.edge.maxAgeSeconds };
			}
			if (options.browser) {
				if (options.browser.maxAgeSeconds) {
					const nodeResponse = this.request._nodeResponse;
					nodeResponse.wroteHeaders = true;
					nodeResponse.setHeader('Cache-Control', `max-age=${options.browser.maxAgeSeconds}`);
				}
			}
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

export function or(...conditions) {
	return new OrRule(conditions);
}
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
