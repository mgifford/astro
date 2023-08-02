import type { RouteData } from '../../@types/astro';
import type { SerializedSSRManifest, SSRManifest } from './types';

import * as fs from 'node:fs';
import { IncomingMessage } from 'node:http';
import { TLSSocket } from 'node:tls';
import { deserializeManifest } from './common.js';
import { App, type MatchOptions } from './index.js';
export { apply as applyPolyfills } from '../polyfill.js';

const clientAddressSymbol = Symbol.for('astro.clientAddress');

function createRequestFromNodeRequest(req: NodeIncomingMessage, body?: Uint8Array): Request {
	const protocol =
		req.socket instanceof TLSSocket || req.headers['x-forwarded-proto'] === 'https'
			? 'https'
			: 'http';
	const hostname = req.headers.host || req.headers[':authority'];
	const url = `${protocol}://${hostname}${req.url}`;
	const rawHeaders = req.headers as Record<string, any>;
	const entries = Object.entries(rawHeaders);
	const method = req.method || 'GET';
	const request = new Request(url, {
		method,
		headers: new Headers(entries),
		body: ['HEAD', 'GET'].includes(method) ? null : body,
	});
	if (req.socket?.remoteAddress) {
		Reflect.set(request, clientAddressSymbol, req.socket.remoteAddress);
	}
	return request;
}

class NodeIncomingMessage extends IncomingMessage {
	/**
	 * The read-only body property of the Request interface contains a ReadableStream with the body contents that have been added to the request.
	 */
	body?: unknown;
}

export class NodeApp extends App {
	match(req: NodeIncomingMessage | Request, opts: MatchOptions = {}) {
		return super.match(req instanceof Request ? req : createRequestFromNodeRequest(req), opts);
	}
	render(req: NodeIncomingMessage | Request, routeData?: RouteData, locals?: object) {
		if (typeof req.body === 'string' && req.body.length > 0) {
			return super.render(
				req instanceof Request ? req : createRequestFromNodeRequest(req, Buffer.from(req.body)),
				routeData,
				locals
			);
		}

		if (typeof req.body === 'object' && req.body !== null && Object.keys(req.body).length > 0) {
			return super.render(
				req instanceof Request
					? req
					: createRequestFromNodeRequest(req, Buffer.from(JSON.stringify(req.body))),
				routeData,
				locals
			);
		}

		if ('on' in req) {
			let body = Buffer.from([]);
			let reqBodyComplete = new Promise((resolve, reject) => {
				req.on('data', (d) => {
					body = Buffer.concat([body, d]);
				});
				req.on('end', () => {
					resolve(body);
				});
				req.on('error', (err) => {
					reject(err);
				});
			});

			return reqBodyComplete.then(() => {
				return super.render(
					req instanceof Request ? req : createRequestFromNodeRequest(req, body),
					routeData,
					locals
				);
			});
		}
		return super.render(
			req instanceof Request ? req : createRequestFromNodeRequest(req),
			routeData,
			locals
		);
	}
}

export async function loadManifest(rootFolder: URL): Promise<SSRManifest> {
	const manifestFile = new URL('./manifest.json', rootFolder);
	const rawManifest = await fs.promises.readFile(manifestFile, 'utf-8');
	const serializedManifest: SerializedSSRManifest = JSON.parse(rawManifest);
	return deserializeManifest(serializedManifest);
}

export async function loadApp(rootFolder: URL): Promise<NodeApp> {
	const manifest = await loadManifest(rootFolder);
	return new NodeApp(manifest);
}
