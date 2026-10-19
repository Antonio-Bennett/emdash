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

- **A room per entry syncs and saves.** A room is a server-side object that holds the entry's shared Yjs document and relays Yjs updates and presence over WebSockets: a Durable Object on Cloudflare Workers, an in-process object on Node.js. It saves the document through the same steps as today's autosave request, so permissions, hooks, validation and revisions apply as they do today, and stored content stays Portable Text.
- **Every other write merges in.** REST, MCP, the CLI, the visual editor and plugins write as they do today. Each write tells the entry's room, which copies the changed fields into the shared document, except fields someone in the room changed since its last save.
- **On by default** wherever the host can run rooms. Everywhere else, editing works as it does today.

Co-editing applies only to collections with revisions. Presence for agents and API callers, comments and suggestions are out of scope.

## Problem and user case

Only one person can edit an EmDash entry at a time. Edit locking ([Discussion #2819](https://github.com/emdash-cms/emdash/discussions/2819)) is on by default: the first person to open an entry holds its lock, and everyone else gets **Open read-only** or **Take over**. When locking is off, a save based on an older `_rev` gets `409 CONFLICT`; after a take-over, the displaced editor's saves get `409 ENTRY_LOCKED`. Nothing merges. Teams take turns, or draft in another tool and paste, which loses Portable Text structure.

The Ideas Discussion ([#4173](https://github.com/emdash-cms/emdash/discussions/4173)) asked for the [goals](#goals) below. A reply asked who is responsible when one publish includes several people's edits: revisions record everyone whose edits they hold, and the publish dialog names them.

### Prior art

- **WordPress 7.0** relayed Yjs updates between browsers, which saved the post through the ordinary save and autosave requests ([Gutenberg #72373](https://github.com/WordPress/gutenberg/pull/72373)). WordPress removed it before release ([removal post](https://make.wordpress.org/core/2026/05/08/rtc-removed-from-7-0/)). Its next design has the server record, authorize, merge and store every update: a browser that fell behind could save over newer work, REST writes couldn't reach open editors, and a privileged browser could save content a less privileged collaborator added ([server-aware post](https://make.wordpress.org/core/2026/09/18/moving-to-a-server-aware-approach-for-collaboration/)).
- **JupyterLab and PreTeXt-Plus** started with browser saves and later moved conversion and saving to the server ([JupyterLab #11599](https://github.com/jupyterlab/jupyterlab/pull/11599), [PreTeXt-Plus #414](https://github.com/PreTeXtPlus/PreTeXt-Plus/pull/414)).
- **Yjs servers** such as Hocuspocus and y-partyserver hold the document, authorize connections, store updates on a debounce, and recover updates lost in a restart from clients, through the y-protocols sync handshake.
- **The Yjs author's model** for an app whose database is the source of truth starts a session from database content, forgets it about an hour after the last client leaves, and accepts that clients from a forgotten session can't merge ([Lexical FAQ](https://lexical.dev/docs/collaboration/faq)).

This design takes the server-aware direction. The room starts from the stored entry, is the only saver of the shared document, and merges every other write. That addresses WordPress's three problems: no browser saves, outside writes reach open editors, and each save is authorized as a co-editor with edit access, in a CMS that has no content only some roles may store ([Security and privacy](#security-and-privacy)).

## Example

Ana (Editor role) opens the post "Spring launch", which Ben (Author role) already has open. Her editor joins Ben's room, and each sees the other's avatar and named cursor. Ana edits the title while Ben rewrites the second paragraph. Two seconds after the last edit, the room saves the post with both people's edits, and both editors show "Saved".

Ben's Wi-Fi drops for twenty seconds. He keeps typing, and when he reconnects his edits merge and the room saves them. A script with Ana's API token updates the post's excerpt, and the new excerpt appears in both editors within a second. Ana publishes: the room saves, the post is published, and Ben's later edits are unpublished changes.

## Goals

- **Concurrent editing** of the entry form, with every replica converging. [The shared document](#the-shared-document) lists which concurrent edits keep one change, and which values save on their own.
- **Presence:** avatars, the field each person is in, and named cursors in rich text. Remote edits render within 500 ms at the 95th percentile.
- **Per-person undo.**
- **Short disconnects.** A client that reconnects within an hour of everyone leaving merges its offline edits. Edits that can't merge are kept as a revision.
- **"Saved" is true.** A client shows "Saved" only when a save holds all its edits.
- **Live outside writes.** A write from REST, MCP, the CLI, the visual editor or a plugin appears in open editors within a second.
- **Deliberate publishing.** Publish is one operation, by someone with publish permission, on a save made at that moment.
- **Hosts:** Cloudflare Workers and single-process Node.js, over WebSockets, with no third-party service and no Cloudflare code in `emdash`.
- **On by default** wherever the host can run rooms.
- **No visitor cost.** Logged-out routes run no additional queries.

## Non-goals

- **Presence for agents and API callers.** Their writes merge, but they have no cursor, presence or undo.
- **Comments, suggestions, tracked changes and approval workflows.**
- **Offline edits that outlive the room or the tab.**
- **Co-editing in the visual editor.** Its writes merge into open rooms, but it doesn't show other people's edits as they happen.
- **Merging inside fields other than rich text.** Each such field is one value, `blocks` and `repeater` included.
- **A per-collection setting.** The site option turns co-editing off everywhere.

## Detailed design

[Appendix A](#appendix-a-implementation-reference) holds the protocol, host integration and tables, and [Appendix B](#appendix-b-limits) the timings and limits.

### Terms

| Term                 | Meaning                                                                                                                                                                                                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Room                 | The server-side object for one entry row (each locale is a row). It keeps the shared document and the room record in room storage, accepts WebSockets, relays updates and presence, saves the document, and merges outside writes into it.                                                                         |
| Open                 | A room is open while it has connections or tokens it issued that are unused and unexpired, and for 10 s after its last connection closes                                                                                                                                                                           |
| Shared document      | The room's `Y.Doc`. Clients replicate it by exchanging Yjs updates over y-protocols.                                                                                                                                                                                                                               |
| Client               | One admin editor instance, usually a tab, with its own replica and Yjs client ID                                                                                                                                                                                                                                   |
| Co-editor, viewer    | A user connected to the room with write access, or with read access only. A client has its user's access.                                                                                                                                                                                                          |
| Snapshot             | A Yjs snapshot: a state vector and a delete set. Snapshot A **contains** snapshot B when A's state vector is at least B's and A's delete set includes B's. A state vector alone can't show deletions.                                                                                                              |
| Stored entry         | The entry row and its revisions in the site database                                                                                                                                                                                                                                                               |
| Room storage         | Where a room keeps its document and room record: the Durable Object's SQLite on Workers, two tables of the site database on Node.js                                                                                                                                                                                |
| Checkpoint           | A snapshot of the document, recorded when every edit in it has been saved: at each save the room makes or skips because nothing changed, at initialization, and after a merge into a document with nothing uncovered. An update is **covered** when the last checkpoint's snapshot contains it.                    |
| Merge base           | The stored entry's `_rev`, and each field's stored and document hashes, as of the room's last checkpoint or merge. A save sends the fields whose document value differs from it, and a merge compares the stored entry with it.                                                                                    |
| Kept checkpoint      | A checkpoint saved without `skipRevision`, or that marked the draft revision as kept, so later checkpoints don't replace its revision                                                                                                                                                                              |
| Actor                | The user a checkpoint is saved as: the co-editor who sent the latest update the checkpoint holds, or the user who asked for a kept checkpoint, by sending `save` or running an operation                                                                                                                           |
| Outside write        | Any write to the stored entry that isn't a checkpoint                                                                                                                                                                                                                                                              |
| Notification         | What a write sends the entry's room after it commits, so that the room merges it                                                                                                                                                                                                                                   |
| Shared editor schema | The admin editor's ProseMirror schema and Portable Text converter, in a DOM-free subpath export of `@emdash-cms/admin` that the editor and rooms both use                                                                                                                                                          |
| Room record          | What the room stores besides the document ([Data model](#data-model))                                                                                                                                                                                                                                              |
| Lineage              | A random ID for one continuous room state. A room that starts from the stored entry starts a new lineage.                                                                                                                                                                                                          |
| Fingerprint          | The `version`, `commit` (EmDash's build commit) and `hash` of the admin manifest. It changes with EmDash upgrades and with collection, plugin or taxonomy definitions. A client's fingerprint is the `version` and `commit` built into its admin bundle, and the `hash` of the manifest its editor was built from. |
| Single-editor mode   | Today's behavior: the client takes a user lock, or opens read-only                                                                                                                                                                                                                                                 |
| Operation            | Publish, schedule, unpublish, unschedule, restoring a revision, discarding the draft, or moving to Trash                                                                                                                                                                                                           |
| Reset                | A client saves its uncovered edits as a recovery revision, discards its replica and joins again ([Reset and recovery](#reset-and-recovery))                                                                                                                                                                        |
| Recovery revision    | A revision, marked `recovery`, that holds edits the room or a client couldn't save, and is neither the draft nor the live one                                                                                                                                                                                      |

"The editor" is the admin entry editor. Editor, Author and Contributor are roles.

### Current behavior

- **Autosave** sends the whole form 2 s after typing stops, as `PUT /_emdash/api/content/{collection}/{id}` with `skipRevision: true` and `_rev`. The route checks edit permission and the edit lock, then calls the runtime's update. A stale `_rev` gets `409 CONFLICT`. The response holds the entry as stored after `content:beforeSave` hooks, with its new `_rev`; `content:afterSave` hooks run afterwards. Draft saves purge no route cache.
- **Every draft save creates a revision.** `skipRevision: true` then deletes the previous draft revision, even one that a manual save created.
- **The edit lock** belongs to a user, lasts 7 minutes, is renewed every 2 minutes, and admits any session of its holder's user. Plugin writes, scheduled and sibling-locale publishing, taxonomy terms, trash restore, permanent delete, duplicate and seeding don't check it, and `overrideLock: true` skips it.
- **Other writers.** The visual editor saves one field at a time, without `_rev`. Plugin `ctx.content.update` writes through the content repository and skips hooks and validation.
- **Values that save on their own:** SEO, author and publication date go through the content `PUT`, written to the live row at once, and taxonomy terms through `POST …/terms/{taxonomy}`. Bylines and changed reference fields ride the form save, with the slug.
- **The editor schema** is built inside the admin editor's React component, from extension modules that load React. The admin editor has its own Portable Text converter, which differs from the converters `emdash` exports for other editors. `emdash` already imports DOM-free modules from `@emdash-cms/admin`, such as `@emdash-cms/admin/portable-text-table`.
- **Schema mismatches delete content.** `@tiptap/y-tiptap` deletes from a Yjs fragment any node that the schema reading it doesn't know.
- **Outside a request,** `withEmDashRuntime()` gives code the runtime that requests use. Scheduled tasks get it the same way.
- **The site-write fence** blocks writes during a site transfer import and records writes for running exports. Middleware applies it to the content API's writes, except the lock route, and MCP tools and plugin writes apply it themselves.
- **WebSockets.** Astro has no WebSocket API ([withastro/roadmap#695](https://github.com/withastro/roadmap/discussions/695)), and `@astrojs/node` handles no upgrades.

### Architecture

```
 Clients (editor tabs) ◀── WebSocket: Yjs sync, presence ──▶ Room (one per entry)
                                                             keeps the Yjs document
                                                             in room storage
                                            checkpoint: the      │      ▲
                                            content update steps │      │ notification
                                                                 ▼      │ after each write
 REST, MCP, CLI, visual editor, plugins ── writes ──▶ EmDash runtime: permissions,
                                                      hooks, validation, revisions
                                                                 │
                                                                 ▼
                                               Draft revision ── publish ──▶ live revision
```

### Guarantees

1. **One room per entry.** Workers runs one Durable Object per name. Node.js keeps one registry of rooms in a single process ([Runtime hosts](#runtime-hosts)).
2. **One lineage.** A client merges only into the lineage it started from. A client from another lineage resets ([Joining a room](#joining-a-room)).
3. **One saver.** Only the room saves the shared document, and it runs initialization, saves and merges one at a time, so each checkpoint contains the one before it. `_rev` stops a save over a write the room hasn't merged ([Saving](#saving)).
4. **Room storage holds every saved update.** The room stores every update a save holds before it saves, so no checkpoint holds an update that room storage lacks ([Updates and room storage](#updates-and-room-storage)).
5. **"Saved" means covered.** A client shows "Saved" when the last checkpoint contains its replica's snapshot from its own last edit, and otherwise asks before its tab closes.
6. **Hook output stays out.** The room writes stored values into the document only when it merges an outside write, never from its own save's response, so hook output stays in the stored entry.

### The shared document

| Field                                                                                                                | Yjs type                                                                                                            | Concurrent edits                                                 |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `portableText`                                                                                                       | A `Y.XmlFragment` per field, bound to TipTap by `@tiptap/extension-collaboration` and `@tiptap/y-tiptap` (both MIT) | Merge. Every concurrent insertion is kept.                       |
| Every other field in `data` (`blocks`, `repeater` and plugin widgets included) except reference fields, and the slug | One value in a `Y.Map`                                                                                              | One of the concurrent changes is kept, the same on every replica |

- **Values outside the document** save on their own: SEO, author, publication date, taxonomy terms, bylines and reference fields. In a room, bylines and reference fields leave the form save and save at once, sending only what changed, without `_rev`. If a save fails, the client shows today's save error and keeps the value unsaved in the input. Reference-field saves are autosaves, so they don't add kept revisions, and byline saves write the live row and create no revision, as today. Each such save notifies the room, which tells the other clients to reload those values, waiting while an input for one has focus.
- **Keys.** The client that creates a Portable Text block assigns its `_key` in the same transaction, including on split and paste. The shared converter derives any other missing or duplicate key, of a block, span or mark definition, from the node's position, so the same document always serializes to the same Portable Text.
- **Normalizing plugins.** Editor plugins that append their own transactions, such as the trailing paragraph, ordered-list joining and table keys, normalize only what the client's own transaction changed, never what a remote update changed. The room writes its initial document, merges and overwrites in the form those plugins leave content, so opening an entry or receiving a merge makes no client write.
- **Undo.** Rich text uses `Y.UndoManager` with only the client's own origin, and the editor turns off TipTap's `undoRedo`; the slash menu, which undoes through `undoRedo` today, uses the same undo manager. Other inputs keep the browser's undo. Merges the room writes are in no one's undo history.
- **Presence** is Yjs awareness. Each client shares the field it is in and, in rich text, its cursor and selection. The room sets each connection's user ID and name from its token, relays awareness only for the Yjs client ID the connection first announced, refuses a client ID that another connection holds, and viewers share neither cursor nor field.
- **Block replacements.** "Turn into", dragging a block, deleting it, and adding table rows or columns replace the block, so concurrent typing inside it is lost.
- **Plugin blocks.** The plugin block modal applies its edit to the block with the same `_key`, not to the position the editor captured when it opened (`editingBlockPosRef`). If that block is gone, the edit is refused.
- **Widgets and plugin actions.** Field widgets keep `value` and `onChange`. A remote change remounts the field's widget; if the widget has focus, the remount waits until it loses focus. A plugin editor action applies its patch in one transaction, which is one undo step.

### Joining a room

The client calls `POST /_emdash/api/content/{collection}/{id}/room` with the session and `X-EmDash-Request`, sending its fingerprint. API tokens are refused. Like the lock route, the route isn't a site write: the site-write fence neither blocks nor records it. It returns one of four results:

- **A room:** `{ url, token }`. Callers need `content:read_drafts`. Users that today's edit check (`requireEntryEditPerm`) allows join as co-editors, the rest as viewers. The route asks the room for the token, by RPC on Workers or a direct call on Node.js, and sends the entry's `_rev` with the request.
- **Single-editor mode,** when co-editing is off, the collection has no revisions, the host can't run rooms, the request runs in a playground session, or the caller holds the entry's user lock, which the client then shares as today. It is also the result when the room won't run: it can't store, or it must initialize and the entry is over 1 MB or holds rich-text marks the editor can't represent, which today's editor refuses to save. When a connection limit is reached, the client opens read-only.
- **`ENTRY_LOCKED`,** when another user holds a user lock. The client shows today's notice, and **Take over** repeats the join with `takeover: true`, which deletes that lock.
- **`409 CLIENT_OUTDATED`,** when the fingerprint differs from the server's. The client saves its uncovered edits as a recovery revision, then reloads the admin.

Rooms take no edit lock. While a room is open, today's lock route reports it as the entry's holder and grants no user lock. Single-editor tabs therefore open read-only, and a tab displaced by **Take over** turns read-only at its next heartbeat.

The token is random, single use, valid for 60 s, and bound to the user, the user's name, the access level and the fingerprint. The room keeps it in memory. Every connection, reconnects included, uses a fresh token.

The client connects to `/_emdash/rooms/{collection}/{id}?token=…`. The room sends `welcome`, then y-protocols sync runs. Until sync completes, the client shows the entry it loaded, read-only.

- **Initialize.** When a room without state is asked for a token, it loads the stored entry, builds its document with the shared editor schema, picks a lineage ID, and records the document's snapshot as the last checkpoint and the loaded entry as the merge base. Every client then syncs from that one document.
- **Lineage.** A client that already has a replica compares lineages, and resets if they differ.
- **Stale entry.** When the `_rev` sent with a token request differs from the merge base's, the room loads the entry and merges it before it answers.
- **Stale room.** A room is stale when a token's fingerprint differs from the one in its record, or when it loads a document that another EmDash build made (the record's `version` or `commit` differs). A stale room never reads its document with the schema. If the document holds uncovered updates, the room saves it as a recovery revision. Then it closes every connection with `rejoin`, drops its state and initializes again from the stored entry.
- **Connection lifetime.** Whenever the room handles a message, it closes every connection older than 15 minutes, and those clients join again, which rechecks the session and access.

### Updates and room storage

- **Updates.** The room applies updates only from co-editors, up to 1 MB each. Viewers send only sync step 1 and awareness, and the room ignores anything else a viewer sends. The room refuses an update over the limit or one that doesn't decode, and closes that connection with `reset`. A client sends incremental updates only after it has sent its sync step 2.
- **Relay, then store.** The room relays each update at once, and appends it to room storage within 1 s. Before it saves, it stores every update the save holds.
- **Restarts.** A room that restarts after a deploy, an eviction or a crash loads its document from room storage when a message first needs it. Reconnecting clients send what it lacks in y-protocols sync step 2. An update is lost only if the room lost it and every client that held it is gone, and then it was never "Saved".
- **Compaction.** When updates appended since the last compaction pass 1 MB, the room replaces all stored updates, in one transaction, with one encoded state from `Y.encodeStateAsUpdate`. The room's document keeps Yjs garbage collection on, so the state holds no deleted content. Stored values over 1 MB are split into parts.
- **Presence** is relayed, never stored. The room announces a connection's awareness removal when its socket closes.
- **Dropping state.** An hour after its last store or closed connection, if it isn't open, the room drops its state. If the document holds uncovered updates, the room first saves them. If that save gets `409 CONFLICT`, because the stored entry changed while the room wasn't open, or fails, the room saves a recovery revision instead. If the recovery save fails too, it keeps its state and tries again an hour later.

### Saving

- **When.** The room saves 2 s after the latest update from a co-editor, and at least every 10 s while such updates keep arriving, except during an operation; when the operation's hold ends, it saves if such updates arrived meanwhile. A merge alone doesn't start a save. It also saves after it loads a document with uncovered updates from room storage, when the last co-editor connection closes, when a client sends `save` for the **Save** button, and when an operation asks. Those last two save kept checkpoints, as the requesting user.
- **How.** Without waiting in between, the room takes the document's snapshot and serializes the fields that updates touched or merges kept since the last checkpoint, or every field after it loads from room storage. It reads rich text as ProseMirror JSON without a schema, which can't change the document, and converts it with the shared editor schema's converter. It then stores every update the snapshot contains, and saves the fields whose hash differs from the merge base, as the actor, with `skipRevision: true`, the merge base's `_rev`, and `editedBy`: the users whose updates the snapshot adds since the last checkpoint.
- **Save steps.** The room saves through the steps of today's `PUT` route, moved into a function the route and rooms share: the actor's edit check and the runtime's update. Room saves also apply the site-write fence, as plugin writes do; a refusal counts as a failed save. They don't check edit locks, as plugin writes don't, and as draft saves they purge no route cache.
- **Nothing to send.** When no field differs from the merge base, an autosave saves nothing and records the snapshot as the last checkpoint. A kept checkpoint marks the entry's draft revision, if it has one, as kept, after the same `_rev` check; marking doesn't change `_rev`.
- **Record.** On success the room records the snapshot as the last checkpoint and updates the merge base: the new `_rev`, the hash of every stored value in the response, and the hash of every value it sent. Then it broadcasts `checkpoint`.
- **Conflict.** On `409 CONFLICT` the room loads the entry, merges it as for a notification, and saves again once. If that conflicts too, it waits for the next update or notification.
- **Refusals.** `403` means the actor lost edit access; a disabled or deleted actor counts as one. The room closes that user's connections with `rejoin`, and saves as the next most recent editor. If no one in `editedBy` can save, the edits stay in the room until someone who can sends an update, or until the room drops its state. `404` means the entry is gone: the room closes every connection with `deleted` and drops its state. The room broadcasts any other refusal, such as a validation error, as a notice, and tries again at the next update.
- **Revisions.** A prerequisite fix marks autosave revisions (`revisions.kind`), so an autosave replaces the previous draft revision only if that one was an autosave too. The new revision's `edited_by` includes the replaced one's. Checkpoints before operations are kept.
- **Hooks** run on every checkpoint, as on today's autosaves, with the actor as the event's actor. `ContentHookEvent` gains `editedBy`.

### Outside writes

Every write to an existing entry, or to its SEO, bylines or taxonomy terms, notifies the entry's room after its transaction commits, without waiting for the room. The notification carries the entry's `_rev` and names the values outside the document that the write changed. Notifications come from the runtime's write paths, the plugin content API, the sandboxed-plugin bridge on Workers and the terms route, so plugin writes, which skip hooks, notify too. Writes the room makes don't notify it, and neither does creating an entry, which has no room yet. A room that isn't open ignores notifications, and the `_rev` check at the next join catches up. Writes that update rows directly without changing `_rev`, such as the WordPress import's URL rewrite, don't notify, and the next save of that field overwrites them, as today's autosave does.

On every notification, the room tells clients to reload the values outside the document that it names. When the notification's `_rev` differs from the merge base's, the room also loads the entry and compares each field's hashes with the merge base's:

| Stored value changed | Document value changed | Result                                        |
| -------------------- | ---------------------- | --------------------------------------------- |
| No                   | Either                 | Nothing to write                              |
| Yes                  | No                     | The stored value is written into the document |
| Yes                  | Yes                    | The document keeps its value                  |

- **Writing.** The room writes rich text with `updateYFragment`, which keeps the blocks before the first change and after the last, and other values with `Y.Map.set`. It never writes rich text with marks the editor can't represent: the document keeps its value, and the stored value stays until someone edits that field in the room. Without waiting in between, it compares the fields, writes them and serializes each field it wrote, using a synchronous hash, so no update lands between the comparison and the write.
- **Merge base.** The room then records the loaded `_rev`, the hash of every loaded value, and, for each field it wrote, the hash of the field's serialization after the write. For a field where both values changed, it clears the document hash, so the next save sends the document's value. It stores the merge and the record in one transaction, then relays the merge like any update.
- **Coverage.** If the document held no uncovered updates before the merge, the room records its snapshot as the last checkpoint. Otherwise the next save stores them.
- **Access.** If the entry's status or author changed, the room closes every connection with `rejoin`, so the join route rechecks access. If the entry is in Trash, it closes them with `deleted` and drops its state.

Merges happen within a second of the write, so open editors show an outside change almost at once.

### Operations

The client calls today's route for the operation. While the entry's room is open, the runtime's method for the operation, when a user calls it through a route or MCP:

1. Asks the room to save a kept checkpoint now, as the requesting user, and gets its `_rev`. If that save fails, the operation fails with its error.
2. Runs the operation, with that `_rev` where the operation takes one: publish, unpublish, schedule and discard.
3. Releases the room, even when the operation failed. The room then loads the entry and merges it. For restore and discard, it overwrites instead: it writes every field whose stored value differs from the kept checkpoint's, whatever the document holds.

From step 1 until the release, or for 30 s at most, the room holds: it makes no other save or merge, so typing can't make the operation conflict or undo a restore. Operations take turns, because a second operation's save waits for the first one's release, and each release names the hold it ends. A room that restarts during a hold loses it, and a release for an expired hold merges like a notification, so in both cases a restore can merge as an ordinary outside write. A status change makes everyone rejoin, and a move to Trash closes the room. Restore and discard refuse a target whose rich text holds marks the editor can't represent. Edits typed during a restore or discard to the fields it changes are overwritten, and no revision holds them.

Scheduled publishing and plugin actions skip these steps. They keep their own `_rev`, their writes merge as outside writes, and scheduled publishing publishes the latest checkpoint, as today.

**Save** sends `save`, and the room saves a kept checkpoint as the sender. **Preview** opens the preview once a checkpoint covers the client's edits. Operations are disabled while the client is offline. The publish dialog names everyone in `edited_by` on the revisions since the live one.

### Reset and recovery

A client resets after a lineage mismatch, a refused update, or a join that returns single-editor mode:

1. If its replica holds updates that no checkpoint covers, it saves the whole document as a recovery revision.
2. It discards its replica and joins again.

Recovery revisions use a new route, `POST /_emdash/api/content/{collection}/{id}/revisions`, with the session, `X-EmDash-Request` and edit access. It takes the document's fields and slug, creates a revision marked `recovery` without moving the draft or live pointer, ignores edit locks, and checks size and shape but not fields, so content from before a schema change still saves. A room saves its own recovery revisions the same way, without an edit check, attributed to everyone in `editedBy`. Recovery revisions show in Revisions with their author and `editedBy`, and are pruned like the others. Because they skip validation and hooks, restoring one saves its fields through the runtime's update, with validation and `content:beforeSave` hooks, as the restoring user. A client that has lost edit access, including one that joins again as a viewer, or whose recovery save fails, keeps the edits in the tab for copying.

Text typed offline into content someone else deleted meanwhile disappears when it merges, as in other Yjs editors.

### Runtime hosts

The room logic lives in `emdash`, depends on `yjs`, `y-protocols`, `lib0`, `@tiptap/y-tiptap` and the shared editor schema, and runs behind internal host boundaries ([Interfaces](#interfaces)). A room reaches the site through core functions that run inside `withEmDashRuntime()`.

On Workers, each room is an `EmDashRoom` Durable Object from `@emdash-cms/cloudflare`, with hibernatable WebSockets. The package's Worker export forwards room upgrades to it before Astro, and the room calls back into its own Worker to load and save. On Node.js, a new `emdash start` command runs the `@astrojs/node` standalone server in one process and takes upgrades on it. Rooms call the site in-process, and room storage is in the site database. Any other way of serving the site gets single-editor mode ([Host integration](#host-integration)).

## Compatibility and migration

- **On by default** where the host can run rooms: Node.js sites started with `emdash start`, and Cloudflare sites with the `EmDashRoom` binding and export ([Configuration](#configuration)). Templates and the Docker image will include both, and other sites keep today's behavior until they add them. `coEditing: false` turns co-editing off.
- **Migrations** are additive and forward-only, with no backfill: `revisions.kind`, `revisions.edited_by`, and the room-storage tables, which every site database gets and only Node.js uses.
- **API.**
  - The revisions list gains `editedBy`. The content `PUT` doesn't change.
  - Two new routes: joining a room, and recovery revisions.
  - `ContentHookEvent` gains `editedBy`. A hook that checks the actor's role before accepting content must check everyone in it.
  - In a room, `content:beforeSave` hooks receive only the fields a checkpoint changed, as they do for visual-editor saves and partial REST updates, instead of the whole form the editor sends today.
  - While a room is open, writes that today get `ENTRY_LOCKED`, because another user holds the lock, land and merge. Writers that send `_rev` can get more `409 CONFLICT`, since the room saves every few seconds.
- **The editor** takes no edit lock for an entry in a room. `editLocking` applies in single-editor mode.
- **The autosave fix** applies to every site: autosaves stop deleting a revision that a manual save created.
- **Turning co-editing off** takes effect when the site restarts or redeploys. Clients reset and use single-editor mode.
- **Tabs opened before co-editing was on** keep single-editor mode until they reload, and their saves can get `409 CONFLICT` while a room saves.
- **Downgrading.** Older versions ignore the new columns and tables.
- **Site transfer** skips recovery revisions, since the target site couldn't tell them apart from others, and doesn't carry the new revision columns or the room-storage tables.
- This RFC amends [Readable revision history](readable-revision-history.md#co-editing). **Deprecations:** none.

## Security and privacy

| Party   | Trusted for                                                                                |
| ------- | ------------------------------------------------------------------------------------------ |
| Client  | Its own edits, within its connection's access                                              |
| Room    | Relaying, storing, saving and merging the document, and enforcing each connection's access |
| Runtime | Permissions, hooks, validation and saving, as today                                        |

- **Joining** needs the admin session and `X-EmDash-Request`, so another site can't obtain a token. Tokens are never logged.
- **Saves are authorized as the actor.** Each checkpoint runs today's edit check for the actor, with that user's current role. A room reaches the site in-process on Node.js, and through an entrypoint of its own Worker on Workers; neither is reachable from outside.
- **One user's save holds another's edits.** Every co-editor has edit access to the entry, and EmDash has no content that only some roles may store: HTML blocks are sanitized or isolated when rendered, whoever saved them. Hooks get `editedBy` for their own checks. If EmDash adds content only some roles may store, checkpoints must check it against everyone in `editedBy`.
- **Recovery revisions** are stored without validation or hooks, so restoring one runs both, as the restoring user ([Reset and recovery](#reset-and-recovery)).
- **Access changes.** A connection lasts at most 15 minutes. A status or author change, from any writer, makes everyone rejoin, and a save refused with `403` closes the actor's connections. Contributors co-edit their own drafts, and after a publish they rejoin as viewers.
- **Attribution.** The room sets each connection's user from its token and records who sent updates, so `editedBy` is exact.
- **Privacy.** Anyone who can open an entry sees who else has it open. Room storage holds Yjs updates, with content, until the room drops its state. Logs carry IDs and lineages, never content or tokens.

## Performance

- **Logged-out routes** are unchanged. Checkpoints are draft autosaves, which purge no route cache.
- **Saving** costs one save per open entry every few seconds while someone types. That is today's autosave rate, made once however many people edit. The room serializes only the fields that updates touched or merges kept, and sends only those that changed.
- **Notifications** add one room call per write to an existing entry, after the response. A room that isn't open answers without loading its document, and the room's own saves send none.
- **Room storage** writes each second's updates as one row, and compaction bounds it.
- **Opening an entry** adds the join request and a WebSocket. A room that wakes only to relay awareness doesn't load its document. Where a room could exist, each lock heartbeat from a single-editor tab asks the room host whether the entry's room is open.
- **Node.js** keeps a room's document in memory while it has connections.
- **Browsers** load the co-editing code only when it is active.

## Failure handling

| Failure                                                      | What happens                                                                                                                                                                              |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Room storage is lost                                         | Reconnecting clients reset, and the room initializes from the stored entry                                                                                                                |
| The room can't store                                         | The room closes every connection, and clients reset. The token request stores first, so joins get single-editor mode until the room can store again.                                      |
| A save fails: validation, a hook, or the site is unreachable | Every client sees the error, the edits stay in the room, and the room tries again at the next update. If it still can't save when the room drops its state, it saves a recovery revision. |
| A notification is lost                                       | The room merges the write when its next save gets `409 CONFLICT`, or at the next join                                                                                                     |

Rooms log with the `[co-editing]` prefix. Operators turn co-editing off with the site option, and recover content from **Revisions**.

## Verification

- **Unit and property tests:** saving and coverage, including delete-only edits; compaction; the lineage, stale-room and fingerprint rules; the field mapping; the merge rule, including two outside writes to one field between saves, a write after a restore, and an unrecorded save; and the Portable Text round trip through the shared editor schema.
- **A fixed-seed convergence harness** runs clients, with the editor's schema and plugins, and a room through random edits and deletions, random delivery orders, drops and reconnects, room restarts that lose unstored updates, saves that commit but aren't recorded, outside writes, and operations. Each run asserts that replicas converge, each checkpoint contains the one before it, no covered edit is lost, and no rich text is duplicated.
- **workerd tests:** hibernation and lazy loading, deploy restarts, the store and save timers, the drop alarm, storage failures, and saves through the Worker.
- **Integration tests:** the join route, the room's save steps (edit check, `_rev`, hooks and `editedBy`), notifications from every writer, the recovery route and the autosave fix, on SQLite, libSQL and PostgreSQL.
- **Playwright tests** with several browser contexts: the [Example](#example), two tabs of one user, a viewer, a Contributor after a publish, restore and discard while others type, a reset, and REST, MCP and visual-editor writes appearing live.
- **A manual pass** with a screen reader and a keyboard, in Arabic, at phone width.

### Acceptance gates

- **Round trip.** Every node, mark and plugin block EmDash ships, and every template's seed content, survives Portable Text → shared document → Portable Text unchanged on the server, and the admin editor saves the same Portable Text from the same document. Serializing a document twice gives identical Portable Text, and neither opening an entry nor receiving a merge makes the editor write to the shared document.
- **Schema safety.** 10,000 fixed-seed runs of 200 concurrent edits each make `@tiptap/y-tiptap` delete no non-empty content. If this fails, rich text switches to a central-authority engine.
- **Server conversion** runs in workerd and Node.js with no DOM.
- **Hosts.** `emdash start` serves rooms on `@astrojs/node` standalone, and `astro dev` serves them beside Vite's HMR socket on both adapters, with every Yjs call made inside the room registry, so routes never load a second copy of `yjs`. Upgrades reach the Durable Object, and its saves reach the Worker, deployed and in development.
- **Cost.** CPU time per save, per merge and per notification is measured and published with the release.

Co-editing ships, on by default, when these gates pass, 100,000 harness runs pass, the harness runs nightly in CI, the 500 ms goal holds, and someone editing alone sees no warning for drops under 5 s.

## Rollout and implementation

1. **Prerequisites:**
   - the autosave fix;
   - the shared editor schema: the schema parts of the admin editor's extensions (names, content, attributes and defaults) and its Portable Text converter move into a DOM-free subpath export of `@emdash-cms/admin`, which the editor extends with node views and commands. The converters `emdash` exports for other editors don't change;
   - TipTap packages aligned so that `@tiptap/extension-collaboration` matches the editor (3.27.0 against 3.20.0 today);
   - the admin bundle records its `version` and `commit` at build, as `emdash` does;
   - the content `PUT` route's steps moved into a function the route and rooms share.
2. **Rooms** on both hosts, the join route, saving, notifications and the recovery route. `emdash` gains `yjs`, `y-protocols`, `lib0`, `@tiptap/y-tiptap` and `ws` as dependencies.
3. **The editor:** bindings, presence, undo, operations and reset.
4. **Hardening:** [Verification](#verification), docs and templates.

## Alternatives

| Alternative                                                                                       | Why not                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Clients save:** the room only relays and stores, and clients take turns saving through autosave | Saving would need a connected client, outside writes would have to be refused or merged late, and save turns and client-side merges would make up most of the protocol |
| **The Durable Object runs its own runtime** instead of calling its Worker                         | Each room would start its own runtime, plugins and database connections, where the Worker's are already warm                                                           |
| **One HTTP transport:** `POST` to send, a streamed response to receive                            | It avoids upgrade handling, but costs a request with a session lookup for every batch, and Yjs tooling assumes WebSockets                                              |
| **A relay without a server document,** as WordPress 7.0 shipped                                   | Clients would initialize and merge on their own, with no single saver. WordPress removed it.                                                                           |
| **Hocuspocus or y-partyserver as the room**                                                       | Each runs on only one of EmDash's hosts, and EmDash would still add saving, merging and its storage rules to both                                                      |
| **Field locks,** as Directus ships                                                                | Presence with one-value fields is simpler, and doesn't stop anyone typing                                                                                              |
| **A central-authority engine** that orders ProseMirror steps, as prosemirror-collab does          | EmDash would build cursors, presence and per-person undo itself. It is the fallback if the schema-safety gate fails.                                                   |
| **Store the Yjs document as content**                                                             | Rendering, REST, MCP, search and site transfer read Portable Text                                                                                                      |

## Drawbacks

- **Merge limits.** Fields other than rich text keep one change. A stored change to a field someone in the room changed since the last checkpoint or merge loses to the room's value, and so does stored rich text with marks the editor can't represent, once someone edits that field in the room. Such a change stays in Revisions when its write created a revision that isn't an autosave, as plugin writes, CLI and MCP updates, and REST updates without `skipRevision` do.
- **One editor schema for two places.** The room merges rich text with the editor's schema, and a node that schema doesn't know is deleted from the document. The admin editor and rooms therefore take the schema from one module, and every editor change lands there.
- **One actor per save.** Hooks see the latest editor as the actor, with everyone in `editedBy`.
- **Fingerprint changes reset rooms.** An EmDash upgrade, or a change to any collection, plugin or taxonomy definition, resets every open room on the site within 15 minutes: clients reload, and unsynced edits become recovery revisions. During a gradual deployment of an upgrade, this repeats whenever requests alternate between versions.
- **Several Node.js processes** would each run their own room for an entry, and rich text typed into the same field in two of them would be lost from one.
- **Node.js needs `emdash start`,** which relies on the undocumented `startServer()` ([Host integration](#host-integration)).

## Open questions

- Are the timings and [limits](#appendix-b-limits) right?
- Should `blocks` and `repeater` merge per item?

## Appendix A: Implementation reference

### Protocol

Messages are binary. Yjs sync and awareness use y-protocols' message types 0 and 1, as y-websocket does. EmDash messages use type 100: a lib0 `varString` of JSON, then an optional `varUint8Array` holding a Yjs snapshot.

| Message      | From   | Carries                                                                                                         |
| ------------ | ------ | --------------------------------------------------------------------------------------------------------------- |
| `welcome`    | Room   | The lineage, the client's access level, and the last checkpoint's snapshot                                      |
| `save`       | Client | A request to save a kept checkpoint now, for the **Save** button. Only from co-editors.                         |
| `checkpoint` | Room   | The new last checkpoint's snapshot and `editedBy`                                                               |
| `notice`     | Room   | What changed and who changed it: an operation, an outside write, values outside the document, or a refused save |

- **Close codes:** 4400 `rejoin`, 4401 `reset` and 4402 `deleted`. The client's provider never reconnects on its own; the client joins again for a fresh token, then reconnects.
- **Presence.** The room relays awareness to every connection, the sender included, as y-websocket's server does. Visible clients renew it about every 15 s, which keeps idle connections alive; long-hidden tabs renew less often and drop out of others' presence.
- **Hashes** are SHA-256 of each document field's value as JSON canonicalized with RFC 8785 (JCS), keyed by field slug, plus the entry's slug. The stored slug is the draft revision's staged `_slug` when it has one, otherwise the live slug, as the admin reads it today. A save response's `item.slug` is always the live one, so after a save that sent the slug, the stored slug hash is the sent slug's. At initialization, the stored hashes come from the loaded entry, and the document hashes from serializing the new document.
- **Unrecorded saves.** A room that restarts after a save commits but before it records the checkpoint gets `409 CONFLICT` at its next save. The merge rule keeps each field that save stored, because the document still differs from the merge base's document hash. The exception is a field someone set back to its value at the checkpoint before: the stored value wins that field.
- **Client IDs.** A room that loads its document from room storage writes with a new Yjs client ID, so it never reuses an ID with an older clock.

### Host integration

**Cloudflare Workers:**

- The default export of `@emdash-cms/cloudflare/worker` wraps `fetch` and forwards room upgrades with `stub.fetch(request)`. Templates already spread that export; a site with its own `fetch` calls the package's `handleRoomUpgrade` first. Under `astro dev`, the Cloudflare Vite plugin runs the Worker entry in workerd and forwards it every upgrade that isn't Vite's own.
- Routes and the write path reach a room by RPC through the `EMDASH_ROOMS` binding, retrying once with a fresh stub.
- A room reaches the site through its own Worker's `EmDashRoomSite` entrypoint, called through `exports` from `cloudflare:workers`, as the plugin sandbox already calls `PluginBridge`. The entrypoint runs core's room-site functions inside `withEmDashRuntime()`.
- The output gate holds a save until the store write before it is durable.
- Each WebSocket's user, access level, connection time and Yjs client ID are kept in its attachment (`serializeAttachment`), so they survive hibernation.
- The store and save delays use `setTimeout`. The drop uses the Durable Object's alarm, which every store and closed connection sets an hour ahead, so a room whose clients all left during a restart still drops. An alarm that fires while the room is open is set again. The 15-minute limit is checked whenever a message arrives.

**Node.js:**

- `emdash start` checks that the adapter runs in standalone mode, sets `ASTRO_NODE_AUTOSTART=disabled`, imports `dist/server/entry.mjs` dynamically, and calls its `startServer()`. It attaches an `upgrade` listener, using `ws` with `noServer` and an explicit `maxPayload`, to the server that starts (`startServer().server.server`, already listening). The listener hands room upgrades to the room registry and refuses other paths with `400`.
- `startServer()` and the `ASTRO_NODE_AUTOSTART` variable are undocumented, though `astro preview` uses the same switch. If they change, `emdash start` can mount the entry's exported `handler` in its own `http.createServer`.
- Under `astro dev` with the Node.js adapter, the integration attaches the listener to Vite's `httpServer` in `astro:server:setup`. It ignores other paths and leaves their sockets alone for Vite's HMR listener. It attaches nothing under the Cloudflare adapter.
- Routes run from a bundled copy of `emdash` in development and production. That copy owns the room registry, the room code and Yjs, and keeps the registry on `globalThis` under a `Symbol.for` key. `emdash start` and the development listener only mark that upgrades reach the registry and hand each one over, so a site started another way, such as `node dist/server/entry.mjs`, gets single-editor mode.
- A room calls core's room-site functions in-process, inside `withEmDashRuntime()`.
- Rooms store and save on shutdown. Every store and closed connection updates the room's `_emdash_rooms.updated_at`, a store in the same transaction as its append, and an hourly cleanup applies the drop rule to every stored room that isn't open in the process and hasn't been updated for an hour, including rooms left by a crash.

### Interfaces

The host boundaries are internal and can change until co-editing is stable:

```ts
// Called by routes and the write path: Durable Object RPC on Workers, the registry on `globalThis` on Node.js.
interface RoomHost {
	// Stores first. Resolves to null when the room can't store or won't run for the entry, and to
	// "full" when a connection limit is reached.
	issueToken(roomId: string, claims: TokenClaims): Promise<{ token: string } | "full" | null>;
	// Whether the room is open, for today's lock route.
	isOpen(roomId: string): Promise<boolean>;
	// Waits for any other hold, saves a kept checkpoint as `actorId`, and holds other saves and
	// merges until `release`. Resolves to null when the room isn't open.
	save(roomId: string, actorId: string): Promise<{ rev: string; hold: string } | null>;
	// Ends the hold. `overwrite` writes every field the operation changed into the document.
	release(roomId: string, hold: string, options?: { overwrite?: boolean }): Promise<void>;
	// Queues a merge of the stored entry at `rev` and returns at once. `outside` names the values
	// outside the document that the write changed, for clients to reload.
	notify(roomId: string, rev: string, outside: OutsideValue[]): Promise<void>;
}

interface TokenClaims {
	userId: string;
	name: string;
	access: "edit" | "view";
	fingerprint: { version: string; commit: string; hash: string };
	// The entry's `_rev` when the join route checked access.
	rev: string;
}

type OutsideValue = "seo" | "author" | "publishedAt" | "terms" | "bylines" | "references";

// Called by a room: in-process on Node.js, through the `EmDashRoomSite` entrypoint on Workers.
interface RoomSite {
	load(entry: EntryRef): Promise<LoadedEntry | null>;
	save(entry: EntryRef, checkpoint: CheckpointInput): Promise<SaveResult>;
	saveRecovery(entry: EntryRef, recovery: RecoveryInput): Promise<void>;
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

| Change                                                                                                                                             | Purpose                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `revisions.kind`, a nullable text: `autosave`, `recovery`, or null for a kept revision                                                             | Autosaves replace only autosaves, and restoring a recovery revision runs validation and hooks |
| `revisions.edited_by`, a nullable JSON list of user IDs                                                                                            | Who edited a revision                                                                         |
| `_emdash_room_updates`: `room_id`, `seq`, `part` and `data` (a blob on SQLite, `bytea` on PostgreSQL), with primary key (`room_id`, `seq`, `part`) | Room storage: updates and compacted state                                                     |
| `_emdash_rooms`: `room_id`, `part`, `record` (JSON) and `updated_at`, with primary key (`room_id`, `part`)                                         | Room storage: the room record                                                                 |

The room record holds the lineage and fingerprint; the last checkpoint's snapshot; the merge base; the users who sent updates since the last checkpoint, latest first; and the entry's status and author when the room last loaded it. On Workers, each Durable Object keeps the two room-storage tables in its own SQLite, where `room_id` is constant. On Node.js, `room_id` is `{collection}:{entry ID}`.

### Configuration

Co-editing is on by default. A site turns it off with:

```js
emdash({
	// database, storage, …
	coEditing: false,
});
```

On Node.js, the `start` script runs `emdash start`. On Cloudflare, the Worker entry re-exports `EmDashRoom` and `EmDashRoomSite` from `@emdash-cms/cloudflare/worker`, and the wrangler config adds:

```jsonc
"durable_objects": { "bindings": [{ "name": "EMDASH_ROOMS", "class_name": "EmDashRoom" }] },
"migrations": [{ "tag": "emdash-rooms", "new_sqlite_classes": ["EmDashRoom"] }]
```

`@emdash-cms/cloudflare` registers its room host when the binding is present. On Node.js, the bundled copy of `emdash` registers the in-process host when `emdash start` or the development server takes upgrades.

## Appendix B: Limits

These are starting values, for the prototype to measure.

| Limit                                                | Value                       |
| ---------------------------------------------------- | --------------------------- |
| Largest update                                       | 1 MB encoded                |
| Largest entry for a room                             | 1 MB of stored data         |
| Connections per room                                 | 25                          |
| Connections per user in a room                       | 5                           |
| Token                                                | 60 s, single use            |
| Connection lifetime                                  | 15 minutes                  |
| Store delay                                          | 1 s                         |
| Compaction threshold, and part size                  | 1 MB                        |
| Save delay                                           | 2 s after the latest update |
| Longest wait between saves while updates arrive      | 10 s                        |
| Operation hold                                       | 30 s                        |
| A room stays open after its last connection closes   | 10 s                        |
| Room state after the last store or closed connection | 1 hour                      |
