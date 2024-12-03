/**
 * The main router class for defining a set of routes and their handlers.
 */
export class Router {
	rules = [];
	get(path, handler) {
		this.rules.push({ path, method: 'GET', handler });
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
		for (let rule of this.rules) {
			if (rule.match(request)) {
				if (rule.getCacheKey) {
					return rule.getCacheKey(request);
				}
			}
		}
		return request.url;
	}


	/**
	 * For each incoming request, perform routing based on the defined rules
	 * @param request
	 */
	onRequest(request, nextHandler) {

	}
}

export function or(...conditions) {
	return {
		conditions,
		operator: 'or',
	}
}
