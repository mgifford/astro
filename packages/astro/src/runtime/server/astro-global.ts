import type { AstroGlobalPartial } from '../../@types/astro';
import { ASTRO_VERSION } from '../../core/constants.js';
import { AstroError, AstroGlobNoMatch, AstroGlobUsedOutside } from '../../core/errors/index.js';

/** Create the Astro.glob() runtime function. */
function createAstroGlobFn() {
	const globHandler = (importMetaGlobResult: Record<string, any>) => {
		if (typeof importMetaGlobResult === 'string') {
			throw new AstroError({
				...AstroGlobUsedOutside,
				message: AstroGlobUsedOutside.message(JSON.stringify(importMetaGlobResult)),
			});
		}
		let allEntries = [...Object.values(importMetaGlobResult)];
		if (allEntries.length === 0) {
			throw new AstroError({
				...AstroGlobNoMatch,
				message: AstroGlobNoMatch.message(JSON.stringify(importMetaGlobResult)),
			});
		}
		// Map over the `import()` promises, calling to load them.
		return Promise.all(allEntries.map((fn) => fn()));
	};
	// Cast the return type because the argument that the user sees (string) is different from the argument
	// that the runtime sees post-compiler (Record<string, Module>).
	return globHandler as unknown as AstroGlobalPartial['glob'];
}

// This is used to create the top-level Astro global; the one that you can use
// inside of getStaticPaths. See the `astroGlobalArgs` option for parameter type.
export function createAstro(site: string | undefined): AstroGlobalPartial {
	return {
		site: site ? new URL(site) : undefined,
		generator: `Astro v${ASTRO_VERSION}`,
		glob: createAstroGlobFn(),
	};
}
