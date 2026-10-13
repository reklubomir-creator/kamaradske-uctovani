# Frontend migration plan — Kamarádské účtování

Status: test-branch implementation in progress. Changes are limited to `test-cesky-hosting`; the live frontend, Google Apps Script, Cloudflare Worker, and production data have not been changed.

Target branch: `test-cesky-hosting`.

## Current frontend locations

The test-branch `index.html` has been adapted to the PHP API:
- `apiRequest()` uses GET for reads and JSON POST for writes.
- `shareLink(token)` points to the proposed HTTPS subdomain.
- `syncRemote()` serializes pending changes and exposes a retry button after a failed save.
- `loadSharedGroup()` reads `?group=TOKEN` and maps the returned data into the current state shape.
- `REMOTE_KEY` stores local group-ID → share-token mappings; a separate versioned key stores owner keys.
- Online deletion requires the owner key and waits for server confirmation.
- Backup import validates the envelope, group structure, duplicate IDs, mapping references, and collection limits before replacing local data. It attempts to restore the previous storage values if a storage write fails.

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


## Automated checks currently in place

The GitHub Actions workflow checks PHP syntax, inline JavaScript syntax, and runs API integration tests against a disposable MariaDB database. The integration suite covers CORS/preflight, invalid content types and JSON, request-size limits, create/read/save/delete, collection validation, and owner-key enforcement.

Latest successful run for the current branch at the time of this update: https://github.com/reklubomir-creator/kamaradske-uctovani/actions/runs/38429977389. These checks do not replace testing the UI in a browser against a configured test server.

## Manual browser acceptance checklist before any hosting deployment

Run only with a disposable test group and test database. Do not use production groups or real owner keys.

### Backup/import safety
- [ ] Export a backup with multiple local groups and verify it contains the groups, active-group ID, token mappings, and (if present) owner-key mapping.
- [ ] Cancel the sensitive-backup warning and verify no download is created when owner keys are included.
- [ ] Import a valid version 1 backup and a valid version 2 backup; verify expected groups and mappings are restored.
- [ ] Select a malformed JSON file, an unsupported version, duplicate group IDs, malformed group/member/expense/note entries, and an oversized file; each should be rejected without changing current storage.
- [ ] Cancel the confirmation before replacing groups; verify current groups remain unchanged.
- [ ] Simulate storage quota/write failure if feasible; verify the prior storage values remain intact. Note: browser storage rollback is best-effort if the browser also refuses the rollback writes.
- [ ] Reload after a successful import and verify group selection, members, expenses, notes, and online-link mappings.

### Online sync and recovery
- [ ] With the test API available, edit a group name, member, expense, shares, and note; reload in the same browser and verify all changes persisted.
- [ ] Open the share link in a second private browser/profile and verify it loads the same group without requiring the owner key.
- [ ] Temporarily block the test API or go offline, make an edit, and verify the UI reports the failed online save without claiming success.
- [ ] Restore connectivity and use “Zkusit synchronizaci znovu”; verify the latest local state is saved and the retry control disappears after success.
- [ ] Make several quick edits while a save is in flight; verify the last edit is present after reload.
- [ ] Attempt deletion without an owner key and with a wrong key; verify the server refuses deletion and the group remains.
- [ ] Delete a disposable test group with the correct owner key and verify the server returns not found on the next read.

Do not deploy to the public hostname or migrate/import live data until the hosting endpoint, HTTPS, and all manual checks above have been verified and there is an explicit rollback plan.
