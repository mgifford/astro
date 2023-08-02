import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AstroInlineConfig, PreviewModule, PreviewServer } from '../../@types/astro';
import { telemetry } from '../../events/index.js';
import { eventCliSession } from '../../events/session.js';
import { runHookConfigDone, runHookConfigSetup } from '../../integrations/index.js';
import { resolveConfig } from '../config/config.js';
import { createNodeLogging } from '../config/logging.js';
import { createSettings } from '../config/settings.js';
import createStaticPreviewServer from './static-preview-server.js';
import { getResolvedHostForHttpServer } from './util.js';

/** The primary dev action */
export default async function preview(
	inlineConfig: AstroInlineConfig
): Promise<PreviewServer | undefined> {
	const logging = createNodeLogging(inlineConfig);
	const { userConfig, astroConfig } = await resolveConfig(inlineConfig ?? {}, 'preview');
	telemetry.record(eventCliSession('preview', userConfig));

	const _settings = createSettings(astroConfig, fileURLToPath(astroConfig.root));

	const settings = await runHookConfigSetup({
		settings: _settings,
		command: 'preview',
		logging: logging,
	});
	await runHookConfigDone({ settings: settings, logging: logging });

	if (settings.config.output === 'static') {
		const server = await createStaticPreviewServer(settings, logging);
		return server;
	}
	if (!settings.adapter) {
		throw new Error(`[preview] No adapter found.`);
	}
	if (!settings.adapter.previewEntrypoint) {
		throw new Error(
			`[preview] The ${settings.adapter.name} adapter does not support the preview command.`
		);
	}
	// We need to use require.resolve() here so that advanced package managers like pnpm
	// don't treat this as a dependency of Astro itself. This correctly resolves the
	// preview entrypoint of the integration package, relative to the user's project root.
	const require = createRequire(settings.config.root);
	const previewEntrypointUrl = pathToFileURL(
		require.resolve(settings.adapter.previewEntrypoint)
	).href;

	const previewModule = (await import(previewEntrypointUrl)) as Partial<PreviewModule>;
	if (typeof previewModule.default !== 'function') {
		throw new Error(`[preview] ${settings.adapter.name} cannot preview your app.`);
	}

	const server = await previewModule.default({
		outDir: settings.config.outDir,
		client: settings.config.build.client,
		serverEntrypoint: new URL(settings.config.build.serverEntry, settings.config.build.server),
		host: getResolvedHostForHttpServer(settings.config.server.host),
		port: settings.config.server.port,
		base: settings.config.base,
	});

	return server;
}
