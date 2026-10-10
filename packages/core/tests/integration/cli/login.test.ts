import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const CLI_BIN = resolve(import.meta.dirname, "../../../dist/cli/index.mjs");

const API_TOKEN = "ec_pat_test";

interface CliResult {
	code: number | null;
	output: string;
}

/** An instance with external auth: discovery offers no device flow, the API accepts one token. */
function startExternalAuthInstance(): Promise<{ server: Server; authorized: string[] }> {
	const authorized: string[] = [];
	const server = createServer((req, res) => {
		const path = req.url ?? "";
		res.setHeader("content-type", "application/json");
		if (path === "/_emdash/.well-known/auth") {
			res.end(
				JSON.stringify({
					instance: { name: "Stub" },
					auth: { mode: "external", methods: { api_tokens: true } },
				}),
			);
			return;
		}
		if (req.headers.authorization !== `Bearer ${API_TOKEN}`) {
			res.writeHead(401);
			res.end(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "" } }));
			return;
		}
		authorized.push(path);
		res.end(JSON.stringify({ data: { items: [] } }));
	});
	return new Promise((done) => server.listen(0, "127.0.0.1", () => done({ server, authorized })));
}

describe("emdash login without device flow", () => {
	let workDir: string;
	let instance: { server: Server; authorized: string[] } | undefined;

	beforeAll(() => {
		workDir = mkdtempSync(join(tmpdir(), "emdash-login-"));
	});

	afterAll(() => {
		rmSync(workDir, { recursive: true, force: true });
	});

	afterEach(async () => {
		if (instance) {
			const { server } = instance;
			await new Promise<void>((done) => server.close(() => done()));
		}
		instance = undefined;
	});

	function runCli(args: string[]): Promise<CliResult> {
		const env: NodeJS.ProcessEnv = {
			...process.env,
			XDG_CONFIG_HOME: join(workDir, "config"),
			NODE_ENV: "production",
			TEST: "",
			NO_COLOR: "1",
		};
		delete env.EMDASH_TOKEN;
		delete env.EMDASH_URL;
		delete env.EMDASH_HEADERS;
		return new Promise((done) => {
			execFile(
				"node",
				[CLI_BIN, ...args],
				{ cwd: workDir, env, timeout: 15_000 },
				(error, stdout, stderr) => {
					const code = error ? (typeof error.code === "number" ? error.code : null) : 0;
					done({ code, output: `${stdout}${stderr}` });
				},
			);
		});
	}

	it("suggests an API token command that reaches the instance", async () => {
		instance = await startExternalAuthInstance();
		const baseUrl = `http://127.0.0.1:${(instance.server.address() as AddressInfo).port}`;

		const login = await runCli(["login", "--url", baseUrl]);
		const suggested = login.output.match(/\bemdash (.*<token>.*)$/m)?.[1];
		expect(suggested, login.output).toBeDefined();

		const args = suggested!
			.trim()
			.split(/\s+/)
			.map((arg) => (arg === "<token>" ? API_TOKEN : arg));
		const result = await runCli(args);

		expect(instance.authorized, result.output).not.toEqual([]);
		expect(result.code).toBe(0);
	});
});
