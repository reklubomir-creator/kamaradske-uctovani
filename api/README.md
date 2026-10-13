# Kamarádské účtování — PHP/MariaDB backend prototype

This backend is being developed separately from the live GitHub Pages app. It does not change the existing Google Apps Script API or the deployed site.

## Files

- `index.php` — JSON API for creating, reading, saving, and deleting shared groups.
- `schema.sql` — MariaDB table definition.
- `config.example.php` — configuration template only; contains no real credentials.

## Before deployment

1. Create a MariaDB database and user in the hosting control panel.
2. Import `schema.sql` through phpMyAdmin.
3. Create `config.php` on the server and fill in the database credentials; never commit it.
4. Add the exact browser origin(s) to `allowed_origins`. Do not use a wildcard.
5. Keep `config.php` out of Git and protect it from public access. Prefer placing it outside the public web directory when the hosting layout allows it.
6. Test on a separate temporary database before importing any real groups.
7. Verify PHP syntax and run the API's negative/positive tests before connecting any frontend.

## API contract

- `POST` JSON `{"action":"create","name":"Nová skupina"}` creates an empty group. The response includes a share token and an owner key. The owner key is shown only at creation and must be saved securely by the app.
- `GET ?action=read&token=...` reads the group for anyone holding the share token.
- `POST` JSON `{"action":"save","token":"…","data":{...}}` saves group data. Anyone holding the share token can edit, matching the current shared-group model.
- `POST` JSON `{"action":"delete","token":"…","ownerKey":"…"}` deletes the group only when both the share token and separate owner key are valid.

The API requires JSON for POST requests, rejects browser origins that are not explicitly listed in `allowed_origins`, and limits request and saved-data sizes. Requests without an Origin header are allowed for server-to-server tools and direct tests.

The test branch frontend now targets `https://vyuctovani.lubarek.cz/api/index.php`, uses the JSON API, stores owner keys in a separate versioned local-storage entry, and generates share links on the new subdomain. This is code preparation only: DNS/HTTPS, server configuration, deployment, migration, and end-to-end tests have not been completed. Do not switch the live app until those checks pass.

## Data migration

Do not import the pasted tokens directly into Git or source code. The migration should be performed on the hosting server or with a one-time protected import tool. Preserve the three chosen groups by their stable IDs; omit the two empty rows only after confirming they are the two rows the user chose to remove.
