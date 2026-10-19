---
"emdash": patch
"@emdash-cms/cloudflare": patch
"@emdash-cms/sandbox-workerd": patch
"@emdash-cms/plugin-test": patch
---

Fixes `ctx.kv` values disappearing when a plugin with the same ID moves between `plugins: []` and `sandboxed: []`. Both sandbox runners share the in-process KV store, and a database migration copies existing non-`settings:` sandbox values and revisions without overwriting in-process values. Original sandbox rows are retained for recovery.

Uninstalling a marketplace or registry plugin with data deletion also removes its shared KV values and settings. Plugin-test KV fixtures and inspection use the shared store; use the settings inspection API for `settings:` keys.

Upgrade `emdash` and your sandbox runner together, stop older instances from writing during the upgrade, and apply database migrations before resuming plugin writes. See the [plugin upgrade guide](https://docs.emdashcms.com/plugins/upgrading-sites/#plugin-kv-storage-when-changing-execution-mode) for conflict handling and rollout details.
