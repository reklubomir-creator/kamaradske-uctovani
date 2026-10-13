# Frontend migration plan — Kamarádské účtování

Status: planning only. This document does not change the live frontend, Google Apps Script, Cloudflare Worker, or database contents.

Target branch: `test-cesky-hosting`.

## Current frontend locations

The existing `index.html` currently contains:
- `API_URL` pointing to Google Apps Script.
- `shareLink(token)` pointing to the Cloudflare Worker redirect.
- `jsonp(params)` for remote create/read/delete operations.
- `postRemote(token, data)` using a hidden iframe/form for saves.
- `syncRemote()` sending `name`, `people`, `expenses`, and `notes`.
- `loadSharedGroup()` reading `?group=TOKEN` from the URL.
- `REMOTE_KEY` storing the local group-ID → share-token mapping.
- The delete handler currently calls the old GET/JSONP API and does not have an owner key.

## Planned API adapter

Use one small set of helpers for all PHP calls:
- POST JSON with `Content-Type: application/json` for `create`, `save`, and `delete`.
- GET for `read`, with the token URL-encoded.
- Check HTTP status and the JSON response's `ok` field; show a useful sync error if either fails.
- Do not fall back silently to the old API after a failed PHP call. Keep the migration branch isolated so the live version is unaffected.

Expected calls:
- Create: `POST { action: "create", name }`; store returned `group.token` and `group.ownerKey`.
- Read: `GET ?action=read&token=...`; map returned `group.data` into the current state shape.
- Save: `POST { action: "save", token, data: { name, people, expenses, notes } }`.
- Delete: `POST { action: "delete", token, ownerKey }`; only remove the local group after the server confirms success.

## Local storage and owner keys

Keep the existing `REMOTE_KEY` mapping for compatibility. Add a separate versioned local-storage mapping for owner keys keyed by the local group ID. Never put owner keys in a URL, share link, exported source code, or Git commit. Treat a browser backup containing owner keys as sensitive.

A user who opens someone else's share link receives the share token but not the owner's key. That user can edit the shared group (as today) but must not be able to delete it. If no owner key exists locally, disable or explain the delete action instead of sending an invalid request.

For migrated groups, decide the ownership policy before import: legacy GAS groups do not automatically have a PHP owner key. Do not claim the owner can delete migrated groups until a controlled migration creates and securely delivers a new owner key.

## Share URL

Replace the Cloudflare Worker link only in the test frontend. Once the subdomain is serving the frontend over valid HTTPS, the proposed format is `https://vyuctovani.lubarek.cz/?group=TOKEN&nazev=SLUG`. Verify that direct loading and refresh preserve the group parameter. Do not change the existing production link until DNS, HTTPS, and the full read/write flow are tested.

## Data compatibility

Preserve the existing data shape:
- `name`: group name.
- `people`: members and their stable IDs/default shares.
- `expenses`: payer, participants, per-person shares, amount, date, and description.
- `notes`: normalize to an array of note objects. Existing code accepts legacy notes stored as a string when reading old data.

The existing frontend saves an empty-string fallback for notes in one place. The new adapter should consistently send `state.notes || []`, normalized to an array, without dropping existing notes.

## Safe implementation order

1. Add a separate API adapter and owner-key storage on this branch only.
2. Keep the current UI and local-storage behavior unchanged.
3. Add tests for create/read/save/delete and error states.
4. Deploy only to a test location with a test database and test groups.
5. Verify the frontend from two separate browsers/devices.
6. Back up the current live groups and compare counts and contents before any migration.
7. Import the chosen non-empty groups by stable IDs/tokens; verify member IDs, expense IDs, shares, and notes.
8. Test the new links, refresh, backup/export, and import.
9. Switch the live frontend only after explicit approval and a rollback plan.

## Acceptance checklist

- [ ] Creating a group returns a share token and owner key; both are stored in the intended local mappings.
- [ ] Opening the same share link in a second browser loads the correct group.
- [ ] Changes to members, expenses, shares, notes, and group name persist after reload.
- [ ] Network/API failures are visible and do not falsely report a successful sync.
- [ ] A participant without an owner key cannot delete a shared group.
- [ ] The owner key can delete only the matching group.
- [ ] Existing local-only groups continue to work.
- [ ] Backup/export and import retain group data and token mappings.
- [ ] The original live Google Apps Script version still works unchanged until the planned cutover.
