import mime from 'mime';
import type {
	EndpointHandler,
	ManifestData,
	RouteData,
	SSRElement,
	SSRManifest,
} from '../../@types/astro';
import type { SinglePageBuiltModule } from '../build/types';
import { attachToResponse, getSetCookiesFromResponse } from '../cookies/index.js';
import { consoleLogDestination } from '../logger/console.js';
import { error, type LogOptions } from '../logger/core.js';
import { prependForwardSlash, removeTrailingForwardSlash } from '../path.js';
import { RedirectSinglePageBuiltModule } from '../redirects/index.js';
import { isResponse } from '../render/core';
import {
	createEnvironment,
	createRenderContext,
	tryRenderRoute,
	type Environment,
	type RenderContext,
} from '../render/index.js';
import { RouteCache } from '../render/route-cache.js';
import {
	createAssetLink,
	createModuleScriptElement,
	createStylesheetElementSet,
} from '../render/ssr-element.js';
import { matchRoute } from '../routing/match.js';
import type { RouteInfo } from './types';
export { deserializeManifest } from './common.js';

const clientLocalsSymbol = Symbol.for('astro.locals');

const responseSentSymbol = Symbol.for('astro.responseSent');

const STATUS_CODES = new Set([404, 500]);

export interface MatchOptions {
	matchNotFound?: boolean | undefined;
}
export interface RenderErrorOptions {
	routeData?: RouteData;
	response?: Response;
	status: 404 | 500;
}

