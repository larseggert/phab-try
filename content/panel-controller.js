/**
 * Shared panel lifecycle for phab-try content scripts.
 *
 * initTryPanel(payload, findAnchor)
 *   payload    – getTryPushes message object { dNumber, bugNumber, author? }
 *   findAnchor – function() → Element|null  (panel is inserted before this element)
 *
 * onDOMReady(fn) – calls fn now or after DOMContentLoaded; used by both
 *   content scripts to avoid duplicating the readyState guard.
 */
"use strict";

function onDOMReady(fn) {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", fn);
  } else {
    fn();
  }
}

function initTryPanel(payload, findAnchor) {
  const LOADING_MSG = "Searching last 500 try pushes\u2026";

  async function fetchPushes(pl, force = false) {
    const resp = await browser.runtime.sendMessage({ type: "getTryPushes", ...pl, force });
    return resp?.pushes || [];
  }

  let stopRefresh = null;
  let ctrl;

  function reload() {
    if (stopRefresh) { stopRefresh(); stopRefresh = null; }
    ctrl.setLoading(LOADING_MSG);
    load(true);
  }

  ctrl = window.ptCreatePanel(reload);
  ctrl.setLoading(LOADING_MSG);

  // Insert before the anchor (e.g. the Details box on Phabricator, the
  // comments section on Bugzilla), or prepend to body as a fallback.
  const anchor = findAnchor();
  if (anchor?.parentNode) {
    anchor.parentNode.insertBefore(ctrl.el, anchor);
  } else {
    document.body.prepend(ctrl.el);
  }

  async function load(force = false) {
    try {
      const pushes = await fetchPushes(payload, force);
      ctrl.setPushes(pushes);
      if (pushes.some(window.ptIsRunning) && !stopRefresh) {
        stopRefresh = window.ptStartAutoRefresh(ctrl.el, payload, fetchPushes);
      }
    } catch (err) {
      ctrl.setError(`Failed to fetch try push data. (${err.message})`);
      console.error("[phab-try]", err);
    }
  }

  load();
}
