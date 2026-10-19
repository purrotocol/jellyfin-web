/* eslint-disable @stylistic/indent, @stylistic/operator-linebreak, no-var, no-empty-function, no-nested-ternary, sonarjs/no-nested-conditional, compat/compat, @typescript-eslint/no-shadow, @typescript-eslint/no-unused-vars, @typescript-eslint/prefer-for-of, @typescript-eslint/prefer-string-starts-ends-with */
// Ported verbatim from the jellyfin-custom server plugin's injected client script (the plugin
// served it into index.html at request time). Legacy ES5 style, deliberately NOT modernised:
// lint is disabled for the whole file rather than touching logic. Only edit: the server-substituted
// placeholders below are now literal constants. HTTP routes (Plugins/TrickplayStatus/...) are
// unchanged and resolved through window.ApiClient.getUrl, so the base path is handled by the client.
(function () {
  'use strict';

  var BADGE_ATTR = 'data-dislike-badged';
  // Marks a .btnUserRating (detail page or OSD) once its sibling dislike button has been
  // inserted - distinct from BADGE_ATTR because these are a different surface (real <button>
  // rows, not cards) with their own lifecycle (see ROW_ATTR usage below).
  var ROW_ATTR = 'data-dislike-row-badged';
  // Marks the button *we* injected after .btnUserRating, so a re-scan of an already-processed
  // row (or a stray sibling from something else) can't be mistaken for it, and so it can be
  // found again after a re-render that leaves the ratingBtn node itself in place.
  var ROW_BTN_ATTR = 'data-dislike-row-button';
  var ROW_SYNC_MS = 1000;
  var DEBOUNCE_MS = 200;
  var MAX_WAIT_MS = 1000;
  var BATCH_CHUNK_SIZE = 200;
  var RETRY_DELAY_MS = 3000;
  var MAX_RETRY_ATTEMPTS = 5;
  var ALWAYS_VISIBLE = true;

  // This one script carries two independent features: the dislike badge/toggle/filter, and the
  // file-size filter/sort. It is injected whenever EITHER is enabled (see the registrar), so each
  // gates its own UI on these flags the controller substitutes. Both default true.
  var DISLIKES_ENABLED = true;
  var FILESIZE_ENABLED = true;

  // --- File-size filter + sort ---------------------------------------------------------------
  //
  // Jellyfin 10.11.11 cannot sort or filter by file size: its ItemSortBy enum has no Size member
  // (verified), and no stock Filters= value expresses a size range. But BaseItems.Size is a
  // stored, fully-populated column, served per-library by the plugin's GET Filesizes endpoint.
  // So both features are driven client-side from that one { id -> bytes } map (see getSizeMap and
  // the size branch of patchGetItems).
  var MB = 1024 * 1024;
  var GB = 1024 * MB;
  // Buckets tuned to the live PH sample (median 252MB, p90 1.5GB - see PROGRESS.md). Membership is
  // [min, max): min <= size < max. `any` disables the filter. These are the only place the
  // boundaries live - retune here if a library skews larger.
  var SIZE_BUCKETS = [
    { value: 'any', label: 'Any size', min: 0, max: Infinity },
    { value: 'lt250mb', label: 'Under 250 MB', min: 0, max: 250 * MB },
    { value: 'mb250to500', label: '250 MB – 500 MB', min: 250 * MB, max: 500 * MB },
    { value: 'mb500to1gb', label: '500 MB – 1 GB', min: 500 * MB, max: GB },
    { value: 'gb1to2', label: '1 GB – 2 GB', min: GB, max: 2 * GB },
    { value: 'gt2gb', label: 'Over 2 GB', min: 2 * GB, max: Infinity }
  ];
  // Sizes are effectively immutable for a stable item, so this can be far longer than the dislike
  // caches' TTL - there is no per-action event that changes an item's size mid-session.
  var SIZE_MAP_TTL_MS = 300000;
  // Stock filter params that our client-side size paging cannot compose with (it pages a
  // precomputed global order and can't know what the server would additionally filter out). If any
  // is present on a grid query while a size feature is active, we refuse to intercept and toast,
  // rather than return a wrong TotalRecordCount / under-filled page. Alpha-picker (NameStartsWith*)
  // is included deliberately.
  var STOCK_FILTER_PARAMS = [
    'Filters', 'Genres', 'GenreIds', 'OfficialRatings', 'Tags', 'TagIds', 'Years',
    'VideoTypes', 'SeriesStatus', 'HasSubtitles', 'IsHd', 'Is4K', 'IsFavorite',
    'NameStartsWithOrGreater', 'NameStartsWith', 'NameLessThan', 'SearchTerm'
  ];

  // --- Disliked filter (Milestone 5) - lives as a checkbox row in Jellyfin's own funnel
  // filter dialog, not a standalone toolbar button (redirected after live feedback - see the
  // section below).
  var FILTER_BODY_CLASS = 'dislikeFilterActive';
  var UNRATED_BODY_CLASS = 'unratedFilterActive';
  var FILTER_ROW_MARKER_ATTR = 'data-dislike-filter-row';
  // Marks the filter dialog's <form> once our own "File size" section has been inserted into it
  // (the size filter is its own titled section, like Genres/Features - not a row in the Filters
  // list, which is what FILTER_ROW_MARKER_ATTR tracks).
  var SIZE_FILTER_SECTION_MARKER = 'data-dislike-size-section';
  // Marks a funnel button whose `.filterButtonBubble` is showing because of *our* filter,
  // so turning the filter off only ever re-hides a badge we ourselves lit - see
  // syncFilterButtonBubble.
  var FILTER_BUBBLE_ATTR = 'data-dislike-filter-bubble';
  var LIBRARY_ID_PATTERN = /[?&]topParentId=([0-9a-fA-F]{32})/;
  // Ceiling on how many ids can ride in one `Ids=` query string before this server rejects the
  // request line. Probed live against container 104: 240 ids (~8.1KB) still returns 200, 300
  // (~10KB) returns 414 - Kestrel's default 8KB request-line limit. 200 leaves ~1.4KB of head-
  // room for the rest of the query (and for a reverse proxy with a tighter limit than Kestrel's).
  // Past this the filter falls back to the pre-1.9.0.0 hide-what's-loaded behaviour; see
  // patchGetItems.
  var MAX_FILTER_IDS = 200;
  // The disliked-id list is fetched per grid fetch, so a short TTL just collapses the burst of
  // fetches a single navigation can produce (view-style switch, alpha picker, paging). Any actual
  // dislike change invalidates it outright - see applyState.
  var FILTER_IDS_TTL_MS = 15000;
  // The list endpoint answers 503 while a user's index is still being rebuilt (it kicks the
  // rebuild itself and expects a retry) - a full rebuild measured ~5s against ~11k items, so two
  // retries 2s apart covers the normal case without leaving the grid spinning for long if it
  // doesn't.
  var FILTER_IDS_RETRIES = 2;
  var FILTER_IDS_RETRY_MS = 2000;

  // itemId -> Set of card elements currently showing that item (the same item can appear in
  // multiple shelves/rows on one page, e.g. Continue Watching + a library grid).
  var cardsByItemId = new Map();
  // itemId -> last known-good disliked state (server-confirmed, or optimistic while a toggle
  // is in flight). Needed as the rollback value if that toggle's request fails.
  var dislikedState = new Map();
  // Detail-page and OSD dislike buttons currently in the DOM. Unlike cardsByItemId, this is not
  // keyed by itemId: the OSD's underlying item can change (next-episode auto-advance) without
  // its row being rebuilt, so each entry re-reads its own itemId from the live .btnUserRating
  // (see syncRowButtons) rather than being filed under a fixed key.
  var rowButtons = new Set();
  // ratingBtn element -> its tracked entry in rowButtons, so re-processing the same still-live
  // .btnUserRating (e.g. from another mutation batch) updates the existing entry instead of
  // creating a duplicate.
  var rowButtonByRatingBtn = new WeakMap();
  var pendingIds = new Set();
  var inFlight = new Set();
  var retryAttempts = new Map();
  var debounceTimer = null;
  var maxWaitTimer = null;
  var retryTimer = null;
  var loginRecheckTimer = null;
  var rowSyncTimer = null;
  // Guards the Shift+X shortcut's own mark-then-advance sequence against re-entry (a rapid
  // second press while the first press's dislike write is still settling), distinct from the
  // per-item `inFlight` set - that one guards a single item's write, this one guards the
  // shortcut action itself so a burst of presses can't fire the write/advance sequence twice
  // before the first has resolved.
  var shortcutInFlight = false;

  // Filter state (Milestone 5, extended for the Unrated filter). The single source of truth is
  // filterMode: 'none' | 'disliked' | 'unrated'. The two plugin checkboxes are mutually exclusive
  // (an item can be neither, but never both), so one mode covers both - see setFilterMode. The
  // checkbox refs are only present while the dialog happens to be open; it is rebuilt from scratch
  // on every funnel-button open, so they are torn down and re-created each time.
  var filterMode = 'none';
  var dislikedCheckboxEl = null;
  var unratedCheckboxEl = null;
  // Cached id list for one library: { libraryId, ids, fetchedAt }, plus the in-flight request that
  // will populate it ({ libraryId, promise }), so several grids refreshing at once share one
  // request rather than each firing their own. Two parallel pairs: the disliked set (the Disliked
  // filter INCLUDES it) and the rated set = favorited-or-disliked (the Unrated filter EXCLUDES it).
  var dislikedIdsCache = null;
  var dislikedIdsInFlight = null;
  var ratedIdsCache = null;
  var ratedIdsInFlight = null;
  // File-size feature state. sizeFilterBucket is the selected SIZE_BUCKETS entry (or null / the
  // 'any' entry = off). sizeSortActive is the authoritative "is size sort on" signal read by
  // patchGetItems, set by our injected sort radio (never written into query.SortBy). sizeSelectEl
  // is the filter dropdown while the filter dialog is open (rebuilt per open). The size map is
  // cached per library like the dislike sets: { libraryId, sizes: {id->bytes}, orderDesc: [ids
  // high->low], fetchedAt }.
  var sizeFilterBucket = null;
  var sizeSortActive = false;
  var sizeSelectEl = null;
  var sizeMapCache = null;
  var sizeMapInFlight = null;
  // Non-zero while a wrapped .itemsContainer fetchData() is on the stack - the only window in
  // which an ApiClient.getItems call is known to be the library grid's own (see
  // wrapItemsContainers). A counter rather than a flag purely so nested/concurrent fetches can't
  // clear it early.
  var gridFetchDepth = 0;
  // Set when the filter is toggled, consumed by the next grid fetch. Mirrors what Jellyfin's own
  // filter dialog does on 'filterchange' (I.StartIndex = 0): a filter change resizes the result
  // set, so staying on page 4 of the old one is meaningless.
  var resetStartIndexOnNextFetch = false;
  // Library id the oversize warning has already been shown for, so it appears once per library
  // rather than on every page/sort/alpha-picker fetch.
  var oversizeWarnedLibraryId = null;
  // Separate latch for the size-feature "can't combine with other filters" toast - kept apart from
  // oversizeWarnedLibraryId so the two unrelated warnings don't suppress each other for a library.
  var sizeComboWarnedLibraryId = null;
  // The library id as of the last handleRouteChange() call. Needed to detect a straight
  // library-to-library hop (sidebar navigation) where getCurrentLibraryId() stays non-null
  // throughout, so a null-check alone can't see the change - see handleRouteChange.
  var lastRouteLibraryId = null;

  // Scroll preservation (Milestone 7). How many items to record as scroll anchors, starting at the
  // first one on screen and running past the fold: one is not enough, since the anchor item can
  // itself be one of the deleted ones, and the filter -> select-all -> delete flow removes many at
  // once. suppressScrollRestore is set while one of *our own* refreshes runs, so it can opt out of
  // the restore - see refreshLibraryGrids.
  var SCROLL_ANCHOR_IDS = 40;
  var suppressScrollRestore = false;

  function injectStyles() {
    var style = document.createElement('style');
    style.textContent =
      // position:relative so the ::before hit-area overlay below anchors to this badge, not to
      // the (also positioned) .cardIndicators ancestor.
      '.dislikeIndicator { position: relative; cursor: pointer; opacity: 1; transition: opacity 0.15s ease; }' +
      // The visible glyph box is only ~24x28px (too small for a touch target). This transparent
      // overlay enlarges the tappable area without adding to the badge's flow-participating box.
      //
      // It grows DOWNWARD ONLY - left/right stay flush with the badge's own 24px box. A centred
      // 44x44 overlay (the obvious first instinct) is wrong here: the trickplay badge sits flush
      // to the immediate left with no gap, and .cardIndicators is pinned right:3.348px, so a
      // centred box would overhang the trickplay glyph on one side and the card edge on the other.
      // Because this badge is appended after the trickplay one and both are unpositioned flex
      // siblings at z-index:auto, later DOM order wins hit-testing - so the overhang would have
      // swallowed clicks on the trickplay glyph's right edge. That is a regression, not just a
      // mis-tap: the trickplay badge has no handler of its own, so clicks on it currently fall
      // through to the enclosing <a class="cardImageContainer"> and navigate. Downward is the
      // only direction with free space (open card image below).
      '.dislikeIndicator::before { content: ""; position: absolute; top: 0; left: 0; right: 0; height: 44px; }' +
      '.dislikeIndicator.dislikeIndicator-dimmed { opacity: 0.35; }' +
      '.dislikeIndicator.dislikeIndicator-active .indicatorIcon { color: #ff5252; }' +
      '.dislikeIndicator.dislikeIndicator-hoverOnly { opacity: 0; pointer-events: none; }' +
      '.card:hover .dislikeIndicator.dislikeIndicator-hoverOnly, ' +
      '.dislikeIndicator.dislikeIndicator-hoverOnly:focus { opacity: 1; pointer-events: auto; }' +
      '.dislikeIndicator.dislikeIndicator-error .indicatorIcon { animation: dislikeErrorFlash 0.6s ease; }' +
      '@keyframes dislikeErrorFlash { 0%, 100% { color: inherit; } 50% { color: #ff1744; } }' +
      '.dislikeToastContainer { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); z-index: 10000; display: flex; flex-direction: column; align-items: center; gap: 8px; pointer-events: none; }' +
      '.dislikeToast { background: rgba(20,20,20,0.92); color: #fff; padding: 10px 16px; border-radius: 4px; font-size: 14px; box-shadow: 0 2px 8px rgba(0,0,0,0.4); opacity: 1; transition: opacity 0.3s ease; }' +
      '.dislikeToast.dislikeToast-hide { opacity: 0; }' +
      // Detail-page and OSD dislike buttons - always visible (unlike the card badge), so no
      // dimmed/hover-only states here; just an active color, consistent with the card badge.
      '.dislikeDetailButton.dislikeRowButton-active .detailButton-icon, ' +
      '.dislikeOsdButton.dislikeRowButton-active .xlargePaperIconButton { color: #ff5252; }' +
      // Hover tint for all three dislike surfaces: a light red (#ff8a80), one step lighter than
      // the active red above. Placed after the active rules and at equal specificity so it wins on
      // hover in both states - hovering a disliked (red) control lightens it rather than leaving it
      // flat. The transition on the resting state makes the shift smooth (the error-flash keyframes
      // still override it while flashing).
      '.dislikeIndicator .indicatorIcon, ' +
      '.dislikeDetailButton .detailButton-icon, ' +
      '.dislikeOsdButton .xlargePaperIconButton { transition: color 0.15s ease; }' +
      '.dislikeIndicator:hover .indicatorIcon { color: #ff8a80; }' +
      '.dislikeDetailButton:hover .detailButton-icon, ' +
      '.dislikeOsdButton:hover .xlargePaperIconButton { color: #ff8a80; }' +
      // Pressed (mousedown) state: a darker red (#d32f2f). After the hover rules and at equal
      // specificity, so while the pointer is held down it wins over hover.
      '.dislikeIndicator:active .indicatorIcon { color: #d32f2f; }' +
      '.dislikeDetailButton:active .detailButton-icon, ' +
      '.dislikeOsdButton:active .xlargePaperIconButton { color: #d32f2f; }' +
      '.dislikeDetailButton.dislikeRowButton-error .detailButton-icon, ' +
      '.dislikeOsdButton.dislikeRowButton-error .xlargePaperIconButton { animation: dislikeErrorFlash 0.6s ease; }' +
      // Inserted-but-itemless row button (see ensureRowButton) - hidden and inert until
      // syncRowButtons finds a real data-id and renderRowButton removes this class.
      '.dislikeDetailButton.dislikeRowButton-pending, .dislikeOsdButton.dislikeRowButton-pending { display: none; }' +
      // Disliked / Unrated filter rows, inside Jellyfin's own funnel filter dialog (Milestone 5;
      // Unrated added later). Same styling - both are cloned from Jellyfin's Favorites row.
      '.dislikeFilterRow, .unratedFilterRow { display: flex; align-items: center; }' +
      // File-size filter: its own titled .verticalSection (like Genres/Features), so the heading
      // inherits Jellyfin\'s own .checkboxListLabel styling. Only the <select> control needs styling.
      '.dislikeSizeFilterBody { display: flex; }' +
      '.dislikeSizeFilterSelect { flex: 1; min-width: 8em; padding: 0.4em 0.5em; ' +
        'color: inherit; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.25); ' +
        'border-radius: 4px; }' +
      '.dislikeSizeFilterSelect option { color: initial; }' +
      // `.paper-icon-button-light` (the funnel button's real class, added at custom-element
      // upgrade time - not present in its static markup) sets `overflow: hidden` for its own
      // ripple effect, and is a circle (`border-radius: 50%`). `.filterButtonBubble` sits at the
      // literal top-right corner of the button's *rectangular* bounding box - a point outside a
      // circle inscribed in that box - so most of the badge was being clipped into a crescent by
      // the button's own overflow. Verified in an isolated harness (real main.css, the button's
      // class added by hand since no browser login is available to reproduce it live): the badge
      // renders as a full circle only once this button stops clipping. Scoped to
      // `.btnFilterWithBubble` (the marker both this code and Jellyfin's own setFilterStatus add
      // only while a badge is actually showing), not the funnel button generally, so the ripple
      // is only unclipped for the moment a badge is up.
      '.btnFilter.btnFilterWithBubble { overflow: visible; }' +
      // Jellyfin's like control is a heart; made a thumbs-up so like and dislike read as a
      // matched pair. The glyph comes from a CSS `content:` rule keyed off the `favorite`
      // class (the span itself is empty in this build's markup), so overriding the content is
      // the way to change it - and it has to be: `emby-ratingbutton`'s own update path re-adds
      // the `favorite` class on every state change, so swapping the class in the DOM wouldn't
      // stick. \e8dc is thumb_up in this build's Material Icons CSS, the same source the
      // thumb_down used for dislike comes from. Scoped to the rating button rather than to the
      // `favorite` class globally: this is the like *control* (all five surfaces of it - list
      // item, card hover overlay, play queue, video OSD, detail page - are that element), not
      // every heart the UI might draw.
      '[is="emby-ratingbutton"] .material-icons.favorite::before { content: "\\e8dc"; }' +
      // Jellyfin ships no color rule for `.favorite` at all in this build (verified live -
      // no `.material-icons.favorite` or `data-isfavorite` selector sets one anywhere in the
      // shipped CSS), so the glyph was rendering in whatever plain icon color surrounded it.
      // Default it to white (unchecked), and light it blue only when the like is checked. Blue
      // matches the app's own accent color, confirmed live off the sign-in button's computed
      // background (`rgb(0, 164, 220)` = #00a4dc) rather than guessed from memory. `checked` here
      // is the favorited state: the shipped emby-ratingbutton setter adds `ratingbutton-icon-
      // withrating` to the icon (and `ratingbutton-withrating` to the button) when favorite is on
      // and removes it when off, on every state change - so keying off that class tracks the live
      // state without this script having to observe it. Its extra class raises specificity over
      // the white default below, so ordering aside it still wins.
      '[is="emby-ratingbutton"] .material-icons.favorite { color: #fff; transition: color 0.15s ease; }' +
      '[is="emby-ratingbutton"] .material-icons.favorite.ratingbutton-icon-withrating { color: #00a4dc; }' +
      // Hover tint: a light blue (#66c8ea, #00a4dc lightened toward white), the like-side mirror of
      // the dislike hover below. After the checked rule and at equal specificity, so it wins on
      // hover whether the like is on or off.
      '[is="emby-ratingbutton"]:hover .material-icons.favorite { color: #66c8ea; }' +
      // Pressed (mousedown) state: a darker blue (#00739a, #00a4dc darkened). After the hover rule
      // and at equal specificity, so while the pointer is held down it wins over hover.
      '[is="emby-ratingbutton"]:active .material-icons.favorite { color: #00739a; }' +
      //
      // LOAD-BEARING FOR USER SAFETY - do not change `display: none` to any other hiding
      // mechanism (visibility:hidden, opacity:0, off-screen positioning, etc).
      //
      // Jellyfin's own "select all" toolbar action (read from the shipped bundle) skips any
      // .chkItemSelect checkbox whose getBoundingClientRect().width is 0 - i.e. it only selects
      // checkboxes that are actually visible. `display: none` is the one hiding mechanism that
      // collapses an element's box to zero width; every other mechanism listed above leaves the
      // box (and therefore the checkbox) measurable, so select-all would then select items this
      // filter is hiding on purpose. That's exactly the flow this feature exists to enable
      // (filter to disliked -> select all -> delete, using Jellyfin's own native multi-select),
      // so a change here would make select-all silently start deleting non-disliked items.
      // A card whose disliked state hasn't resolved yet also matches (fails safe: hidden until
      // proven disliked, not the other way around).
      'body.' + FILTER_BODY_CLASS + ' .card[data-id]:not([data-disliked="true"]) { display: none !important; }' +
      // The Unrated filter's identical safety net, and for the identical reason: it feeds the same
      // select-all -> delete flow, so every non-unrated card (favorited OR disliked) MUST be hidden
      // with `display: none` and no other mechanism (see the LOAD-BEARING note above). This net is
      // what makes the feature safe even if the server ignores the `ExcludeItemIds` narrowing in
      // patchGetItems - worst case the grid still contains rated cards, and this hides them from
      // select-all. `data-unrated` is set by markUnratedCards from the fetched rated-id set; a card
      // that hasn't been marked yet fails safe (hidden until proven unrated).
      'body.' + UNRATED_BODY_CLASS + ' .card[data-id]:not([data-unrated="true"]) { display: none !important; }';
    document.head.appendChild(style);
  }

  function getItemId(card) {
    return card.getAttribute('data-id');
  }

  function isLoggedIn() {
    return !!(
      window.ApiClient &&
      typeof window.ApiClient.getCurrentUserId === 'function' &&
      window.ApiClient.getCurrentUserId()
    );
  }

  function scheduleLoginRecheck() {
    if (loginRecheckTimer) {
      return;
    }

    loginRecheckTimer = setTimeout(function () {
      loginRecheckTimer = null;
      flush();
    }, RETRY_DELAY_MS);
  }

  // window.Events' full method contract wasn't live-verified beyond its existence (see
  // CLAUDE.md), so this is a best-effort nicety on top of the re-check-on-every-flush gating
  // below, not a replacement for it.
  function hookAuthEvent() {
    if (window.Events && typeof window.Events.on === 'function' && window.ApiClient) {
      try {
        window.Events.on(window.ApiClient, 'authenticated', function () {
          flush();
        });
      } catch (e) {
        // Defensive: contract unverified, never let this break the rest of the script.
      }
    }
  }

  function showToast(message) {
    var container = document.querySelector('.dislikeToastContainer');
    if (!container) {
      container = document.createElement('div');
      container.className = 'dislikeToastContainer';
      document.body.appendChild(container);
    }

    var toast = document.createElement('div');
    toast.className = 'dislikeToast';
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(function () {
      toast.classList.add('dislikeToast-hide');
      setTimeout(function () {
        if (toast.parentNode) {
          toast.parentNode.removeChild(toast);
        }
      }, 300);
    }, 3000);
  }

  function registerCard(card) {
    var itemId = getItemId(card);
    if (!itemId) {
      return;
    }

    var set = cardsByItemId.get(itemId);
    if (!set) {
      set = new Set();
      cardsByItemId.set(itemId, set);
    }

    set.add(card);
  }

  // Cards leave the DOM constantly (virtualized grids, navigating between library views) and
  // never come back for most items. Without this sweep cardsByItemId (and the derived
  // dislikedState/retryAttempts) would grow for the entire lifetime of the SPA session.
  function pruneDisconnectedCards() {
    cardsByItemId.forEach(function (cards, itemId) {
      cards.forEach(function (card) {
        if (!card.isConnected) {
          cards.delete(card);
        }
      });

      if (cards.size === 0) {
        cardsByItemId.delete(itemId);
        dislikedState.delete(itemId);
        retryAttempts.delete(itemId);
      }
    });
  }

  function findNewCards(root) {
    var found = [];
    if (root.nodeType !== 1) {
      return found;
    }

    if (root.matches && root.matches('.card[data-id]') && !root.hasAttribute(BADGE_ATTR)) {
      found.push(root);
    }

    if (root.querySelectorAll) {
      var descendants = root.querySelectorAll('.card[data-id]:not([' + BADGE_ATTR + '])');
      for (var i = 0; i < descendants.length; i++) {
        found.push(descendants[i]);
      }
    }

    return found;
  }

  function scheduleFlush() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }

    debounceTimer = setTimeout(flush, DEBOUNCE_MS);

    if (!maxWaitTimer) {
      maxWaitTimer = setTimeout(flush, MAX_WAIT_MS);
    }
  }

  function flush() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }

    if (maxWaitTimer) {
      clearTimeout(maxWaitTimer);
      maxWaitTimer = null;
    }

    pruneDisconnectedCards();

    if (pendingIds.size === 0) {
      return;
    }

    // Re-checked on every flush (not just once at load) - a plain page load has ApiClient/Events
    // present before login, so a load-time-only check would burn the retry budget on 401s and
    // never recover once the user actually signs in.
    if (!isLoggedIn()) {
      scheduleLoginRecheck();
      return;
    }

    var ids = Array.from(pendingIds);
    pendingIds.clear();
    sendBatched(ids);
  }

  function sendBatched(ids) {
    for (var i = 0; i < ids.length; i += BATCH_CHUNK_SIZE) {
      requestBatch(ids.slice(i, i + BATCH_CHUNK_SIZE));
    }
  }

  function requestBatch(itemIds) {
    if (!isLoggedIn()) {
      itemIds.forEach(function (id) {
        pendingIds.add(id);
      });
      scheduleLoginRecheck();
      return;
    }

    window.ApiClient.ajax({
      type: 'POST',
      url: window.ApiClient.getUrl('Plugins/TrickplayStatus/Dislikes/Batch'),
      data: JSON.stringify({ itemIds: itemIds }),
      contentType: 'application/json',
      dataType: 'json'
    }).then(
      function (statesById) {
        itemIds.forEach(function (id) {
          if (Object.prototype.hasOwnProperty.call(statesById, id)) {
            retryAttempts.delete(id);
            applyState(id, statesById[id] === true);
          }
        });

        // The server omits an id when it doesn't resolve to a real, visible item (a stable
        // fact, unlike the trickplay batch endpoint's "unknown" case) - but a card can render
        // for an item a beat before it's queryable server-side, so still retry (bounded, same
        // budget as everything else here) rather than assuming permanent invisibility.
        var missing = itemIds.filter(function (id) {
          return !Object.prototype.hasOwnProperty.call(statesById, id);
        });
        if (missing.length > 0) {
          scheduleRetry(missing);
        }
      },
      function () {
        scheduleRetry(itemIds);
      }
    );
  }

  function scheduleRetry(itemIds) {
    var toRetry = [];
    itemIds.forEach(function (id) {
      var attempts = (retryAttempts.get(id) || 0) + 1;
      if (attempts > MAX_RETRY_ATTEMPTS) {
        retryAttempts.delete(id);
        return;
      }

      retryAttempts.set(id, attempts);
      toRetry.push(id);
    });

    if (toRetry.length === 0) {
      return;
    }

    toRetry.forEach(function (id) {
      pendingIds.add(id);
    });

    if (retryTimer) {
      return;
    }

    retryTimer = setTimeout(function () {
      retryTimer = null;
      flush();
    }, RETRY_DELAY_MS);
  }

  function applyState(itemId, disliked) {
    var previous = dislikedState.get(itemId);
    // Only an actual change between two *known* states invalidates the cached disliked-id list.
    // A first resolution (undefined -> false/true) is this script reading state, not changing it -
    // and it happens ~100 times per grid load, which would otherwise throw away the very list
    // that load just fetched.
    if (typeof previous === 'boolean' && previous !== disliked) {
      dislikedIdsCache = null;
      // Also drops any in-flight fetch's claim on the cache - it was issued before this change
      // and would otherwise repopulate the cache with a list that's now known to be stale.
      dislikedIdsInFlight = null;
      // A dislike change also moves the item in or out of the rated set (favorited OR disliked),
      // so the Unrated filter's cache is stale too. (A favorite-only change is covered by the
      // short FILTER_IDS_TTL_MS instead - there's no per-item favorite hook here.) The next grid
      // fetch repopulates it; the per-card update below handles the immediate visual.
      ratedIdsCache = null;
      ratedIdsInFlight = null;
    }

    dislikedState.set(itemId, disliked);

    var cards = cardsByItemId.get(itemId);
    if (cards) {
      cards.forEach(function (card) {
        renderBadge(card, disliked);
        // While the Unrated filter is on, an item just marked disliked is now rated, so hide it
        // immediately (the CSS net keys off data-unrated). The un-dislike direction can't be
        // resolved locally - the item may still be favorited - so it's left hidden until the next
        // fetch re-marks it, which fails safe (hidden, never wrongly shown).
        if (filterMode === 'unrated' && disliked) {
          card.setAttribute('data-unrated', 'false');
        }
      });
    }

    // rowButtons is small (at most one detail-page row and one OSD row at a time), so a linear
    // scan per state change is cheap - unlike cards, entries aren't keyed by itemId because the
    // OSD's itemId can change out from under a still-mounted row (see syncRowButtons).
    rowButtons.forEach(function (entry) {
      if (entry.itemId === itemId) {
        renderRowButton(entry, disliked);
      }
    });
  }

  function renderBadge(card, disliked) {
    if (!card.isConnected) {
      // Virtualized grid scrolled the card out and dropped it; stop tracking it.
      var itemId = getItemId(card);
      var set = itemId ? cardsByItemId.get(itemId) : null;
      if (set) {
        set.delete(card);
      }

      return;
    }

    // Re-queried fresh every call (never cached across ticks) - this is what lets this script
    // and trickplay-status.js safely coexist on the same card without racing to create
    // .cardIndicators first.
    var indicators = card.querySelector('.cardIndicators');
    if (!indicators) {
      var container = card.querySelector('.cardImageContainer') || card;
      indicators = document.createElement('div');
      indicators.className = 'cardIndicators';
      container.appendChild(indicators);
    }

    var badge = indicators.querySelector('.dislikeIndicator');
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'indicator dislikeIndicator itemAction';
      // Makes jellyfin-web's own card-activation handler treat this as a no-navigate control,
      // the same idiom its own favorite/playstate buttons use (verified live).
      badge.setAttribute('data-action', 'none');
      badge.setAttribute('role', 'button');
      badge.setAttribute('tabindex', '0');

      var span = document.createElement('span');
      span.className = 'material-icons indicatorIcon';
      span.setAttribute('aria-hidden', 'true');
      span.textContent = 'thumb_down';
      badge.appendChild(span);
      indicators.appendChild(badge);
    }

    badge.classList.toggle('dislikeIndicator-active', disliked);
    badge.classList.toggle('dislikeIndicator-dimmed', ALWAYS_VISIBLE && !disliked);
    badge.classList.toggle('dislikeIndicator-hoverOnly', !ALWAYS_VISIBLE && !disliked);
    badge.setAttribute('aria-pressed', disliked ? 'true' : 'false');
    badge.setAttribute('aria-label', disliked ? 'Remove dislike' : 'Mark as disliked');

    card.setAttribute(BADGE_ATTR, 'done');
    card.setAttribute('data-disliked', disliked ? 'true' : 'false');
  }

  function flashError(itemId) {
    var cards = cardsByItemId.get(itemId);
    if (cards) {
      cards.forEach(function (card) {
        var badge = card.querySelector('.dislikeIndicator');
        if (!badge) {
          return;
        }

        badge.classList.add('dislikeIndicator-error');
        setTimeout(function () {
          badge.classList.remove('dislikeIndicator-error');
        }, 600);
      });
    }

    rowButtons.forEach(function (entry) {
      if (entry.itemId !== itemId || !entry.dislikeBtn.isConnected) {
        return;
      }

      entry.dislikeBtn.classList.add('dislikeRowButton-error');
      setTimeout(function () {
        entry.dislikeBtn.classList.remove('dislikeRowButton-error');
      }, 600);
    });
  }

  // --- Detail page + OSD dislike buttons -----------------------------------------------------
  //
  // Both surfaces expose the item id on a sibling `.btnUserRating` (the heart/favorite button,
  // present on both the detail page and the video OSD as the same `emby-ratingbutton` custom
  // element - verified live, see CLAUDE.md). We insert our own button immediately after it and
  // mirror its surrounding markup conventions, which differ between the two surfaces.

  function classifyRatingSurface(ratingBtn) {
    if (ratingBtn.classList.contains('detailButton')) {
      return 'detail';
    }

    if (ratingBtn.classList.contains('paper-icon-button-light') || ratingBtn.classList.contains('autoSize')) {
      return 'osd';
    }

    return null;
  }

  // Applied at creation time on both builders below, so a button is never nameless/stateless to
  // assistive tech - even briefly, and even permanently for a row whose .btnUserRating never
  // resolves a data-id (see the pending-hide handling in ensureRowButton/syncRowButtons).
  // renderRowButton() overwrites these once real state is known.
  function applyDefaultRowButtonState(btn) {
    btn.setAttribute('aria-pressed', 'false');
    btn.title = 'Mark as disliked';
    btn.setAttribute('aria-label', 'Mark as disliked');
  }

  function buildDetailRowButton() {
    var btn = document.createElement('button');
    btn.type = 'button';
    // Mirrors the surrounding button-flat/detailButton/emby-button classes for visual
    // consistency, plus our own identifying class - deliberately omits "btnUserRating" itself
    // (that class is tied to the `emby-ratingbutton` custom element's own behavior) and the
    // `is="emby-ratingbutton"` attribute.
    btn.className = 'button-flat detailButton emby-button dislikeDetailButton';
    btn.setAttribute(ROW_BTN_ATTR, 'detail');
    applyDefaultRowButtonState(btn);

    var content = document.createElement('div');
    content.className = 'detailButton-content';

    var icon = document.createElement('span');
    icon.className = 'material-icons detailButton-icon thumb_down';
    icon.setAttribute('aria-hidden', 'true');

    content.appendChild(icon);
    btn.appendChild(content);
    return btn;
  }

  function buildOsdRowButton() {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'autoSize paper-icon-button-light dislikeOsdButton';
    btn.setAttribute(ROW_BTN_ATTR, 'osd');
    applyDefaultRowButtonState(btn);

    var icon = document.createElement('span');
    icon.className = 'xlargePaperIconButton material-icons thumb_down';
    icon.setAttribute('aria-hidden', 'true');

    btn.appendChild(icon);
    return btn;
  }

  function renderRowButton(entry, disliked) {
    var btn = entry.dislikeBtn;
    if (!btn.isConnected) {
      return;
    }

    // A real itemId is known by the time this runs (see syncRowButtons/applyState call sites),
    // so it's safe to reveal the button here even if it was inserted pending (no data-id yet).
    btn.classList.remove('dislikeRowButton-pending');
    btn.classList.toggle('dislikeRowButton-active', disliked);
    btn.setAttribute('aria-pressed', disliked ? 'true' : 'false');

    var label = disliked ? 'Remove dislike' : 'Mark as disliked';
    btn.title = label;
    btn.setAttribute('aria-label', label);
  }

  function trackRowButton(ratingBtn, dislikeBtn, surface) {
    var entry = rowButtonByRatingBtn.get(ratingBtn);
    if (!entry) {
      entry = { ratingBtn: ratingBtn, dislikeBtn: dislikeBtn, surface: surface, itemId: null };
      rowButtonByRatingBtn.set(ratingBtn, entry);
      rowButtons.add(entry);
    } else {
      entry.dislikeBtn = dislikeBtn;
    }

    // At least one row button now exists; make sure the poll that catches OSD item changes
    // (see syncRowButtons) is running. No-op if it already is.
    scheduleRowSync();

    return entry;
  }

  // Finds .btnUserRating rows not yet processed and inserts our button immediately after them.
  // Idempotent: a row whose sibling button already carries ROW_BTN_ATTR is left alone (covers
  // the OSD case, where the same row persists across an item change with no rebuild - see
  // syncRowButtons for how that item change itself is picked up).
  function ensureRowButton(ratingBtn) {
    var surface = classifyRatingSurface(ratingBtn);
    if (!surface) {
      ratingBtn.setAttribute(ROW_ATTR, 'skip');
      return;
    }

    var sibling = ratingBtn.nextElementSibling;
    var dislikeBtn = sibling && sibling.hasAttribute(ROW_BTN_ATTR) ? sibling : null;
    if (!dislikeBtn) {
      dislikeBtn = surface === 'detail' ? buildDetailRowButton() : buildOsdRowButton();
      // A row can exist before its item does (an OSD row observed before playback resolves an
      // item, for instance) - a button that can't identify its item can't usefully be clicked,
      // so keep it hidden (not just nameless) until syncRowButtons finds a real data-id and
      // reveals it via renderRowButton.
      if (!ratingBtn.getAttribute('data-id')) {
        dislikeBtn.classList.add('dislikeRowButton-pending');
      }

      ratingBtn.insertAdjacentElement('afterend', dislikeBtn);
    }

    trackRowButton(ratingBtn, dislikeBtn, surface);
    ratingBtn.setAttribute(ROW_ATTR, 'done');
  }

  function findNewRatingButtons(root) {
    var found = [];
    if (root.nodeType !== 1) {
      return found;
    }

    if (root.matches && root.matches('.btnUserRating:not([' + ROW_ATTR + '])')) {
      found.push(root);
    }

    if (root.querySelectorAll) {
      var descendants = root.querySelectorAll('.btnUserRating:not([' + ROW_ATTR + '])');
      for (var i = 0; i < descendants.length; i++) {
        found.push(descendants[i]);
      }
    }

    return found;
  }

  // Re-reads each tracked row's itemId fresh from the live .btnUserRating rather than trusting
  // a cached value (requirement: the OSD's item can change - next episode, queue advance -
  // without the row being torn down and rebuilt). Runs after every relevant mutation batch and
  // on a short poll, since it's unverified whether the OSD's item change is reflected as a
  // data-id attribute mutation the MutationObserver would catch on its own (see PROGRESS.md) -
  // the poll is a cheap, DOM-assumption-free fallback that makes this correct either way.
  function syncRowButtons() {
    rowButtons.forEach(function (entry) {
      if (!entry.ratingBtn.isConnected || !entry.dislikeBtn.isConnected) {
        rowButtons.delete(entry);
        rowButtonByRatingBtn.delete(entry.ratingBtn);
        return;
      }

      var itemId = entry.ratingBtn.getAttribute('data-id');
      if (!itemId || itemId === entry.itemId) {
        return;
      }

      entry.itemId = itemId;
      if (dislikedState.has(itemId)) {
        renderRowButton(entry, dislikedState.get(itemId) === true);
      } else {
        renderRowButton(entry, false);
        pendingIds.add(itemId);
        scheduleFlush();
      }
    });

    // Nothing left to poll for (both rows torn down, or none ever appeared) - stop rather than
    // ticking for the rest of the SPA session, consistent with every other timer in this file
    // being one-shot/re-armed on demand. trackRowButton re-arms this the next time a row button
    // is inserted.
    if (rowButtons.size === 0) {
      stopRowSync();
    }
  }

  function scheduleRowSync() {
    if (rowSyncTimer) {
      return;
    }

    rowSyncTimer = setInterval(syncRowButtons, ROW_SYNC_MS);
  }

  function stopRowSync() {
    if (!rowSyncTimer) {
      return;
    }

    clearInterval(rowSyncTimer);
    rowSyncTimer = null;
  }

  function findRowButton(target) {
    return target && typeof target.closest === 'function'
      ? target.closest('.dislikeDetailButton, .dislikeOsdButton')
      : null;
  }

  function toggleDislike(itemId) {
    if (inFlight.has(itemId)) {
      // Ignore a second click while one is still pending, rather than racing two writes.
      return;
    }

    if (!isLoggedIn()) {
      return;
    }

    var previous = dislikedState.get(itemId) === true;
    var next = !previous;

    inFlight.add(itemId);
    applyState(itemId, next);

    // Mutual exclusivity: marking disliked clears any like (see clearFavorite). Only in the
    // disliking direction - un-disliking must leave the favorite untouched.
    if (next) {
      clearFavorite(itemId);
    }

    window.ApiClient.ajax({
      type: 'POST',
      url: window.ApiClient.getUrl('Plugins/TrickplayStatus/Dislikes/' + itemId, { disliked: next }),
      dataType: 'json'
    }).then(
      function (response) {
        inFlight.delete(itemId);
        var confirmed = response && typeof response.Disliked === 'boolean' ? response.Disliked : next;
        applyState(itemId, confirmed);
      },
      function () {
        inFlight.delete(itemId);
        applyState(itemId, previous);
        flashError(itemId);
        showToast('Could not update dislike status. Please try again.');
      }
    );
  }

  // Idempotent set-to-disliked, used by the Shift+X shortcut (see below) - deliberately NOT a
  // toggle, unlike toggleDislike above. "Shift+X while already disliked" must still skip without
  // un-disliking (see PROGRESS.md for the reasoning), so an already-disliked item short-circuits
  // before any network write. `onSettled` always fires - synchronously when short-circuited,
  // async otherwise - so the caller can clear its own re-entry guard either way.
  function setDisliked(itemId, onSettled) {
    var previous = dislikedState.get(itemId) === true;
    if (previous || inFlight.has(itemId) || !isLoggedIn()) {
      // Nothing to write: already disliked, another write for this exact item is already in
      // flight (avoid racing it), or not logged in (shouldn't happen mid-playback, but don't
      // optimistically claim a write that can't happen).
      if (onSettled) {
        onSettled();
      }
      return;
    }

    inFlight.add(itemId);
    applyState(itemId, true);

    // Mutual exclusivity: this always marks disliked, so always clear any like (see clearFavorite).
    clearFavorite(itemId);

    window.ApiClient.ajax({
      type: 'POST',
      url: window.ApiClient.getUrl('Plugins/TrickplayStatus/Dislikes/' + itemId, { disliked: true }),
      dataType: 'json'
    }).then(
      function (response) {
        inFlight.delete(itemId);
        var confirmed = response && typeof response.Disliked === 'boolean' ? response.Disliked : true;
        applyState(itemId, confirmed);
        if (onSettled) {
          onSettled();
        }
      },
      function () {
        inFlight.delete(itemId);
        // Roll back to this specific itemId's previous state (captured above, before the
        // player advanced), not to whatever happens to be playing by the time this rejects -
        // the whole point of the shortcut is that playback has already moved on.
        applyState(itemId, previous);
        flashError(itemId);
        showToast('Could not update dislike status. Please try again.');
        if (onSettled) {
          onSettled();
        }
      }
    );
  }

  // --- Like/dislike mutual exclusivity -------------------------------------------------------
  //
  // Thumbs-up (Jellyfin's own favorite, `emby-ratingbutton`) and thumbs-down (our dislike) are
  // mutually exclusive: turning one on clears the other. The two states live in different stores
  // (favorite is Jellyfin's UserData.IsFavorite, dislike is our own UserData.Rating), so this is
  // reconciled from the client whenever the user flips either control.
  //
  // Direction "dislike clears like": clearFavorite is called from the dislike write paths below
  // whenever an item is being marked disliked. Best-effort and unconditional - clearing a favorite
  // that isn't set is a harmless idempotent write, and doing it unconditionally guarantees
  // exclusivity even for a favorite set from another session that never showed in this DOM. The
  // native like controls repaint themselves off the resulting UserDataChanged event (verified in
  // the shipped emby-ratingbutton: it listens for UserDataChanged and re-reads IsFavorite), so
  // there's no DOM to update here. Deliberately not called when a dislike is being *cleared* - that
  // direction must not touch the favorite.
  function clearFavorite(itemId) {
    var apiClient = window.ApiClient;
    if (!isLoggedIn() || !apiClient || typeof apiClient.updateFavoriteStatus !== 'function') {
      return;
    }

    try {
      var result = apiClient.updateFavoriteStatus(apiClient.getCurrentUserId(), itemId, false);
      if (result && typeof result.catch === 'function') {
        // Fire-and-forget: the dislike write the user actually initiated is the source of truth,
        // and a failed favorite-clear just leaves a stale heart the next UserDataChanged corrects.
        result.catch(function () {});
      }
    } catch (e) {
      // updateFavoriteStatus was verified present on this build's ApiClient, but never let a
      // reconciliation nicety break the dislike action that triggered it.
    }
  }

  // Direction "like clears dislike": force this item's dislike off. Deliberately a straight
  // set-to-false, never toggleDislike - the caller (a like being turned on) knows only that dislike
  // must end up off, not what it currently is, and toggling an item whose state we haven't loaded
  // would *add* a dislike. A known-false state short-circuits before any network write; an unknown
  // state writes false anyway (idempotent server-side) rather than guessing.
  function clearDislike(itemId) {
    if (inFlight.has(itemId) || !isLoggedIn()) {
      return;
    }

    if (dislikedState.get(itemId) === false) {
      return;
    }

    var previous = dislikedState.get(itemId) === true;

    inFlight.add(itemId);
    applyState(itemId, false);

    window.ApiClient.ajax({
      type: 'POST',
      url: window.ApiClient.getUrl('Plugins/TrickplayStatus/Dislikes/' + itemId, { disliked: false }),
      dataType: 'json'
    }).then(
      function (response) {
        inFlight.delete(itemId);
        var confirmed = response && typeof response.Disliked === 'boolean' ? response.Disliked : false;
        applyState(itemId, confirmed);
      },
      function () {
        inFlight.delete(itemId);
        applyState(itemId, previous);
        flashError(itemId);
        showToast('Could not update dislike status. Please try again.');
      }
    );
  }

  // --- Disliked filter row in Jellyfin's own filter dialog (Milestone 5) ---------------------
  //
  // This section only inserts/removes a checkbox row into Jellyfin's own funnel filter dialog
  // (next to Favorites) and drives the filter state from it. The filtering itself lives in two
  // places: the grid's own query is narrowed server-side (see "Server-side disliked filtering"
  // below), and the CSS rule in injectStyles still hides any non-disliked card that reaches the
  // DOM anyway - which is what keeps select-all safe. No delete endpoint, permission
  // probe, or confirmation UI lives here: deletion is entirely Jellyfin's own native
  // "select all -> delete" flow, governed by Jellyfin's own permissions.
  //
  // Originally this was a standalone toolbar toggle button. Redirected per explicit user
  // feedback after live deployment: "filtering is done from the 'funnel' dropdown" - so the
  // control was moved into Jellyfin's own filter dialog instead, alongside Favorites/Played/etc.
  // The CSS hiding mechanism (and its load-bearing select-all safety property) is unchanged;
  // only how the user reaches the toggle changed.

  // Verified live in the library toolbar (route `#/<type>?topParentId=<32-hex>`): the id lives
  // in the hash as `topParentId=`, not the pathname - this build is hash-routed.
  function getCurrentLibraryId() {
    var match = LIBRARY_ID_PATTERN.exec(window.location.hash);
    return match ? match[1] : null;
  }

  // Single source of truth for whether the filter is on - the checkbox (when a dialog happens
  // to be open) is only ever a view onto this, synced in both directions explicitly (never via
  // relying on the checkbox's own property mutation alone). This is also what makes dialog
  // cancel/Escape harmless: our own 'change' listener applies the filter immediately (see
  // onFilterCheckboxChange), not on some later "Apply" step, and if Jellyfin's own dialog-close
  // logic resets checkbox DOM state on the way out, it can only affect a row that's about to be
  // destroyed - filterMode (and therefore the body class already applied) is untouched, and
  // the next dialog open resyncs the fresh checkboxes from filterMode again.
  // Single source of truth for which filter (if any) is on. The two checkboxes are only ever a
  // view onto this, synced explicitly in both directions - which is also how the mutual exclusivity
  // is enforced: setting the mode unchecks whichever of the two isn't it, so the dialog can never
  // show both ticked. Switching to unrated re-marks cards immediately (a no-op until the rated-id
  // set is cached; the grid fetch that follows populates it and re-marks).
  function setFilterMode(mode) {
    filterMode = mode;
    document.body.classList.toggle(FILTER_BODY_CLASS, mode === 'disliked');
    document.body.classList.toggle(UNRATED_BODY_CLASS, mode === 'unrated');
    syncFilterButtonBubble();

    if (dislikedCheckboxEl && dislikedCheckboxEl.checked !== (mode === 'disliked')) {
      dislikedCheckboxEl.checked = mode === 'disliked';
    }

    if (unratedCheckboxEl && unratedCheckboxEl.checked !== (mode === 'unrated')) {
      unratedCheckboxEl.checked = mode === 'unrated';
    }

    if (mode === 'unrated') {
      markUnratedCards();
    }
  }

  // Jellyfin badges the funnel button with a `.filterButtonBubble` while a filter is on
  // (ItemsView.setFilterStatus in the shipped bundle). It recomputes that from *its own* filter
  // set on every query build, and it knows nothing about ours - so with only the Disliked filter
  // on, the funnel looked untouched, and any grid fetch would clear a badge we had lit.
  //
  // Rather than teach it about our filter, we drive the same element it does, with the same
  // markup and classes: one badge on the button whether it is on for a stock filter, for ours,
  // or for both, and a later stock setFilterStatus finds our node and takes it over instead of
  // adding a second one.
  function syncFilterButtonBubble() {
    var buttons = document.querySelectorAll('.btnFilter');

    for (var i = 0; i < buttons.length; i++) {
      var button = buttons[i];

      // A previous page's toolbar, left in the document by SPA navigation, measures 0x0 (see
      // CLAUDE.md) - badging it would only put a stale mark on a page the user may come back to.
      if (!button.getClientRects().length) {
        continue;
      }

      var bubble = button.querySelector('.filterButtonBubble');

      if (!bubble) {
        if (!anyFilterActive()) {
          continue;
        }

        // A <span>, deliberately, where Jellyfin's own setFilterStatus writes a <div>: on this
        // build `.paper-icon-button-light>div` (main.css) sets position:relative, display:block
        // and transform:scale(1.8), and it outweighs `.filterButtonBubble`'s own
        // position:absolute. Measured live on the real funnel button: as a div the badge renders
        // 35x35 in normal flow and widens the button from 41px to 61px, shoving the funnel
        // sideways; as a span it is the intended 20x20 pinned to the button's top-right corner.
        // Stock only ever looks the badge up by class, so it still finds, hides and shows this
        // one - and never adds a second.
        button.insertAdjacentHTML('afterbegin', '<span class="filterButtonBubble">!</span>');
        button.classList.add('btnFilterWithBubble');
        bubble = button.querySelector('.filterButtonBubble');
      }

      if (anyFilterActive()) {
        bubble.classList.remove('hide');
        button.setAttribute(FILTER_BUBBLE_ATTR, 'shown');
      } else if (button.hasAttribute(FILTER_BUBBLE_ATTR)) {
        // Only touches a badge this code lit, so a badge that is up purely for a stock filter is
        // left alone. It can still re-hide one that was up for both: harmless, because every path
        // that turns our filter off is either followed by a grid fetch (whose setFilterStatus
        // relights it in the same tick) or is a route change away from that page entirely.
        button.removeAttribute(FILTER_BUBBLE_ATTR);
        bubble.classList.add('hide');
      }
    }
  }

  // One handler for both checkboxes; `mode` is the one this checkbox turns on. Checking it selects
  // that mode (setFilterMode unchecks the other, enforcing mutual exclusivity); unchecking it can
  // only mean turning the currently-on filter off, so it goes to 'none'. A programmatic .checked
  // change from setFilterMode does NOT dispatch 'change', so unchecking the other box here never
  // re-enters this handler.
  function onFilterCheckboxChange(mode, e) {
    setFilterMode(e.target.checked ? mode : 'none');
    // Both directions need a refetch now that the filter is part of the query, not just a
    // stylesheet: turning it on narrows the query, turning it off widens it back.
    resetStartIndexOnNextFetch = true;
    refreshLibraryGrids();
  }

  // Builds our row by cloning Jellyfin's own Favorites row rather than hand-building markup,
  // because `is="emby-checkbox"` is a customized built-in custom element - a hand-built
  // `<input is="emby-checkbox">` from an HTML string is not guaranteed to upgrade the same way a
  // real one (created by Jellyfin's own template code) does, and getting that wrong would render
  // a plain, unstyled checkbox instead of the themed one. Cloning preserves the exact upgraded
  // markup (the `.checkboxOutline`/`.checkboxIcon` spans the custom element itself manages).
  //
  // NOT independently verified live (no browser access here) whether cloning an already-upgraded
  // customized-built-in element produces a second instance that re-upgrades correctly once
  // reinserted into the (connected) dialog - this is the approach the brief explicitly asked for
  // pending a live check, not something guessed from nothing. Flagged in PROGRESS.md.
  function buildFilterRow(favoritesRow, mode, filterClass, rowClass, label) {
    var clone = favoritesRow.cloneNode(true);
    clone.classList.add(rowClass);

    var checkbox = clone.querySelector('input');
    if (checkbox) {
      // Deliberately NOT chkStandardFilter / data-filter="..." - Jellyfin's own filter-apply
      // logic iterates .chkStandardFilter elements and reads data-filter to build its
      // server-side query. Neither of our filters maps to a stock `Filters=` value on this build
      // (`Dislikes` is implemented as the *liked* set - see CLAUDE.md; "unrated" has no stock
      // filter at all), so picking up either of those would hand Jellyfin's query engine a filter
      // it can't honour. We narrow the same query ourselves instead - see patchGetItems. The
      // chkDislikedFilter/chkUnratedFilter class is a distinct class solely for our own
      // lookup/cleanup; emby-checkbox is kept for styling/upgrade.
      checkbox.classList.remove('chkStandardFilter', 'chkFavorite');
      checkbox.classList.add(filterClass);
      checkbox.removeAttribute('data-filter');
      checkbox.removeAttribute('id');
      checkbox.addEventListener('change', function (e) {
        onFilterCheckboxChange(mode, e);
      });
      // Deliberately NOT set here - checked is applied once by ensureFilterRow, after the row
      // is actually connected to the document, so the is="emby-checkbox" custom element's own
      // visual sync (the checkboxIcon glyph) reacts the same way it would to a real user click,
      // rather than relying on a property write against a still-disconnected clone.
    }

    var labelSpan = clone.querySelector('.checkboxLabel');
    if (labelSpan) {
      labelSpan.textContent = label;
    }

    return { row: clone, checkbox: checkbox };
  }

  // Idempotent, but only in the success direction: the checkboxList carries the marker
  // attribute once a row has actually been inserted into it, so a list that's already been
  // handled this open is left alone - but a list that hasn't (yet) matched is deliberately left
  // unmarked and gets re-attempted on every subsequent mutation batch (see the comment below on
  // why marking on mere "attempted" rather than "succeeded" was the original bug). The dialog is
  // rebuilt from scratch on every funnel-button open, so this runs again - and inserts a fresh
  // row - each time one appears.
  function ensureFilterRow(checkboxList) {
    if (checkboxList.hasAttribute(FILTER_ROW_MARKER_ATTR)) {
      return;
    }

    // Jellyfin inserts each .checkboxList empty and populates its label children afterward
    // (see scanForFilterRows below for the discovery-side consequence of that ordering) - so
    // the very first attempt against a given list can legitimately find nothing yet.
    var favoritesInput = checkboxList.querySelector('.chkFavorite');
    var favoritesRow = favoritesInput ? favoritesInput.closest('label.emby-checkbox-label') : null;

    if (!favoritesRow) {
      // Do NOT mark the list here. A marker must mean "this succeeded", never "this was
      // attempted" - the original bug was exactly this: marking unconditionally on entry, before
      // Jellyfin had actually populated the list's children, permanently excluded the one
      // checkboxList that would have matched a moment later on a subsequent mutation batch. The
      // ~7 sections that never contain Favorites just get re-checked (one querySelector each)
      // on every batch while the dialog stays open - cheap, and correct beats cheap here anyway.
      return;
    }

    // Disliked then Unrated, cloned from the Favorites row so both inherit the themed emby-checkbox
    // markup. (scanForFilterRows only calls this when DISLIKES_ENABLED.)
    var dislikedBuilt = buildFilterRow(favoritesRow, 'disliked', 'chkDislikedFilter', 'dislikeFilterRow', 'Disliked');
    favoritesRow.insertAdjacentElement('afterend', dislikedBuilt.row);

    var unratedBuilt = buildFilterRow(favoritesRow, 'unrated', 'chkUnratedFilter', 'unratedFilterRow', 'Unrated');
    dislikedBuilt.row.insertAdjacentElement('afterend', unratedBuilt.row);

    // Only mark now that insertion has actually happened - see the comment above.
    checkboxList.setAttribute(FILTER_ROW_MARKER_ATTR, 'done');

    dislikedCheckboxEl = dislikedBuilt.checkbox;
    unratedCheckboxEl = unratedBuilt.checkbox;

    // Reflect existing state immediately on insertion - applied to the now-connected checkboxes
    // (see buildFilterRow for why not before), not only once some later state resolves.
    dislikedCheckboxEl.checked = filterMode === 'disliked';
    unratedCheckboxEl.checked = filterMode === 'unrated';
  }

  // The file-size filter is its OWN titled section, matching Jellyfin's own Genres/Features/VideoType
  // groups: a `.verticalSection` with an `<h2 class="checkboxListLabel">` heading and a body -
  // rather than a row wedged into the basic Filters checkbox list. The control inside is a range
  // <select> (a bucket picker, not a set of booleans); its change drives the size paging engine in
  // patchGetItems and sets no stock Filters= value.
  function buildSizeFilterSection() {
    var section = document.createElement('div');
    section.className = 'verticalSection verticalSection-extrabottompadding dislikeSizeFilterSection focuscontainer-x';

    var heading = document.createElement('h2');
    heading.className = 'checkboxListLabel';
    heading.textContent = 'File size';

    var body = document.createElement('div');
    body.className = 'dislikeSizeFilterBody';

    var select = document.createElement('select');
    select.className = 'dislikeSizeFilterSelect';
    for (var i = 0; i < SIZE_BUCKETS.length; i++) {
      var opt = document.createElement('option');
      opt.value = SIZE_BUCKETS[i].value;
      opt.textContent = SIZE_BUCKETS[i].label;
      select.appendChild(opt);
    }

    select.addEventListener('change', function (e) {
      setSizeFilterBucket(e.target.value);
    });

    body.appendChild(select);
    section.appendChild(heading);
    section.appendChild(body);
    return { section: section, select: select };
  }

  // Idempotent per dialog via a marker on the <form>: the dialog is rebuilt on every funnel open,
  // so a fresh section is inserted each time one appears. Keyed off the form (reached from
  // Jellyfin's own Favorites checkbox, always present) so it works whether or not the dislike rows
  // are enabled.
  function ensureSizeFilterSection(form) {
    if (form.hasAttribute(SIZE_FILTER_SECTION_MARKER)) {
      return;
    }

    var built = buildSizeFilterSection();
    // After the basic Filters section when present, else at the end of the form - so it sits among
    // the other titled groups rather than before the first one.
    var basic = form.querySelector('.basicFilterSection');
    if (basic) {
      basic.insertAdjacentElement('afterend', built.section);
    } else {
      form.appendChild(built.section);
    }

    form.setAttribute(SIZE_FILTER_SECTION_MARKER, 'done');
    sizeSelectEl = built.select;
    // Reflect current selection so reopening the dialog shows the active bucket.
    sizeSelectEl.value = sizeFilterBucket ? sizeFilterBucket.value : 'any';
  }

  function findSizeBucket(value) {
    for (var i = 0; i < SIZE_BUCKETS.length; i++) {
      if (SIZE_BUCKETS[i].value === value) {
        return SIZE_BUCKETS[i];
      }
    }
    return null;
  }

  function setSizeFilterBucket(value) {
    var bucket = findSizeBucket(value);
    sizeFilterBucket = bucket && bucket.value !== 'any' ? bucket : null;

    if (sizeSelectEl && sizeSelectEl.value !== value) {
      sizeSelectEl.value = value;
    }

    syncFilterButtonBubble();
    // A filter change resizes the result set, so start from page 1 (mirrors onFilterCheckboxChange).
    resetStartIndexOnNextFetch = true;
    refreshLibraryGrids();
  }

  // --- Sort menu: inject a "File Size" radio into Jellyfin's own sort menu ---------------------
  //
  // The library sort menu (LibraryBrowser.showSortMenu, shipped) is a dialog of
  // `<input type="radio" is="emby-radio" name="SortBy" class="menuSortBy">` rows - NOT the
  // `<select>` dialog in chunk 60545 (which this view doesn't use). Each native radio's own change
  // handler sets `query.SortBy` off its value and re-queries. Since `ItemSortBy` has no Size value,
  // we do NOT ride that mechanism: our radio drives our own `sizeSortActive` flag (read by
  // patchGetItems) instead, and never writes anything into query.SortBy. Direction still comes
  // from the native Sort Order radios via query.SortOrder.
  //
  // A single capture-phase change listener on the group handles both directions and, crucially,
  // runs BEFORE each native radio's own bubble-phase handler - so when the user picks a native
  // sort, sizeSortActive is already false by the time that handler's re-query fires.
  function ensureSortRadio(group, nativeRadios) {
    var template = nativeRadios[0].closest('label.radio-label-block');
    if (!template) {
      return;
    }

    // Clone a real radio row so the emby-radio styling/upgrade is preserved (cloneNode does not
    // copy the native change listener, so ours is the only handler on this element).
    var label = template.cloneNode(true);
    var input = label.querySelector('input');
    input.classList.add('dislikeSizeSortRadio');
    input.setAttribute('data-id', 'trickplayFilesize');
    input.value = 'trickplayFilesize';
    input.checked = sizeSortActive;
    var span = label.querySelector('span');
    if (span) {
      span.textContent = 'File Size';
    }
    group.appendChild(label);

    group.addEventListener(
      'change',
      function (e) {
        var target = e.target;
        if (!target || !target.classList || !target.classList.contains('menuSortBy')) {
          return;
        }

        var mine = target.classList.contains('dislikeSizeSortRadio');
        // Radios share name="SortBy", so exactly one is checked; set the flag from which one.
        sizeSortActive = mine && target.checked;

        if (mine && target.checked) {
          // The native re-query handler is bound only to the native radios, so selecting ours
          // won't refresh the grid - do it ourselves. StartIndex reset so a stale page can't land
          // past the end when a size filter is also on.
          resetStartIndexOnNextFetch = true;
          refreshLibraryGrids();
        }
      },
      true
    );
  }

  function scanForSortRadios() {
    if (!FILESIZE_ENABLED) {
      return;
    }

    var radios = document.querySelectorAll('.menuSortBy');
    if (!radios.length) {
      return;
    }

    var firstLabel = radios[0].closest('label.radio-label-block');
    var group = firstLabel ? firstLabel.parentNode : null;
    // Idempotent per open: skip once our radio is in this group (the dialog is rebuilt each open,
    // so a fresh one is added the next time the menu appears).
    if (group && !group.querySelector('.dislikeSizeSortRadio')) {
      ensureSortRadio(group, radios);
    }
  }

  // NOT keyed off newly-added subtrees (an earlier version was, via a ".checkboxList" scan
  // over each mutation's addedNodes). That looked correct but still failed live: Jellyfin adds
  // the 8 empty ".checkboxList" elements first, then adds each one's <label> children in LATER,
  // separate mutations - and in those later mutations the added node IS the <label>, so a scan
  // scoped to "descendants of what was just added" never re-examines the ALREADY-added (and
  // still being tracked as unmarked) checkboxList that just gained a Favorites row. An observer
  // that only inspects added subtrees will always miss anything that becomes ready later inside
  // an element it already walked past - see CLAUDE.md.
  //
  // The fix is to stop keying off the container and key off the thing we actually need instead:
  // document.querySelectorAll('.chkFavorite') is correct regardless of build order (the element
  // either exists yet or it doesn't - there's no "exists but not in the place we looked" case),
  // and cheap enough to run unconditionally on every mutation batch (normally 0 or 1 match; even
  // with a dialog open, at most one real match plus its container walk).
  function scanForFilterRows() {
    var favoritesInputs = document.querySelectorAll('.chkFavorite');
    for (var i = 0; i < favoritesInputs.length; i++) {
      if (DISLIKES_ENABLED) {
        var checkboxList = favoritesInputs[i].closest('.checkboxList');
        if (checkboxList && !checkboxList.hasAttribute(FILTER_ROW_MARKER_ATTR)) {
          ensureFilterRow(checkboxList);
        }
      }

      if (FILESIZE_ENABLED) {
        // The size filter is its own titled section, keyed off the dialog form rather than the
        // Favorites checkbox list.
        var form = favoritesInputs[i].closest('form');
        if (form && !form.hasAttribute(SIZE_FILTER_SECTION_MARKER)) {
          ensureSizeFilterSection(form);
        }
      }
    }
  }

  // Drops the tracked row reference and turns the filter off whenever the route's library id has
  // actually changed since the last call - not only when it goes null. An earlier version only
  // checked for null, which correctly cleared the filter on leaving library views entirely but
  // missed the normal sidebar path of hopping straight from one library to another
  // (topParentId=A -> topParentId=B): getCurrentLibraryId() stays non-null the whole time, so the
  // filter (and the body class actually hiding cards) silently carried into the new library
  // without the user ever enabling it there. Comparing against lastRouteLibraryId catches this.
  // This does not affect the delete-safety property either way (display: none still holds
  // regardless of which library the filter is scoped to), but a filter silently
  // active on a library the user never touched is still a correctness bug worth closing. The
  // filter dialog itself needs no explicit teardown here: it isn't kept open across navigation in
  // practice, and even if it were, our row's references would just go stale until the next open
  // rebuilds it fresh.
  function handleRouteChange() {
    var libraryId = getCurrentLibraryId();

    if (libraryId !== lastRouteLibraryId) {
      if (filterMode !== 'none') {
        setFilterMode('none');
      }

      dislikedCheckboxEl = null;
      unratedCheckboxEl = null;
      dislikedIdsCache = null;
      ratedIdsCache = null;
      oversizeWarnedLibraryId = null;
      sizeComboWarnedLibraryId = null;

      // Size feature state is per-library too - clear the selection, the cached size map, and the
      // torn-down dialog element refs on any library change (including a straight library-to-library
      // hop, where getCurrentLibraryId stays non-null). syncFilterButtonBubble after, so the funnel
      // badge drops if the size filter was the only thing lighting it.
      var hadSizeFilter = isSizeFilterActive();
      sizeFilterBucket = null;
      sizeSortActive = false;
      sizeSelectEl = null;
      sizeMapCache = null;
      if (hadSizeFilter) {
        syncFilterButtonBubble();
      }
    }

    lastRouteLibraryId = libraryId;
  }

  // --- Server-side disliked filtering --------------------------------------------------------
  //
  // The CSS rule in injectStyles hides every non-disliked card, but on its own it could only
  // ever hide cards that were already on screen: a library view pages 100 items at a time, so
  // "filter to disliked" showed the disliked items *of the current page*, not of the library.
  // Reported live after 1.8.0.0.
  //
  // The fix narrows the grid's own query instead of only decorating its output. Verified live
  // against container 104: GET /Items honours `Ids` alongside ParentId/Recursive/IncludeItemTypes
  // and returns a TotalRecordCount for the intersection, so Jellyfin's own sorting, paging
  // control, alpha picker and other active filters keep working unchanged - it is the same
  // query, narrowed. The id list comes from the plugin's own `GET Dislikes?parentId=` endpoint,
  // which exists precisely because this is the one query UserData.Rating can't answer natively
  // (see CLAUDE.md on the broken `Filters=Dislikes`).
  //
  // The CSS rule stays: it is what makes select-all safe (see the LOAD-BEARING comment), and it
  // still covers the gap between a card rendering and its state resolving, plus any grid whose
  // query we didn't narrow.
  //
  // Mechanically, from the shipped bundle: the library view assigns `fetchData` onto its
  // `.itemsContainer` custom element, that function calls the global
  // `ApiClient.getItems(userId, query)` synchronously, and `refreshItems()` re-runs it and
  // re-renders (including the paging control) from the response. So both get wrapped - fetchData
  // to know that a getItems call is the grid's own rather than a home-screen shelf's or a
  // play-all's, and getItems to narrow that one call.

  function delay(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function requestDislikedIds(libraryId, attempt) {
    return window.ApiClient.ajax({
      type: 'GET',
      url: window.ApiClient.getUrl('Plugins/TrickplayStatus/Dislikes', { parentId: libraryId }),
      dataType: 'json'
    }).then(
      function (response) {
        var items = (response && response.Items) || [];
        var ids = [];
        for (var i = 0; i < items.length; i++) {
          if (items[i] && items[i].ItemId) {
            ids.push(items[i].ItemId);
          }
        }

        return ids;
      },
      function (error) {
        if (attempt >= FILTER_IDS_RETRIES) {
          throw error;
        }

        return delay(FILTER_IDS_RETRY_MS).then(function () {
          return requestDislikedIds(libraryId, attempt + 1);
        });
      }
    );
  }

  // Cached only on success - a failed fetch leaves nothing behind, so the next grid fetch (or the
  // next time the user toggles the filter) retries for free rather than being told "no dislikes"
  // by a cache entry that only means "the request didn't work".
  function getDislikedIds(libraryId) {
    if (
      dislikedIdsCache &&
      dislikedIdsCache.libraryId === libraryId &&
      Date.now() - dislikedIdsCache.fetchedAt < FILTER_IDS_TTL_MS
    ) {
      return Promise.resolve(dislikedIdsCache.ids);
    }

    if (dislikedIdsInFlight && dislikedIdsInFlight.libraryId === libraryId) {
      return dislikedIdsInFlight.promise;
    }

    var promise = requestDislikedIds(libraryId, 0).then(
      function (ids) {
        // Only cache if this request is still the current one. A dislike written while it was
        // in flight clears dislikedIdsInFlight (see applyState), which makes this response
        // known-stale: still a fine answer for whoever is already awaiting it, but it must not
        // become the cached list that a later fetch reuses.
        if (dislikedIdsInFlight && dislikedIdsInFlight.promise === promise) {
          dislikedIdsInFlight = null;
          dislikedIdsCache = { libraryId: libraryId, ids: ids, fetchedAt: Date.now() };
        }

        return ids;
      },
      function (error) {
        if (dislikedIdsInFlight && dislikedIdsInFlight.promise === promise) {
          dislikedIdsInFlight = null;
        }

        throw error;
      }
    );

    dislikedIdsInFlight = { libraryId: libraryId, promise: promise };
    return promise;
  }

  // The rated set (favorited OR disliked) for the Unrated filter, from the plugin's own
  // `GET Dislikes/Rated?parentId=` endpoint. Mirrors requestDislikedIds - same retry/backoff, same
  // 503-while-rebuilding contract - but reads a plain `ItemIds` string array rather than an Items
  // list, since the Unrated filter only needs the ids to exclude, not item names.
  function requestRatedIds(libraryId, attempt) {
    return window.ApiClient.ajax({
      type: 'GET',
      url: window.ApiClient.getUrl('Plugins/TrickplayStatus/Dislikes/Rated', { parentId: libraryId }),
      dataType: 'json'
    }).then(
      function (response) {
        return (response && response.ItemIds) || [];
      },
      function (error) {
        if (attempt >= FILTER_IDS_RETRIES) {
          throw error;
        }

        return delay(FILTER_IDS_RETRY_MS).then(function () {
          return requestRatedIds(libraryId, attempt + 1);
        });
      }
    );
  }

  // Same cache-only-on-success / share-in-flight discipline as getDislikedIds. A favorite or
  // dislike toggle moves an item in or out of the rated set, so the cache is invalidated on both:
  // a dislike change clears it in applyState (alongside dislikedIdsCache), and a like being turned
  // ON clears it in handleLikeActivate (which also hides the card immediately). A favorite turned
  // OFF from outside those paths is covered only by the short FILTER_IDS_TTL_MS - acceptable
  // because that direction fails safe (an item wrongly still hidden, never wrongly shown).
  function getRatedIds(libraryId) {
    if (
      ratedIdsCache &&
      ratedIdsCache.libraryId === libraryId &&
      Date.now() - ratedIdsCache.fetchedAt < FILTER_IDS_TTL_MS
    ) {
      return Promise.resolve(ratedIdsCache.ids);
    }

    if (ratedIdsInFlight && ratedIdsInFlight.libraryId === libraryId) {
      return ratedIdsInFlight.promise;
    }

    var promise = requestRatedIds(libraryId, 0).then(
      function (ids) {
        if (ratedIdsInFlight && ratedIdsInFlight.promise === promise) {
          ratedIdsInFlight = null;
          ratedIdsCache = { libraryId: libraryId, ids: ids, fetchedAt: Date.now() };
        }

        return ids;
      },
      function (error) {
        if (ratedIdsInFlight && ratedIdsInFlight.promise === promise) {
          ratedIdsInFlight = null;
        }

        throw error;
      }
    );

    ratedIdsInFlight = { libraryId: libraryId, promise: promise };
    return promise;
  }

  // The CSS safety net for the Unrated filter: set data-unrated on every card from the cached rated
  // set (unrated == id not in the set). A no-op until the set is cached, and only while the Unrated
  // filter is on - a card left unmarked stays hidden by the load-bearing CSS rule, which fails safe.
  // Runs on every mutation batch (cards are re-inserted, not recycled - see CLAUDE.md - so freshly
  // rendered cards need marking) and again right after a rated-ids fetch resolves.
  function markUnratedCards() {
    if (filterMode !== 'unrated' || !ratedIdsCache) {
      return;
    }

    var rated = new Set(ratedIdsCache.ids);
    var cards = document.querySelectorAll('.card[data-id]');
    for (var i = 0; i < cards.length; i++) {
      var id = cards[i].getAttribute('data-id');
      cards[i].setAttribute('data-unrated', id && !rated.has(id) ? 'true' : 'false');
    }
  }

  // Only ever consulted while a wrapped fetchData is on the stack, so this doesn't have to tell a
  // grid query apart from every other query in the app - just from the other queries the same
  // view makes (its play-all, which copies the query but targets no particular page of it).
  function isLibraryGridQuery(query) {
    var libraryId = getCurrentLibraryId();
    return !!(libraryId && query && query.ParentId === libraryId);
  }

  function shallowCopyQuery(query) {
    var copy = {};
    for (var key in query) {
      if (Object.prototype.hasOwnProperty.call(query, key)) {
        copy[key] = query[key];
      }
    }

    return copy;
  }

  function emptyItemsResult(query) {
    return { Items: [], TotalRecordCount: 0, StartIndex: (query && query.StartIndex) || 0 };
  }

  // --- File-size data + query helpers --------------------------------------------------------

  function requestSizeMap(libraryId, attempt) {
    return window.ApiClient.ajax({
      type: 'GET',
      url: window.ApiClient.getUrl('Plugins/TrickplayStatus/Filesizes', { parentId: libraryId }),
      dataType: 'json'
    }).then(
      function (response) {
        var sizes = (response && response.Sizes) || {};
        // Precompute the descending-by-size id order once; the ascending direction is just this
        // reversed at slice time, so we don't keep two arrays.
        var orderDesc = Object.keys(sizes);
        orderDesc.sort(function (a, b) {
          return sizes[b] - sizes[a];
        });
        return { sizes: sizes, orderDesc: orderDesc };
      },
      function (error) {
        if (attempt >= FILTER_IDS_RETRIES) {
          throw error;
        }

        return delay(FILTER_IDS_RETRY_MS).then(function () {
          return requestSizeMap(libraryId, attempt + 1);
        });
      }
    );
  }

  // Same cache-only-on-success / share-in-flight discipline as getDislikedIds, just a much longer
  // TTL (sizes don't change under us). Resolves to { sizes, orderDesc }.
  function getSizeMap(libraryId) {
    if (
      sizeMapCache &&
      sizeMapCache.libraryId === libraryId &&
      Date.now() - sizeMapCache.fetchedAt < SIZE_MAP_TTL_MS
    ) {
      return Promise.resolve(sizeMapCache);
    }

    if (sizeMapInFlight && sizeMapInFlight.libraryId === libraryId) {
      return sizeMapInFlight.promise;
    }

    var promise = requestSizeMap(libraryId, 0).then(
      function (map) {
        if (sizeMapInFlight && sizeMapInFlight.promise === promise) {
          sizeMapInFlight = null;
          sizeMapCache = {
            libraryId: libraryId,
            sizes: map.sizes,
            orderDesc: map.orderDesc,
            fetchedAt: Date.now()
          };
        }

        return sizeMapCache && sizeMapCache.libraryId === libraryId
          ? sizeMapCache
          : { libraryId: libraryId, sizes: map.sizes, orderDesc: map.orderDesc, fetchedAt: Date.now() };
      },
      function (error) {
        if (sizeMapInFlight && sizeMapInFlight.promise === promise) {
          sizeMapInFlight = null;
        }

        throw error;
      }
    );

    sizeMapInFlight = { libraryId: libraryId, promise: promise };
    return promise;
  }

  function isSizeFilterActive() {
    return !!(sizeFilterBucket && sizeFilterBucket.value !== 'any');
  }

  // Whether some plugin filter (not sort) is on, for the funnel badge and the grid-intercept gate.
  // Sort is deliberately excluded - it reorders but doesn't reduce the set, so it earns no badge.
  function anyFilterActive() {
    return filterMode !== 'none' || isSizeFilterActive();
  }

  function queryHasStockFilter(query) {
    for (var i = 0; i < STOCK_FILTER_PARAMS.length; i++) {
      var v = query[STOCK_FILTER_PARAMS[i]];
      if (v == null || v === '') {
        continue;
      }
      if (Array.isArray(v) && v.length === 0) {
        continue;
      }
      return true;
    }
    return false;
  }

  // Builds the ordered, filtered id list a size-active grid query pages through, from the cached
  // size map and (when a dislike/unrated filter is also on) that filter's id set. Ascending vs
  // descending comes from the view's own SortOrder. A size FILTER with no size SORT still returns
  // a size-ordered list, because there is no other order available client-side (documented v1
  // behaviour: filtering by size orders the view by size).
  function buildSizeWorkingList(map, query, filterIdSet, filterExclude) {
    var ids = [];
    var order = map.orderDesc;
    var bucket = isSizeFilterActive() ? sizeFilterBucket : null;

    for (var i = 0; i < order.length; i++) {
      var id = order[i];

      if (bucket) {
        var size = map.sizes[id];
        if (size < bucket.min || size >= bucket.max) {
          continue;
        }
      }

      if (filterIdSet) {
        var inSet = filterIdSet.has(id);
        // disliked filter INCLUDES its set; unrated EXCLUDES it.
        if (filterExclude ? inSet : !inSet) {
          continue;
        }
      }

      ids.push(id);
    }

    // orderDesc is high->low; the view's Ascending order just walks it backwards.
    var ascending = String((query && query.SortOrder) || '').toLowerCase().indexOf('asc') === 0;
    if (ascending) {
      ids.reverse();
    }

    return ids;
  }

  function normalizeId(id) {
    return String(id).replace(/-/g, '').toLowerCase();
  }

  // getItems returns Items in the server's own order, which ignores an `Ids=` list's order - so
  // put them back into the slice's (size) order. Ids missing from the response (e.g. one deleted
  // between the size-map fetch and now) are simply dropped.
  function reorderResult(result, slice) {
    if (!result || !result.Items) {
      return result || { Items: [], TotalRecordCount: 0 };
    }

    var byId = {};
    for (var i = 0; i < result.Items.length; i++) {
      var item = result.Items[i];
      if (item && item.Id != null) {
        byId[normalizeId(item.Id)] = item;
      }
    }

    var ordered = [];
    for (var j = 0; j < slice.length; j++) {
      var match = byId[normalizeId(slice[j])];
      if (match) {
        ordered.push(match);
      }
    }

    result.Items = ordered;
    return result;
  }

  // The client-side paging engine shared by the size filter and the size sort. Computes the
  // ordered+filtered id list, slices out the requested page (always <=100 ids, safely under the
  // ~200-id URL cap), fetches exactly those, reorders them, and reports the full filtered count so
  // Jellyfin's own paging control works. Fails to an empty grid - never a silently unfiltered one,
  // since this feeds select-all -> delete (see the disliked path's failure comment).
  function runSizeQuery(original, self, userId, query, libraryId) {
    // Our precomputed global order can't account for a server-side stock filter, so refuse to
    // combine (would under-fill pages / mis-count) and let the server answer its own (non-size)
    // query normally - query.SortBy already holds a real sort, never anything of ours.
    if (queryHasStockFilter(query)) {
      if (sizeComboWarnedLibraryId !== libraryId) {
        sizeComboWarnedLibraryId = libraryId;
        showToast('File Size can’t combine with other filters yet - showing the unsized result.');
      }
      return original.apply(self, [userId, query]);
    }

    var filterPromise =
      filterMode === 'disliked' ? getDislikedIds(libraryId)
        : filterMode === 'unrated' ? getRatedIds(libraryId)
          : Promise.resolve(null);

    return Promise.all([getSizeMap(libraryId), filterPromise]).then(
      function (results) {
        var map = results[0];
        var filterIds = results[1];

        if (filterMode === 'unrated') {
          markUnratedCards();
        }

        var filterSet = filterIds ? new Set(filterIds) : null;
        var working = buildSizeWorkingList(map, query, filterSet, filterMode === 'unrated');

        if (working.length === 0) {
          return emptyItemsResult(query);
        }

        var start = query.StartIndex || 0;
        // A page past the (possibly just-shrunk) end shows nothing though items exist; clamp to the
        // first page. Filter/sort changes also set resetStartIndexOnNextFetch, but a stale StartIndex
        // can still arrive here, so guard it.
        if (start >= working.length) {
          start = 0;
        }

        // The grid always sends Limit=100, but clamp to the id cap defensively: a missing Limit
        // would otherwise slice the whole (possibly thousands-long) working list into one Ids=
        // request and 414. Reported TotalRecordCount stays the true count, so paging is unaffected.
        var limit = Math.min(query.Limit || working.length, MAX_FILTER_IDS);
        var slice = working.slice(start, start + limit);

        // Copied, never mutated (the view keeps this object - see the disliked path). SortBy is
        // left as-is; the server's ordering of the <=100 ids is irrelevant because reorderResult
        // reimposes the size order below.
        var narrowed = shallowCopyQuery(query);
        narrowed.Ids = slice.join(',');
        // The Ids list IS the page, so fetch it from its own start; the real page offset is
        // reported back on the result below, not sent to the server.
        narrowed.StartIndex = 0;
        narrowed.Limit = slice.length;
        narrowed.EnableTotalRecordCount = false;

        return Promise.resolve(original.call(self, userId, narrowed)).then(function (result) {
          result = reorderResult(result, slice);
          result.TotalRecordCount = working.length;
          result.StartIndex = start;
          return result;
        });
      },
      function () {
        showToast('Could not load file sizes. Try the filter again.');
        return emptyItemsResult(query);
      }
    );
  }

  function patchGetItems() {
    var apiClient = window.ApiClient;
    if (!apiClient || typeof apiClient.getItems !== 'function' || apiClient.getItems.dislikeFilterPatched) {
      return;
    }

    var original = apiClient.getItems;

    var patched = function (userId, query) {
      var isGridQuery = gridFetchDepth > 0 && isLibraryGridQuery(query);

      if (isGridQuery && resetStartIndexOnNextFetch) {
        // The one field written back onto the view's own query object, deliberately: it has to
        // survive into the paging control and the next/previous-page arithmetic, which both read
        // that same object. It's also exactly what Jellyfin writes there on its own filterchange.
        query.StartIndex = 0;
        resetStartIndexOnNextFetch = false;
      }

      // Size sort is driven by our own module flag (set by the injected sort radio), NOT by any
      // value in query.SortBy - we never write a bogus sort into the query, so nothing size-related
      // can ever reach the server as a SortBy. hasSizeSort gates on FILESIZE_ENABLED so a stale
      // flag can't outlive a feature toggle. Size FILTER is likewise impossible with the feature
      // off (its dropdown is never injected), so isSizeFilterActive covers itself.
      var hasSizeSort = FILESIZE_ENABLED && sizeSortActive;
      var sizeActive = isGridQuery && (isSizeFilterActive() || hasSizeSort);

      // Nothing for us to do: not the grid's own fetch, or the grid with no plugin feature on.
      if (!sizeActive && (!isGridQuery || !anyFilterActive())) {
        return original.apply(this, arguments);
      }

      // Jellyfin's own query build - which just ran, synchronously, to produce this call - reset
      // the funnel badge from its own filter set, so re-assert ours here rather than leaving it
      // to the observer batch the eventual re-render triggers: that is a network round trip away,
      // and the badge would visibly blink off for the whole of it.
      syncFilterButtonBubble();

      var self = this;
      var libraryId = query.ParentId;

      // A size feature (filter and/or sort) takes over paging entirely: the server can neither
      // range-filter nor order by size, so we compute the page's ids ourselves and reorder the
      // response. It also folds in a simultaneously-active dislike/unrated filter.
      if (sizeActive) {
        return runSizeQuery(original, self, userId, query, libraryId);
      }

      if (filterMode === 'disliked') {
        return getDislikedIds(libraryId).then(
          function (ids) {
            if (ids.length === 0) {
              return emptyItemsResult(query);
            }

            if (ids.length > MAX_FILTER_IDS) {
              if (oversizeWarnedLibraryId !== libraryId) {
                oversizeWarnedLibraryId = libraryId;
                showToast(
                  'Too many disliked items (' + ids.length + ') to filter the whole library at once - ' +
                    'showing only the disliked items of the loaded page.'
                );
              }

              // Deliberately unnarrowed: the CSS rule still hides every non-disliked card, so this
              // degrades to exactly the pre-1.9.0.0 behaviour (and keeps select-all safe) instead
              // of sending a request this server would answer with 414.
              return original.call(self, userId, query);
            }

            // Copied rather than mutated: the view keeps this object for the lifetime of the page
            // and hands it to userSettings.saveQuerySettings on sort/filter changes, so an `Ids`
            // left on it could be persisted and outlive the filter entirely.
            var narrowed = shallowCopyQuery(query);
            narrowed.Ids = ids.join(',');
            return original.call(self, userId, narrowed);
          },
          function () {
            // Never fall back to the unnarrowed query on failure. The grid feeds Jellyfin's own
            // select-all -> delete: an empty grid is a visible failure, a silently unfiltered one
            // is a dangerous one. Resolving (rather than rejecting) also matters - the view hides
            // its loading spinner in the response handler.
            showToast('Could not load the disliked list. Try the filter again.');
            return emptyItemsResult(query);
          }
        );
      }

      // filterMode === 'unrated'. "Unrated" is the complement of the rated set, so it is expressed
      // by EXCLUDING the rated ids rather than including a show-list (which would be nearly the
      // whole library - see the plan). markUnratedCards then re-marks against the freshly cached
      // set as the CSS safety net.
      return getRatedIds(libraryId).then(
        function (ids) {
          markUnratedCards();

          // Nothing rated -> the whole library is unrated. Unlike the disliked empty case (which
          // means an empty grid), here we want the library unnarrowed.
          if (ids.length === 0) {
            return original.call(self, userId, query);
          }

          if (ids.length > MAX_FILTER_IDS) {
            if (oversizeWarnedLibraryId !== libraryId) {
              oversizeWarnedLibraryId = libraryId;
              showToast(
                'Too many rated items (' + ids.length + ') to filter the whole library at once - ' +
                  'showing only the unrated items of the loaded page.'
              );
            }

            // Unnarrowed: the CSS net (markUnratedCards + the display:none rule) still hides every
            // rated card, degrading to per-page filtering rather than sending a 414-length request.
            return original.call(self, userId, query);
          }

          var narrowed = shallowCopyQuery(query);
          narrowed.ExcludeItemIds = ids.join(',');
          return original.call(self, userId, narrowed);
        },
        function () {
          // Same reasoning as the disliked failure path: never widen to an unfiltered grid on
          // failure, since it feeds select-all -> delete. An empty grid is the safe failure.
          showToast('Could not load the rated list. Try the filter again.');
          return emptyItemsResult(query);
        }
      );
    };

    patched.dislikeFilterPatched = true;
    apiClient.getItems = patched;
  }

  // Re-scans on every mutation batch instead of marking containers as handled: the view assigns
  // fetchData after the container element itself exists, and the element's own detachedCallback
  // nulls it on every detach - so a container walked past once can legitimately need wrapping
  // later. Marking the *function* (not the element) is what keeps this idempotent.
  function wrapItemsContainers() {
    var containers = document.querySelectorAll('.itemsContainer');
    for (var i = 0; i < containers.length; i++) {
      var container = containers[i];
      var fetchData = container.fetchData;

      if (typeof fetchData === 'function' && !fetchData.dislikeFilterWrapped) {
        container.fetchData = wrapFetchData(fetchData);
      }

      // Checked independently of the fetchData wrap above, not as an else/continue: a container
      // whose fetchData is already wrapped still needs this, and vice versa. refreshItems lives on
      // the element's prototype, so the assignment below shadows it per element - which is exactly
      // why the mark must be read back off the element's own property and never written onto the
      // shared prototype function.
      var refreshItems = container.refreshItems;

      if (typeof refreshItems === 'function' && !refreshItems.dislikeScrollWrapped) {
        container.refreshItems = wrapRefreshItems(refreshItems);
      }
    }
  }

  function wrapFetchData(original) {
    var wrapped = function () {
      gridFetchDepth++;
      try {
        return original.apply(this, arguments);
      } finally {
        gridFetchDepth--;
      }
    };

    wrapped.dislikeFilterWrapped = true;
    return wrapped;
  }

  // --- Scroll preservation across grid redraws (Milestone 7) ---------------------------------
  //
  // Deleting an item from midway down a grid used to lose the reader's place. Nothing reloads the
  // page: both delete paths that start from a grid (Jellyfin's own multi-select -> Delete, and a
  // card's context-menu Delete, which passes navigate:false) end at
  // `emby-itemscontainer.refreshItems()`, which re-fetches and then does
  // `this.innerHTML = this.getItemsHtml(items)` - every card node discarded and re-parsed.
  // Jellyfin carries *focus* across that (by data-id) but not scroll. Only the detail page's
  // delete navigates away; that one is not this surface.
  //
  // The hook goes on refreshItems rather than on the delete deliberately: the container also
  // refreshes on the LibraryChanged websocket event, debounced 10s, so a restore tied to the
  // delete click would be undone moments later anyway. Anchoring every redraw is both simpler
  // and correct for the sort/paging/metadata refreshes that go through the same path.

  // The element that actually scrolls this container. On this build's library view that is the
  // document, but finding it by walking up is no more code than hard-coding that and doesn't
  // silently do the wrong thing inside a dialog or a nested scroller.
  function findScroller(el) {
    var node = el ? el.parentElement : null;

    while (node && node !== document.body && node !== document.documentElement) {
      if (node.scrollHeight > node.clientHeight + 1) {
        var overflowY = window.getComputedStyle(node).overflowY;
        if (overflowY === 'auto' || overflowY === 'scroll') {
          return node;
        }
      }

      node = node.parentElement;
    }

    return document.scrollingElement || document.documentElement;
  }

  // Where the top of the visible area sits in client coordinates. For the document scroller those
  // are already viewport coordinates; a nested scroller's own box top is its viewport top.
  function scrollerViewportTop(scroller) {
    if (scroller === document.scrollingElement || scroller === document.documentElement) {
      return 0;
    }

    return scroller.getBoundingClientRect().top;
  }

  function anchorItemSelector(itemId) {
    return '.card[data-id="' + itemId + '"], .listItem[data-id="' + itemId + '"]';
  }

  // Records what the reader is looking at, not where the scrollbar is. Deleting an item pulls
  // everything after it up a slot (and at a page boundary the next page's first item slides in),
  // so restoring the raw offset lands a fraction of a row off; putting a known item back at the
  // offset it had is exactly right. Every recorded item carries its *own* offset rather than
  // sharing the first one's, which is what lets the list run past the fold: if everything on
  // screen was just deleted, the first survivor below it still knows where it used to sit. The
  // raw scrollTop is kept only for when none of them survived at all.
  function captureScrollAnchor(container) {
    // A previous page's container, left in the document by SPA navigation, measures 0x0 (see
    // CLAUDE.md) - it has no visible position worth preserving.
    if (!container || !container.getClientRects().length) {
      return null;
    }

    var scroller = findScroller(container);
    if (!scroller || scroller.scrollTop === 0) {
      return null;
    }

    var viewportTop = scrollerViewportTop(scroller);
    var items = container.querySelectorAll('.card[data-id], .listItem[data-id]');
    var anchors = [];

    for (var i = 0; i < items.length && anchors.length < SCROLL_ANCHOR_IDS; i++) {
      var rect = items[i].getBoundingClientRect();

      // Anything fully above the viewport top is scrolled past; recording starts at the first item
      // still on screen. Zero-height items are hidden (the filter's own display:none rule among
      // others) and would report a meaningless position.
      if (rect.height === 0 || rect.bottom <= viewportTop) {
        continue;
      }

      var itemId = items[i].getAttribute('data-id');
      // Guid.ToString("N") on this build, but validated rather than trusted: these ids go straight
      // into a selector below.
      if (!itemId || !/^[0-9a-fA-F]{32}$/.test(itemId)) {
        continue;
      }

      anchors.push({ itemId: itemId, offset: rect.top - viewportTop });
    }

    return {
      container: container,
      scroller: scroller,
      scrollTop: scroller.scrollTop,
      anchors: anchors
    };
  }

  // Returns whether an anchor item was found, so the caller can tell "restored" from "had to fall
  // back". Scoped to the container the anchor came from - a document-wide lookup could match the
  // same item on a hidden previous page.
  function applyScrollAnchor(anchor) {
    var viewportTop = scrollerViewportTop(anchor.scroller);

    for (var i = 0; i < anchor.anchors.length; i++) {
      var entry = anchor.anchors[i];
      var el = anchor.container.querySelector(anchorItemSelector(entry.itemId));

      if (el && el.getClientRects().length) {
        var delta = el.getBoundingClientRect().top - viewportTop - entry.offset;

        if (delta !== 0) {
          anchor.scroller.scrollTop += delta;
        }

        return true;
      }
    }

    return false;
  }

  function restoreScrollAnchor(anchor) {
    if (!applyScrollAnchor(anchor)) {
      // Every recorded item is gone - a big enough delete, or a page that shifted wholesale. The
      // raw offset is a worse answer than an item anchor and a much better one than the top.
      anchor.scroller.scrollTop = anchor.scrollTop;
    }

    // Card images load lazily and the paging row is rebuilt along with the grid, so the layout the
    // pass above measured against can still move under it. One more pass once it has settled.
    window.requestAnimationFrame(function () {
      applyScrollAnchor(anchor);
    });
  }

  function wrapRefreshItems(original) {
    var wrapped = function () {
      // Captured synchronously, before the re-render: this is the last moment the old cards are
      // still on screen. A paused container returns without rendering at all, which just makes the
      // restore a no-op - the real refresh arrives later via resume(), through this same wrapper.
      var anchor = suppressScrollRestore ? null : captureScrollAnchor(this);
      var result = original.apply(this, arguments);

      if (!anchor || !result || typeof result.then !== 'function') {
        return result;
      }

      // The render is chained inside refreshItems itself, so by the time this runs the new cards
      // are already in the DOM. A rejected fetch skips it, deliberately: nothing was redrawn.
      return result.then(function (value) {
        restoreScrollAnchor(anchor);
        return value;
      });
    };

    wrapped.dislikeScrollWrapped = true;
    return wrapped;
  }

  function refreshLibraryGrids() {
    // Wrapped/patched here too, not only from the observer: the toggle can be the first thing to
    // happen after a view rendered, and an unwrapped fetchData would fetch unnarrowed.
    patchGetItems();
    wrapItemsContainers();

    var containers = document.querySelectorAll('.itemsContainer');
    for (var i = 0; i < containers.length; i++) {
      var container = containers[i];

      if (typeof container.refreshItems !== 'function' || typeof container.fetchData !== 'function') {
        continue;
      }

      // Deliberately not filtered down to on-screen containers first. SPA navigation leaves the
      // previous page's DOM in the document (see CLAUDE.md), so this can refresh a stale hidden
      // grid too - which is harmless (it re-fetches unnarrowed, since its ParentId is no longer
      // the route's library, and nothing can see it) and much safer than guessing at a
      // visibility test: this runs with Jellyfin's own filter dialog open on top, and a wrong
      // guess about what that does to the page underneath would silently skip the one refresh
      // that matters.
      //
      // Scroll restoration is suppressed for these: a filter change resizes the result set and
      // resets StartIndex to 0 (see patchGetItems), so the top of the new first page is the
      // correct place to be, not wherever the reader was in the old one. The flag is read
      // synchronously inside the wrapper, at capture time, so it doesn't need to outlive the loop.
      suppressScrollRestore = true;
      try {
        container.refreshItems();
      } finally {
        suppressScrollRestore = false;
      }
    }
  }

  // --- Shift+X shortcut: dislike the current video and skip to the next one -----------------
  //
  // Scoped to actual video playback only (never library grids or the detail page) and never a
  // plain toggle - see the milestone brief / PROGRESS.md for why "set disliked, then advance" is
  // the correct reading of "toggle dislike on and play next".

  function isEditableElement(el) {
    if (!el) {
      return false;
    }

    var tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      return true;
    }

    return !!el.isContentEditable;
  }

  function isTypingContext(e) {
    if (isEditableElement(e.target) || isEditableElement(document.activeElement)) {
      return true;
    }

    // Generic modal/dialog check (native <dialog>, or anything ARIA-flagged as one) -
    // deliberately not keyed to any jellyfin-web-specific dialog class name, since none was
    // among this milestone's verified DOM facts and CLAUDE.md says not to guess those.
    var active = document.activeElement;
    return !!(active && typeof active.closest === 'function' && active.closest('dialog, [role="dialog"], [aria-modal="true"]'));
  }

  // "Genuinely playing" per the brief: a real <video> element, connected to the DOM, with a
  // loaded frame (readyState >= HAVE_CURRENT_DATA) and not past the end. Presence of
  // .videoOsdBottom alone is explicitly NOT sufficient (it persists after playback with a stale
  // item id - see CLAUDE.md) - this is the actual playback-state check, independent of that.
  function findActiveVideo() {
    var videos = document.querySelectorAll('video');
    for (var i = 0; i < videos.length; i++) {
      var video = videos[i];
      if (!video.isConnected || video.ended) {
        continue;
      }

      if (!video.duration || isNaN(video.duration) || video.readyState < 2) {
        continue;
      }

      return video;
    }

    return null;
  }

  // Same DOM fact Milestone 4 uses for the OSD row button - the current item id lives on the
  // OSD's own .btnUserRating, re-read fresh (never cached) since it can change under an
  // already-mounted OSD (next-episode/queue advance).
  function currentOsdItemId() {
    var ratingBtn = document.querySelector('.videoOsdBottom .btnUserRating');
    return ratingBtn ? ratingBtn.getAttribute('data-id') : null;
  }

  // playbackManager isn't reachable from this injected script (no AMD loader - see CLAUDE.md),
  // so advancing means clicking jellyfin's own visible .btnNextTrack rather than reimplementing
  // queue logic. Two variants can be in the DOM at once (brief: one plain, one "(Shift+N)"
  // titled, the latter shipping with a `hide` class).
  //
  // DELIBERATELY NO SIZE/VISIBILITY CHECK HERE - do not "fix" this by adding one back.
  // .videoOsdBottom auto-hides during normal playback (that's its steady state while actually
  // watching, not an edge case), and everything inside it - including a real, clickable
  // .btnNextTrack - measures 0x0 while it's hidden. offsetWidth/offsetHeight (or a computed-style
  // check) would reject the one button that's actually there during the overwhelmingly common
  // case and misreport "end of queue" (confirmed live: queue playback with the OSD auto-hidden
  // produced hide:false, disabled:false, size:[0,0] - and DID_SKIP:false, because a now-removed
  // size check rejected it). A programmatic .click() does not require the target to be visible,
  // so a zero-size button is still perfectly clickable - and forcing the OSD visible first, just
  // to satisfy a size check, would add a visible side effect to a shortcut whose entire point is
  // not needing the OSD open. `.hide` is the only discriminator that's actually reliable: it is
  // absent on the real next-track button whenever a next item exists (OSD shown or hidden) and
  // present on the single remaining `(Shift+N)`-titled variant when there is nothing to advance
  // to (see findActionableNextTrackButton's only caller for how that maps to the end-of-queue
  // toast).
  function findActionableNextTrackButton() {
    var buttons = document.querySelectorAll('.btnNextTrack');
    for (var i = 0; i < buttons.length; i++) {
      var btn = buttons[i];
      if (!btn.isConnected || btn.classList.contains('hide') || btn.disabled) {
        continue;
      }

      return btn;
    }

    return null;
  }

  function handleDislikeShortcut(e) {
    if (e.repeat) {
      return;
    }

    // Exact chord only: Shift+X with no other modifiers, so e.g. Ctrl+Shift+X (devtools-ish)
    // doesn't trigger this. Matched on e.code (physical key position) rather than e.key, so the
    // shortcut sits on the same physical key regardless of keyboard layout - the tradeoff is
    // that on a non-QWERTY/non-QWERTZ-ish layout the physical key may not be labelled "X", but a
    // stable physical position was judged more important than a layout-correct label for a
    // playback power-user shortcut.
    if (!e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || e.code !== 'KeyX') {
      return;
    }

    if (isTypingContext(e) || shortcutInFlight) {
      return;
    }

    if (!findActiveVideo()) {
      // Not confidently "playing" (no loaded, unended <video>) - stray Shift+X elsewhere in the
      // app must be inert.
      return;
    }

    var itemId = currentOsdItemId();
    if (!itemId) {
      return;
    }

    // Only now do we decide to act - preventDefault comes after every bail-out check above, not
    // before.
    e.preventDefault();
    shortcutInFlight = true;

    // Order of operations: mark disliked first (optimistic apply happens synchronously inside
    // setDisliked, before the network round-trip and before we advance), then advance - but the
    // advance is not blocked on that round-trip completing, per the brief.
    setDisliked(itemId, function () {
      shortcutInFlight = false;
    });

    // End-of-queue detection is entirely findActionableNextTrackButton's `.hide` check, not
    // anything size-based (see the comment there) - single-item playback is the case where the
    // remaining .btnNextTrack genuinely carries `.hide`, so `nextBtn` is null here on purpose,
    // not by the accident of a hidden OSD. Both branches call showToast synchronously,
    // immediately after the click (not deferred), so the toast fires on this path exactly like
    // the end-of-queue one - if it isn't seen live, check timing/sampling before suspecting this.
    var nextBtn = findActionableNextTrackButton();
    if (nextBtn) {
      nextBtn.click();
      showToast('Disliked - skipping to next video.');
    } else {
      showToast('Disliked - no more videos in the queue.');
    }
  }

  function findBadge(target) {
    return target && typeof target.closest === 'function' ? target.closest('.dislikeIndicator') : null;
  }

  function findLikeButton(target) {
    return target && typeof target.closest === 'function'
      ? target.closest('[is="emby-ratingbutton"]')
      : null;
  }

  // Mutual exclusivity, "like clears dislike" direction. Jellyfin's own click handler is bound to
  // the rating button element itself, so it has already run by the time this bubbling document
  // listener fires - but its updateFavoriteStatus call resolves async and only then flips
  // data-isfavorite, so the attribute still holds the PRE-toggle value here. "false" therefore
  // means this click is turning the like ON, the only direction that should clear a dislike; a
  // click turning the like OFF leaves the dislike alone.
  function handleLikeActivate(target) {
    var likeBtn = findLikeButton(target);
    if (!likeBtn || likeBtn.getAttribute('data-isfavorite') === 'true') {
      return;
    }

    var itemId = likeBtn.getAttribute('data-id');
    if (itemId) {
      clearDislike(itemId);

      // Turning a like ON makes the item rated, so - while the Unrated filter is active - it must
      // leave the grid immediately, or select-all -> delete could take a just-favorited item. The
      // rated cache is now stale (invalidate it; the next grid fetch repopulates it), and this
      // item's cards need hiding now, since no grid refetch fires on a favorite click - the TTL in
      // getRatedIds is only consulted on a fetch. The un-favorite direction needs nothing: it can
      // only make an item unrated, which fails safe (the card stays hidden until a refetch re-marks
      // it). clearDislike above can also mark this item disliked-off, but never rated-off, so it
      // doesn't conflict with the data-unrated="false" set here.
      if (filterMode === 'unrated') {
        ratedIdsCache = null;
        ratedIdsInFlight = null;
        var favedCards = document.querySelectorAll('.card[data-id="' + itemId + '"]');
        for (var i = 0; i < favedCards.length; i++) {
          favedCards[i].setAttribute('data-unrated', 'false');
        }
      }
    }
  }

  function onActivate(e) {
    var badge = findBadge(e.target);
    if (badge) {
      // The badge sits inside <a class="cardImageContainer"> (verified live) -
      // data-action="none" stops jellyfin-web's own delegated navigation logic, but
      // preventDefault is still needed to stop the anchor's native navigation, belt-and-braces
      // with stopPropagation.
      e.preventDefault();
      e.stopPropagation();

      var card = badge.closest('.card[data-id]');
      if (!card) {
        return;
      }

      var cardItemId = getItemId(card);
      if (!cardItemId) {
        return;
      }

      toggleDislike(cardItemId);
      return;
    }

    var rowBtn = findRowButton(e.target);
    if (!rowBtn) {
      // Not one of our controls - the only other thing we care about here is a click on
      // Jellyfin's own like button, which (when it turns the like on) clears any dislike.
      handleLikeActivate(e.target);
      return;
    }

    // Real <button> elements, not anchors - no navigation to suppress. Read the item id fresh
    // from the sibling .btnUserRating rather than the tracked entry, in case syncRowButtons
    // hasn't run since the most recent item change.
    //
    // previousElementSibling assumes nothing gets inserted between .btnUserRating and our
    // button after ensureRowButton places it there - true today (verified: nothing else targets
    // this position). If that ever stops holding, the classList.contains('btnUserRating') guard
    // below turns the failure into a silent no-op (toggleDislike never called) rather than a
    // wrong write to whatever element happened to land there.
    var ratingBtn = rowBtn.previousElementSibling;
    var rowItemId =
      ratingBtn && ratingBtn.classList.contains('btnUserRating') ? ratingBtn.getAttribute('data-id') : null;
    if (!rowItemId) {
      return;
    }

    toggleDislike(rowItemId);
  }

  // Belt-and-braces against the server bug behind 1.7.0.0 (see CLAUDE.md /
  // DislikeController.GetDislikedBatch): a library tile (data-isfolder="true", e.g.
  // CollectionFolder/UserView) can never have a dislike state, so it's skipped here before any
  // network round trip rather than trusted to come back omitted from the batch response.
  //
  // data-isfolder="true" is the skip condition, not a data-mediatype="Video" allow-list - only
  // verified live on Movie cards, so a positive check could silently drop badges from other
  // video card types (episodes, etc.) that weren't checked. Skipping folders is the direction
  // that fails safe.
  function isFolderCard(card) {
    return card.getAttribute('data-isfolder') === 'true';
  }

  function processCards(cards) {
    cards.forEach(function (card) {
      if (isFolderCard(card)) {
        card.setAttribute(BADGE_ATTR, 'done');
        return;
      }

      card.setAttribute(BADGE_ATTR, 'pending');
      registerCard(card);
      var itemId = getItemId(card);
      if (itemId) {
        pendingIds.add(itemId);
      }
    });

    if (cards.length > 0) {
      scheduleFlush();
    }
  }

  function start() {
    injectStyles();
    hookAuthEvent();

    // Dislike badge/toggle/shortcut listeners only when that feature is on - the script is also
    // served for the file-size feature alone, in which case none of these should be wired.
    if (DISLIKES_ENABLED) {
      document.addEventListener('click', onActivate);
      document.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') {
          return;
        }

        if (findBadge(e.target)) {
          onActivate(e);
        }
      });
      document.addEventListener('keydown', handleDislikeShortcut);
    }

    var observer = new MutationObserver(function (mutations) {
      var newCards = [];
      var newRatingButtons = [];
      var sawAttributeChange = false;

      mutations.forEach(function (mutation) {
        if (mutation.type === 'attributes') {
          sawAttributeChange = true;
          return;
        }

        mutation.addedNodes.forEach(function (node) {
          if (DISLIKES_ENABLED) {
            newCards = newCards.concat(findNewCards(node));
            newRatingButtons = newRatingButtons.concat(findNewRatingButtons(node));
          }
        });
      });

      if (newCards.length > 0) {
        processCards(newCards);
        // Freshly rendered cards need their data-unrated set for the CSS net (a no-op unless the
        // Unrated filter is on and the rated set is cached).
        markUnratedCards();
      }

      newRatingButtons.forEach(ensureRowButton);

      // Also re-sync on a plain data-id attribute change, in case that does turn out to be how
      // the OSD reflects an item change (unverified either way - the ROW_SYNC_MS poll below is
      // the fallback that makes this correct regardless).
      if (DISLIKES_ENABLED && (newRatingButtons.length > 0 || sawAttributeChange)) {
        syncRowButtons();
      }

      // Unconditional, not scoped to this batch's addedNodes - see scanForFilterRows for why a
      // container-keyed scan isn't enough here (build order defeats it). Each self-gates on its
      // feature flag / on finding its anchor.
      scanForFilterRows();
      scanForSortRadios();

      // Cheap, and only while a filter is on: Jellyfin re-hides the funnel badge from its own
      // filter set on every grid query build (see syncFilterButtonBubble), and the re-render that
      // follows that fetch is exactly what puts us here.
      if (anyFilterActive()) {
        syncFilterButtonBubble();
      }

      // Same reasoning, and the same cost (one querySelectorAll plus a property check each):
      // both the grid's fetchData and window.ApiClient itself can be (re)assigned long after the
      // element or the page they belong to first appeared.
      patchGetItems();
      wrapItemsContainers();

      // Unconditional, not gated on the mutation batch containing anything in particular - the
      // page is rebuilt wholesale on SPA navigation (same rebuild that produces the newCards
      // above), and this call is cheap (two null checks) whenever there's nothing to do.
      handleRouteChange();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-id']
    });

    // Belt-and-braces alongside the MutationObserver above: fires immediately on navigation
    // (this build is hash-routed - see getCurrentLibraryId), so a filter left active on a
    // library page is cleared the instant the route changes, rather than waiting for the next
    // DOM mutation to be observed. handleRouteChange() itself is idempotent either way.
    window.addEventListener('hashchange', handleRouteChange);

    // Cards and rating-button rows already on the page before the observer attached (e.g. first
    // paint). ensureRowButton/trackRowButton arms the row-sync poll itself if any row is found;
    // nothing to arm here when there is none (e.g. landing on a page with neither surface). The
    // filter dialog is opened by a user click, never present at first paint, but scanForFilterRows
    // is cheap and correct to call anyway (a no-op when nothing matches).
    if (DISLIKES_ENABLED) {
      processCards(findNewCards(document.body));
      findNewRatingButtons(document.body).forEach(ensureRowButton);
      syncRowButtons();
    }
    scanForFilterRows();
    scanForSortRadios();
    patchGetItems();
    wrapItemsContainers();
  }

  if (document.body) {
    start();
  } else {
    document.addEventListener('DOMContentLoaded', start);
  }
})();
/* eslint-enable */
