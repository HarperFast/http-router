import { createServer } from 'node:https';
import { readFileSync } from 'node:fs';

let requestCount = 0;

createServer({ key: readFileSync('/certs/key.pem'), cert: readFileSync('/certs/cert.pem') }, (request, response) => {
	const chunks = [];
	request.on('data', (chunk) => chunks.push(chunk));
	request.on('end', () => {
		requestCount++;
		response.writeHead(200, { 'Content-Type': 'application/json', 'X-Origin-Server': `echo-${requestCount}` });
		response.end(
			JSON.stringify({
				method: request.method,
				url: request.url,
				headers: request.headers,
				body: Buffer.concat(chunks).toString(),
			})
		);
	});
}).listen(443);
