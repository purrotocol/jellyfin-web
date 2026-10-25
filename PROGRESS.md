# PROGRESS

## custom-features (off release-10.11.z, v10.11.11)

- Ported `trickplay-status.js` and `dislike.js` from jellyfin-custom into `src/custom/`, imported once via `src/custom/index.js` from `src/index.jsx` (next to the other auto-running side-effect imports).
- Scripts stay plain ES5 IIFEs. Only logic-free edits: placeholders replaced by literal constants (poll 7000ms, batch chunk 200 = `DislikeBatchChunkSize`, badge-always/dislikes/filesize enabled = true); per-file `eslint-disable` for legacy style (var, 2-space indent, operator-linebreak, for loops) with an `eslint-enable` at the end.
- Base URL: no change needed. All requests go through `window.ApiClient.getUrl('Plugins/TrickplayStatus/...')`, which prepends the server base. Routes/shapes unchanged.
- ApiClient timing: `window.ApiClient` is assigned in `ServerConnections` (`src/lib/jellyfin-apiclient/ServerConnections.js`) during `init()`, after this static import evaluates. Same as before (the injected scripts also ran before login); the scripts re-check `window.ApiClient`/`getCurrentUserId` on every flush/mutation batch, so no change.
- Environment: repo requires Node >=20 (`engines`, `.npmrc` engine-strict); local is Node 18.19.1/npm 9.2. Used `npm ci --engine-strict=false` for local verification only; lint and `build:development` pass on Node 18. Re-verify on Node 20 before release.
- Verification: `npx eslint src/custom src/index.jsx` clean; `npm run build:development` compiled successfully; both scripts' routes found in `dist/main.jellyfin.bundle.js`, no leftover `__PLACEHOLDER__` tokens.
- Not verifiable without a live server: runtime behaviour (badges, dislike toggle/filter, size sort). Also untested: two ApiClient instances (script patches `window.ApiClient`).

## 12.2: native filters in the modern library UI

- `src/custom/dislike.js` hooks the legacy filter dialog (`.chkFavorite`) and `ApiClient.getItems`; 12.2 movie/TV/episode/video libraries use the React modern app (SDK fetch, MUI dialogs), so the Disliked/Unrated/File size filters and file size sort were ported natively: `utils/customFilters.ts`, `FiltersStatus.tsx`, `FiltersSize.tsx`, `FilterButton.tsx`, `SortButton.tsx`, `useFetchItems.ts` (default case).
- Disliked → `ids=`, Unrated → `excludeItemIds=` from `Plugins/TrickplayStatus/Dislikes[/Rated]`; capped at 200 ids (Kestrel 8KB request line), over the cap the filter is not applied (console warning).
- File size uses server `minSize`/`maxSize` and `sortBy=Size` (see jellyfin-fork PROGRESS.md). Tabs: Movies, Episodes, Videos, MusicVideos.
- Dislike card badge/detail/OSD buttons still come from `dislike.js` (legacy DOM still present). Verified manually on test CT190 (proxmox, 10.0.0.55).

## Ctrl+D: delete the playing video and skip to the next

- `src/custom/delete-skip.js` (ported from the jellyfin-custom plugin's `Web/delete-skip.js`, imported in `src/custom/index.js`). Ctrl+D during video playback; second press within 4s confirms (the delete is permanent).
- Order: click the OSD next-track button (or `history.back()` at end of queue), then `ApiClient.deleteItem` after 2s, retry once after 3s (404 on retry = already gone). Deleting while the stream is open fails on the SMB mount (`Directory not empty`) and breaks the Stopped report (FK error).
- Item id from `.videoOsdBottom .btnUserRating[data-id]`, same as Shift+X. Name/`CanDelete` lookup is best-effort.
- Deployed to CT190 (prod) by replacing `/opt/jellyfin-web` (previous build kept as `/opt/jellyfin-web.prev`). Production build on Node 18 needs an `Array.prototype.toSorted` polyfill via `NODE_OPTIONS=--require` (copy-webpack-plugin).
