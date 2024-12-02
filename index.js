/**
 * The main router class for defining a set of routes and their handlers.
 */
export class Router {
	rules = [];
	get(path, handler) {
		this.rules.push({ path, method: 'GET', handler });
		return this;
	}

	/**
	 * For each incoming request, perform routing based on the defined rules
	 * @param request
	 */
	onRequest(request) {

	}
}

export function or(...conditions) {
	return {
		conditions,
		operator: 'or',
	}
}
