---
title: Let Editors pick an entry's author
type: feature-plan
status: proposed
authors:
  - Daniel Mueller (@danielmlr)
discussion: null
created: 2026-10-14
---

# Let Editors pick an entry's author

## Problem and user case

An Editor who takes over a post from a colleague, or writes one for a new author, wants to set who owns it. The server already allows this: an update may change `authorId` when the caller holds `content:edit_any`, which Editors have. The entry editor has an author picker for exactly this, under **Ownership** in the settings sidebar.

Editors never see that picker. The editor loads the user list from `GET /_emdash/api/admin/users`, which refuses everyone below Admin, so the request fails with 403 and the **Ownership** section stays hidden. Only Admins can change an entry's author from the admin today.

Opening `/admin/users` to Editors is not the fix. It returns every user's email, role, disabled state, last sign-in, passkey count and OAuth providers, and its `role` filter would let an Editor list all Admins. `GET /_emdash/api/content/{collection}/authors` is not enough either: it lists only users who already wrote an entry in that collection, so a newly invited author never appears.

## Proposed behavior

A new route lists the users an entry in a collection can be assigned to, with only what the picker shows:

```http
GET /_emdash/api/content/posts/assignable-authors?search=sam&limit=50
```

```json
{
	"items": [
		{
			"id": "01J…",
			"name": "Sam Okafor",
			"email": "sam@example.com",
			"avatarUrl": null
		}
	],
	"nextCursor": "…"
}
```

- It requires `content:edit_any`, the permission the server already checks before it lets an update change `authorId`.
- It lists users who can create content (`content:create`, Contributor and above in 1.x) and are not disabled.
- Items are sorted by name, then email, like the `/authors` route. `search` matches name or email. Pagination follows the list convention: `limit` defaults to 50 and is clamped to 100, with `cursor` and `nextCursor`.
- The entry editor loads the picker from this route instead of `/admin/users`, for everyone who holds `content:edit_any`. Admins use the same route, so the picker shows the same list to an Admin and an Editor.

The route sits under the collection, although the list doesn't depend on the collection in 1.x. The custom roles RFC ([#4156](https://github.com/emdash-cms/emdash/pull/4156)) scopes content permissions to collections. Under that design, the check and the filter can both name the collection: who may assign authors in `jobs`, and who may write in `jobs`.

## Goals

- Editors can change an entry's author from the entry editor.
- The picker shows only users the entry can usefully be assigned to.
- An Editor learns nothing about users beyond the name, email and avatar the picker needs.

## Non-goals

- Linking a byline to a user. The byline dialog also loads `/admin/users`, so Editors, who hold `bylines:manage`, get an empty user list there. That is the same gap under a different permission and needs its own decision.
- Refusing an `authorId` outside this list on update. The update route keeps accepting the values it accepts today, so API and MCP clients don't change.
- A searchable author picker. The picker keeps loading the first 100 users, as it does today. `search` is there so a later picker can use it.

## Interfaces and compatibility

- New route `GET /_emdash/api/content/{collection}/assignable-authors`, added to the OpenAPI document and the REST API reference. No existing route changes. `/admin/users` stays Admin-only.
- The admin's author picker switches routes. For Admins the list gets shorter: Subscribers and disabled users are no longer offered as authors.
- No database changes and no new permission.
- An entry whose slug is `assignable-authors` can't be opened by slug through `/content/{collection}/{slug}`, the same as an entry whose slug is `authors` or `trash` today. Opening it by ID still works.
- The route is admin-only, so logged-out pages run no new query.

## Errors and edge cases

- Signed out: 401. Signed in without `content:edit_any`: 403. Unknown collection: 404 `COLLECTION_NOT_FOUND`, like `/authors`.
- Users without a name are labelled by email in the picker, as they are today. This is why the response carries email.
- The current author is not in the list, because they were disabled, moved below Contributor, or fall outside the first 100. The picker keeps the entry's current author selected and labels it "Current author", and an Editor can still move the entry to someone in the list.
- An empty list can't happen for a signed-in caller who holds `content:edit_any`, because the caller is listed. The **Ownership** section still hides itself when the request fails.

## Verification

- Integration tests for the route on SQLite and PostgreSQL: an Editor gets the list; Contributors and Authors get 403; Subscribers and disabled users are left out; each item has only `id`, `name`, `email` and `avatarUrl`; search, ordering, the limit clamp and the cursor work; an unknown collection answers 404.
- An admin test: an Editor opening an entry sees **Ownership** with the author picker, and changing the author sends `authorId` in the update.
- A manual pass as an Editor in the demo, in English and Arabic, with a screenshot of the picker for the implementation PR.

## Open questions

- Should Editors see email at all? Contributors already get the email of every user who has written in a collection, through `/authors`. Dropping email would leave users without a name with no label.
- Should the picker fetch the current author when they aren't in the list (for example with an `include` parameter), so it can show their name instead of "Current author"?