export class App {
	/**
	 * The current environment of the application
	 */
	#env: Environment;
	#manifest: SSRManifest;
	#manifestData: ManifestData;
	#routeDataToRouteInfo: Map<RouteData, RouteInfo>;
	#encoder = new TextEncoder();
	#logging: LogOptions = {
		dest: consoleLogDestination,
		level: 'info',
	};
	#baseWithoutTrailingSlash: string;

	constructor(manifest: SSRManifest, streaming = true) {
		this.#manifest = manifest;
		this.#manifestData = {
			routes: manifest.routes.map((route) => route.routeData),
		};
		this.#routeDataToRouteInfo = new Map(manifest.routes.map((route) => [route.routeData, route]));
		this.#baseWithoutTrailingSlash = removeTrailingForwardSlash(this.#manifest.base);
		this.#env = this.#createEnvironment(streaming);
	}

	set setManifest(newManifest: SSRManifest) {
		this.#manifest = newManifest;
	}

	/**
	 * Creates an environment by reading the stored manifest
	 *
	 * @param streaming
	 * @private
	 */
	#createEnvironment(streaming = false) {
		return createEnvironment({
			adapterName: this.#manifest.adapterName,
			logging: this.#logging,
			markdown: this.#manifest.markdown,
			mode: 'production',
			compressHTML: this.#manifest.compressHTML,
			renderers: this.#manifest.renderers,
			clientDirectives: this.#manifest.clientDirectives,
			resolve: async (specifier: string) => {
				if (!(specifier in this.#manifest.entryModules)) {
					throw new Error(`Unable to resolve [${specifier}]`);
				}
				const bundlePath = this.#manifest.entryModules[specifier];
				switch (true) {
					case bundlePath.startsWith('data:'):
					case bundlePath.length === 0: {
						return bundlePath;
					}
					default: {
						return createAssetLink(bundlePath, this.#manifest.base, this.#manifest.assetsPrefix);
					}
				}
			},
			routeCache: new RouteCache(this.#logging),
			site: this.#manifest.site,
			ssr: true,
			streaming,
		});
	}

	set setManifestData(newManifestData: ManifestData) {
		this.#manifestData = newManifestData;
	}
	removeBase(pathname: string) {
		if (pathname.startsWith(this.#manifest.base)) {
			return pathname.slice(this.#baseWithoutTrailingSlash.length + 1);
		}
		return pathname;
	}
	// Disable no-unused-vars to avoid breaking signature change
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	match(request: Request, _opts: MatchOptions = {}): RouteData | undefined {
		const url = new URL(request.url);
		// ignore requests matching public assets
		if (this.#manifest.assets.has(url.pathname)) return undefined;
		let pathname = prependForwardSlash(this.removeBase(url.pathname));
		let routeData = matchRoute(pathname, this.#manifestData);
		// missing routes fall-through, prerendered are handled by static layer
		if (!routeData || routeData.prerender) return undefined;
		return routeData;
	}
	async render(request: Request, routeData?: RouteData, locals?: object): Promise<Response> {
		if (!routeData) {
			routeData = this.match(request);
		}
		if (!routeData) {
			return this.#renderError(request, { routeData, status: 404 });
		}

		Reflect.set(request, clientLocalsSymbol, locals ?? {});
		const defaultStatus = this.#getDefaultStatusCode(routeData.route);
		const mod = await this.#getModuleForRoute(routeData);

		const pageModule = (await mod.page()) as any;
		const url = new URL(request.url);

		const renderContext = await this.#createRenderContext(
			url,
			request,
			routeData,
			mod,
			defaultStatus
		);
		let response;
		try {
			response = await tryRenderRoute(
				routeData.type,
				renderContext,
				this.#env,
				pageModule,
				mod.onRequest
			);
		} catch (err: any) {
			error(this.#logging, 'ssr', err.stack || err.message || String(err));
			return this.#renderError(request, { routeData, status: 500 });
		}

		if (isResponse(response, routeData.type)) {
			if (STATUS_CODES.has(response.status)) {
				return this.#renderError(request, {
					routeData,
					response,
					status: response.status as 404 | 500,
				});
			}
			Reflect.set(response, responseSentSymbol, true);
			return response;
		} else {
			if (response.type === 'response') {
				if (response.response.headers.get('X-Astro-Response') === 'Not-Found') {
					return this.#renderError(request, {
						routeData,
						response: response.response,
						status: 404,
					});
				}
				return response.response;
			} else {
				const body = response.body;
				const headers = new Headers();
				const mimeType = mime.getType(url.pathname);
				if (mimeType) {
					headers.set('Content-Type', `${mimeType};charset=utf-8`);
				} else {
					headers.set('Content-Type', 'text/plain;charset=utf-8');
				}
				const bytes = this.#encoder.encode(body);
				headers.set('Content-Length', bytes.byteLength.toString());

				const newResponse = new Response(bytes, {
					status: 200,
					headers,
				});
				attachToResponse(newResponse, response.cookies);
				return newResponse;
			}
		}
	}

	setCookieHeaders(response: Response) {
		return getSetCookiesFromResponse(response);
	}

	/**
	 * Creates the render context of the current route
	 */
	async #createRenderContext(
		url: URL,
		request: Request,
		routeData: RouteData,
		page: SinglePageBuiltModule,
		status = 200
	): Promise<RenderContext> {
		if (routeData.type === 'endpoint') {
			const pathname = '/' + this.removeBase(url.pathname);
			const mod = await page.page();
			const handler = mod as unknown as EndpointHandler;
			return await createRenderContext({
				request,
				pathname,
				route: routeData,
				status,
				env: this.#env,
				mod: handler as any,
			});
		} else {
			const pathname = prependForwardSlash(this.removeBase(url.pathname));
			const info = this.#routeDataToRouteInfo.get(routeData)!;
			// may be used in the future for handling rel=modulepreload, rel=icon, rel=manifest etc.
			const links = new Set<never>();
			const styles = createStylesheetElementSet(info.styles);

			let scripts = new Set<SSRElement>();
			for (const script of info.scripts) {
				if ('stage' in script) {
					if (script.stage === 'head-inline') {
						scripts.add({
							props: {},
							children: script.children,
						});
					}
				} else {
					scripts.add(createModuleScriptElement(script));
				}
			}
			const mod = await page.page();
			return await createRenderContext({
				request,
				pathname,
				componentMetadata: this.#manifest.componentMetadata,
				scripts,
				styles,
				links,
				route: routeData,
				status,
				mod,
				env: this.#env,
			});
		}
	}

	/**
	 * If is a known error code, try sending the according page (e.g. 404.astro / 500.astro).
	 * This also handles pre-rendered /404 or /500 routes
	 */
	async #renderError(
		request: Request,
		{ routeData, status, response: originalResponse }: RenderErrorOptions
	) {
		const errorRouteData = matchRoute('/' + status, this.#manifestData);
		const url = new URL(request.url);
		if (errorRouteData) {
			if (errorRouteData.prerender && !errorRouteData.route.endsWith(`/${status}`)) {
				const statusURL = new URL(`${this.#baseWithoutTrailingSlash}/${status}`, url);
				const response = await fetch(statusURL.toString());
				return this.#mergeResponses(response, originalResponse);
			}
			const finalRouteData = routeData ?? errorRouteData;
			const mod = await this.#getModuleForRoute(errorRouteData);
			try {
				const newRenderContext = await this.#createRenderContext(
					url,
					request,
					finalRouteData,
					mod,
					status
				);
				const page = (await mod.page()) as any;
				const response = (await tryRenderRoute(
					'page', // this is hardcoded to ensure proper behavior for missing endpoints
					newRenderContext,
					this.#env,
					page
				)) as Response;
				return this.#mergeResponses(response, originalResponse);
			} catch {}
		}

		const response = this.#mergeResponses(new Response(null, { status }), originalResponse);
		Reflect.set(response, responseSentSymbol, true);
		return response;
	}

	#mergeResponses(newResponse: Response, oldResponse?: Response) {
		if (!oldResponse) return newResponse;
		const { status, statusText, headers } = oldResponse;

		return new Response(newResponse.body, {
			status: status === 200 ? newResponse.status : status,
			statusText,
			headers: new Headers(Array.from(headers)),
		});
	}

	#getDefaultStatusCode(route: string): number {
		route = removeTrailingForwardSlash(route);
		if (route.endsWith('/404')) return 404;
		if (route.endsWith('/500')) return 500;
		return 200;
	}

	async #getModuleForRoute(route: RouteData): Promise<SinglePageBuiltModule> {
		if (route.type === 'redirect') {
			return RedirectSinglePageBuiltModule;
		} else {
			if (this.#manifest.pageMap) {
				const importComponentInstance = this.#manifest.pageMap.get(route.component);
				if (!importComponentInstance) {
					throw new Error(
						`Unexpectedly unable to find a component instance for route ${route.route}`
					);
				}
				const pageModule = await importComponentInstance();
				return pageModule;
			} else if (this.#manifest.pageModule) {
				const importComponentInstance = this.#manifest.pageModule;
				return importComponentInstance;
			} else {
				throw new Error(
					"Astro couldn't find the correct page to render, probably because it wasn't correctly mapped for SSR usage. This is an internal error, please file an issue."
				);
			}
		}
	}
}
