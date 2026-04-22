/**
 * Content script for phabricator.services.mozilla.com/D* pages.
 * Extracts revision metadata and delegates panel lifecycle to panel-controller.js.
 */

(function () {
  "use strict";

  function getDNumber() {
    const m = window.location.pathname.match(/\/D(\d+)/);
    return m ? m[1] : null;
  }

  function getBugNumber() {
    for (const src of [document.title,
                       document.querySelector(".phui-header-header")?.textContent ?? ""]) {
      const m = src.match(/\bBug\s+(\d+)/i);
      if (m) return m[1];
    }
    return null;
  }

  // Returns username@mozilla.com as a search hint; background auto-discovers
  // the real email from Treeherder, so this only speeds up deep-history lookups.
  function getAuthorHint() {
    for (const link of document.querySelectorAll("a[href^='/p/']")) {
      const m = link.getAttribute("href").match(/^\/p\/([^/]+)\//);
      if (!m) continue;
      let node = link.parentElement;
      for (let depth = 0; depth < 4 && node && node !== document.body; depth++) {
        if (node.textContent.length < 400 && /\bauthor/i.test(node.textContent)) {
          return `${m[1]}@mozilla.com`;
        }
        node = node.parentElement;
      }
    }
    return null;
  }

  function findInsertionPoint() {
    for (const key of document.querySelectorAll(".phui-property-list-key")) {
      if (!/\bAuthor\b/i.test(key.textContent)) continue;
      let node = key;
      while (node && node !== document.body) {
        if (node.classList.contains("phui-box")) return node;
        node = node.parentElement;
      }
    }
    return (
      document.querySelector(".phui-main-column > .phui-box") ||
      document.querySelector(".phui-two-column-content .phui-box")
    );
  }

  function init() {
    const dNumber = getDNumber();
    if (!dNumber) return;
    const author = getAuthorHint();
    initTryPanel(
      { dNumber, bugNumber: getBugNumber(), ...(author ? { author } : {}) },
      findInsertionPoint,
    );
  }

  onDOMReady(init);
})();
