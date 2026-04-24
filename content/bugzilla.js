/**
 * Content script for bugzilla.mozilla.org/show_bug.cgi?id=* pages.
 * Extracts bug metadata and delegates panel lifecycle to panel-controller.js.
 */

(function () {
  "use strict";

  const PHAB_BASE = window.ptPhabBase;

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

  // Finds all Phabricator revision attachments via comment-section schema.org metadata.
  // Works for all users (unlike #module-phabricator-revisions-content which requires login).
  function getPhabAttachments() {
    return [...document.querySelectorAll(".attachment[data-id]")].flatMap(el => {
      const m = el.querySelector('meta[itemprop="name"]')?.content
        ?.match(/^phabricator-D(\d+)-url\.txt$/);
      return m ? [{ attachmentId: el.dataset.id, dNumber: m[1] }] : [];
    });
  }

  // Injects a D-link badge into each Phabricator attachment row in the #attachments table.
  function injectDBadges(attachments) {
    for (const { attachmentId, dNumber } of attachments) {
      const actions = document.querySelector(
        `#attachments tr[data-attachment-id="${attachmentId}"] .attach-actions`
      );
      if (!actions || actions.querySelector(".pt-bz-d-link")) continue;
      actions.prepend(" | ", Object.assign(document.createElement("a"), {
        href: `${PHAB_BASE}/D${dNumber}`, textContent: `D${dNumber}`,
        target: "_blank", rel: "noopener noreferrer", className: "pt-bz-d-link",
      }));
    }
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

    const attachments = getPhabAttachments();
    injectDBadges(attachments);

    const dNums  = attachments.map(a => a.dNumber);
    const author = getAssigneeEmail();

    const payload = {
      bugNumber,
      ...(dNums.length >= 2 ? { dNumbers: dNums } : dNums.length ? { dNumber: dNums[0] } : {}),
      ...(author && { author }),
    };

    initTryPanel(payload, findInsertionPoint, window.ptCreateBugzillaPanel);
  }

  onDOMReady(init);
})();
