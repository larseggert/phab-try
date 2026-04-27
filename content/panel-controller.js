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

function initTryPanel(payload, findAnchor, panelFactory = window.ptCreatePanel) {
  if (document.querySelector("[data-pt-panel]")) return;  // already injected
  const LOADING_MSG = "Searching try pushes\u2026";

  function fetchPushes(pl, force = false) {
    return new Promise((resolve, reject) => {
      const port = browser.runtime.connect({ name: "getTryPushes" });
      port.postMessage({ ...pl, force });
      port.onMessage.addListener(({ type, pushes, message, done, total }) => {
        if (type === "progress") ctrl.setLoading(message, done, total);
        else if (type === "result") { resolve(pushes ?? []); port.disconnect(); }
        else if (type === "error")  { reject(new Error(message)); port.disconnect(); }
      });
      port.onDisconnect.addListener(() =>
        reject(new Error(browser.runtime.lastError?.message ?? "Connection lost")));
    });
  }

  let stopRefresh = null;
  let generation  = 0;

  function reload() {
    stopRefresh?.();
    stopRefresh = null;
    generation++;
    ctrl.setLoading(LOADING_MSG);
    load(true);
  }

  const ctrl = panelFactory(reload);
  ctrl.setLoading(LOADING_MSG);

  const anchor = findAnchor();
  if (anchor?.parentNode) {
    anchor.parentNode.insertBefore(ctrl.el, anchor);
  } else {
    document.body.prepend(ctrl.el);
  }

  async function load(force = false) {
    const myGen = generation;
    try {
      const pushes = await fetchPushes(payload, force);
      if (myGen !== generation) return;  // superseded by a later reload()
      ctrl.setPushes(pushes);
      if (pushes.some(window.ptIsRunning) && !stopRefresh) {
        stopRefresh = window.ptStartAutoRefresh(ctrl.el, payload, fetchPushes);
      }
    } catch (err) {
      if (myGen !== generation) return;
      ctrl.setError(`Failed to fetch try push data. (${err.message})`);
      console.error("[phab-try]", err);
    }
  }

  load();
}
