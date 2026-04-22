// initTryPanel(payload, findAnchor) — shared by phabricator.js and bugzilla.js
// onDOMReady(fn)                    — DOMContentLoaded guard, also shared
/* exported onDOMReady, initTryPanel */
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

  function reload() {
    if (stopRefresh) { stopRefresh(); stopRefresh = null; }
    ctrl.setLoading(LOADING_MSG);
    load(true);
  }

  const ctrl = window.ptCreatePanel(reload);
  ctrl.setLoading(LOADING_MSG);

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
