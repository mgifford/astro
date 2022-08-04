import { fileURLToPath } from 'node:url';
import type { PluginContext as RollupPluginContext, ResolvedId } from 'rollup';
import type { HmrContext, ModuleNode, ViteDevServer } from 'vite';
import type { AstroConfig } from '../@types/astro';
import type { LogOptions } from '../core/logger/core.js';
import { info } from '../core/logger/core.js';
import * as msg from '../core/messages.js';
import { cachedCompilation, invalidateCompilation, isCached } from './compile.js';

interface TrackCSSDependenciesOptions {
	viteDevServer: ViteDevServer | null;
	file: string;
	id: string;
	deps: Set<string>;
}

export async function trackCSSDependencies(
	this: RollupPluginContext,
	opts: TrackCSSDependenciesOptions
): Promise<void> {
	const { viteDevServer, file, deps, id } = opts;
	if (viteDevServer) {
		// Track any CSS dependencies so that HMR is triggered when they change.
		const { moduleGraph } = viteDevServer;
		const thisModule = moduleGraph.getModuleById(id);
		if (thisModule) {
			const depModules = new Set<string | ModuleNode>();
			const cssDeps = (
				await Promise.all(
					Array.from(deps).map((dep) =>
						this.resolve(dep, id, { skipSelf: true })
					)
				)
			)
				.filter(Boolean)
				.map((dep) => dep?.id) as string[];
			for (const dep of cssDeps) {
				for (const m of moduleGraph.getModulesByFile(dep) ?? []) {
					if (m.id?.endsWith('?direct')) {
						depModules.add(m);
					}
				}
				this.addWatchFile(dep);
			}
			for (const styleMod of thisModule.importedModules) {
				if (styleMod.file === file && styleMod.id?.endsWith('.css')) {
					await moduleGraph.updateModuleInfo(
						styleMod,
						depModules,
						null,
						new Set(),
						null,
						true,
						true
					);
				}
			}
		}
	}
}

const PKG_PREFIX = new URL('../../', import.meta.url);
const isPkgFile = (id: string | null) => {
	return id?.startsWith(fileURLToPath(PKG_PREFIX)) || id?.startsWith(PKG_PREFIX.pathname);
};

export interface HandleHotUpdateOptions {
	config: AstroConfig;
	logging: LogOptions;
	compile: () => ReturnType<typeof cachedCompilation>;
}

export async function handleHotUpdate(
	ctx: HmrContext,
	{ config, logging, compile }: HandleHotUpdateOptions
) {
	let isStyleOnlyChange = false;
	if (ctx.file.endsWith('.astro')) {
		// Get the compiled result from the cache
		const oldResult = await compile();
		// But we also need a fresh, uncached result to compare it to
		invalidateCompilation(config, ctx.file);
		const newResult = await compile();
		// If the hashes are identical, we assume only styles have changed
		if (oldResult.scope === newResult.scope) {
			isStyleOnlyChange = true;
			// All styles are the same, we can skip an HMR update
			const styles = new Set(newResult.css);
			for (const style of oldResult.css) {
				if (styles.has(style)) {
					styles.delete(style);
				}
			}
			if (styles.size === 0) {
				return [];
			}
		}
	} else {
		invalidateCompilation(config, ctx.file);
	}

	// Skip monorepo files to avoid console spam
	if (isPkgFile(ctx.file)) {
		return;
	}

	// go through each of these modules importers and invalidate any .astro compilation
	// that needs to be rerun.
	const filtered = new Set<ModuleNode>(ctx.modules);
	const files = new Set<string>();
	for (const mod of ctx.modules) {
		// Skip monorepo files to avoid console spam
		if (isPkgFile(mod.id ?? mod.file)) {
			filtered.delete(mod);
			continue;
		}

		if (mod.file && isCached(config, mod.file)) {
			filtered.add(mod);
			files.add(mod.file);
		}

		for (const imp of mod.importers) {
			if (imp.file && isCached(config, imp.file)) {
				filtered.add(imp);
				files.add(imp.file);
			}
		}
	}

	// Invalidate happens as a separate step because a single .astro file
	// produces multiple CSS modules and we want to return all of those.
	for (const file of files) {
		if (isStyleOnlyChange && file === ctx.file) continue;
		invalidateCompilation(config, file);
	}

	// Bugfix: sometimes style URLs get normalized and end with `lang.css=`
	// These will cause full reloads, so filter them out here
	const mods = ctx.modules.filter((m) => !m.url.endsWith('='));
	const file = ctx.file.replace(config.root.pathname, '/');

	// If only styles are changed, remove the component file from the update list
	if (isStyleOnlyChange) {
		info(logging, 'astro', msg.hmr({ file, style: true }));
		// remove base file and hoisted scripts
		return mods.filter((mod) => mod.id !== ctx.file && !mod.id?.endsWith('.ts'));
	}

	// Add hoisted scripts so these get invalidated
	for (const mod of mods) {
		for (const imp of mod.importedModules) {
			if (imp.id?.includes('?astro&type=script')) {
				mods.push(imp);
			}
		}
	}

	// TODO: Svelte files should be marked as `isSelfAccepting` but they don't appear to be
	const isSelfAccepting = mods.every((m) => m.isSelfAccepting || m.url.endsWith('.svelte'));
	if (isSelfAccepting) {
		info(logging, 'astro', msg.hmr({ file }));
	} else {
		info(logging, 'astro', msg.reload({ file }));
	}

	return mods;
}
