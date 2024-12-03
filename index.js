/**
 * The main router class for defining a set of routes and their handlers.
 */
export class Router {
	rules = [];
	get(path, options) {
		this.rules.push(new Rule({ path, method: 'GET'}));
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
	constructor(condition, options) {
		this.condition = condition;
		if (typeof options === 'function') {
			this.handler = options;
		} else {
			Object.assign(this, options);
		}
	}
	match(request) {
		if (this.condition.path) {
			if (this.condition.path === request.url) {
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
	setResponseHeader(key, value) {
		if (!this.responseHeaders) this.responseHeaders = new Map();
		this.responseHeaders.set(key, value);
	}
	cache(options) {
		let client = options.browser ?? options.edge;
		if (client?.maxAgeSeconds) {
			this.maxAgeSeconds = client.maxAgeSeconds;
		}
	}
	async run(handler) {
		if (this.redirect) {
			return {
				status: this.redirect.status,
				headers: { Location: this.redirect.location },
			}
		}
		let response = await handler(this.request);
		if (this.responseHeaders) {
			for (let [key, value] of this.responseHeaders) {
				response.headers.set(key, value);
			}
		}
		if (this.maxAgeSeconds) {
			response.headers.set('Cache-Control', `max-age=${this.maxAgeSeconds}`);
		}
		return response;
	}
}

export function or(...conditions) {
	return {
		conditions,
		operator: 'or',
	}
}
