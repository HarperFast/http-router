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

	/**
	 * For each incoming request, perform routing based on the defined rules
	 * @param request
	 */
	onRequest(request, nextHandler) {
		for (let rule of this.rules) {
			if (rule.match(request)) {
				if (rule.handler) {
					let actions = new RequestActions(request);
					rule.handler(actions);
					return actions.run(nextHandler);
				} else {
					return nextHandler(request);
				}
			}
		}
		return nextHandler(request);
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
			nodeResponse.setHeader(key, value);
		};
	}
	get cache() {
		let actions = this;
		return (options) => {
			let client = options.browser ?? options.edge;
			if (client?.maxAgeSeconds) {
				actions.maxAgeSeconds = client.maxAgeSeconds;
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
