/**
 * Parses a cookie header string into an object.
 * Properly handles cookie values that contain '=' characters.
 * @param {string} cookieHeader - The Cookie header value
 * @return {Object} An object mapping cookie names to values
 */
function parseCookies(cookieHeader) {
	const cookies = {};
	if (!cookieHeader) return cookies;

	// Split by ';' but be careful with values that might contain ';'
	const parts = cookieHeader.split(';');
	for (let part of parts) {
		part = part.trim();
		if (!part) continue;

		// Find the first '=' to split name and value
		// This handles cases where the value itself contains '='
		const eqIndex = part.indexOf('=');
		if (eqIndex === -1) continue;

		const name = part.slice(0, eqIndex).trim();
		const value = part.slice(eqIndex + 1).trim();

		// Only add if name is not empty
		if (name) {
			cookies[name] = value;
		}
	}

	return cookies;
}