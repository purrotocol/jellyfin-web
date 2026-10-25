/* eslint-disable @stylistic/indent, no-var, @typescript-eslint/prefer-for-of */
// Ported from the jellyfin-custom plugin's Web/delete-skip.js; legacy ES5 style, lint disabled for the file.
(function () {
  'use strict';

  // Ctrl+D during video playback: delete the playing item, then skip to the next one.
  // Self-contained (own toast/helpers) so it works without dislike.js. Needs a second press
  // within CONFIRM_WINDOW_MS - deletion removes the file from disk and cannot be undone.
  var CONFIRM_WINDOW_MS = 4000;
  // Deleting the file of a video that is still streaming fails on SMB mounts ("Directory not
  // empty": the open stream pins the file/folder) and makes the old session's Stopped report hit
  // a foreign key error. So playback moves on first, and the delete follows after this delay.
  var DELETE_DELAY_MS = 2000;
  var DELETE_RETRY_MS = 3000;

  var pendingId = null;
  var pendingName = '';
  var pendingTimer = null;
  var inFlight = false;

  function showToast(message) {
    var container = document.querySelector('.deleteSkipToastContainer');
    if (!container) {
      container = document.createElement('div');
      container.className = 'deleteSkipToastContainer';
      container.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:10000;display:flex;flex-direction:column;align-items:center;gap:8px;pointer-events:none;';
      document.body.appendChild(container);
    }

    var toast = document.createElement('div');
    toast.style.cssText = 'background:rgba(20,20,20,0.92);color:#fff;padding:10px 16px;border-radius:4px;font-size:14px;box-shadow:0 2px 8px rgba(0,0,0,0.4);opacity:1;transition:opacity 0.3s ease;';
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(function () {
      toast.style.opacity = '0';
      setTimeout(function () {
        if (toast.parentNode) {
          toast.parentNode.removeChild(toast);
        }
      }, 300);
    }, 3000);
  }

  function isEditableElement(el) {
    if (!el) {
      return false;
    }

    var tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!el.isContentEditable;
  }

  function isTypingContext(e) {
    if (isEditableElement(e.target) || isEditableElement(document.activeElement)) {
      return true;
    }

    var active = document.activeElement;
    return !!(active && typeof active.closest === 'function' && active.closest('dialog, [role="dialog"], [aria-modal="true"]'));
  }

  // A loaded, unended <video> - .videoOsdBottom alone persists after playback with a stale id.
  function findActiveVideo() {
    var videos = document.querySelectorAll('video');
    for (var i = 0; i < videos.length; i++) {
      var video = videos[i];
      if (video.isConnected && !video.ended && video.duration && !isNaN(video.duration) && video.readyState >= 2) {
        return video;
      }
    }

    return null;
  }

  // Re-read on every press: the OSD's item changes under a mounted OSD on queue advance.
  function currentOsdItemId() {
    var ratingBtn = document.querySelector('.videoOsdBottom .btnUserRating');
    return ratingBtn ? ratingBtn.getAttribute('data-id') : null;
  }

  // No size/visibility check on purpose: the auto-hidden OSD measures 0x0 but its button is
  // still clickable. `.hide` is the reliable "nothing to advance to" signal (see dislike.js).
  function findActionableNextTrackButton() {
    var buttons = document.querySelectorAll('.btnNextTrack');
    for (var i = 0; i < buttons.length; i++) {
      var btn = buttons[i];
      if (btn.isConnected && !btn.classList.contains('hide') && !btn.disabled) {
        return btn;
      }
    }

    return null;
  }

  function clearPending() {
    pendingId = null;
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
  }

  function describeError(err) {
    return err && err.status ? ' (HTTP ' + err.status + ')' : '';
  }

  function deleteAfterPlaybackMoved(itemId, name, attemptsLeft) {
    window.ApiClient.deleteItem(itemId).then(function () {
      inFlight = false;
      showToast('Deleted "' + name + '".');
    }, function (err) {
      // A 500 can still have removed the item (the folder cleanup is what failed), so a 404 on
      // the retry means it is gone.
      if (err && err.status === 404) {
        inFlight = false;
        showToast('Deleted "' + name + '".');
        return;
      }

      if (attemptsLeft > 0) {
        setTimeout(function () {
          deleteAfterPlaybackMoved(itemId, name, attemptsLeft - 1);
        }, DELETE_RETRY_MS);
        return;
      }

      inFlight = false;
      showToast('Could not delete "' + name + '"' + describeError(err) + '.');
    });
  }

  function deleteAndSkip(itemId, name) {
    inFlight = true;
    clearPending();

    // Leave the old stream first (skip, or back out of the player at the end of the queue).
    var nextBtn = findActionableNextTrackButton();
    if (nextBtn) {
      nextBtn.click();
    } else {
      window.history.back();
    }

    setTimeout(function () {
      deleteAfterPlaybackMoved(itemId, name, 1);
    }, DELETE_DELAY_MS);
  }

  function handleShortcut(e) {
    // Exact chord, matched on e.code so it sits on the same physical key on any layout.
    if (e.repeat || !e.ctrlKey || e.shiftKey || e.altKey || e.metaKey || e.code !== 'KeyD') {
      return;
    }

    if (inFlight || isTypingContext(e) || !findActiveVideo() || !window.ApiClient) {
      return;
    }

    var itemId = currentOsdItemId();
    if (!itemId) {
      return;
    }

    e.preventDefault();

    if (pendingId === itemId) {
      deleteAndSkip(itemId, pendingName);
      return;
    }

    var userId = window.ApiClient.getCurrentUserId();
    window.ApiClient.getItem(userId, itemId).then(function (item) {
      if (item.CanDelete === false) {
        showToast('You do not have permission to delete "' + item.Name + '".');
        return;
      }

      arm(itemId, item.Name);
    }, function () {
      // Lookup is only for the name and an early permission check; the server enforces
      // permission on delete, so don't block the shortcut on it.
      arm(itemId, 'this video');
    });
  }

  function arm(itemId, name) {
    // The video may have advanced while the lookup was in flight; arm only if it hasn't.
    if (currentOsdItemId() !== itemId) {
      return;
    }

    clearPending();
    pendingId = itemId;
    pendingName = name;
    pendingTimer = setTimeout(clearPending, CONFIRM_WINDOW_MS);
    showToast('Press Ctrl+D again to delete "' + name + '".');
  }

  document.addEventListener('keydown', handleShortcut);
})();
/* eslint-enable */
