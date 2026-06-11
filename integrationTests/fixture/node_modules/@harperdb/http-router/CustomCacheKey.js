exports.CustomCacheKey = class CustomCacheKey {
	/**
	 * Specifies which query parameters should be included, using the most convoluted name possible.
	 * @return {CustomCacheKey} A self-reference, suitable for chaining.
	 */
	excludeAllQueryParametersExcept(...names) {
		this.include_query_params = [];
		for (let name of names) {
			this.include_query_params.push(name);
		}
		return this;
	}
	addCookie(cookie) {
		if (!this.include_cookies) this.include_cookies = [];
		this.include_cookies.push(cookie);
		return this;
	}
};
