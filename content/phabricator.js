/**
 * Content script for phabricator.services.mozilla.com/D* pages.
 * Extracts D-number, bug-number, and revisionTitle from the DOM (per
 * DATA.md §"Phabricator D-page" Field sources) and delegates panel
 * lifecycle to panel-controller.js.
 */

(function () {
  "use strict";

  const getDNumber = () => window.location.pathname.match(/\/D(\d+)/)?.[1] ?? null;

  // bugNumber is canonically Phabricator's `Bug Id` field; the page renders
  // it as a bugzilla.../show_bug.cgi?id=N hyperlink and as a "Bug N" prefix
  // in the page title / header.
  function getBugNumber() {
    for (const src of [
      document.title,
      document.querySelector(".phui-header-header")?.textContent ?? "",
    ]) {
      const n = src.match(/\bBug\s+(\d+)/i)?.[1];
      if (n) return n;
    }
    const link = document.querySelector('a[href*="bugzilla.mozilla.org/show_bug.cgi?id="]');
    return link?.href.match(/show_bug\.cgi\?id=(\d+)/)?.[1] ?? null;
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
      document.querySelector(".phui-main-column > .phui-box") ??
      document.querySelector(".phui-two-column-content .phui-box")
    );
  }

  function init() {
    const dNumber = getDNumber();
    if (!dNumber) return;
    const revisionTitle = stripPhabSuffix(document.title);
    const bugNumber = getBugNumber();
    initTryPanel(
      { dNumber, ...(bugNumber && { bugNumber }), ...(revisionTitle && { revisionTitle }) },
      findInsertionPoint,
    );
  }

  onDOMReady(init);
})();
