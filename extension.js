import { getCacheHandler } from '@harperdb/http-cache/extension.js';
export function start(options = {}) {
	let cacheHandler = getCacheHandler(options);
	return {
		async handleFile(js, url_path, file_path) {
			const routes = (await import(file_path)).default;
			const servers = options.server.http(async (request, nextHandler) => {
				const handler = routes.onRequest(request, nextHandler); // get the handler for the request, that has/will
				// process the request
				// if we have a cache key, we can attempt to resolve the request from the cache
				if (request.cacheKey) {
					// let the cache attempt to resolve
					return cacheHandler(request, handler);
				} else {
					return handler(request);
				}
			});
		},
	};
}
