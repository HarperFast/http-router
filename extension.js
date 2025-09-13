const { getCacheHandler } = require('@harperdb/http-cache/extension');
const { dirname } = require('path');
exports.origins = new Map();
exports.baseDir == __dirname;
exports.start = function (options = {}) {
	let cacheHandler = getCacheHandler(options);
	return {
		async handleFile(js, url_path, file_path) {
			if (file_path.includes('edgio.config.')) {
				exports.baseDir = dirname(file_path);
				const moduleExports = (await import(file_path)).default;
				for (let origin of moduleExports.origins || []) {
					exports.origins.set(origin.name, {
						hostname: origin.hosts?.[0]?.location?.[0]?.hostname ?? origin.hosts?.[0]?.location,
						rejectUnauthorized: !origin.tls_verify?.allow_self_signed_certs,
						servername: origin.tls_verify?.sni_hint_and_strict_san_check,
						hostHeader: origin.override_host_header,
					});
				}
				return;
			}
			if (file_path.includes('layer0.config.')) {
				exports.baseDir = dirname(file_path);
				const moduleExports = (await import(file_path)).default;
				for (let originName in moduleExports.backends) {
					const origin = moduleExports.backends[originName];
					exports.origins.set(originName, {
						hostname: origin.domainOrIp,
						hostHeader: origin.hostHeader,
						rejectUnauthorized: !origin.disableCheckCert,
					});
				}
				return;
			}
			if (file_path.includes('routes.')) {
				exports.baseDir = dirname(file_path);
				let routes = (await import(file_path)).default;
				if (typeof routes === 'function') routes = routes();
				const servers = options.server.http(async (request, nextHandler) => {
					const handler = await routes.onRequest(request, nextHandler);
					// get the handler for the request, that has/will
					// process the request
					// if we have a cache key, we can attempt to resolve the request from the cache
					if (request.cacheKey || request.pathname === '/invalidate') {
						// let the cache attempt to resolve
						return cacheHandler(request, handler);
					} else {
						return handler(request);
					}
				});
			}
		},
	};
};
