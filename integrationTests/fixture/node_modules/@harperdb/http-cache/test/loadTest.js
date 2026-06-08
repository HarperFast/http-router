const crypto = require('crypto');
const v8 = require('v8');
const { HttpCache } = databases.cache;
const dataPool = crypto.randomBytes(1024 * 1024);
const countPerSecond = +process.env.HTTP_CACHE_LOAD_TEST;
exports.loadTest = async function() {
	while(true) {
		for (let i = 0; i < countPerSecond; i++) {
			const entry = {
				id: '/some-path/' + Math.random().toString(36).substring(7),
				headers: { 'content-type': 'application/json' },
				content: dataPool.subarray(0, Math.floor(Math.random() * dataPool.length)),
			}
			await HttpCache.put(entry);
		}
		await new Promise(resolve => setTimeout(resolve, 1000));
		console.warn('Cache count', HttpCache.primaryStore.getStats().entryCount, JSON.stringify(process.memoryUsage()));
	}
}