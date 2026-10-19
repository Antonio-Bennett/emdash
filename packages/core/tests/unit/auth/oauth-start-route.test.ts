import { describe, it, expect, vi, afterEach } from "vitest";

import { GET as startOAuth } from "../../../src/astro/routes/api/auth/oauth/[provider].js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

/**
 * Regression for #1736: the route used to read
 * `locals.runtime?.env` for Cloudflare bindings. Astro 6+ makes
 * `locals.runtime.env` a getter that *throws* rather than returning
 * undefined, so `?.` optional-chaining didn't protect the fallback --
 * the throw propagated into the route's outer try/catch and surfaced as
 * a generic "oauth_error", masking `provider_not_configured` even when
 * running on Node (where `locals.runtime` never exists at all in
 * practice, but a throwing getter is exactly what real Cloudflare
 * deployments hit). The route no longer touches `locals.runtime` --
 * it reads through the `virtual:emdash/env` module instead.
 */
function makeThrowingRuntimeLocals() {
	return {
		emdash: { db: {} as never, config: {} },
		get runtime() {
			return {
				get env(): never {
					throw new Error(
						"Astro.locals.runtime.env has been removed in Astro v6. Use 'import { env } from \"cloudflare:workers\"' instead.",
					);
				},
			};
		},
	};
}

const GOOGLE_AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";

function redirect(url: string): Response {
	return new Response(null, { status: 302, headers: { Location: url } });
}

function startGoogle(get: typeof startOAuth, db: unknown): Promise<Response> {
	return get({
		params: { provider: "google" },
		request: new Request("http://localhost:4321/_emdash/api/auth/oauth/google"),
		locals: { emdash: { db, config: {} } },
		redirect,
	} as unknown as Parameters<typeof startOAuth>[0]);
}

describe("OAuth start route (#1736)", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.doUnmock("virtual:emdash/env");
		vi.resetModules();
	});

	it("does not throw when locals.runtime.env is a throwing getter (Astro 6+ Cloudflare)", async () => {
		const request = new Request("http://localhost:4321/_emdash/api/auth/oauth/google");

		const response = await startOAuth({
			params: { provider: "google" },
			request,
			locals: makeThrowingRuntimeLocals(),
			redirect: (url: string) => new Response(null, { status: 302, headers: { Location: url } }),
		} as unknown as Parameters<typeof startOAuth>[0]);

		// No credentials configured in this test env -- the route should
		// reach the provider-configured check (not crash into the generic
		// oauth_error path the old code hit when locals.runtime.env threw).
		const location = response.headers.get("Location") ?? "";
		expect(location).toContain("error=provider_not_configured");
		expect(location).not.toContain("error=oauth_error");
	});

	it("reads provider credentials from the virtual:emdash/env module on Cloudflare", async () => {
		vi.resetModules();
		vi.doMock(
			"virtual:emdash/env",
			() => ({
				env: {
					EMDASH_OAUTH_GOOGLE_CLIENT_ID: "test-client-id",
					EMDASH_OAUTH_GOOGLE_CLIENT_SECRET: "test-client-secret",
				},
			}),
			{ virtual: true },
		);
		const { GET: startOAuthWithEnv } =
			await import("../../../src/astro/routes/api/auth/oauth/[provider].js");

		const request = new Request("http://localhost:4321/_emdash/api/auth/oauth/google");
		const response = await startOAuthWithEnv({
			params: { provider: "google" },
			request,
			locals: { emdash: { db: {} as never, config: {} } },
			redirect: (url: string) => new Response(null, { status: 302, headers: { Location: url } }),
		} as unknown as Parameters<typeof startOAuth>[0]);

		// Credentials found -- the route proceeds past the provider-configured
		// check into building the real authorization URL (which then fails on
		// the unmocked DB, but NOT with provider_not_configured or oauth_error
		// from the env-reading step itself).
		const location = response.headers.get("Location") ?? "";
		expect(location).not.toContain("error=provider_not_configured");

		vi.doUnmock("virtual:emdash/env");
	});

	it("reads provider credentials from the runtime env on Node", async () => {
		const db = await setupTestDatabase();
		const worker = (globalThis as { __vitest_worker__: { metaEnv: Record<string, unknown> } })
			.__vitest_worker__;
		const liveEnv = worker.metaEnv;
		const previousClientId = process.env.EMDASH_OAUTH_GOOGLE_CLIENT_ID;
		const previousClientSecret = process.env.EMDASH_OAUTH_GOOGLE_CLIENT_SECRET;
		try {
			// Vitest makes import.meta.env and process.env the same object, so freeze
			// the build-time env here the way a production build does.
			worker.metaEnv = { ...liveEnv };
			process.env.EMDASH_OAUTH_GOOGLE_CLIENT_ID = "runtime-client-id";
			process.env.EMDASH_OAUTH_GOOGLE_CLIENT_SECRET = "runtime-client-secret";

			const response = await startGoogle(startOAuth, db);
			const location = response.headers.get("Location") ?? "";
			expect(location).not.toContain("error=provider_not_configured");
			const authorizeUrl = new URL(location);
			expect(authorizeUrl.origin + authorizeUrl.pathname).toBe(GOOGLE_AUTHORIZE);
			expect(authorizeUrl.searchParams.get("client_id")).toBe("runtime-client-id");
		} finally {
			worker.metaEnv = liveEnv;
			if (previousClientId === undefined) delete process.env.EMDASH_OAUTH_GOOGLE_CLIENT_ID;
			else process.env.EMDASH_OAUTH_GOOGLE_CLIENT_ID = previousClientId;
			if (previousClientSecret === undefined) delete process.env.EMDASH_OAUTH_GOOGLE_CLIENT_SECRET;
			else process.env.EMDASH_OAUTH_GOOGLE_CLIENT_SECRET = previousClientSecret;
			await teardownTestDatabase(db);
		}
	});

	it("reads Cloudflare credentials when the runtime env sets a different client id", async () => {
		const db = await setupTestDatabase();
		try {
			vi.resetModules();
			vi.doMock(
				"virtual:emdash/env",
				() => ({
					env: {
						EMDASH_OAUTH_GOOGLE_CLIENT_ID: "cf-client-id",
						EMDASH_OAUTH_GOOGLE_CLIENT_SECRET: "cf-client-secret",
					},
				}),
				{ virtual: true },
			);
			vi.stubEnv("EMDASH_OAUTH_GOOGLE_CLIENT_ID", "runtime-client-id");
			vi.stubEnv("EMDASH_OAUTH_GOOGLE_CLIENT_SECRET", "runtime-client-secret");
			const { GET: startOAuthWithEnv } =
				await import("../../../src/astro/routes/api/auth/oauth/[provider].js");

			const response = await startGoogle(startOAuthWithEnv, db);
			const location = response.headers.get("Location") ?? "";
			const authorizeUrl = new URL(location);
			expect(authorizeUrl.searchParams.get("client_id")).toBe("cf-client-id");

			vi.doUnmock("virtual:emdash/env");
		} finally {
			await teardownTestDatabase(db);
		}
	});
});
