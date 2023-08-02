import type { AstroIntegration } from 'astro';
import { version as ReactVersion } from 'react-dom';
import react, {type Options as ViteReactPluginOptions} from '@vitejs/plugin-react';

const FAST_REFRESH_PREAMBLE = `
import RefreshRuntime from '/@react-refresh'
RefreshRuntime.injectIntoGlobalHook(window)
window.$RefreshReg$ = () => {}
window.$RefreshSig$ = () => (type) => type
window.__vite_plugin_react_preamble_installed__ = true
`;

function getRenderer() {
	return {
		name: '@astrojs/react',
		clientEntrypoint: ReactVersion.startsWith('18.')
			? '@astrojs/react/client.js'
			: '@astrojs/react/client-v17.js',
		serverEntrypoint: ReactVersion.startsWith('18.')
			? '@astrojs/react/server.js'
			: '@astrojs/react/server-v17.js',
	};
}

function getViteConfiguration({include, exclude}: Options = {}) {
	return {
		optimizeDeps: {
			include: [
				ReactVersion.startsWith('18.')
					? '@astrojs/react/client.js'
					: '@astrojs/react/client-v17.js',
				'react',
				'react/jsx-runtime',
				'react/jsx-dev-runtime',
				'react-dom',
			],
			exclude: [
				ReactVersion.startsWith('18.')
					? '@astrojs/react/server.js'
					: '@astrojs/react/server-v17.js',
			],
		},
		plugins: [react({include, exclude})],
		resolve: {
			dedupe: ['react', 'react-dom', 'react-dom/server'],
		},
		ssr: {
			external: ReactVersion.startsWith('18.')
				? ['react-dom/server', 'react-dom/client']
				: ['react-dom/server.js', 'react-dom/client.js'],
			noExternal: [
				// These are all needed to get mui to work.
				'@mui/material',
				'@mui/base',
				'@babel/runtime',
				'redoc',
				'use-immer',
			],
		},
	};
}

export type Options =Pick<ViteReactPluginOptions, 'include' | 'exclude'>;
export default function ({include, exclude}: Pick<ViteReactPluginOptions, 'include' | 'exclude'> = {}): AstroIntegration {
	return {
		name: '@astrojs/react',
		hooks: {
			'astro:config:setup': ({ command, addRenderer, updateConfig, injectScript }) => {
				addRenderer(getRenderer());
				updateConfig({ vite: getViteConfiguration({include, exclude}) });
				if (command === 'dev') {
					injectScript('before-hydration', FAST_REFRESH_PREAMBLE);
				}
			},
		},
	};
}
