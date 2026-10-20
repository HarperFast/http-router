const https = require('node:https');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { PassThrough, Readable, Writable } = require('node:stream');

const repositoryRoot = path.resolve(__dirname, '../../..');
const indexPath = path.join(repositoryRoot, 'index.js');
const sendPath = require.resolve('send', { paths: [repositoryRoot] });

const loggedMessages = { info: [], warn: [], error: [] };
globalThis.logger = {
	info: (...args) => loggedMessages.info.push(args),
	warn: (...args) => loggedMessages.warn.push(args),
	error: (...args) => loggedMessages.error.push(args),
};

function clearLoggedMessages() {
	for (const level in loggedMessages) loggedMessages[level].length = 0;
}

class FakeClientRequest extends EventEmitter {
	constructor(options, onResponse) {
		super();
		this.options = options;
		this.onResponse = onResponse;
		this.ended = new Promise((resolve) => {
			this.resolveEnded = resolve;
		});
	}
	end(body) {
		this.body = body;
		this.resolveEnded(body);
	}
	respond({ statusCode = 200, statusMessage = 'OK', headers = {}, body = '' } = {}) {
		const response = new PassThrough();
		response.statusCode = statusCode;
		response.statusMessage = statusMessage;
		response.headers = headers;
		this.onResponse(response);
		response.end(body);
		return response;
	}
}

const proxyStub = { requests: [], nextThrow: null };
https.request = (options, onResponse) => {
	if (proxyStub.nextThrow) {
		const error = proxyStub.nextThrow;
		proxyStub.nextThrow = null;
		throw error;
	}
	const clientRequest = new FakeClientRequest(options, onResponse);
	proxyStub.requests.push(clientRequest);
	return clientRequest;
};

const sendStub = { calls: [], createStream: () => Readable.from(['static body']) };
function fakeSend(request, filePath, options) {
	sendStub.calls.push({ request, filePath, options });
	return sendStub.createStream();
}
const sendModule = new Module(sendPath);
sendModule.filename = sendPath;
sendModule.exports = fakeSend;
sendModule.loaded = true;
require.cache[sendPath] = sendModule;

const extension = require(path.join(repositoryRoot, 'extension.js'));

function loadRouterModule() {
	delete require.cache[indexPath];
	return require(indexPath);
}

class FakeNodeResponse extends Writable {
	chunks = [];
	headersSet = {};
	_write(chunk, encoding, callback) {
		this.chunks.push(Buffer.from(chunk));
		callback();
	}
	writeHead(statusCode, statusMessage, headers) {
		this.statusCode = statusCode;
		this.statusMessage = statusMessage;
		this.headersWritten = headers;
	}
	setHeader(name, value) {
		this.headersSet[name] = value;
	}
	get body() {
		return Buffer.concat(this.chunks).toString();
	}
}

function createRequest({ url = '/', pathname, method = 'GET', headers = {}, ip = '203.0.113.7', query, body } = {}) {
	const headerValues = new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
	const queryStart = url.indexOf('?');
	const request = {
		url,
		pathname: pathname ?? (queryStart === -1 ? url : url.slice(0, queryStart)),
		method,
		ip,
		headers: {
			get: (name) => headerValues.get(name.toLowerCase()),
			get asObject() {
				return Object.fromEntries(headerValues);
			},
		},
		_nodeResponse: new FakeNodeResponse(),
		_nodeRequest: Readable.from(body === undefined ? [] : [Buffer.from(body)]),
	};
	if (query !== undefined) request.query = query;
	return request;
}

const nextHandler = () => 'next handler result';

module.exports = {
	clearLoggedMessages,
	createRequest,
	extension,
	loadRouterModule,
	loggedMessages,
	nextHandler,
	proxyStub,
	repositoryRoot,
	sendStub,
};
