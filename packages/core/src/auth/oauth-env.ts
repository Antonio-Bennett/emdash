/**
 * Environment OAuth provider credentials are read from.
 *
 * On Cloudflare, `virtual:emdash/env` re-exports the `cloudflare:workers`
 * env and that object is returned unchanged. Other adapters export
 * `undefined`. Vite replaces `import.meta.env` with the environment from
 * build time, so a Node server overlays `process.env` and those values win.
 * Keys present only on `import.meta.env` are kept, which is how `astro dev`
 * sees credentials loaded from `.env`.
 */
export async function getOAuthEnv(): Promise<Record<string, unknown>> {
	const { env: platformEnv } = await import("virtual:emdash/env");
	if (platformEnv != null) return platformEnv;

	if (typeof process !== "undefined") {
		return { ...import.meta.env, ...process.env };
	}
	return { ...import.meta.env };
}
