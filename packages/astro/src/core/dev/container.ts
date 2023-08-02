import type * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AstroInlineConfig, AstroSettings } from '../../@types/astro';

import nodeFs from 'node:fs';
import * as vite from 'vite';
import { injectImageEndpoint } from '../../assets/internal.js';
import {
	runHookConfigDone,
	runHookConfigSetup,
	runHookServerDone,
	runHookServerStart,
} from '../../integrations/index.js';
import { createVite } from '../create-vite.js';
import type { LogOptions } from '../logger/core.js';
import { apply as applyPolyfill } from '../polyfill.js';

export interface Container {
	fs: typeof nodeFs;
	logging: LogOptions;
	settings: AstroSettings;
	viteServer: vite.ViteDevServer;
	inlineConfig: AstroInlineConfig;
	restartInFlight: boolean; // gross
	handle: (req: http.IncomingMessage, res: http.ServerResponse) => void;
	close: () => Promise<void>;
}

export interface CreateContainerParams {
	logging: LogOptions;
	settings: AstroSettings;
	inlineConfig?: AstroInlineConfig;
	isRestart?: boolean;
	fs?: typeof nodeFs;
}

export async function createContainer({
	isRestart = false,
	logging,
	inlineConfig,
	settings,
	fs = nodeFs,
}: CreateContainerParams): Promise<Container> {
	// Initialize
	applyPolyfill();
	settings = await runHookConfigSetup({
		settings,
		command: 'dev',
		logging,
		isRestart,
	});

	// HACK: Since we only inject the endpoint if `experimental.assets` is on and it's possible for an integration to
	// add that flag, we need to only check and inject the endpoint after running the config setup hook.
	if (settings.config.experimental.assets) {
		settings = injectImageEndpoint(settings);
	}

	const { host, headers, open } = settings.config.server;

	// The client entrypoint for renderers. Since these are imported dynamically
	// we need to tell Vite to preoptimize them.
	const rendererClientEntries = settings.renderers
		.map((r) => r.clientEntrypoint)
		.filter(Boolean) as string[];

	const viteConfig = await createVite(
		{
			mode: 'development',
			server: { host, headers, open },
			optimizeDeps: {
				include: rendererClientEntries,
			},
		},
		{ settings, logging, mode: 'dev', command: 'dev', fs }
	);
	await runHookConfigDone({ settings, logging });
	const viteServer = await vite.createServer(viteConfig);

	const container: Container = {
		inlineConfig: inlineConfig ?? {},
		fs,
		logging,
		restartInFlight: false,
		settings,
		viteServer,
		handle(req, res) {
			viteServer.middlewares.handle(req, res, Function.prototype);
		},
		// TODO deprecate and remove
		close() {
			return closeContainer(container);
		},
	};

	return container;
}

async function closeContainer({ viteServer, settings, logging }: Container) {
	await viteServer.close();
	await runHookServerDone({
		config: settings.config,
		logging,
	});
}

export async function startContainer({
	settings,
	viteServer,
	logging,
}: Container): Promise<AddressInfo> {
	const { port } = settings.config.server;
	await viteServer.listen(port);
	const devServerAddressInfo = viteServer.httpServer!.address() as AddressInfo;
	await runHookServerStart({
		config: settings.config,
		address: devServerAddressInfo,
		logging,
	});

	return devServerAddressInfo;
}

export function isStarted(container: Container): boolean {
	return !!container.viteServer.httpServer?.listening;
}
