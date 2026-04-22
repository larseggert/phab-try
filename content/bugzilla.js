/**
 * Content script for bugzilla.mozilla.org/show_bug.cgi?id=* pages.
 * Extracts bug metadata and delegates panel lifecycle to panel-controller.js.
 */

(function () {
  "use strict";

  function getBugNumber() {
    const id = new URLSearchParams(window.location.search).get("id");
    if (id && /^\d+$/.test(id)) return id;
    const m = document.title.match(/\bBug\s+(\d+)\b/i);
    return m ? m[1] : null;
  }

  function getAssigneeEmail() {
    const candidates = [
      document.querySelector("#field-assigned_to a[data-user-email]"), // BMO modal UI
      document.querySelector("#assigned_to_input"),
      document.querySelector("span[itemprop='assignee'] a.email"),
      document.querySelector(".assigned-to a"),
      document.querySelector("[data-field-name='assigned_to'] a"),
    ];
    for (const node of candidates) {
      if (!node) continue;
      const email = (node.dataset?.userEmail || node.value || node.textContent || "").trim();
      if (email.includes("@")) return email;
    }
    for (const label of document.querySelectorAll(".field-label, th, .field_name")) {
      if (!/Assigned/i.test(label.textContent)) continue;
      const sib = label.nextElementSibling
               ?? label.closest("tr")?.querySelector("td:not(.field-label)");
      if (!sib) continue;
      const a = sib.querySelector("a[href*='mailto:']");
      if (a) {
        const m = a.href.match(/mailto:([^?]+)/);
        if (m) return decodeURIComponent(m[1]);
      }
      const text = sib.textContent.trim();
      if (text.includes("@")) return text;
    }
    return null;
  }

  // If the bug has a linked Phabricator revision, use its D-number for the
  // try-push search — more reliable than bug-number text matching.
  function getLinkedDNumber() {
    const link = document.querySelector(
      '#module-phabricator-revisions-content a[href*="phabricator.services.mozilla.com/D"]'
    );
    if (!link) return null;
    const m = link.href.match(/\/D(\d+)\b/);
    return m ? m[1] : null;
  }

  function findInsertionPoint() {
    return (
      document.querySelector("#top-actions") ||        // BMO modal UI — after all module sections
      document.querySelector("#comment-actions") ||
      document.querySelector("#comments") ||
      document.querySelector(".bz_comment_table") ||
      document.querySelector("#comment_table")
    );
  }

  function init() {
    const bugNumber = getBugNumber();
    if (!bugNumber) return;
    const dNumber = getLinkedDNumber();
    const author  = getAssigneeEmail();
    initTryPanel(
      { bugNumber, ...(dNumber && { dNumber }), ...(author && { author }) },
      findInsertionPoint,
      window.ptCreateBugzillaPanel,
    );
  }

  onDOMReady(init);
})();
