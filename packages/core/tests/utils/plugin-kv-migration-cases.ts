import { type Kysely, type KyselyPlugin, sql } from "kysely";
import { expect, it } from "vitest";

import { up } from "../../src/database/migrations/092_plugin_kv_options.js";

interface KvRow {
	pluginId: string;
	id: string;
	data: string;
	revision: string;
}

async function insertKv(db: Kysely<unknown>, rows: readonly KvRow[]): Promise<void> {
	for (const row of rows) {
		await sql`
			INSERT INTO _plugin_storage (plugin_id, collection, id, data, revision)
			VALUES (${row.pluginId}, '__kv', ${row.id}, ${row.data}, ${row.revision})
		`.execute(db);
	}
}

async function readOptions(db: Kysely<unknown>) {
	return (
		await sql<{ name: string; value: string; revision: string }>`
			SELECT name, value, revision FROM options ORDER BY name
		`.execute(db)
	).rows;
}

function failAfter(count: number): KyselyPlugin {
	let statements = 0;
	return {
		transformQuery: ({ node }) => node,
		transformResult: ({ result }) => {
			if (++statements === count) throw new Error("lost migration response");
			return Promise.resolve(result);
		},
	};
}

export function pluginKvMigrationCases(getDb: () => Kysely<unknown>): void {
	it("copies JSON values and revisions while preserving namespaces and backups", async () => {
		const db = getDb();
		await insertKv(db, [
			{ pluginId: "alpha", id: "config", data: '{"name":"Acme"}', revision: "rev-config" },
			{ pluginId: "alpha", id: "Settings:case", data: "false", revision: "rev-case" },
			{ pluginId: "alpha", id: "empty", data: "null", revision: "rev-null" },
			{ pluginId: "alpha", id: "settings:", data: '{"secret":true}', revision: "rev-settings" },
			{
				pluginId: "alpha",
				id: "settings:profile",
				data: '{"name":"regular"}',
				revision: "rev-profile",
			},
			{
				pluginId: "alpha",
				id: "settings_backup",
				data: '{"name":"backup"}',
				revision: "rev-backup",
			},
			{ pluginId: "beta", id: "config", data: '{"name":"Beta"}', revision: "rev-beta" },
			{ pluginId: "alpha", id: "other", data: '{"ignored":true}', revision: "rev-other" },
		]);
		await sql`INSERT INTO _plugin_storage (plugin_id, collection, id, data, revision)
			VALUES ('alpha', 'records', 'config', '{"ignored":true}', 'rev-record')`.execute(db);
		await sql`INSERT INTO options (name, value, revision)
			VALUES ('plugin:alpha:config', '{"native":true}', 'native-revision'), ('site:title', '"Site"', 'site-revision')`.execute(
			db,
		);

		await up(db);

		expect((await readOptions(db)).filter((row) => row.name.startsWith("plugin:"))).toEqual([
			{ name: "plugin:alpha:Settings:case", value: "false", revision: "rev-case" },
			{ name: "plugin:alpha:config", value: '{"native":true}', revision: "native-revision" },
			{ name: "plugin:alpha:empty", value: "null", revision: "rev-null" },
			{ name: "plugin:alpha:other", value: '{"ignored":true}', revision: "rev-other" },
			{ name: "plugin:alpha:settings_backup", value: '{"name":"backup"}', revision: "rev-backup" },
			{ name: "plugin:beta:config", value: '{"name":"Beta"}', revision: "rev-beta" },
		]);
		const legacy = await sql<{
			count: number;
		}>`SELECT COUNT(*) AS count FROM _plugin_storage`.execute(db);
		expect(Number(legacy.rows[0]?.count)).toBe(9);
	});

	it("resumes after a partially completed batch and is safe to retry", async () => {
		const db = getDb();
		const rows = Array.from({ length: 40 }, (_, index) => ({
			pluginId: index % 2 === 0 ? "alpha" : "beta",
			id: `key-${String(index).padStart(2, "0")}`,
			data: JSON.stringify({ index }),
			revision: `revision-${index}`,
		}));
		await insertKv(db, rows);
		await sql`INSERT INTO options (name, value, revision)
			VALUES ('plugin:alpha:key-00', '{"index":"before"}', 'current-revision'), ('site:title', '"Current site"', 'site-revision')`.execute(
			db,
		);

		await expect(up(db.withPlugin(failAfter(3)))).rejects.toThrow("lost migration response");
		await sql`UPDATE options SET value = '{"index":"updated"}', revision = 'updated-revision'
			WHERE name = 'plugin:alpha:key-00'`.execute(db);
		await up(db);
		const migrated = (await readOptions(db)).filter((row) => row.name.startsWith("plugin:"));
		expect(migrated).toHaveLength(rows.length);
		expect(migrated.find((row) => row.name === "plugin:alpha:key-00")).toEqual({
			name: "plugin:alpha:key-00",
			value: '{"index":"updated"}',
			revision: "updated-revision",
		});
		expect((await readOptions(db)).find((row) => row.name === "site:title")).toEqual({
			name: "site:title",
			value: '"Current site"',
			revision: "site-revision",
		});
		expect(migrated.map((row) => row.name)).toEqual(
			rows
				.toSorted((a, b) => a.pluginId.localeCompare(b.pluginId) || a.id.localeCompare(b.id))
				.map((row) => `plugin:${row.pluginId}:${row.id}`),
		);
		await up(db);
		expect((await readOptions(db)).filter((row) => row.name.startsWith("plugin:"))).toEqual(
			migrated,
		);
	});
}
