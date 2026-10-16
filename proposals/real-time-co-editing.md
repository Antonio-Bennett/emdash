---
title: Real-time co-editing
type: rfc
status: proposed
authors:
  - Noah Pham (@khoinguyenpham04)
champion: Noah Pham (@khoinguyenpham04)
sponsor: null
discussions:
  - https://github.com/emdash-cms/emdash/discussions/4173
created: 2026-10-16
---

# Real-time co-editing

> **Draft.** Open before acceptance: a Maintainer sponsor, and the prototype results in [Open questions](#open-questions).

## Summary

This RFC adds real-time co-editing to the admin entry editor. Several people edit one entry at the same time, see each other's presence and cursors, and undo only their own edits.

- **Rooms.** Each entry being co-edited has one room: a stateful server-side object that holds the entry's authoritative Yjs document. It is a Durable Object on Cloudflare Workers, and an in-process object on Node.js. Browsers keep replicas and exchange Yjs updates with it.
- **Logged before shared.** The room checks each update against the collection's fields, the editor schema and the sender's access, and logs it durably before applying, broadcasting or acknowledging it.
- **Checkpoints.** Shortly after editing stops, the room saves its document as the entry's draft revision through the existing save path, hooks and validation included. Stored content stays Portable Text, and revisions remain the record.
- **Merging.** Concurrent edits to rich-text and plain-text fields merge. Other fields are single values. While someone changes one, an advisory field lease shows it read-only to everyone else.
- **Out-of-band writes.** REST, CLI and MCP writes keep getting `409 ENTRY_LOCKED`. Plugins, scheduled publishing, the visual editor and `overrideLock` requests write through the room.

Publishing stays one operation, by someone with publish permission. Co-editing is experimental and opt-in, and covers only collections with revisions. Agents as co-editors, comments and suggestions are out of scope.

## Problem and user case

Only one person can edit an EmDash entry at a time. Edit locking ([Discussion #2819](https://github.com/emdash-cms/emdash/discussions/2819)) is on by default. It gives the first person to open an entry the lock, and everyone else gets **Open read-only** or **Take over**. When locking is off, or between two tabs of one user, a save based on an older `_rev` is refused, and **Save anyway** overwrites the newer content. Nothing merges. Teams take turns, or paste from another tool and lose Portable Text structure.

The Ideas Discussion ([#4173](https://github.com/emdash-cms/emdash/discussions/4173)) asked for:

- the whole entry form;
- presence;
- merging;
- per-person undo;
- short disconnects;
- deliberate publishing.

A reply asked who is responsible when one publish includes several people's edits. The publish dialog names them ([Operations](#operations)).

### Prior art

WordPress built co-editing for 7.0 with browsers merging Yjs updates and the server relaying them. It removed the feature before release, citing "surface area, race conditions, server load, memory efficiency, and recurring bugs found through fuzz testing" ([removal post](https://make.wordpress.org/core/2026/05/08/rtc-removed-from-7-0/)). Its next design has the server record, authorize, merge and store every update ([server-aware post](https://make.wordpress.org/core/2026/09/18/moving-to-a-server-aware-approach-for-collaboration/)).

The failures reported in Yjs-based editors came from the code around the CRDT:

- a save response written back into the document reverted peers' edits ([Gutenberg #79936](https://github.com/WordPress/gutenberg/pull/79936));
- a revision restore wiped blocks for everyone ([#75233](https://github.com/WordPress/gutenberg/pull/75233));
- multi-instance fan-out deleted content on stale replicas ([Hocuspocus #1151](https://github.com/ueberdosis/hocuspocus/issues/1151));
- the ProseMirror binding deletes content that concurrent edits make schema-invalid ([y-prosemirror #258](https://github.com/yjs/y-prosemirror/issues/258), [#275](https://github.com/yjs/y-prosemirror/issues/275)).

This design puts the room in every write path, and specifies that surrounding code.

## Example

Ana (Editor role) opens the post "Spring launch", which Ben (Author role) already has open. Ana sees Ben's avatar in the header and his named cursor in the body.

Ana edits the title while Ben rewrites the second paragraph, and each sees the other's typing as it happens. While Ana has the featured image picker open, Ben's editor shows "Ana is editing this field." on it. Ana's Wi-Fi drops for twenty seconds. Her header shows "Reconnecting…" and she keeps typing. When the connection returns, her edits merge and the header shows "Saved".

Ana publishes. The dialog says "Publishing includes changes from Ben." Ben sees "Ana published this entry." and keeps writing, and his new edits are unpublished changes.

A script with an API token tries to update the post meanwhile. It gets today's lock error, which now lists the co-editors:

```json
{
	"success": false,
	"error": {
		"code": "ENTRY_LOCKED",
		"message": "Ben Ito and Ana Lima are editing this entry",
		"details": {
			"userId": "01JB7C4D5E6F7G8H9J0K1M2N3P",
			"userName": "Ben Ito",
			"acquiredAt": "2026-10-16T09:12:04.000Z",
			"expiresAt": "2026-10-16T09:19:04.000Z",
			"editors": [
				{ "userId": "01JB7C4D5E6F7G8H9J0K1M2N3P", "userName": "Ben Ito" },
				{ "userId": "01JB3M2V8Q0F6K7R9T1W4X5Y6Z", "userName": "Ana Lima" }
			]
		}
	}
}
```

On Node.js, one option turns co-editing on. Cloudflare sites also bind and export the room class ([Configuration and protocol](#configuration-and-protocol)).

```js
import emdash, { inProcessRooms, local } from "emdash/astro";
import { sqlite } from "emdash/db";

emdash({
	database: sqlite({ url: "file:./data.db" }),
	storage: local({ directory: "./uploads", baseUrl: "/_emdash/api/media/file" }),
	experimental: { coEditing: inProcessRooms() },
});
```

## Goals

- **Concurrent editing.** Co-editors change one entry at once, even the same paragraph, and every replica converges. [The shared document](#the-shared-document) lists the edits that keep only one change.
- **Visible collaboration.** Remote edits and cursors render within 500 ms at the 95th percentile.
- **No lost acknowledged edits.** Acknowledged updates survive disconnects, restarts, deploys and evictions. "Saved" means the room has logged every update from the client, whether or not a checkpoint has saved it yet.
- **Short disconnects.** A client out of contact for under 30 minutes merges its offline edits on reconnect. Edits that can't merge become a recovery revision.
- **Per-client undo.** Undo and redo revert only the client's own edits.
- **Server authority.** The room authorizes and logs every update with its sender, and each revision records everyone whose edits it contains.
- **Deliberate publishing.** Publish is one operation by someone with publish permission. It includes every edit in the publisher's client when they click, or it fails.
- **Same hosts as EmDash:** Cloudflare Workers and single-process Node.js, with no third-party service and no Cloudflare code in `emdash`.
- **Safe fallback.** Without a room, clients use today's edit lock or open read-only.
- **No visitor cost.** Logged-out routes run no additional queries.
- **Accessible.** Presence and status follow the admin's localization, RTL and accessibility rules.

## Non-goals

- **Agents and API callers as co-editors.** They keep getting `ENTRY_LOCKED`, and `overrideLock` is their only way in. Agent presence, merged API writes and suggestions need a follow-on RFC. Plugins keep writing without a lock, through the room.
- **Comments, suggestions, tracked changes and approval workflows.**
- **Long offline editing:** disconnects over 30 minutes, or edits that survive a browser restart.
- **Co-editing in the visual editor.** Its saves merge through the room, but it shows no presence or remote typing.
- **Several Node.js processes, and serverless hosts.**
- **Character-level merging of every field.** Numbers, dates, selects, media, references, JSON and plugin widgets are single values.
- **Word-level attribution.** Revisions record who edited them, not who wrote each word.
- **Co-editing outside entries:** schemas, menus, taxonomies and site settings.
- **A new storage format.** Yjs state is never stored as content.
- **Unlimited capacity.** Rooms have [limits](#appendix-b-limits), and the Workers Free plan covers about three hours of continuous co-editing a day ([Performance](#performance)).
- **On by default for existing sites.** That needs evidence from the experimental period, and its own proposal.

## Detailed design

This section is the design. [Appendix A](#appendix-a-implementation-reference) specifies each mechanism in detail.

### Terms

| Term | Meaning |
| --- | --- |
| Room | The server-side authority for one entry row (each locale is a row): an `EmDashRoom` Durable Object on Workers, an in-process object on Node.js. It holds the shared document, the update log, presence and the operation queue. |
| Room states | **Active:** a co-editor is connected, and the room holds the entry's edit lock. **Draining:** no co-editor is connected; the room keeps the lock until its final checkpoint is stored or rejected. **Read-only:** co-editors are connected, but the room couldn't claim the lock, so it serves everyone read-only and retries the claim every 2 minutes. **Idle:** no lock, and no co-editor. |
| Participant | A person connected to a room, over a WebSocket on Workers or as a [member](#runtime-hosts) on Node.js: a **co-editor**, with write access (`edit` or `edit-draft`), or a **viewer**, with `view` access. A co-editor made read-only follows the viewer rules: its updates are refused, it shares no cursor, its `editing` is stripped, it doesn't count toward the Active or Draining states or `editors`, and a full room can bump it. |
| Client | One admin editor instance, usually a tab, replicating the shared document under its own Yjs client ID |
| Shared document | The room's authoritative `Y.Doc`. Clients replicate it by exchanging Yjs **updates**. |
| Update log | The room's durable, append-only log of updates, plus compacted state |
| Epoch | A random ID for one unbroken lineage of a shared document. Only **initialization** from stored content starts one. |
| Checkpoint | Saving the shared document as the entry's draft revision through the normal save path. The revision records its **checkpoint position** (epoch and log position); updates up to it are **covered**. A **retained** checkpoint (`reason: save`) isn't replaced by later automatic ones. |
| Expected revisions | The `draft_revision_id` and `live_revision_id` pair the room last confirmed. Checkpoints commit only while the entry still has it. |
| Merge base | The content a writer started from. For changes found in storage, it is the stored content of the expected revisions, after hooks. The room also keeps the pre-hook content of its last checkpoint ([merge rules](#out-of-band-writes)). |
| Three-way merge | `diff3(merge base, room document, writer's content)`, applied as a **server update**: one the room authors under its own client ID, logged like any other and on no undo stack |
| Field lease | An advisory claim, from presence, by one co-editor on a single-value field or a `blocks` or `repeater` item |
| Room lock, fallback lock | Today's per-entry edit lock (`_emdash_entry_locks`), held by a room or by a client in [fallback](#fallback) |
| Recovery revision | A `recovery` revision, never the draft or live one. A **client** one holds edits a client couldn't apply; a **room** one holds the room's document when a checkpoint it needed was rejected. |

"The editor" is the admin editor. Editor, Author and Contributor are roles, and "live" means published.

### Architecture

```
 Clients (admin editor tabs)
     │  Yjs updates: WebSocket on Workers; event stream + POST on Node.js
     ▼
 Room (one per entry): check → append to update log → apply → broadcast → acknowledge
     │  checkpoint                                ▲  read the entry, compute access
     ▼                                            │
 EmDash runtime: hooks, validation, revisions, edit lock
     │
     ▼
 Draft revision ── Publish ──▶ live revision
```

The room is not a store of record. Its log keeps acknowledged updates durable until a checkpoint covers them, and REST, MCP and page rendering read the latest checkpoint.

Constraints from the current code:

- **Saves replace whole fields.** Autosave sends the whole form 2 s after typing stops, and `EmDashRuntime.handleContentUpdate` merges it into the draft by top-level field.
- **The rich-text editor reads its value once,** when it mounts. It doesn't write the keys of new or split blocks back into the document.
- **The edit lock belongs to a user, not a tab,** and applies only while the collection's `editLocking` is on. Plugin `ctx.content.update`, scheduled publishing and sibling-locale sync don't check it.
- **There are three Portable Text converters,** in the admin editor, the visual editor and core. The visual editor gives blocks random keys on every save.
- **The admin has no push channel,** and Astro has no WebSocket API ([withastro/roadmap#695](https://github.com/withastro/roadmap/discussions/695)).

### Lifecycle

1. **Join.** The editor calls the join route and connects. The first co-editor makes the room claim the entry's edit lock, then resume its update log or initialize a new epoch from stored content ([Joining a room](#joining-a-room), [The room lock](#the-room-lock)).
2. **Edit.** The room checks, logs, applies, broadcasts and acknowledges each update ([Updates and protocol](#updates-and-protocol)).
3. **Checkpoint.** Shortly after updates stop, the room saves its document as the draft revision, but only while the entry's revisions still match its expected revisions ([Checkpoints](#checkpoints)).
4. **Operate.** Publish and the other operations run one at a time inside the room, each after a retained checkpoint ([Operations](#operations)).
5. **Recover.** A client that reconnects within 30 minutes merges. Edits that can't merge become recovery revisions ([Reconnection and recovery](#reconnection-and-recovery)). A client that can't reach the room falls back to the edit lock ([Fallback](#fallback)).
6. **Drain.** When the last co-editor leaves, the room writes a final checkpoint and releases the lock. It deletes its state once a checkpoint covers the log and an hour has passed with no connections.

### Guarantees

1. **One room per entry.** Workers runs one Durable Object per name. On Node.js, every checkpoint checks the room lock's fencing token.
2. **Logged before shared.** No update reaches the room's document, another client or an acknowledgement before its log append commits.
3. **Acknowledged updates survive** restarts, deploys and evictions. If the log is lost, the latest checkpoint is the floor, and clients save acknowledged updates past it as client recovery revisions.
4. **Unacknowledged updates stay in the client.** The client resends them, and asks before the tab closes.
5. **Only the room initializes,** once per epoch. Within an epoch it never initializes again, and it refuses updates from other epochs.
6. **No checkpoint over unseen writes.** A checkpoint commits only while the entry's revisions equal the expected revisions. Otherwise, the room merges what is stored first.
7. **Lossless round trip.** Portable Text to shared document and back changes nothing. Unknown blocks and marks load as placeholders.
8. **Clients never repair shared content.** A client assigns keys and normalizes only nodes its own transaction creates. The room makes every other repair, as a server update.
9. **Every update is authorized.** Only co-editors' updates are accepted. A refused update closes its connection, and the client discards its replica.
10. **Undo is per client.** Undoing an inserted block also removes what others typed inside it.
11. **Restore and discard move forward,** as server updates in the current epoch, after the replaced content is saved as a revision.

### The shared document

The shared document has one top-level key per field, plus the slug and the staged references. Fields inside `blocks` and `repeater` items use the same mapping.

| Field | Yjs type | Concurrent edits |
| --- | --- | --- |
| `portableText` | `Y.XmlFragment`, bound to TipTap by `@tiptap/extension-collaboration` and `@tiptap/y-tiptap` (both MIT) | Merge. Every concurrent insertion is kept, so two replacements of the same word both appear. |
| `string`, `text` | `Y.Text` | Merge, as above |
| `blocks`, `repeater` | A `Y.Map` of items by identity. Each item is a `Y.Map` of its fields, plus a fractional position. | Edits to different items merge. A move changes only the position, and never deletes. Concurrent moves keep one position. |
| References, the slug and every other type, including plugin widgets | One value | One value survives. Every replica picks the same one, by Yjs client ID, not by time. |

- **Slug.** While the entry has never been published and its slug equals its slugified title, the slug stays unset in the document. Clients show `slugify(title)`, and checkpoints store it. Setting any other slug ends this, and so does publishing: on resume, after each operation and on each out-of-band notification, a room that finds its entry published with the slug unset writes the stored slug into the document as a server update. Today, the slug stops following the title when the editor reloads.
- **Settings-panel fields** stay outside the document, and save through their routes. They are SEO, bylines, the entry author, the publication date and taxonomy terms. The room announces each change.
- **Keys.** The client that creates a Portable Text node assigns its `_key` (`emdashPortableTextKey`) in the same transaction, including on split and paste. The room replaces any duplicates that merges leave. `blocks` items use their stored `_key`. Repeater items and keyless `blocks` items get an identity for the epoch, which is never stored.
- **Field leases.**
  - A co-editor's client sets `editing` in its presence while the person changes a single-value field or has its picker open.
  - The lease ends when they leave the field, 30 s after their last activity in it, or 5 s after they disconnect. The room computes expiry, and strips `editing` from viewers.
  - Leases also cover settings-panel fields and whole `blocks` and `repeater` items.
  - Clients show leased fields read-only, and disable removing or moving leased items. The room doesn't enforce leases, so an update that ignores one resolves as single values do.
- **Edits that keep one change.** These commands replace a block's `Y.XmlElement`, so concurrent typing in the block is lost:
  - "Turn into";
  - dragging the block by its handle;
  - deleting it;
  - adding table rows or columns.

  If another client's cursor is in the block, the command asks for a second activation. Overlapping marks combine. One mark with two values, such as two `href`s, resolves to one, and so do concurrent edits to one plugin block's attributes, which are one opaque value.
- **Undo.** Rich text uses `Y.UndoManager`, tracking only the client's local origin, in place of ProseMirror history, including slash commands and block insertion. Plain-text fields get their own undo, because programmatic updates break the browser's.
- **Presence** is Yjs awareness. Each client shares its field and, in text, its cursor and selection. The room overwrites the `user` fields (ID, name and color) from the session on every message. Viewers share no cursor. The presence UI follows the admin's existing patterns, and its design is left to the implementation.

### Out-of-band writes

| Writer | While the room holds the lock (active or draining) |
| --- | --- |
| Clients in the room | Send updates instead of autosaves |
| SEO, byline and publication-date saves | Today's SEO and publication-date requests, plus a new bylines-only request instead of riding the autosave. All three use the content `PUT` without `_rev`, carrying `X-EmDash-Room-Connection`, `X-EmDash-Room-State` and only these fields, and SEO sends only changed settings. Each waits behind operations and for the caller's updates, writes no checkpoint, and ends with the room re-reading the entry. |
| Author changes | An operation |
| Taxonomy terms | Save at once, as today |
| Admin tabs outside the room (opened before co-editing was on, or in fallback) | `ENTRY_LOCKED`; reloading joins the room |
| REST, CLI and MCP with API tokens | `ENTRY_LOCKED`, co-editors' own tokens included |
| `overrideLock: true` requests | An operation. A content write saves a retained checkpoint, applies the sent fields as a replacement attributed to the caller, checkpoints with hooks, and returns the stored entry. |
| Plugin `ctx.content.update` | A replacement of the sent fields, logged with the plugin as sender. It returns once logged, with the entry as the room holds it, and triggers no checkpoint; the next one includes it and runs hooks. Its `seo` part saves immediately. |
| Plugin `ctx.content.delete`, publish and other actions | Operations |
| Plugin editor panels and actions | One undoable client edit, applied when the person confirms the panel, and refused if a patched field changed since the panel opened |
| Scheduled publishing (`publishDueContent`) | An operation with no caller to wait for. If the room is unreachable, the scheduler publishes the latest checkpoint, and the room rechecks access when it next reads the entry. |
| Visual editor | Each single-field save is a three-way merge against the value it loaded |
| Sibling-locale sync on publish | Writes the siblings' live content and undiverged draft fields, as today, then notifies their rooms with `after()`, and they merge the change |
| `emdash seed --on-conflict update` (local SQLite) | Skips entries a room holds |
| Duplicate, translation create, imports of new entries, restore from Trash | Unaffected |

When the room is idle, out-of-band writes succeed as today. The route then notifies the room with `after()`, and the room merges the write so that viewers see it.

Three-way merges follow these rules:

- **Rich text.** Blocks align by `_key`. Writers that assign new keys, which are MCP's Markdown path and the visual editor, align by an LCS diff over block text instead. Text inside aligned blocks merges by character.
- **Single values.** A value changed on one side takes that side's value. If both sides changed it, the room's value stays.
- **Replacements.** Writers without a merge base use the room's document as the base, so their fields replace the current values. These writers are plugins, `overrideLock`, restore and discard.
- **Hooks.** The room keeps the content it sent to its last checkpoint, before hooks. Where a hook rewrote a block or a single-value field, the room's changes are judged against that pre-hook content, and that block or field merges as a single value; if neither side changed it, the room's value stays. The rest of the field merges as usual, and merges never bring the room's own hook output into the document.
- **Lost conflicts.** If any part of a visual-editor save loses a conflict, nothing applies, and the save returns `409 CONFLICT`. A stored change that loses stays in Revisions, as the revision its writer saved.
- **Identity.** Unchanged blocks keep their identity, and applying a merge twice produces an empty update.
- **No loops.** Plugin updates never trigger checkpoints, so a hook that writes the entry it is saving can't loop.

### Plugin contract

- **Widgets.** Field widgets receive `readOnly` and `leasedBy` (the lease holder's ID and name) along with the props `ContentEditor` passes today (`value`, `onChange`, `label`, `id`, `required`, `options`, `validation`, `minimal`). Sandboxed widgets, rendered through `BlockKitFieldWidget`, get them too. Focus inside a widget sets `editing` for its field. When another client changes the field, the editor remounts the widget unless it has focus.
- **Blocks.** An edit from `PluginBlockModal` applies to the block with its `_key`, not to the position the editor captured when the modal opened (`editingBlockPosRef`). If that block is gone, the edit is refused. The image and gallery sidebar shows remote attribute changes as they arrive.
- **Hooks.** `ContentHookEvent` gains `editedBy` and `isAutosave`, which is true for automatic checkpoints and today's autosaves. A checkpoint's `actor` can differ from its revision author.

### Permissions

- **Access.** A connection belongs to the session that joined it. The ticket on Workers, or the session cookie on Node.js, proves identity only. The room computes access from the site database:
  - `edit`: `entryEditAccess` returns `full`, through `content:edit_own` on the person's own entries or `content:edit_any`;
  - `edit-draft`: `entryEditAccess` returns `draft`, through `content:edit_own_drafts` on the person's own entries in draft status, as Contributors have;
  - `view`: `content:read_drafts`, checked separately;
  - otherwise refused.
- **Rechecks.** The room rechecks a connection's access, including disabled accounts, on its first message once 60 s have passed since its last check, and right after any operation that changes the entry's status or author. Clients renew their presence at least once a minute, so every live connection is rechecked within 2 minutes.
- **Account changes.** Logout, disabling a user and changing a user's role notify the user's rooms through the registry. Those rooms downgrade or close the user's connections, and a missed notification applies at the next recheck.
- **Credential renewal.** Every 15 minutes, a Workers client sends a fresh ticket from the join route over its socket. The room closes any connection that hasn't presented a valid ticket in the last 16 minutes. On Node.js, every `POST` carries the session cookie, and the room closes event streams after 15 minutes. Clients reopen them.
- **Losing write access** makes the client read-only. Unacknowledged edits become a client recovery revision if the recovery route still accepts the person. Otherwise they stay in the tab, to copy.

## Compatibility and migration

Co-editing stays off until a site configures it, so upgrading changes nothing. Once a site turns it on:

| Who | What changes |
| --- | --- |
| Admin users | Opening an entry joins its room. **Take over** appears only in fallback. |
| Site owners | One option on Node.js. On Cloudflare, also a binding, a migration and an export. Node.js sites with several processes should leave co-editing off. |
| Plugin authors | [Out-of-band writes](#out-of-band-writes) and [Plugin contract](#plugin-contract) |
| API and MCP callers | Writes get `ENTRY_LOCKED` while a room holds the lock, even from co-editors' tokens, and `details` gains `editors`. `overrideLock` requests run as operations. Reads return the latest checkpoint: normally under 30 s old, but older while checkpoints are rejected or fenced. |
| Contributors | They co-edit their own entries in draft status, and become read-only before a status or author change |

- **Migrations** are forward-only and additive, with no content-sized backfill.
- **Turning co-editing off** checkpoints and closes rooms, and clients reload into the edit lock. Before downgrading EmDash, turn co-editing off and wait for the registry to empty, because older versions can't read room state. The new columns and tables then sit unused.
- **Site transfer.** Collection records gain `coEditing`, exported only when `false`, and revision records gain `reason`, `editedBy` and the checkpoint and recovery fields. `editedBy` IDs are remapped as a list of principals, like revision authors. The records are strict objects, so a package that uses these fields declares a new `co_editing` feature as required, and older readers refuse it with `TRANSFER_UNSUPPORTED_FEATURE` instead of failing validation. Room state is never exported.
- **Readable revision history** is amended in the same design PR. **Deprecations:** none.

## Security and privacy

| Party | Trusted for |
| --- | --- |
| Client | Nothing. The room checks every update. |
| Room | Holding the shared document and enforcing access. It runs only EmDash code. |
| Runtime | Hooks, validation, permissions and saving, as today |

- **Joining** uses the admin session and `X-EmDash-Request`, and refuses API tokens.
- **Tickets.** WebSocket upgrades can't carry that header, so they present a single-use, 60-second ticket bound to one person, session and entry. The Worker verifies it and checks `Origin` before any Durable Object exists ([Runtime hosts](#runtime-hosts)).
- **Node.js** connections use the session cookie, and every `POST` needs `X-EmDash-Request`.
- **Connection IDs** are random and never broadcast. A route accepts one only on a session request from the person whose session owns a connected co-editor in that room.
- **Crafted updates** fail the [checks](#updates-and-protocol) before they are logged, so they can't plant content that makes other clients' bindings delete content.
- **Revocation** is weaker than REST's check on every request: a missed role change applies within 2 minutes, and a connection can outlive its session by up to 16 minutes.
- **Attribution.** The log records every update's sender, and automatic checkpoints give hooks the least-privileged recent co-editor as the actor. A plugin that trusts the actor's role can't be used to pass one person's content off as another's.
- **Abuse.** Limits apply per person to rooms and connections, per connection to the update rate, and per process on Node.js. `dailyRowBudget` caps writes on Workers.
- **Privacy.** Anyone who can open an entry sees who else has it open, including viewers, but `ENTRY_LOCKED` names only co-editors. The log keeps recent updates with user IDs until compaction, and is deleted once covered and an hour after the room's last connection closes. Garbage collection drops deleted text, so later viewers never receive it. Cursor positions are never stored, and logs carry IDs, epochs and positions, never content, names, tickets or headers.
- **Content** gets today's validation and render-time sanitization. Co-editing adds no new way to store HTML or code.

## Performance

- **Logged-out pages** are unchanged. Checkpoints write only draft revisions, which purge no route cache (`liveContentChanged`), and core search's FTS triggers skip them. Settings-panel saves purge the cache as today. The Cloudflare AI Search plugin's `content:afterSave` hook syncs on every save of a draft or scheduled entry, so it skips `isAutosave` events.
- **Opening an entry** adds a join request and a connection. A checkpoint costs about what an autosave costs today.
- **Cloudflare.**
  - Durable Object pricing counts every stored batch, deletion, alarm and nonce as a row written ([pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)).
  - Continuous typing in one room writes about 30,000 rows an hour, including compaction and the merge base logged at each checkpoint.
  - The Free plan's 100,000 rows a day per account cover about three hours of continuous typing, and the Paid plan includes 50 million a month.
  - Incoming WebSocket messages are billed as requests, at 20:1, including the presence renewals each client sends at least once a minute, which also wake the room.
  - The registry adds about two D1 writes per checkpoint cycle, and one per join or departure.
- **Node.js** keeps rooms with connections in memory, and unloads a room once it has no connections and its log is covered.
- **Browsers** load the co-editing code only when it is active.

## Failure handling

| Failure | What clients see | What happens |
| --- | --- | --- |
| A log write fails | "Not saved. Don't close this tab." | On Workers, the Durable Object aborts and restarts. On Node.js, the room stops acknowledging. Clients resend. |
| The Durable Object write quota or `dailyRowBudget` runs out | A notice that co-editing paused, then the edit lock | Rooms checkpoint and close, unacknowledged edits become client recovery revisions, and the edit lock applies until the next UTC day |
| The log is lost or unusable | Recovery revisions | A new epoch from the latest checkpoint |
| Validation or a hook rejects a checkpoint | "Draft not updated", naming the field but never a person | The room stays editable, and retries at its next checkpoint trigger, or with backoff once draining ([Checkpoints](#checkpoints)) |
| The site write fence is closed | "Draft not updated" | Checkpoints wait |
| The entry is trashed outside the room | Read-only | The checkpoint fails, so the room writes a room recovery revision and closes. Reopening the entry starts a new epoch. |
| A client and the room diverge | Nothing | After each initial sync, the client compares a Portable Text hash with the room's. A mismatch forces a full resync, and is logged. |
| Two Node.js processes compete for a room | The second shows the entry as edited elsewhere | The fencing token stops the stale process from checkpointing |

When the checkpoint before an operation is rejected:

- publish, schedule, **Save version**, preview, author changes and `overrideLock` writes fail;
- unpublish and unschedule go ahead;
- restore, discard and **Move to Trash** write a room recovery revision first;
- scheduled publishing uses the latest successful checkpoint.

A rejected final checkpoint releases the lock, but the room keeps its state. Out-of-band writes merge in, and the next co-editor resumes the room. Before any close or new epoch, a rejected checkpoint produces a room recovery revision.

Rooms log with the `[co-editing]` prefix. Operators turn co-editing off with the site option or per collection, and recover content from **Revisions**.

## Verification

- **Unit and property tests** cover the room logic, update checks, field mapping, three-way merges (including applying one twice), the checkpoint precondition and the Portable Text round trip.
- **A fixed-seed convergence harness,** modeled on Yjs's test helper, runs clients and a room through random edits and delivery orders, drops, reconnects, restarts, storage failures, and a malicious peer that sends well-formed updates that fail the checks and updates under other clients' IDs. Each run asserts that every replica matches the room, the schema is valid, Portable Text round-trips, no acknowledged text is lost except through an attributed edit, and honest clients delete nothing because of the malicious peer.
- **Integration tests** cover every [out-of-band writer](#out-of-band-writes), on SQLite, libSQL and PostgreSQL.
- **workerd tests** cover logging before sharing, aborts on failed writes, hibernation, eviction and quota errors.
- **Playwright tests,** with several browser contexts, cover the [Example](#example), two tabs, a viewer, a Contributor downgraded by a publish, restore and discard during edits, being offline past the window, an out-of-date client, fallback, and API, MCP and plugin writes.
- **A manual pass** uses a screen reader and a keyboard, in Arabic, in dark mode, at phone width and with reduced motion.

Co-editing becomes stable when all of these hold:

- 100,000 harness runs pass, and the harness runs nightly in CI.
- 10,000 consecutive checkpoints on sites the maintainers run pass the round-trip check. Development builds check every checkpoint.
- Remote edits render within 500 ms at the 95th percentile, from the sender's transaction to the receiver's render, with both clients near the Durable Object.
- A person editing alone sees no warning for drops shorter than 5 s.

## Rollout and implementation

1. **Prerequisites:**
   - the autosave fix;
   - one DOM-free editor schema and Portable Text converter, shared by the admin editor, the visual editor and the room;
   - TipTap packages upgraded together, so that `@tiptap/extension-collaboration` matches the editor (3.27.0 against 3.20.0 today).
2. **Rooms:** both hosts, the update checks, the room lock, the join route and presence.
3. **The editor and every writer:**
   - bindings, leases, undo, status and recovery;
   - routes, plugins, the scheduler and the visual editor, through the room.
4. **Hardening:** [Verification](#verification), docs with a plugin section, and templates.

Co-editing ships behind `experimental.coEditing`. New templates turn it on once the stable criteria pass.

## Alternatives

| Alternative | Why not |
| --- | --- |
| **Improve the edit lock,** with presence and a faster take-over | People would still edit one at a time, and the Discussion asks for simultaneous editing |
| **Merge whole saves on the server,** three ways | Nobody sees anyone else's work until they save, and conflicts still reach people at save time |
| **Relay-only or peer-to-peer sync** | The server can't authorize, attribute or validate updates, and out-of-band writers can't take part. WordPress removed this design. |
| **A central-authority engine** that orders and transforms ProseMirror steps, like prosemirror-collab editors such as Confluence | EmDash would build cursors, presence and per-person undo itself, and transform on the server so slow clients aren't starved ([Marijn Haverbeke](https://marijnhaverbeke.nl/blog/collaborative-editing-wordgard.html)). It is the fallback if the schema-safety gate fails, and would change only the room logic and the editor binding. |
| **A hosted service,** such as Liveblocks or Tiptap Cloud | Every site would depend on a vendor and an account |
| **Hocuspocus or y-partyserver as the room** | Both store updates on a debounce (2 s, at most 10 s), so a crash loses that window. y-partyserver also rebuilds from clients after waking, has no epochs, and offers only a per-connection read-only hook. EmDash would still build everything around the CRDT. |
| **Share rich text only, and lock other fields** | One entry would have two write paths, and two people couldn't edit the title at once |
| **Store the Yjs document as content** | Rendering, REST, MCP, search and site transfer read Portable Text. Switching would break stored data, and tie content to one library. |
| **Automerge or Loro** | Their ProseMirror bindings are pre-1.0, and TipTap's binding uses Yjs |
| **Polling on Node.js** | Polling costs requests even for one person editing alone. WordPress measured 840 requests and about 5,000 queries an hour, polling every 4 s ([presence-api #444](https://github.com/WordPress/presence-api/issues/444)). |

## Drawbacks

- **New infrastructure.** Sites get a Durable Object binding on Cloudflare, and in-process state on Node.js. Mitigation: templates configure it, and without a room, clients fall back.
- **Implementation cost.** Two hosts, a binding for each field type, the update checks, a protocol and a fuzz harness. Mitigation: both hosts share the room logic.
- **Merge limits.** Some concurrent edits keep only one change ([The shared document](#the-shared-document)).
- **Room storage outside D1 on Cloudflare.** It isn't in D1 exports, so revisions remain the record.

## Open questions

Before acceptance, the prototype must pass these gates:

- **Round trips.** Every node, mark and plugin block that EmDash ships, and every template's seed content, survives Portable Text → editor → shared document → Portable Text unchanged.
- **Schema safety.** With the co-editing schema, 10,000 fixed-seed runs of 200 concurrent edits each make `@tiptap/y-tiptap` delete no non-empty content. If this fails, the RFC switches rich text to a central-authority engine before acceptance.
- **Normalizers.** In the same harness, the identity, trailing-node and table plugins add no duplicate content under concurrent edits. Entries the editor can't convert open read-only.
- **Durable Objects.**
  - `withEmDashRuntime()` runs checkpoints inside a Durable Object, with a cold start under 2 s.
  - 20 active rooms in one isolate stay under 64 MB.
  - Upgrades reach the room, both deployed and under `astro dev`.
  - An injected storage failure delivers nothing in 1,000 trials.
  - The behavior on a quota error is known.
- **Node.js streams** deliver within 100 ms, both directly and behind nginx and Cloudflare's proxy, and close within 5 s of a client leaving.
- **Cost.** Rows written and Durable Object duration per co-editor-hour are measured, and published with the experimental release.

Before stable:

- Is 30 minutes the right offline window?
- Are the timings and [limits](#appendix-b-limits) right?

## Appendix A: Implementation reference

These sections specify the mechanisms that [Detailed design](#detailed-design) summarizes.

### Joining a room

1. **Join.** The editor calls `POST /_emdash/api/content/{collection}/{id}/room` with the session and `X-EmDash-Request`.
   - The route refuses API tokens with `403`.
   - It requires co-editing on for the site and the collection, revisions on, and at least `view` access.
   - It returns the transport, a connection ID and, on Workers, a ticket.
   - Entries over the size limit get today's edit lock instead.

   If someone else holds the edit lock, the route returns today's lock response instead. For a fallback lock, a co-editor's join requests its release unless the join presents that lock's tab token ([Fallback](#fallback)).
2. **Hello.** The client connects and sends its protocol version, its epoch if any, its schema fingerprint, its Yjs client ID and its state vector.
3. **Lock first.** When the first co-editor connects, the room claims the edit lock before reading content. If the claim fails, the room serves every connection read-only, and clients show today's lock notice.
4. **Resume or initialize.**
   - The room resumes its epoch from usable state, first three-way merging any change stored since its expected revisions. The update log keeps the merge base, so deleting the expected revisions doesn't make state unusable.
   - State is unusable if it fails to decode, or has pending structs or deletions.
   - With no usable state, the room starts a new epoch and initializes from the entry's row fields with its draft revision applied. Initialization runs once, inside `blockConcurrencyWhile` on Workers or behind a per-room promise on Node.js. Its result is logged before anyone is served.
   - On Workers, the room reads through the D1 primary.
5. **Sync.** y-protocols sync steps 1 and 2 exchange missing updates. The client stays read-only until sync completes, which is when it has joined.

When a room is full, an arriving co-editor closes the most recently joined viewer's connection, and that viewer falls back to a read-only view of the latest checkpoint. When every connection is a co-editor's, later clients open that read-only view and retry every 30 s.

### The room lock

- **Holding.** While active or draining, the room holds the edit lock with `holder_type: room`, and it claims, renews and releases the lock by that marker.
- **Named person.** `user_id` names the earliest-joined co-editor still connected, for today's notices. If that user is deleted, the row cascades, and the room recreates it at its next renewal. Until then, out-of-band writes succeed and merge.
- **Enforcement.** A room lock applies whatever `editLocking` says, because `findEnforceable` matches the marker. It can't be taken over, and it ignores claims, refreshes and releases from the named user's other tabs.
- **`ENTRY_LOCKED`** keeps today's `details`, and adds `editors`, the connected co-editors, whom its message names. `entryMutationConflictSchema` and `entryLockConflictSchema` gain `editors`.
- **On Workers,** the lock lasts 7 minutes. The room renews it every 2 minutes from an alarm, as today's lock heartbeat does.
- **On Node.js,** the lock lasts 60 s.
  - A process-wide timer renews the process's room locks every 20 s.
  - The lock records the boot ID and a fencing token. The token increments when another boot ID takes the lock, and checkpoints commit only with the current token.
  - The timer also reclaims lapsed room locks that the registry shows with uncovered updates, checkpoints those rooms and releases their locks, backing off for rooms whose checkpoints keep failing.
  - A graceful shutdown checkpoints every room and releases its lock.
  - At startup, a background task checkpoints every room the registry shows with uncovered updates, even if co-editing is now off.
  - If another boot ID keeps renewing a room lock, another process is running. This process serves that entry read-only, and logs that co-editing needs a single process.

### Fallback

A client falls back only while the REST API responds, in two cases:

- it hasn't joined within 10 s;
- it has joined, has nothing unacknowledged, and the room has been unreachable for 30 s.

Otherwise, it keeps reconnecting.

If no room holds the lock, a falling-back client takes a fallback lock and autosaves as today. If a room holds the lock, the client opens read-only on the latest checkpoint.

A co-editor's join from any other tab, including the same person's, sets `release_requested` on a fallback lock. The fallback client sees the flag in its next autosave or lock-renewal response, normally within 2 minutes; a suspended tab's lock expires after 7 minutes. The client autosaves, then joins the room with a fresh replica, presenting the fallback lock's tab token. Once that client's sync completes, the room takes the lock over; other tabs of the same person can't. If the autosave or the join fails first, the client keeps the lock, or takes it again if it expired meanwhile. Meanwhile, a joining client shows today's lock notice for the fallback holder, and retries the join every 30 s.

### Updates and protocol

- **Checks.** The room checks each update on a scratch replica before logging it:
  - **Decoding:** it decodes completely, with no pending structs or deletions, so it depends on no update the room hasn't seen.
  - **Shape:** every top-level key is a field, the slug or the staged references, with its mapped Yjs type.
  - **Schema:** changed rich-text nodes and marks are in the editor's ProseMirror schema, with allowed attributes and URL schemes. Unknown plugin blocks stay one opaque JSON attribute.
  - **Ownership:** every item's client ID is bound to the sender. `hello` binds a client ID to the person and session for the epoch, and the room logs the binding and keeps it in its compacted state. Clients keep their client ID in memory only, so a duplicated tab gets its own. A later `hello` for that client ID from the same session replaces the old connection and closes it. A `hello` is refused if its client ID is bound to another session, or has logged items but no binding.
  - **Size:** at most 1 MB. Clients refuse pastes over 1 MB before sending them. Over the rate limit, acknowledgements are delayed, not refused.
- **Refusal** closes the connection with a reset code. The client discards its replica and client ID, saves its unacknowledged edits as a client recovery revision, and rejoins.
- **Logging.** Updates that arrive within 250 ms of the first are appended as one log entry, each tagged with its sender's user and connection. After the write commits, the room applies, broadcasts and acknowledges them with their log position. It also announces each checkpoint's position.
- **Client duties.** A client keeps every unacknowledged update, resends it after reconnecting, and asks before its tab closes while any remain. It reports "Saved" once nothing has been unacknowledged for 1 s, and "Not saved" when an update sent 10 s ago is still unacknowledged on an open connection; updates queued during a restore or discard don't count. While disconnected it keeps editing, and while offline it disables operations.
- **Messages** are binary, lib0-encoded as in y-protocols, and each carries the protocol version:

  | Message | From | Carries |
  | --- | --- | --- |
  | `hello` | Client | Its epoch, if any, its schema fingerprint, its Yjs client ID and its state vector |
  | `sync` | Room | The epoch, the client's access, the room's state vector, the updates the client lacks, the latest checkpoint position, and a hash of the document's Portable Text |
  | `sync` | Client | The updates the room lacks. Co-editors only. They pass the same checks, merge window and epoch check as `update`, and get `ack`s. |
  | `update` | Client | One Yjs update |
  | `ack` | Room | The log position, and the highest clock of the client's own updates that the log now contains |
  | `update` | Room | A logged update, with its log position and its sender's user ID |
  | `presence` | Either | The sender's awareness state. The room overwrites `user`. |
  | `checkpoint` | Room | A successful checkpoint's position and revision ID |
  | `notice` | Room | An operation or setting change and who made it, a rejected or fenced checkpoint and its field, a pause, or a conflict for this client: a single value changed while it was offline, or edits into deleted content |
  | `access` | Room | The connection's new access level |
  | `auth` | Client | A fresh ticket, on Workers, verified like an upgrade's: same person, session and entry, single use |
  | `reset` | Room | Why the room is closing the connection |

  On Node.js, room messages travel on the event stream, and client messages travel in `POST` bodies, whose responses carry the `ack`s.
- **Versions and epochs.** The schema fingerprint hashes the collection's fields and the editor's ProseMirror schema, including plugin block types, and the room stores it with the epoch. A client whose protocol version or fingerprint differs is out of date ([Reconnection and recovery](#reconnection-and-recovery)). A schema change makes the room checkpoint with the old fields and start a new epoch. Every epoch change closes all connections, and clients discard their replica and client ID.
- **Presence messages** can change only the sender's own presence, within a size limit and a fixed set of fields. `editing` must name one field or item that the sender may change.
- **HTML blocks.** A remote code change resets the preview to **Run preview**, and the sandboxed iframe stays the boundary.
- **Compaction.** At a size threshold, when the room has no connections, viewers included, and at least hourly, the room writes `Y.encodeStateAsUpdate` of its document (with `gc: true`) in rows under 1 MB, and drops the log entries it includes, in one `RoomStore` transaction that also writes the client-ID bindings. It deletes its state once a checkpoint covers the log and it has had no connections for an hour.

### Checkpoints

- **Triggers.** The room checkpoints:
  - 2 s after co-editors' updates stop;
  - at least every 30 s while they continue;
  - before every operation;
  - 30 s into draining, if no co-editor returns, which is the final checkpoint.

  Plugin updates don't start or reset these timers.
- **Path.** The room converts a copy of its document to Portable Text and calls `EmDashRuntime.handleContentUpdate` as an admin save does, with the same hooks and partial validation. On Workers it goes through `withEmDashRuntime()`.
- **Precondition.**
  - The room picks the revision ID in advance and logs it before writing.
  - The draft swap is a variant of `ContentRepository.replaceDraftRevision`. It compares only `draft_revision_id` and `live_revision_id` with the expected revisions, not `version`, which most writes bump. It still increments `version`.
  - After a lost response or restart, a logged ID that is now the draft or live revision means the checkpoint committed. Otherwise, the room three-way merges the stored content against its previous merge base, adopts the stored pair and checkpoints again.
- **Reasons.** `revisions.reason` is one of these:
  - `autosave` for automatic checkpoints, each replacing the room's previous automatic checkpoint, meaning an `autosave` revision with a checkpoint position in the current epoch;
  - `save` for **Save version**, pre-operation and final checkpoints;
  - `restore` for the checkpoint that saves a restore's target;
  - `recovery` for recovery revisions.

  Saves and restores outside rooms record the same reasons. A prerequisite fix stops today's autosave (`skipRevision: true`) from deleting the explicit save before it.
- **Attribution.** `edited_by` lists everyone with updates since the last successful checkpoint, plus the list from the `autosave` revision it replaces. The room keeps that set in its log until a checkpoint succeeds. The revision author is the operation's caller or, for an automatic checkpoint, the co-editor with the most recent update.
- **Hook actor.** Automatic checkpoints pass hooks the person with the least access among those with updates since the last successful checkpoint. `edit-draft` ranks lowest, then `edit` through `content:edit_own`, then `content:edit_any`. A tie goes to the lower role, then the most recent edit. Operation checkpoints pass the caller.
- **Hooks** change stored content only, as today ([merge rules](#out-of-band-writes)).
- **A rejected final checkpoint.** The room releases the lock, keeps its state, and retries with backoff, from an alarm on Workers and from the process timer on Node.js. After 24 hours of rejections, it writes a room recovery revision with cause `close` and drops its state.
- **Closing.** Turning co-editing off for a collection or the site makes its rooms checkpoint and close, and clients reload into the edit lock; the schema route finds the rooms through the registry. Turning revisions off is refused while the registry shows rooms in the collection with uncovered updates.
- **Write fence.** Checkpoints pass `assertSiteWriteAllowed`, and wait while the site write fence is closed, during imports and media-usage activation.

### Operations

Routes keep their permission checks and dialogs. While the room holds the lock, an authorized route hands the operation to the room, by RPC on Workers or a direct call on Node.js. The room runs operations one at a time:

1. **Wait for the caller.** A participant's request carries `X-EmDash-Room-Connection` and `X-EmDash-Room-State`, the client's state vector, and routes ignore `_rev`. The room waits up to 5 s until its log contains every update in that state vector. If it doesn't, the operation fails and can be retried. Callers outside the room, such as `overrideLock` requests and the scheduler, skip this step.
2. **Downgrade.** Before publish, schedule, unpublish, unschedule and author changes, `edit-draft` connections become read-only.
3. **Run.** The room pauses its timers, saves a retained `save` checkpoint, and runs the operation on it. Publish passes that checkpoint's `_rev` to `handleContentPublish`. If a concurrent write moved the draft, the room checkpoints and retries once.
4. **Resume.** The room updates its expected revisions, rechecks access, and announces who ran the operation, for example "Ana published this entry."

| Operation | Effect in the room |
| --- | --- |
| Publish, schedule | Publish or schedule the retained checkpoint. A due schedule publishes its pre-operation checkpoint, or the latest successful checkpoint if that one is rejected or the room is unreachable. |
| Unpublish, unschedule | Change the status only |
| Restore | Save the target content as a checkpoint with `reason: restore`, then apply it to the document as a server update. If that checkpoint is rejected, the restore fails; a rejected pre-operation checkpoint is handled as in [Failure handling](#failure-handling). |
| Discard | Run today's discard handler, then apply the live content to the document as a server update |
| Move to Trash | Close the room, and clients become read-only |
| Author change | Recheck access |
| **Save version**, which replaces the Save button in a room | Keep the retained checkpoint |
| Preview | Wait for the caller, then save an `autosave` checkpoint instead of a retained one |

A failed operation keeps its retained checkpoint, and only the caller sees the error. An operation still running after 30 s, by the room's clock, fails its request with an unknown outcome, but keeps the queue until it settles. If it hasn't settled after 2 minutes, the room resets: the Durable Object aborts, or the Node.js room is rebuilt from its log. Either way, the room re-reads and merges stored content before the next operation.

The handlers' writes compare the `version` they read, so a late commit from the abandoned operation lands only if nothing else changed the entry first. A late commit that moves a revision fails the next checkpoint's precondition, and one that changes only the status is picked up at the next lock renewal, when the room re-reads the entry. Trash's delete checks only `deleted_at` today, so the room's **Move to Trash** passes the version it read, and the delete is conditioned on it.

Once a restore or discard reaches its run step, before the pre-operation checkpoint, the room queues incoming updates and processes them after the server update, so no update falls between the pre-operation checkpoint and the replacement. Queued updates don't count toward "Not saved", and those that edit replaced content follow [edits inside deleted content](#reconnection-and-recovery).

Operations purge the route cache as their routes do today, including when the outcome is unknown. Operations without a route, such as scheduled publishing and plugin publishes, purge through the host's invalidator. On Workers, that is the package's cache provider, which the Cloudflare scheduled handler already passes to `runScheduledTasks` through `onPublished`. Core has no invalidator for work outside requests on Node.js, so the Node.js host adds one for rooms. Operations requested from inside a running operation, for example by a hook, are refused.

Dialogs name everyone whose unpublished edits an operation includes or replaces: `edited_by` since the live revision, plus the current co-editors. Restore, discard and **Move to Trash** warn that the current draft stays in Revisions. Bulk actions use the same routes.

### Reconnection and recovery

- **Merge window.** The room records, by its own clock, each client ID's last message. A client that reconnects in the same epoch within 30 minutes of it syncs normally. Otherwise, it saves any unacknowledged updates as a client recovery revision, then loads the room's document.
- **A lost log.** Clients holding acknowledged updates past the last announced checkpoint save them as client recovery revisions. These don't count toward the daily limit. They can overlap, but nothing is lost.
- **Single values changed offline.** Another client may have set the same key after the reconnecting client's last message. If so, the room applies that value again, as a server update, and the returning person is told, and can apply their value again.
- **Edits inside deleted content.** When updates, from a reconnect or queued during a restore, insert into content that was deleted meanwhile, the room reports them to the sender, whose client saves them as a client recovery revision.
- **Client recovery revisions** use `POST /_emdash/api/content/{collection}/{id}/revisions/recovery`, which needs the session, `X-EmDash-Request` and current write access, and ignores edit locks.
  - Each holds the client's whole document as Portable Text. The route checks size and structure but not the current fields, so content from before a schema change still saves.
  - The route allows 10 per person per entry per UTC day, and sets the author, `recovery_cause`, and `recovered_from` (the last checkpoint the client saw covered). Neither automatic checkpoints nor pruning delete a revision that a recovery revision references.
  - They don't count toward the 50-revision limit, and are pruned after 30 days. If the route refuses one, the client keeps the edits, to copy.
- **Room recovery revisions** are written without hooks, validation or limits, and never pruned automatically. The room writes one whenever a checkpoint it needs is rejected: before restore, discard and **Move to Trash**, and before closing. It also writes one before starting a new epoch while its document still decodes and has uncovered updates.
- **Restoring a recovery revision** validates it as a draft against the current fields, after dropping removed fields. If that fails, it can only be opened and copied.
- **Out-of-date clients,** whose protocol version or schema fingerprint differs from the room's, become read-only and save unacknowledged edits as a client recovery revision. They never reload themselves while holding edits, and they say whether EmDash or the fields changed.

### Runtime hosts

Core (`emdash`) holds the room logic: checks, merges, presence, leases, checkpoint scheduling and the operation queue. It runs against an internal host boundary, which can change until co-editing is stable:

```ts
interface RoomHost {
	store: RoomStore;
	send(connectionId: string, message: Uint8Array): void;
	close(connectionId: string, code: number): void;
	setAlarm(at: number): void;
	runtime<T>(fn: (runtime: EmDashRuntime) => Promise<T>): Promise<T>;
	invalidate(tags: string[]): Promise<void>;
}

interface RoomStore {
	// Resolves with the entry's log position only after the write commits.
	append(entry: Uint8Array): Promise<number>;
	readFrom(position: number): AsyncIterable<[position: number, entry: Uint8Array]>;
	readState(key: string): Promise<Uint8Array | null>;
	// All writes in one call commit together, or not at all. `fn` is synchronous;
	// Node.js buffers its writes and applies them in one database transaction.
	transaction(fn: (tx: RoomStoreWriter) => void): Promise<void>;
	deleteAll(): Promise<void>;
}

interface RoomStoreWriter {
	writeState(key: string, value: Uint8Array): void;
	truncate(through: number): void;
}

// Called by routes and other writers: by RPC on Workers, directly on Node.js.
interface RoomApi {
	join(session: SessionRef): Promise<JoinResult>;
	attachStream(connectionId: string, session: SessionRef, stream: WritableStream<Uint8Array>): void;
	receive(connectionId: string, session: SessionRef, messages: Uint8Array[]): Promise<Uint8Array[]>;
	runOperation(operation: Operation, caller: Caller): Promise<OperationResult>;
	mergeWrite(write: OutOfBandWrite, caller: Caller): Promise<MergeResult>;
	notifyStoredWrite(): Promise<void>;
	revokeUser(userId: string): Promise<void>;
	close(reason: CloseReason): Promise<void>;
}
```

`attachStream` and `receive` are the Node.js transport; on Workers, messages arrive on the hibernatable socket. `runOperation` also carries the settings-panel `PUT`s. `mergeWrite` takes plugin `ctx.content.update` writes and visual-editor saves, and returns `409 CONFLICT` for a visual-editor save that loses. `close` serves co-editing being turned off and schema changes. Every write of durable state goes through `transaction`, including the pending checkpoint's revision ID before its database write.

On Workers, in `@emdash-cms/cloudflare`:

- **Durable Object.** Each room is a SQLite-backed `EmDashRoom`, named `{site ID}:{collection}:{entry ID}`, with the site ID from the `emdash:site_id` option.
- **Hibernation.** Rooms use hibernatable WebSockets, keep presence in socket attachments, and set one alarm at the earliest deadline: lock renewal or claim retry, checkpoint or checkpoint retry, or field-lease expiry. Leases and inactivity come from timestamps, so quiet rooms hibernate between renewals.
- **Upgrades.** The Worker entry from `@emdash-cms/cloudflare/worker` handles room upgrades before Astro, because EmDash's middleware rewraps every response (`finalizeResponse`) and a `101` can't be rewrapped ([workerd #3047](https://github.com/cloudflare/workerd/issues/3047)).
- **Runtime.** `runtime()` uses `withEmDashRuntime()` from `emdash/middleware`, which shares `runOutsideRequest` with the Cron Trigger's `runScheduledTasks`, and `invalidate()` uses the package's cache provider.
- **Tickets.** Upgrades present a ticket: HMAC-signed with its own secret, typed, single-use, valid for 60 s, and bound to one person, session and entry. The Worker verifies it with `crypto.subtle` before any Durable Object exists, and routes by its entry, which must match the path. It checks `Origin` against the request origin, the site URL and the allowed origins ([OWASP](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html)), and refuses upgrades without an `Origin`. The ticket travels as a base64url `Sec-WebSocket-Protocol` value; the room echoes only `emdash.v1`, and keeps nonces until they expire, so tickets can't be replayed after a restart. Upgrade headers are never logged.
- **Deploys** restart every Durable Object, and clients reconnect with backoff.
- **Jurisdiction.** An optional `jurisdiction`, such as `"eu"`, keeps rooms in one region. Changing it changes the namespace, so drain first: turn co-editing off and wait for the registry to empty.

On Node.js, in `emdash`:

- **Log storage.** Rooms live in the server process, and `RoomStore` writes through Kysely to `_emdash_room_updates` and `_emdash_room_state`, on SQLite, libSQL or PostgreSQL. `runtime()` calls the runtime directly, and `invalidate()` is new, because core has no invalidator for work outside requests on Node.js.
- **Transport.** The server sends on an event stream, `GET …/room/events`. Clients send `POST …/room/messages`, one in flight per client, and the responses carry acknowledgements. The stream `GET` and every `POST` carry the connection ID from the join route, which the room accepts only from the session it was issued to. Both are ordinary Astro routes on `@astrojs/node` standalone.
- **Membership.** A participant joins with its first `POST`, which carries `X-EmDash-Request`, and stays while its stream is open or for 3 minutes after its last `POST`. A tab hidden for 30 s closes its stream and sends a heartbeat `POST` every minute, then resyncs without reloading when shown. A closing tab sends a `keepalive` leave `POST`.
- **Proxies and fences.** EmDash turns off proxy buffering on the stream, and requires an Astro version that reports client disconnects. Room routes are exempt from the per-request write fence, like the lock route, and checkpoints check the fence themselves.

Serverless adapters, such as Vercel and Netlify, can't use `inProcessRooms()`, and configuring it fails the build. Playground and preview databases don't support rooms.

### Configuration and protocol

- **Site option.** `experimental.coEditing` takes `inProcessRooms()` from `emdash/astro`, or `durableObjectRooms({ binding, jurisdiction?, dailyRowBudget? })` from `@emdash-cms/cloudflare`. When stable, it becomes a top-level `coEditing`. The experimental key then fails with a pointer to it, as `experimental.registry` does today.
- **Cloudflare wiring.** A Cloudflare site also binds the class in `wrangler.jsonc` and exports it from `src/worker.ts`, as shown below. A custom Worker entry that doesn't spread the package's handler must forward room upgrades itself.
- **Collection setting.** `coEditing` is a boolean, defaulting to `true`. It sits beside `editLocking` in:
  - the content type editor;
  - seed files;
  - the schema API;
  - the MCP schema tools;
  - `emdash export-seed`;
  - site transfer.

  The setting can be turned on only when co-editing is configured and the collection has revisions.
- **Health.** The runtime reports whether co-editing is running, not configured, or unavailable, and the admin shows it to administrators.
- **Stability.** The collection setting, the hook fields, the revision columns and the `ENTRY_LOCKED` additions are stable from the first release. The site option, room routes and protocol can change until co-editing is stable.
```js
import { d1, durableObjectRooms, r2 } from "@emdash-cms/cloudflare";
import emdash from "emdash/astro";

emdash({
	database: d1({ binding: "DB", session: "auto", coalesce: true }),
	storage: r2({ binding: "MEDIA" }),
	experimental: { coEditing: durableObjectRooms({ binding: "ROOMS" }) },
});
```

```jsonc
"durable_objects": { "bindings": [{ "name": "ROOMS", "class_name": "EmDashRoom" }] },
"migrations": [{ "tag": "emdash-rooms", "new_sqlite_classes": ["EmDashRoom"] }]
```

```ts
export { EmDashRoom } from "@emdash-cms/cloudflare/worker";
```

### Data model

| Change | Purpose |
| --- | --- |
| `_emdash_collections.co_editing`, an integer defaulting to 1 | The collection setting |
| `_emdash_entry_locks` gains `holder_type` (`user`, `room` or `fallback`) and `release_requested`, plus `boot_id` and `fencing_token` on Node.js | Room locks and fallback locks |
| `_emdash_rooms`, the room registry: a row for each room with stored state. It holds the collection, entry ID, participants' user IDs, `has_uncovered_updates`, and the rows written that UTC day. Rooms update it on joins, departures and flag changes, and deleting a user removes them. | Lets the content list (one batched request per page, needing `content:read_drafts`), `ENTRY_LOCKED`, account and schema changes, `dailyRowBudget` and the Node.js startup task find rooms, which Workers can't enumerate |
| `revisions.reason`, nullable: `autosave`, `save`, `restore` or `recovery`. Existing rows stay null and are retained. | Automatic checkpoints replace only the room's own `autosave` revision from the current epoch |
| `revisions.edited_by`, a nullable JSON list of user IDs | Who edited a revision |
| `revisions.checkpoint_position`, `recovered_from` and `recovery_cause` (`client`, `restore`, `discard`, `trash`, `close` or `epoch`), all nullable | Checkpoint and recovery metadata |
| `_emdash_room_updates`: `room_id`, `position`, `epoch`, `entry` (the batch's updates with their senders) and `created_at`, keyed by `room_id` and `position` | The update log on Node.js, where `room_id` is `{collection}:{entry ID}`. Each Durable Object keeps the same table, without `room_id`. |
| `_emdash_room_state`: `room_id`, `key`, `chunk` and `value`, keyed by `room_id`, `key` and `chunk` | The room's durable state, in chunks under 1 MB |
| `emdash:room_ticket_secret` option | Signs tickets. Backups and site transfer copy options by allowlist, so they skip it. |

Besides its log, each room keeps this durable state:

- its epoch and schema fingerprint;
- its compacted document, and the log position it includes;
- client-ID bindings, and each client ID's last-message time, written at most once a minute and on disconnect, so the 30-minute window has one-minute precision;
- its expected revisions, the pending checkpoint's revision ID, and the merge base, before and after hooks;
- the `edited_by` set since the last successful checkpoint;
- checkpoint and lock-claim retry state;
- on Workers, ticket nonces until they expire.

The revisions list response gains `editedBy`, with each person's ID and name. Deleted users show as "Unknown author", as revision authors do today.

## Appendix B: Limits

These are starting values, for the prototype to measure.

| Limit | Value |
| --- | --- |
| Largest update | 1 MB, encoded |
| Largest paste | 1 MB |
| Largest entry | 1.9 MB of Portable Text JSON. D1 rows max out at 2 MB. |
| Update rate | 50 updates a second per connection. Faster updates delay acknowledgements. |
| Compaction threshold | 1,000 log entries, or 1 MB |
| Connections per room | 25 |
| Per person | 10 rooms, and 5 connections in each room |
| Per Node.js process | 500 rooms and 2,000 event streams |
| Client recovery revisions | 10 per person per entry per UTC day, kept for 30 days |
| Ticket | 60 s, single use |
