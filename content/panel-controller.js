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
  if (document.querySelector("[data-pt-panel]")) return;

  // Bail before any setup if the page lacks the expected anchor — e.g. a
  // Bugzilla "Access Denied" / private-bug page or any URL that matches the
  // content-script glob but isn't actually a bug/D page. Fetching and
  // mounting a panel on these pages would be misleading.
  const anchor = findAnchor();
  if (!anchor?.parentNode) return;

  const LOADING_MSG = "Searching pushes\u2026";

  // The background search emits its result progressively: once for the
  // fast direct-match phase, again once the slow hg-edge mach-try-auto
  // walks resolve. The first emit resolves fetchPushes (so the panel
  // renders early); subsequent emits update the panel directly via ctrl.
  // The "complete" message disconnects the port.
  //
  // `silent` mode is used by the auto-refresh timer: it suppresses all
  // progress UI (no setLoading flash, no setStatus indicator) so a tick
  // either updates the rendered rows in place when results arrive, or
  // leaves them unchanged. The initial panel load and manual Reload both
  // run silent=false so the user sees the progress bar.
  function fetchPushes(pl, force = false, silent = false) {
    return new Promise((resolve, reject) => {
      const port = browser.runtime.connect({ name: "getPushes" });
      port.postMessage({ ...pl, force });
      let firstResolved = false;
      port.onMessage.addListener(({ type, pushes, errors, dInfos, message, done, total }) => {
        if (type === "progress") {
          if (silent) return;
          // Only update the loading state until first results render. After
          // that, progress messages from the slow walk phase would blow
          // away the rendered rows; route them to a non-destructive status
          // line instead.
          if (!firstResolved) ctrl.setLoading(message, done, total);
          else ctrl.setStatus?.(message, done, total);
        } else if (type === "result") {
          const payload = { pushes: pushes ?? [], errors: errors ?? [], dInfos: dInfos ?? {} };
          if (!firstResolved) {
            firstResolved = true;
            resolve(payload);
          } else {
            // Subsequent emit (post-walk): apply directly to the panel.
            window.ptApplyResult(ctrl, payload);
            if (!silent) ctrl.setStatus?.(null);
          }
        } else if (type === "complete") {
          if (!silent) ctrl.setStatus?.(null);
          port.disconnect();
        } else if (type === "error") {
          if (!firstResolved) reject(new Error(message));
          port.disconnect();
        }
      });
      port.onDisconnect.addListener(() => {
        if (!firstResolved)
          reject(new Error(browser.runtime.lastError?.message ?? "Connection lost"));
      });
    });
  }

  let stopRefresh = null;
  let generation = 0;

  function reload() {
    stopRefresh?.();
    stopRefresh = null;
    generation++;
    ctrl.setLoading(LOADING_MSG);
    load(true);
  }

  const ctrl = panelFactory(reload);
  ctrl.setLoading(LOADING_MSG);
  anchor.parentNode.insertBefore(ctrl.el, anchor);

  async function load(force = false) {
    const myGen = generation;
    try {
      const result = await fetchPushes(payload, force);
      if (myGen !== generation) return; // superseded by a later reload()
      window.ptApplyResult(ctrl, result);
      if (result.pushes.some(window.ptIsRunning) && !stopRefresh) {
        stopRefresh = window.ptStartAutoRefresh(ctrl.el, payload, fetchPushes);
      }
    } catch (err) {
      if (myGen !== generation) return;
      ctrl.setError(`Failed to fetch push data. (${err.message})`);
      console.error("[phab-try]", err);
    }
  }

  load();
}
