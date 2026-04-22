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

  /**
   * Extract the revision author's Phabricator username and return
   * "username@mozilla.com" as a hint for the Treeherder author query.
   *
   * Phabricator renders "(authored by <a href='/p/username/'>…)" in the
   * timeline — we walk up from each /p/ link checking ancestors for the
   * word "author". The background script also auto-discovers the real email
   * from Treeherder push.author data, so this is just an optimisation for
   * pushes older than the 200-push broad-search window.
   */
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

  /**
   * Return the Details phui-box so the panel is inserted before it,
   * making it the first panel on the page.
   */
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
