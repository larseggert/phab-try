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

  /** Extract the assignee email from the Bugzilla DOM. */
  function getAssigneeEmail() {
    const candidates = [
      document.querySelector("#assigned_to_input"),
      document.querySelector("span[itemprop='assignee'] a.email"),
      document.querySelector(".assigned-to a"),
      document.querySelector("[data-field-name='assigned_to'] a"),
    ];
    for (const node of candidates) {
      if (!node) continue;
      const email = (node.value || node.textContent || "").trim();
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

  function findInsertionPoint() {
    return (
      document.querySelector("#comments") ||
      document.querySelector(".bz_comment_table") ||
      document.querySelector("#comment_table")
    );
  }

  function init() {
    const bugNumber = getBugNumber();
    if (!bugNumber) return;
    const author = getAssigneeEmail();
    initTryPanel(
      { bugNumber, ...(author ? { author } : {}) },
      findInsertionPoint,
    );
  }

  onDOMReady(init);
})();
