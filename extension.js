import { getCacheHandler } from '@harperdb/http-cache/extension.js';
export function start(options = {}) {
	let cacheHandler = getCacheHandler(options);
	return {
		async handleFile(js, url_path, file_path) {
			const routes = await import(file_path);
			const servers = options.server.http(async (request, nextHandler) => {
				// set the cache key for the request, applying any rules for the cache key
				request.cacheKey = routes.getCacheKey(request);
				// let the cache attempt to resolve
				return cacheHandler(request, () => {
					// wasn't cached, handle the routing. nextHandler can be called to delegate to the main origin server
					return routes.onRequest(request, nextHandler);
				});
			});
		}
	}
}
