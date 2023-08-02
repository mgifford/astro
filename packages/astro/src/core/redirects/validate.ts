import { AstroError, RedirectWithNoLocation } from '../errors/index.js';

export function getRedirectLocationOrThrow(headers: Headers): string {
	let location = headers.get('location');

	if (!location) {
		throw new AstroError({
			...RedirectWithNoLocation,
		});
	}

	return location;
}
