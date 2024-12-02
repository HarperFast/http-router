export function start(options = {}) {
	return {
		async handleFile(js, url_path, file_path) {
			const routes = await import(file_path);
			const servers = options.server.http(async (request, nextHandler) => {
				// handle the routing. nextHandler can be called to delegate to the main origin server
				return routes.onRequest(request);
			});
		}
	}
}
