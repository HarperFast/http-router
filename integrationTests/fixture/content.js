let originHits = 0;

server.http((request, nextHandler) => {
	if (!request.pathname.startsWith('/content/')) return nextHandler(request);
	originHits++;
	request._nodeResponse.writeHead(200, { 'Content-Type': 'text/plain', 'X-Origin-Hits': String(originHits) });
	request._nodeResponse.end(`content for ${request.pathname}`);
});
