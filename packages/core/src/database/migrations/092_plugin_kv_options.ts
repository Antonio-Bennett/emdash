import { sql, type Kysely } from "kysely";

interface PluginKvMigrationTables extends Record<string, Record<string, unknown>> {
	_plugin_storage: {
		plugin_id: string;
		collection: string;
		id: string;
		data: string;
		revision: string;
	};
	options: {
		name: string;
		value: string;
		revision: string;
	};
}

// Each inserted row binds three values; D1 permits 100 parameters per statement.
const BATCH_SIZE = 33;

export async function up(db: Kysely<unknown>): Promise<void> {
	const typedDb = db.withTables<PluginKvMigrationTables>();
	let cursor: { pluginId: string; id: string } | undefined;

	while (true) {
		let query = typedDb
			.selectFrom("_plugin_storage")
			.select(["plugin_id", "id", "data", "revision"])
			.where("collection", "=", "__kv")
			.where(sql<boolean>`substr(id, 1, 9) <> 'settings:'`)
			.orderBy("plugin_id", "asc")
			.orderBy("id", "asc")
			.limit(BATCH_SIZE);

		const currentCursor = cursor;
		if (currentCursor) {
			query = query.where((eb) =>
				eb.or([
					eb("plugin_id", ">", currentCursor.pluginId),
					eb.and([eb("plugin_id", "=", currentCursor.pluginId), eb("id", ">", currentCursor.id)]),
				]),
			);
		}

		const rows = await query.execute();
		if (rows.length === 0) return;

		await typedDb
			.insertInto("options")
			.values(
				rows.map((row) => ({
					name: `plugin:${row.plugin_id}:${row.id}`,
					value: row.data,
					revision: row.revision,
				})),
			)
			.onConflict((oc) => oc.column("name").doNothing())
			.execute();

		const last = rows.at(-1);
		if (!last) return;
		cursor = { pluginId: last.plugin_id, id: last.id };
	}
}

export async function down(_db: Kysely<unknown>): Promise<void> {
	// Forward-only data migration; legacy storage remains available as a backup.
}
