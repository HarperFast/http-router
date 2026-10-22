const { realpathSync } = require('node:fs');

// Harper 5 can load this package more than once per thread (the plugin and the application's
// routes get separate module caches), so state lives on globalThis, keyed by package directory.
const ROUTER_STATES = Symbol.for('@harperdb/http-router/state');

exports.getRouterState = function (packageDirectory) {
	const states = (globalThis[ROUTER_STATES] ??= new Map());
	const key = realpathSync(packageDirectory);
	let state = states.get(key);
	if (!state) {
		state = { origins: new Map(), baseDir: packageDirectory };
		states.set(key, state);
	}
	return state;
};
