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

> **Draft.** Open before acceptance: a Maintainer sponsor, and the prototype results for the [acceptance gates](#acceptance-gates).

## Summary

This RFC lets several people edit one entry in the admin editor at the same time. Each person sees who else is editing and where, concurrent rich-text edits merge, and undo reverts only that person's edits.

- **A room per entry syncs.** A room is a server-side object that holds the entry's shared Yjs document and relays Yjs updates and presence over WebSockets: a Durable Object on Cloudflare Workers, an in-process object on Node.js. It keeps the document in its own storage and never reads or writes the stored entry.
- **Clients save.** Clients in the room save the document through today's autosave request, with `_rev`, one at a time: the room hands out a save grant. Permissions, hooks, validation and revisions apply as they do today, and stored content stays Portable Text.
- **The stored entry stays authoritative.** A write that isn't a checkpoint, such as a plugin update, surfaces as a `_rev` conflict at the next checkpoint. The saving client copies the changed fields into the shared document, except fields someone in the room changed since the last checkpoint.
- **Other writers get `409 ENTRY_LOCKED`** while a room lease is live ([Out-of-band writes](#out-of-band-writes)).

Co-editing is experimental, off by default, and applies only to collections with revisions. Agents as co-editors, comments and suggestions are out of scope.

## Problem and user case

Only one person can edit an EmDash entry at a time. Edit locking ([Discussion #2819](https://github.com/emdash-cms/emdash/discussions/2819)) is on by default: the first person to open an entry holds its lock, and everyone else gets **Open read-only** or **Take over**. When locking is off, a save based on an older `_rev` gets `409 CONFLICT`; after a take-over, the displaced editor's saves get `409 ENTRY_LOCKED`. Nothing merges. Teams take turns, or draft in another tool and paste, which loses Portable Text structure.

The Ideas Discussion ([#4173](https://github.com/emdash-cms/emdash/discussions/4173)) asked for the [goals](#goals) below. A reply asked who is responsible when one publish includes several people's edits: revisions record everyone whose edits they hold, and the publish dialog names them.

### Prior art

- **WordPress 7.0** relayed Yjs updates between browsers, which saved the post through the ordinary save and autosave requests ([Gutenberg #72373](https://github.com/WordPress/gutenberg/pull/72373)). WordPress removed it before release ([removal post](https://make.wordpress.org/core/2026/05/08/rtc-removed-from-7-0/)). Its next design has the server record, authorize, merge and store every update: a browser that fell behind could save over newer work, REST writes couldn't reach open editors, and a privileged browser could save content a less privileged collaborator added ([server-aware post](https://make.wordpress.org/core/2026/09/18/moving-to-a-server-aware-approach-for-collaboration/)).
- **OpenCloud Web** ships most of this split: its Hocuspocus room never converts the document, and browsers save files with `If-Match`. The room grants seeding to one client and, after concurrent recoveries duplicated content, recovery too ([design notes](https://raw.githubusercontent.com/opencloud-eu/web/main/dev/docs/yjs.md), [#3429](https://github.com/opencloud-eu/web/issues/3429)). JupyterLab and PreTeXt-Plus started with browser saves and later moved conversion to the server ([JupyterLab #11599](https://github.com/jupyterlab/jupyterlab/pull/11599), [PreTeXt-Plus #414](https://github.com/PreTeXtPlus/PreTeXt-Plus/pull/414)).
- **Yjs servers** hold the document and recover updates lost in a restart from clients, through the y-protocols sync handshake. Hocuspocus and y-partyserver also authorize connections and store on a debounce.
- **The Yjs author's model** for an app whose database is the source of truth starts a session from database content, forgets it about an hour after the last client leaves, and accepts that clients from a forgotten session can't merge ([Lexical FAQ](https://lexical.dev/docs/collaboration/faq)). Two clients that both initialize an empty document corrupt it ([Lexical guide](https://lexical.dev/docs/collaboration/react)).

This design follows the Yjs author's model, with one initializing client per room, and saves from the client, where EmDash's editor schema and Portable Text converter already run. It addresses WordPress's three problems: the room grants one save at a time and refuses a client that is behind the last checkpoint; `_rev` refuses saves over unseen writes, which then merge field by field; and EmDash has no content that only some roles may store ([Security and privacy](#security-and-privacy)).

## Example

Ana (Editor role) opens the post "Spring launch", which Ben (Author role) already has open. Her editor joins Ben's room, and each sees the other's avatar and named cursor. Ana edits the title while Ben rewrites the second paragraph. Two seconds after Ben stops typing, his client saves a checkpoint that holds both people's edits, and both editors show "Saved".

Ben's Wi-Fi drops for twenty seconds. He keeps typing, and when he reconnects his edits merge and reach the next checkpoint. Ana publishes: her client saves a checkpoint, then publishes it, and Ben's later edits are unpublished changes. Meanwhile, a script with Ana's API token tries to update the post and gets `409 ENTRY_LOCKED`.

## Goals

- **Concurrent editing** of the entry form, with every replica converging. [The shared document](#the-shared-document) lists which concurrent edits keep one change, and which values keep saving on their own.
- **Presence:** avatars, the field each person is in, and named cursors in rich text. Remote edits render within 500 ms at the 95th percentile.
- **Per-person undo.**
- **Short disconnects.** A client that reconnects before its room goes stale, at least an hour after everyone left, merges its offline edits. Edits that can't merge are kept as a revision.
- **"Saved" is true.** A client shows "Saved" only when a checkpoint holds all its edits.
- **Deliberate publishing.** Publish is one operation, by someone with publish permission, on a checkpoint the publisher's client has just saved.
- **Hosts:** Cloudflare Workers and single-process Node.js, over WebSockets, with no third-party service and no Cloudflare code in `emdash`.
- **No visitor cost.** Logged-out routes run no additional queries.

## Non-goals

- **Agents and API callers as co-editors.** They get `ENTRY_LOCKED` while a room is open.
- **Comments, suggestions, tracked changes and approval workflows.**
- **Offline edits that outlive the room or the tab.**
- **Co-editing in the visual editor.**
- **Merging inside fields other than rich text.** Each such field is one value, `blocks` and `repeater` included.
- **Checkpoints made by the room** ([Alternatives](#alternatives)).
- **A per-collection setting** while co-editing is experimental, and **on by default**, which needs its own proposal.

## Detailed design

[Appendix A](#appendix-a-implementation-reference) holds the protocol, host integration and tables, and [Appendix B](#appendix-b-limits) the timings and limits.

### Terms

| Term               | Meaning                                                                                                                                                                                                                                                         |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Room               | The server-side object for one entry row (each locale is a row). It keeps the shared document and the room record in room storage, accepts WebSockets, relays updates and presence, and hands out save grants. It runs no EmDash runtime, hooks or plugins.     |
| Shared document    | The room's `Y.Doc`. Clients replicate it by exchanging Yjs updates over y-protocols.                                                                                                                                                                            |
| Client             | One admin editor instance, usually a tab, with its own replica and Yjs client ID                                                                                                                                                                                |
| Co-editor, viewer  | A user connected to the room with write access, or with read access only. A client has its user's access.                                                                                                                                                       |
| Snapshot           | A Yjs snapshot: a state vector and a delete set. Snapshot A **contains** snapshot B when A's state vector is at least B's and A's delete set includes B's. A state vector alone can't show deletions.                                                           |
| Stored entry       | The entry row and its revisions in the site database, written only by EmDash routes                                                                                                                                                                             |
| Room storage       | Where a room keeps its document and room record: the Durable Object's SQLite on Workers, two tables of the site database on Node.js                                                                                                                             |
| Save copy          | The field values a client serializes from its replica for one save, with the replica's snapshot at that moment                                                                                                                                                  |
| Checkpoint         | A save copy that the grant holder saved with the content `PUT` and the room recorded: its `_rev`, its snapshot and its hashes. "The last checkpoint" is the most recent one recorded. An update is **covered** when the last checkpoint's snapshot contains it. |
| Kept checkpoint    | A checkpoint saved without `skipRevision`, so later checkpoints don't replace its revision                                                                                                                                                                      |
| Merge update       | A Yjs update, built in a scratch document with a fresh client ID, that writes stored values into the shared document                                                                                                                                            |
| Save grant         | The room's permission for one client to save. One grant is active at a time.                                                                                                                                                                                    |
| Room record        | What the room stores besides the document ([Data model](#data-model))                                                                                                                                                                                           |
| Lineage            | A random ID for one continuous room state. A room that starts from the stored entry starts a new lineage.                                                                                                                                                       |
| Fingerprint        | The `version`, `commit` (EmDash's build commit) and `hash` of the admin manifest. It changes with EmDash upgrades and with collection, plugin or taxonomy definitions.                                                                                          |
| Edit lock          | A live row in `_emdash_entry_locks`. A **user lock** is today's lock. A **room lease** has `room_host` set, and refuses lock-checked writes that don't carry `X-EmDash-Room` ([The room lease](#the-room-lease)).                                               |
| Single-editor mode | Today's behavior: the client takes a user lock, or opens read-only                                                                                                                                                                                              |
| Out-of-band write  | Any write to the stored entry that isn't a checkpoint                                                                                                                                                                                                           |
| Operation          | Publish, schedule, unpublish, unschedule, restoring a revision, discarding the draft, or moving to Trash                                                                                                                                                        |
| Reset              | A client saves its uncovered edits as a recovery revision, discards its replica and joins again ([Reset and recovery](#reset-and-recovery))                                                                                                                     |
| Recovery revision  | A revision that is neither the draft nor the live one                                                                                                                                                                                                           |

"The editor" is the admin entry editor. Editor, Author and Contributor are roles.

### Current behavior

- **Autosave** sends the whole form 2 s after typing stops, as `PUT /_emdash/api/content/{collection}/{id}` with `skipRevision: true` and `_rev`. A stale `_rev` gets `409 CONFLICT`. The response holds the entry as stored after `content:beforeSave` hooks, with its new `_rev`; `content:afterSave` hooks run afterwards.
- **Every draft save creates a revision.** `skipRevision: true` then deletes the previous draft revision, even one that a manual save created.
- **The edit lock** belongs to a user, lasts 7 minutes, is renewed every 2 minutes, and admits any session of its holder's user. Plugin writes, scheduled and sibling-locale publishing, taxonomy terms, trash restore, permanent delete, duplicate and seeding don't check it, and `overrideLock: true` skips it.
- **Values that save on their own:** SEO, author and publication date go through the content `PUT`, written to the live row at once, and taxonomy terms through `POST …/terms/{taxonomy}`. Bylines and changed reference fields ride the form save, with the slug.
- **WebSockets.** Astro has no WebSocket API ([withastro/roadmap#695](https://github.com/withastro/roadmap/discussions/695)), and `@astrojs/node` handles no upgrades.

### Architecture

```
 Clients (editor tabs) ◀── WebSocket: Yjs sync, presence, grants ──▶ Room (one per entry)
        │                                                            keeps the Yjs document
        │ checkpoint: today's autosave PUT, with _rev                in room storage
        ▼
 EmDash routes: permissions, hooks, validation, revisions, edit lock
        │
        ▼
 Draft revision ── publish ──▶ live revision
```

### Guarantees

1. **One room per entry.** Workers runs one Durable Object per name. Node.js keeps one registry of rooms in a single process ([Runtime hosts](#runtime-hosts)).
2. **One lineage.** A client merges only into the lineage it started from. A client from another lineage resets ([Joining a room](#joining-a-room)).
3. **Checkpoints move forward.** The room grants one save at a time, and only to a client whose save copy contains the last checkpoint and nothing the room lacks, so each checkpoint contains the one before it ([Checkpoints](#checkpoints)). Clients save checkpoints and run operations only while they hold a grant; the runtime doesn't check grants, and `_rev` is what stops a save over unseen writes.
4. **Room storage holds every saved update.** The room stores every unstored update before it grants a save or records a checkpoint, so no checkpoint holds an update that room storage lacks ([Updates and room storage](#updates-and-room-storage)).
5. **"Saved" means covered.** A client shows "Saved" when the last checkpoint contains its replica's snapshot from its own last edit, and otherwise asks before its tab closes. Its own edits include the merge updates it sent.
6. **One writer of stored values.** The initializing client builds the document from the stored entry. After that, only the grant holder writes stored values into it, through merge updates. No client writes a save response into the document, so hook output stays in the stored entry.

### The shared document

| Field                                                                                                                | Yjs type                                                                                                            | Concurrent edits                                                 |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `portableText`                                                                                                       | A `Y.XmlFragment` per field, bound to TipTap by `@tiptap/extension-collaboration` and `@tiptap/y-tiptap` (both MIT) | Merge. Every concurrent insertion is kept.                       |
| Every other field in `data` (`blocks`, `repeater` and plugin widgets included) except reference fields, and the slug | One value in a `Y.Map`                                                                                              | One of the concurrent changes is kept, the same on every replica |

- **Values outside the document** save on their own, with the room header: SEO, author, publication date, taxonomy terms, bylines and reference fields. In a room, bylines and reference fields leave the form save and save at once, sending only what changed, with `_rev`. On `409 CONFLICT` the client rereads `_rev` and retries once; if that fails too, it shows today's save error and keeps the value unsaved in the input. Reference-field saves are autosaves, so they don't add kept revisions, and byline saves write the live row and create no revision, as today. After such a save, the client sends a notice through the room, and the other clients reload those values, waiting while an input for one has focus.
- **Keys.** The client that creates a Portable Text block assigns its `_key` in the same transaction, including on split and paste. A grant holder that finds duplicate keys replaces them through a merge update before it serializes.
- **Undo.** Rich text uses `Y.UndoManager` with only the client's own origin, and the editor turns off TipTap's `undoRedo`. Other inputs keep the browser's undo.
- **Presence** is Yjs awareness. Each client shares the field it is in and, in rich text, its cursor and selection. The room sets each connection's user ID and name from its token, and viewers share neither cursor nor field.
- **Block replacements.** "Turn into", dragging a block, deleting it, and adding table rows or columns replace the block, so concurrent typing inside it is lost.
- **Plugin blocks.** `PluginBlockModal` applies its edit to the block with the same `_key`, not to the position it captured on opening (`editingBlockPosRef`). If that block is gone, the edit is refused.
- **Widgets and plugin actions.** Field widgets keep `value` and `onChange`. A remote change remounts the field's widget; if the widget has focus, the remount waits until it loses focus. A plugin editor action applies its patch in one transaction, which is one undo step.

### Joining a room

The client calls `POST /_emdash/api/content/{collection}/{id}/room` with the session and `X-EmDash-Request`, sending the fingerprint it loaded. API tokens are refused. The route returns one of four results:

- **A room:** `{ url, token }`. Callers need `content:read_drafts`. Users that today's edit check (`requireEntryEditPerm`) allows join as co-editors, the rest as viewers. The route asks the room for the token, by RPC on Workers or a direct call on Node.js, then claims the room lease for a co-editor ([The room lease](#the-room-lease)).
- **Single-editor mode,** when co-editing is off, the collection has no revisions, the host can't run rooms, the request runs in a playground session, or the caller holds the entry's user lock, which the client then shares as today. It is also the result when the room can't store, in which case the route clears the room lease, and when a connection limit is reached, in which case the client opens read-only.
- **`ENTRY_LOCKED`,** when another user holds a user lock. The client shows today's notice, and **Take over** repeats the join with `takeover: true`, which turns that lock into a room lease.
- **`409 CLIENT_OUTDATED`,** when the fingerprint differs from the server's. The client saves its uncovered edits as a recovery revision, then reloads the admin.

The token is random, single use, valid for 60 s, and bound to the user, the user's name, the access level and the fingerprint. The room keeps it in memory. Every connection, reconnects included, uses a fresh token.

The client connects to `/_emdash/rooms/{collection}/{id}?token=…`. The room sends `welcome`, then y-protocols sync runs. Until sync completes, the client shows the entry it loaded, read-only.

- **Initialize.** A room without state asks one co-editor's client to initialize. That client builds the document in a scratch `Y.Doc` from the entry it loaded, picks a lineage ID, and sends `init`. The room stores the first `init` it gets, as the new lineage and the last checkpoint, ignores any other, and serves everyone. If the client asked leaves first, the room asks the next co-editor. A client asked to initialize from stored data over 1 MB, or from rich text with marks the editor can't represent, which today's editor refuses to save, declines: it leaves the room, releases the lease as any leaving client does, and only then uses single-editor mode.
- **Lineage.** A client that already has a replica compares lineages, and resets if they differ.
- **Stale room.** When a co-editor joins a room whose last connection closed over an hour ago, or whose fingerprint differs from the token's, the room doesn't sync. If its document holds uncovered updates, it sends that client the document with its `editedBy`. The client saves it as a recovery revision that records `editedBy`, tells its user, and reports back; a client with a replica of the same lineage applies the document to its replica and saves that instead. Only then does the room close every other connection with `reset`, drop its state and ask the client to initialize a new lineage. If the client leaves first, the next co-editor saves the document again, and clients that reset save their own uncovered edits, so a stale room can leave several copies. A viewer who joins a stale room waits for a co-editor.
- **Stale entry.** A client that finds the entry's `_rev` differs from the last checkpoint's asks for a save at once, so out-of-band writes merge in.
- **Connection lifetime.** Whenever the room handles a message, it closes every connection older than 15 minutes, and those clients join again, which rechecks the session and access.

### Updates and room storage

- **Updates.** The room applies updates only from co-editors, up to 1 MB each, or 4 MB for `init` and merge updates. It refuses an update from a viewer, one over the limit, and one that doesn't decode, and closes that connection with `reset`. Like any Yjs document, it holds an update whose dependencies it lacks (a **waiting update**) until they arrive. A client sends incremental updates only after it has sent its sync step 2.
- **Relay, then store.** The room relays each update at once, and appends it to room storage within 1 s. Before granting a save, it stores every unstored update.
- **Restarts.** A room that restarts after a deploy, an eviction or a crash loads its document from room storage when a message first needs it. Reconnecting clients send what it lacks in y-protocols sync step 2. An update is lost only if the room lost it and every client that held it is gone, and then it was never "Saved".
- **Compaction.** When updates appended since the last compaction pass 1 MB, the room replaces all stored updates, in one transaction, with one encoded state (`Y.encodeStateAsUpdate`, with `gc: true`). Stored values over 1 MB are split into parts.
- **Presence** is relayed, never stored. The room announces a connection's awareness removal when its socket closes.
- **Dropping state.** An hour after its last connection closes, a room whose document is fully covered drops its state. Uncovered updates stay until a co-editor joins: within the hour the room resumes, and after it the joining client saves them as a recovery revision ([Stale room](#joining-a-room)).

### Checkpoints

- **When.** Viewers never save. A co-editor's client asks for a save:
  - 2 s after its own last edit, as today's autosave does;
  - when its page becomes hidden, if the last checkpoint doesn't cover its own edits;
  - once the document has held uncovered updates for 10 s, which saves edits from a client that left or one that types without pausing.
- **Grant.** The client serializes a save copy and sends `save` with its snapshot. The room grants it when no grant is active, it holds no waiting update, the save copy's snapshot contains the last checkpoint's, and the room's snapshot contains the save copy's. Otherwise it answers `retry`. A grant carries the last checkpoint's `_rev` and `editedBy`, the users who sent updates since the last checkpoint. It ends when its holder releases it or disconnects, or 30 s after it started.
- **Save.** The client sends `PUT /_emdash/api/content/{collection}/{id}` with the `X-EmDash-Room` header, `skipRevision: true`, `_rev`, `editedBy`, and the document's fields and slug.
- **Report.** On success the client sends `saved`: the new `_rev`, and hashes of the stored values from the response and of the values it sent. The room refuses a `saved` whose snapshot its document doesn't contain. Otherwise it stores every unstored update and the record, then broadcasts `checkpoint` with the save copy's snapshot. A save whose report is lost isn't a checkpoint: the next save conflicts, and the merge rule keeps the room's values for the fields it stored.
- **Conflict.** On `409 CONFLICT` the client reads the entry and compares each field's hashes with the last checkpoint's:

  | Stored value changed | Document value changed | Result                                        |
  | -------------------- | ---------------------- | --------------------------------------------- |
  | No                   | Either                 | Nothing to write                              |
  | Yes                  | No                     | The stored value is written into the document |
  | Yes                  | Yes                    | The document keeps its value                  |

  A stored rich-text value with marks the editor can't represent is never written: the document keeps its value, as when both changed. The client builds a merge update for the stored values, using `updateYFragment` for rich text, which keeps the blocks before the first change and after the last. It sends the merge update, the new `_rev` and new hashes in `merged`. The room stores every unstored update, the merge update and the record in one transaction, then relays the merge update to everyone, the sender included, so a merge update the room never accepted is dropped. Once its replica holds the relayed update, the client serializes again and saves, under the same grant. Saves of values outside the document change `_rev` without changing the document, so the save after one writes nothing.

- **Refusals.** `401` means the session expired: the client asks its user to sign in again, and keeps its replica. `403` means the user lost write access, and `409 ENTRY_LOCKED` that the room lease was lost; in both cases the client resets. `404` means the entry is gone, and the client leaves the room and shows today's not-found state. The room broadcasts any other refusal, such as a validation error, as a notice, and clients don't resend the same refused payload.
- **Revisions.** A prerequisite fix marks autosave revisions (`revisions.autosave`), so an autosave replaces the previous draft revision only if that one was an autosave too. The new revision's `edited_by` includes the replaced one's. Checkpoints before operations, and from **Save**, are kept.
- **Hooks** run on every checkpoint, as on today's autosaves. The actor is the saving client's user, and `ContentHookEvent` gains `editedBy`.

### Operations

The client runs an operation in five steps:

1. It takes a grant, retrying while another is active.
2. It saves a kept checkpoint and reports it.
3. It calls today's route with the room header, and with the new `_rev` where the route takes one: publish, unpublish, schedule and discard.
4. For restore and discard, it reads the entry and writes every field whose stored hash changed, whatever the document holds, through `merged`. For the others, it sends `merged` with the new `_rev` only.
5. It sends `release` with a notice naming the operation. After a status change, the room closes every connection with `rejoin`, so the join route rechecks access. After a move to Trash, it closes them with `deleted` and drops its state.

**Save** is steps 1, 2 and 5. **Preview** asks for an ordinary save, and opens the preview once a checkpoint covers the client's edits. An author change is a save of a value outside the document, whose notice makes the room close every connection with `rejoin`. Operations are disabled while the client is offline. The publish dialog names everyone in `edited_by` on the revisions since the live one. Scheduled publishing runs as today, on the latest checkpoint.

Restore and discard refuse a target whose rich text holds marks the editor can't represent. During a restore or discard, edits typed between steps 2 and 4 to the fields it changes are overwritten, and no revision holds them. A save copy serialized before the restored values reached its client can store the old values once more, until the next checkpoint.

### The room lease

A room lease applies whatever `editLocking` says.

- **Claiming.** `_emdash_entry_locks` gains `room_host`: null for a user lock, and for a room lease `durable-object` or the Node.js process's random ID. The join route claims a room lease when there is no live edit lock or the live lock is a room lease.
- **Renewal.** Every co-editor client's existing lock heartbeat renews the lease with the room header, every 2 minutes for 7, under the same rule. Each renewal sets `user_id` to that co-editor and `room_host` to the renewing host. A co-editor whose renewal finds another lock resets.
- **Release.** A client that leaves releases the lease as today, if it claimed or renewed it last and the room reports no other co-editor connection. Otherwise the lease expires 7 minutes after its last renewal.
- **Enforcement.** A lock-checked write passes a room lease only with the `X-EmDash-Room` header, from a session, with the caller's usual permission. The header marks a client in the room; it isn't a credential. Everything else gets `ENTRY_LOCKED`, with today's `details` naming the lease's user. `overrideLock: true` writes still pass, and the recovery-revision route ignores edit locks.
- **Without the room header,** today's lock route reports a live room lease in any collection as another user's lock, even to the lease's user, and `takeover` can't take it. A client sent to single-editor mode therefore opens read-only until the lease ends. The route's claims set `room_host` to null.
- **Co-editing off.** The runtime ignores `room_host`, so a room lease is a user lock, as in older versions.

### Out-of-band writes

| Writer                                                          | While a room lease is live                                                        |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Co-editors' saves of values outside the document                | Pass with the room header, and the other clients reload the values                |
| The visual editor, REST, the CLI, MCP and tabs outside the room | `ENTRY_LOCKED`                                                                    |
| `overrideLock: true` writes                                     | Succeed, and the merge rule applies them at the next checkpoint                   |
| Plugin `ctx.content.update`                                     | Writes a new draft revision, and the merge rule applies it at the next checkpoint |
| Scheduled publishing                                            | Publishes the latest checkpoint                                                   |
| Sibling-locale sync on publish                                  | Writes the siblings, and each sibling's room applies it at its next checkpoint    |
| Permanent delete                                                | Also deletes the room's state                                                     |

Merges happen at checkpoints, so an out-of-band change appears in open editors after the next edit, or when a client joins.

### Reset and recovery

A client resets after a lineage mismatch, a refused update, a checkpoint refused with `403`, a lost room lease, or co-editing being turned off:

1. If its replica holds updates that no checkpoint covers, it saves the whole document as a recovery revision.
2. It discards its replica and joins again, starting from the room's document, or from the stored entry in a new lineage.

Recovery revisions use a new route, `POST /_emdash/api/content/{collection}/{id}/revisions`, with the session, `X-EmDash-Request` and edit access. It takes the document's fields and slug and an optional `editedBy`, creates a revision without moving the draft or live pointer, ignores edit locks, and checks size and shape but not fields, so content from before a schema change still saves. Recovery revisions show in Revisions with their author and `editedBy`, and are pruned like the others. A client that has lost edit access, or whose recovery save fails, keeps the edits in the tab for copying.

Text typed offline into content someone else deleted meanwhile disappears when it merges, as in other Yjs editors.

### Runtime hosts

The room logic lives in `emdash`, depends only on `yjs`, `y-protocols` and `lib0`, and runs behind an internal host boundary ([Interfaces](#interfaces)). On Workers, each room is an `EmDashRoom` Durable Object from `@emdash-cms/cloudflare`, with hibernatable WebSockets, and the package's Worker export forwards room upgrades to it before Astro. On Node.js, a new `emdash start` command runs the `@astrojs/node` standalone server in one process and takes upgrades on it, and room storage is in the site database. Any other way of serving the site gets single-editor mode ([Host integration](#host-integration)).

## Compatibility and migration

- **Off by default.** Upgrading changes nothing until a site turns on `experimental.coEditing` ([Configuration](#configuration)). Cloudflare sites also add the binding and export, and Node.js sites start with `emdash start`, as templates and the Docker image will.
- **Migrations** are additive and forward-only, with no backfill: `revisions.autosave`, `revisions.edited_by`, `_emdash_entry_locks.room_host`, and the room-storage tables, which every site database gets and only Node.js uses.
- **API.**
  - The content `PUT` gains an optional, draft-only `editedBy`, and the revisions list gains `editedBy`.
  - Two new routes: joining a room, and recovery revisions.
  - `ContentHookEvent` gains `editedBy`. A hook that checks the actor's role before accepting content must check everyone in it.
  - A room lease refuses writes that a user lock admits for its holder: the holder's other tabs, visual editor, CLI, MCP and API tokens. It also applies in collections with `editLocking` off, where today's lock doesn't.
- **The autosave fix** applies to every site: autosaves stop deleting a revision that a manual save created.
- **Turning co-editing off** takes effect when the site restarts or redeploys. Clients reset and use single-editor mode.
- **Downgrading.** Older versions ignore the new columns and tables, and treat a room lease as a user lock that expires.
- **Site transfer** doesn't carry the new revision columns or the room-storage tables while co-editing is experimental.
- This RFC amends [Readable revision history](readable-revision-history.md#co-editing). **Deprecations:** none.

## Security and privacy

| Party   | Trusted for                                                               |
| ------- | ------------------------------------------------------------------------- |
| Client  | Its own edits, within what its user's session allows over REST            |
| Room    | Relaying and storing the document, and enforcing each connection's access |
| Runtime | Permissions, hooks, validation and saving, as today                       |

- **Joining** needs the admin session and `X-EmDash-Request`, so another site can't obtain a token. Tokens are never logged.
- **One user's save holds another's edits.** Every co-editor has edit access to the entry, and each save and operation is authorized by its own session. EmDash has no content that only some roles may store: HTML blocks are sanitized or isolated when rendered, whoever saved them. Hooks get `editedBy` for their own checks. If EmDash adds content only some roles may store, checkpoints must check it against everyone in `editedBy`.
- **Access changes.** A connection lasts at most 15 minutes, and a checkpoint refused with `403` resets its client. Status and author changes made in the room make everyone rejoin at once; after scheduled publishing, or an operation whose client disconnects before step 5, access is rechecked by those limits. Contributors co-edit their own drafts, and after a publish they rejoin as viewers.
- **Attribution.** The room counts who sent updates, and the saving client relays `editedBy`, so a co-editor's client could misreport it. Attribution records who edited; it isn't access control.
- **Privacy.** Anyone who can open an entry sees who else has it open. Room storage holds Yjs updates, with content, until the room drops its state. Logs carry IDs and lineages, never content or tokens.

## Performance

- **Logged-out routes** are unchanged. Checkpoints are draft autosaves, which purge no route cache, and `editedBy` is stored only on revisions.
- **Opening an entry** adds the join request and a WebSocket. Checkpoints cost what autosaves cost today.
- **Cloudflare.** Each second's updates are one stored row, an estimated 7,000 to 15,000 rows per room-hour of typing with index writes and deletion, so the Free plan's 100,000 rows a day cover about 7 to 14 room-hours across the account. Incoming WebSocket messages are billed as requests at 20:1. A room that wakes only to relay awareness doesn't load its document.
- **Node.js** keeps a room's document in memory while it has connections.
- **Browsers** load the co-editing code only when it is active.

## Failure handling

| Failure                                                                     | What happens                                                                                                                                         |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Room storage is lost                                                        | Reconnecting clients reset, and the next join initializes from the stored entry                                                                      |
| The room can't store, for example after the Workers Free plan's daily quota | The room closes every connection, and clients reset. The token request stores first, so joins get single-editor mode until the room can store again. |
| Validation or a hook rejects a checkpoint                                   | Every client sees the error, and the edits stay in the room                                                                                          |
| Every remaining tab is hidden for minutes                                   | Hidden tabs' timers slow to about once a minute, so checkpoints slow down. The edits stay in the room.                                               |

Rooms log with the `[co-editing]` prefix. Operators turn co-editing off with the site option, and recover content from **Revisions**.

## Verification

- **Unit and property tests:** the grant rule, including delete-only edits; compaction; the lineage, stale-room and fingerprint rules; the field mapping; the merge rule, applied twice and after a lost report; and the Portable Text round trip.
- **A fixed-seed convergence harness** runs clients and a room through random edits and deletions, random delivery orders, drops and reconnects, room restarts that lose unstored updates, concurrent save requests and initializations, lost reports and `merged` messages, and out-of-band writes. Each run asserts that replicas converge, each checkpoint contains the one before it, no covered edit is lost, and no rich text is duplicated.
- **workerd tests:** hibernation and lazy loading, deploy restarts, the store timer, the drop alarm and storage failures.
- **Integration tests:** the join route, the room lease, the recovery route, the autosave fix and every out-of-band writer, on SQLite, libSQL and PostgreSQL.
- **Playwright tests** with several browser contexts: the [Example](#example), two tabs of one user, a viewer, a Contributor after a publish, restore and discard while others type, a reset, and API and MCP writes.
- **A manual pass** with a screen reader and a keyboard, in Arabic, at phone width.

### Acceptance gates

- **Round trip.** Every node, mark and plugin block EmDash ships, and every template's seed content, survives Portable Text → editor → shared document → Portable Text unchanged.
- **Schema safety.** 10,000 fixed-seed runs of 200 concurrent edits each make `@tiptap/y-tiptap` delete no non-empty content. If this fails, rich text switches to a central-authority engine.
- **Hosts.** `emdash start` serves rooms on `@astrojs/node` standalone, and `astro dev` serves them beside Vite's HMR socket on both adapters, with every Yjs call made inside the room registry, so routes never load a second copy of `yjs`. Upgrades reach the Durable Object, deployed and in development.
- **Cost.** Rows written and requests per co-editor-hour are measured, and published with the experimental release.

Co-editing becomes stable when 100,000 harness runs pass, the harness runs nightly in CI, the 500 ms goal holds, and someone editing alone sees no warning for drops under 5 s.

## Rollout and implementation

1. **Prerequisites:** the autosave fix; TipTap packages aligned so that `@tiptap/extension-collaboration` matches the editor (3.27.0 against 3.20.0 today).
2. **Rooms** on both hosts, the join route, the room lease and the recovery route. `emdash` gains `yjs`, `y-protocols`, `lib0` and `ws` as dependencies.
3. **The editor:** bindings, presence, undo, checkpoints, operations and reset.
4. **Hardening:** [Verification](#verification), docs and templates.

Co-editing ships behind `experimental.coEditing`. Once it is stable, a separate proposal can make it a top-level option and turn it on in templates.

## Alternatives

| Alternative                                                                                    | Why not                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Checkpoints made by the room,** which converts the document and saves it through the runtime | The room would need EmDash's runtime, hooks and plugins, and an exact server copy of the editor schema and converter. Saving with no client connected stays open to a later RFC behind the same protocol. |
| **One HTTP transport:** `POST` to send, a streamed response to receive                         | It avoids upgrade handling, but costs a request with a session lookup for every batch, and Yjs tooling assumes WebSockets                                                                                 |
| **A relay without a server document,** as WordPress 7.0 shipped                                | Clients would initialize and merge on their own, with no single order of saves. WordPress removed it.                                                                                                     |
| **Hocuspocus or y-partyserver as the room**                                                    | Each runs on only one of EmDash's hosts, and EmDash would still add grants, tokens and its storage rules to both                                                                                          |
| **Field locks,** as Directus ships                                                             | Presence with one-value fields is simpler, and doesn't stop anyone typing                                                                                                                                 |
| **A central-authority engine** that orders ProseMirror steps, as prosemirror-collab does       | EmDash would build cursors, presence and per-person undo itself. It is the fallback if the schema-safety gate fails.                                                                                      |
| **Store the Yjs document as content**                                                          | Rendering, REST, MCP, search and site transfer read Portable Text                                                                                                                                         |

## Drawbacks

- **Saving needs a client.** Edits left uncovered when the last client leaves wait in room storage. A co-editor who joins within an hour resumes the room, and the next checkpoint saves them. After that, or after a fingerprint change, they become a recovery revision that someone must restore. Until then, reads, publishing and API callers see the last checkpoint. On Cloudflare, those edits sit in Durable Object storage, outside D1 backups and site transfer.
- **Merge limits.** Fields other than rich text keep one change. A stored change to a field the room also changed loses to the room's value, and so does stored rich text with marks the editor can't represent. Such a change stays in Revisions when its write created a revision that isn't an autosave, as plugin writes, CLI and MCP updates, and REST updates without `skipRevision` do.
- **Fingerprint changes reset rooms.** An EmDash upgrade, or a change to any collection, plugin or taxonomy definition, resets every open room on the site within 15 minutes: clients reload, and uncovered edits become recovery revisions. During a gradual deployment of an upgrade, this repeats whenever requests alternate between versions.
- **Several Node.js processes** would each run their own room for an entry, and their checkpoints would overwrite each other. A process logs an error when it takes a room lease that another process renewed after it started.

## Open questions

- Are the timings and [limits](#appendix-b-limits) right?
- Should `blocks` and `repeater` merge per item?

## Appendix A: Implementation reference

### Protocol

Messages are binary. Yjs sync and awareness use y-protocols' message types 0 and 1, as y-websocket does. EmDash messages use type 100: a lib0 `varString` of JSON, then an optional `varUint8Array` holding a Yjs update or snapshot.

| Message       | From   | Carries                                                                                                                              |
| ------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `welcome`     | Room   | The lineage or none, the client's access level, the last checkpoint's `_rev` and snapshot, and whether this client should initialize |
| `initialize`  | Room   | A request to initialize: to the next co-editor when the one asked leaves, or after a stale room drops its state                      |
| `stale`       | Room   | A stale room's document and `editedBy`, for the joining co-editor to save as a recovery revision                                     |
| `recovered`   | Client | The stale document is saved, so the room can drop its state                                                                          |
| `init`        | Client | The lineage ID, the document as one update, the loaded entry's `_rev`, and hashes                                                    |
| `save`        | Client | The save copy's snapshot                                                                                                             |
| `grant`       | Room   | The last checkpoint's `_rev`, and `editedBy`                                                                                         |
| `retry`       | Room   | No grant: one is active, an update is waiting, or the save copy's snapshot doesn't fit                                               |
| `saved`       | Client | The new `_rev`, the save copy's snapshot, and stored and sent hashes                                                                 |
| `merged`      | Client | The merge update, if any, the new `_rev`, and hashes. Only from the grant holder.                                                    |
| `release`     | Client | Ends the grant, with an optional notice                                                                                              |
| `notice`      | Either | What changed, such as a publish, a save of values outside the document, or a refused checkpoint. The room adds who.                  |
| `checkpoint`  | Room   | The new last checkpoint's snapshot and `_rev`                                                                                        |
| `connections` | Room   | The number of co-editor connections, whenever it changes                                                                             |

- **Close codes:** 4400 `rejoin`, 4401 `reset` and 4402 `deleted`. The client's provider never reconnects on its own; the client joins again for a fresh token, then reconnects.
- **Refusals.** The room refuses `saved` and `merged` from a connection that doesn't hold the grant.
- **Presence.** The room relays awareness to every connection, the sender included, as y-websocket's server does. Visible clients renew it about every 15 s, which keeps idle connections alive; long-hidden tabs renew less often and drop out of others' presence.
- **Hashes** are SHA-256 of each document field's value as JSON canonicalized with RFC 8785 (JCS), keyed by field slug, plus the entry's slug. The stored slug is the draft revision's staged `_slug` when it has one, otherwise the live slug, as the admin reads it today. A save response's `item.slug` is always the live one, so after a save the stored slug hash is the sent slug's. In `init`, the stored hashes come from the loaded entry and the sent hashes from serializing the new document.
- **Waiting updates.** Yjs has no public API for them; the room reads `doc.store.pendingStructs` and `doc.store.pendingDs`.
- **Lost reports.** The merge rule keeps each field a lost save stored, because the document still differs from the recorded sent hash. The exception is a field someone set back to its value at the checkpoint before: the stored value wins that field.

### Host integration

**Cloudflare Workers:**

- The default export of `@emdash-cms/cloudflare/worker` wraps `fetch` and forwards room upgrades with `stub.fetch(request)`. Templates already spread that export; a site with its own `fetch` calls the package's `handleRoomUpgrade` first. Under `astro dev`, the Cloudflare Vite plugin runs the Worker entry in workerd and forwards it every upgrade that isn't Vite's own.
- The join route reaches the room by RPC through `env` from `cloudflare:workers`, retrying once with a fresh stub.
- The store write runs in the same synchronous turn as the `grant` send, so the output gate holds the grant until the write is durable.
- The store delay uses `setTimeout`, which keeps the room in memory for up to 1 s. The one-hour drop uses the Durable Object's alarm, and the 15-minute and 30 s limits are checked whenever a message arrives.

**Node.js:**

- `emdash start` checks that the adapter runs in standalone mode, sets `ASTRO_NODE_AUTOSTART=disabled`, imports `dist/server/entry.mjs` dynamically, and calls its `startServer()`. It attaches an `upgrade` listener, using `ws` with `noServer` and an explicit `maxPayload`, to the server that starts (`startServer().server.server`, already listening). The listener answers or destroys every upgrade, refusing other paths with `400`.
- `startServer()` and the `ASTRO_NODE_AUTOSTART` variable are undocumented, though `astro preview` uses the same switch. If they change, `emdash start` can mount the entry's exported `handler` in its own `http.createServer`.
- Under `astro dev` with `inProcessRooms()`, the integration attaches the listener to Vite's `httpServer` in `astro:server:setup`. It ignores other paths and leaves their sockets alone for Vite's HMR listener. It attaches nothing under the Cloudflare adapter.
- The room registry lives on `globalThis` under a `Symbol.for` key, because routes run from a bundled copy of `emdash` in development and production.
- Rooms store unstored updates on shutdown. An hourly cleanup drops the state of rooms whose last connection closed over an hour ago and whose document is covered.

### Interfaces

The host boundary is internal and can change until co-editing is stable:

```ts
// Called by routes: Durable Object RPC on Workers, the registry on `globalThis` on Node.js.
interface RoomHost {
	// Stores first; resolves to null when the room can't store.
	issueToken(roomId: string, claims: TokenClaims): Promise<string | null>;
	destroy(roomId: string): Promise<void>;
}

// Called by a room: the Durable Object's SQLite on Workers, the site database through Kysely on Node.js.
interface RoomStore {
	load(): Promise<{ record: RoomRecord | null; updates: Uint8Array[] }>;
	append(updates: Uint8Array[]): Promise<void>;
	writeRecord(record: RoomRecord, update?: Uint8Array): Promise<void>;
	compact(state: Uint8Array): Promise<void>;
	drop(): Promise<void>;
}
```

Sockets and timers come from the host.

### Data model

| Change                                                                                                                                             | Purpose                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `revisions.autosave`, an integer defaulting to 0                                                                                                   | Autosaves replace only autosaves          |
| `revisions.edited_by`, a nullable JSON list of user IDs                                                                                            | Who edited a revision                     |
| `_emdash_entry_locks.room_host`, nullable text                                                                                                     | Room leases, and the room's host          |
| `_emdash_room_updates`: `room_id`, `seq`, `part` and `data` (a blob on SQLite, `bytea` on PostgreSQL), with primary key (`room_id`, `seq`, `part`) | Room storage: updates and compacted state |
| `_emdash_rooms`: `room_id`, `part`, `record` (JSON) and `updated_at`, with primary key (`room_id`, `part`)                                         | Room storage: the room record             |

The room record holds the lineage and fingerprint; the last checkpoint's `_rev`, snapshot, and stored and sent hashes; the users who sent updates since the last checkpoint; and when the last connection closed. On Workers, each Durable Object keeps the two room-storage tables in its own SQLite, where `room_id` is constant. On Node.js, `room_id` is `{collection}:{entry ID}`.

### Configuration

On Node.js, the option takes `inProcessRooms()` from `emdash/astro`, and the `start` script runs `emdash start`:

```js
emdash({
	// database, storage, …
	experimental: { coEditing: inProcessRooms() },
});
```

On Cloudflare, the option takes `durableObjectRooms()` from `@emdash-cms/cloudflare`, and the Worker entry adds `EmDashRoom` to its exports:

```js
emdash({
	// database, storage, …
	experimental: { coEditing: durableObjectRooms({ binding: "ROOMS" }) },
});
```

```jsonc
"durable_objects": { "bindings": [{ "name": "ROOMS", "class_name": "EmDashRoom" }] },
"migrations": [{ "tag": "emdash-rooms", "new_sqlite_classes": ["EmDashRoom"] }]
```

## Appendix B: Limits

These are starting values, for the prototype to measure.

| Limit                                     | Value                                             |
| ----------------------------------------- | ------------------------------------------------- |
| Largest update                            | 1 MB encoded; `init` and merge updates up to 4 MB |
| Largest entry for a room                  | 1 MB of stored data                               |
| Connections per room                      | 25                                                |
| Connections per user in a room            | 5                                                 |
| Token                                     | 60 s, single use                                  |
| Connection lifetime                       | 15 minutes                                        |
| Store delay                               | 1 s                                               |
| Compaction threshold, and part size       | 1 MB                                              |
| Grant timeout                             | 30 s                                              |
| Save delay                                | 2 s after the client's own last edit              |
| Uncovered updates before any client saves | 10 s                                              |
| Room state after the last connection      | 1 hour                                            |
