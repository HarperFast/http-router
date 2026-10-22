server.http((request, nextHandler) => {
	if (!request.pathname.startsWith('/content/') && !request.pathname.startsWith('/variant/')) {
		return nextHandler(request);
	}
	const cookie = request.headers.get('cookie') ?? '';
	request._nodeResponse.writeHead(200, { 'Content-Type': 'text/plain' });
	request._nodeResponse.end(`content for ${request.pathname} ${cookie}`.trim());
});
