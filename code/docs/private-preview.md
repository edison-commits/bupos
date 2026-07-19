# Private admin preview

The preview route is intentionally disabled unless all of these Worker secrets exist:

- `BUPOS_PREVIEW_EMAIL`
- `BUPOS_PREVIEW_PASSWORD`
- `BUPOS_PREVIEW_SECRET`
- `BUPOS_ORG_ID`
- `BUPOS_LOCATION_ID`

Open `/preview/admin`, enter `BUPOS_PREVIEW_SECRET`, and the server provisions the dedicated manager identity on first successful access, then creates a normal scoped admin session. Existing accounts are never modified.

The preview identity is a manager bound to `BUPOS_ORG_ID` and `BUPOS_LOCATION_ID`. The regular `/login` route and all normal admin/API authorization checks remain unchanged.

To disable the preview, remove the three `BUPOS_PREVIEW_*` Worker secrets. The route then returns `404` and no preview session can be created.
