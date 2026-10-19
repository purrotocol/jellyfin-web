/* eslint-disable @stylistic/indent, @stylistic/operator-linebreak, no-var, @typescript-eslint/prefer-for-of */
// Ported verbatim from the jellyfin-custom server plugin's injected client script (the plugin
// served it into index.html at request time). Legacy ES5 style, deliberately NOT modernised:
// lint is disabled for the whole file rather than touching logic. Only edit: the server-substituted
// placeholders below are now literal constants. HTTP routes (Plugins/TrickplayStatus/...) are
// unchanged and resolved through window.ApiClient.getUrl, so the base path is handled by the client.
(function () {
  'use strict';

  var BADGE_ATTR = 'data-trickplay-badged';
  var DEBOUNCE_MS = 200;
  var MAX_WAIT_MS = 1000;
  var POLL_INTERVAL_MS = 7000;
  var BATCH_CHUNK_SIZE = 200;
  var RETRY_DELAY_MS = 3000;
  var MAX_RETRY_ATTEMPTS = 5;

  var ICONS = {
    Available: { icon: 'local_movies', className: 'trickplayIndicator-available' },
    Generating: { icon: 'autorenew', className: 'trickplayIndicator-generating' },
    Unavailable: { icon: 'image_not_supported', className: 'trickplayIndicator-unavailable' }
  };

  // itemId -> Set of card elements currently showing that item (the same item can appear in
  // multiple shelves/rows on one page, e.g. Continue Watching + a library grid).
  var cardsByItemId = new Map();
  var pendingIds = new Set();
  var generatingIds = new Set();
  var retryAttempts = new Map();
  var debounceTimer = null;
  var maxWaitTimer = null;
  var retryTimer = null;
  var pollTimer = null;

  function injectStyles() {
    var style = document.createElement('style');
    style.textContent =
      '.trickplayIndicator-generating .indicatorIcon { animation: trickplaySpin 1.5s linear infinite; }' +
      '@keyframes trickplaySpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }';
    document.head.appendChild(style);
  }

  function getItemId(card) {
    return card.getAttribute('data-id');
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
  // generatingIds/retryAttempts) would grow for the entire lifetime of the SPA session.
  function pruneDisconnectedCards() {
    cardsByItemId.forEach(function (cards, itemId) {
      cards.forEach(function (card) {
        if (!card.isConnected) {
          cards.delete(card);
        }
      });

      if (cards.size === 0) {
        cardsByItemId.delete(itemId);
        generatingIds.delete(itemId);
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
    if (!window.ApiClient || typeof window.ApiClient.ajax !== 'function') {
      return;
    }

    window.ApiClient.ajax({
      type: 'POST',
      url: window.ApiClient.getUrl('Plugins/TrickplayStatus/Batch'),
      data: JSON.stringify({ itemIds: itemIds }),
      contentType: 'application/json',
      dataType: 'json'
    }).then(
      function (statusesById) {
        applyStatuses(statusesById);

        // Ids the server didn't recognize (e.g. added after the last reconciliation pass) get
        // no entry in the response at all - retry them too, rather than leaving them badge-less
        // until the user reloads the page.
        var missing = itemIds.filter(function (id) {
          return !Object.prototype.hasOwnProperty.call(statusesById, id);
        });
        if (missing.length > 0) {
          scheduleRetry(missing);
        }
      },
      function () {
        // Network error or non-2xx response.
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

  function applyStatuses(statusesById) {
    Object.keys(statusesById).forEach(function (itemId) {
      var status = statusesById[itemId];
      retryAttempts.delete(itemId);
      applyStatusToCards(itemId, status);

      if (status === 'Generating') {
        generatingIds.add(itemId);
      } else {
        generatingIds.delete(itemId);
      }
    });

    ensurePolling();
  }

  function applyStatusToCards(itemId, status) {
    var cards = cardsByItemId.get(itemId);
    if (!cards) {
      return;
    }

    cards.forEach(function (card) {
      renderBadge(card, status);
    });
  }

  function renderBadge(card, status) {
    if (!card.isConnected) {
      // Virtualized grid scrolled the card out and dropped it; stop tracking it.
      var itemId = getItemId(card);
      var set = itemId ? cardsByItemId.get(itemId) : null;
      if (set) {
        set.delete(card);
      }

      return;
    }

    var indicators = card.querySelector('.cardIndicators');
    if (!indicators) {
      // Jellyfin only renders the .cardIndicators wrapper when a card already has at least one
      // indicator (played/progress/etc). Cards with none need it created from scratch.
      var container = card.querySelector('.cardImageContainer') || card;
      indicators = document.createElement('div');
      indicators.className = 'cardIndicators';
      container.appendChild(indicators);
    }

    var iconInfo = ICONS[status] || ICONS.Unavailable;
    var badge = indicators.querySelector('.trickplayStatusIndicator');
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'indicator trickplayStatusIndicator';
      var span = document.createElement('span');
      span.className = 'material-icons indicatorIcon';
      span.setAttribute('aria-hidden', 'true');
      badge.appendChild(span);
      indicators.appendChild(badge);
    }

    badge.className = 'indicator trickplayStatusIndicator ' + iconInfo.className;
    var iconSpan = badge.firstChild;
    iconSpan.textContent = iconInfo.icon;

    card.setAttribute(BADGE_ATTR, 'done');
  }

  function processCards(cards) {
    cards.forEach(function (card) {
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

  function ensurePolling() {
    if (generatingIds.size === 0) {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }

      return;
    }

    if (!pollTimer) {
      pollTimer = setInterval(function () {
        pruneDisconnectedCards();

        if (generatingIds.size === 0) {
          clearInterval(pollTimer);
          pollTimer = null;
          return;
        }

        sendBatched(Array.from(generatingIds));
      }, POLL_INTERVAL_MS);
    }
  }

  function start() {
    injectStyles();

    var observer = new MutationObserver(function (mutations) {
      var newCards = [];
      mutations.forEach(function (mutation) {
        mutation.addedNodes.forEach(function (node) {
          newCards = newCards.concat(findNewCards(node));
        });
      });

      if (newCards.length > 0) {
        processCards(newCards);
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    // Cards already on the page before the observer attached (e.g. first paint).
    processCards(findNewCards(document.body));
  }

  if (document.body) {
    start();
  } else {
    document.addEventListener('DOMContentLoaded', start);
  }
})();
/* eslint-enable */
