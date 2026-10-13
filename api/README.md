# Kamarádské účtování — PHP/MariaDB backend prototype

This backend is being developed separately from the live GitHub Pages app. It does not change the existing Google Apps Script API or the deployed site.

## Files

- `index.php` — JSON API for creating, reading, saving, and deleting shared groups.
- `schema.sql` — MariaDB table definition.
- `config.example.php` — configuration template only; contains no real credentials.

## Before deployment

1. Create a MariaDB database and user in the hosting control panel.
2. Import `schema.sql` through phpMyAdmin.
3. Copy `config.example.php` to `config.php` on the server and fill in the database credentials.
4. Add the exact browser origin(s) to `allowed_origins`. Do not use a wildcard.
5. Keep `config.php` out of Git and protect it from public access. Prefer placing it outside the public web directory when the hosting layout allows it.
6. Test on a separate temporary database before importing any real groups.

## API contract

- `GET ?action=create&name=...` creates an empty group. The response includes a share token and an owner key. The owner key is shown only at creation and must be saved securely by the app.
- `GET ?action=read&token=...` reads the group for anyone holding the share token.
- `POST` JSON `{"action":"save","token":"…","data":{...}}` saves group data. Anyone holding the share token can edit, matching the current shared-group model.
- `POST` JSON `{"action":"delete","token":"…","ownerKey":"…"}` deletes the group only when both the share token and separate owner key are valid.

The existing frontend currently uses JSONP and a Cloudflare share-link redirect. It must be updated separately to use this JSON API, store owner keys locally, and generate share links for the new deployment. This prototype is not yet connected to the live app and should not be treated as production-ready until CORS, deployment, migration, and end-to-end tests pass.

## Data migration

Do not import the pasted tokens directly into Git or source code. The migration should be performed on the hosting server or with a one-time protected import tool. Preserve the three chosen groups by their stable IDs; omit the two empty rows only after confirming they are the two rows the user chose to remove.
