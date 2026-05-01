/**
 * Content script for bugzilla.mozilla.org/show_bug.cgi?id=* pages.
 * Extracts bug metadata and per-D `creator` emails from the DOM (per
 * DATA.md §"Bugzilla bug page" Field sources) and delegates panel
 * lifecycle to panel-controller.js.
 */

(function () {
  "use strict";

  // PHAB_BASE / PHAB_ATTACHMENT_RE / phabRevUrl come from lib/pure.js.

  function getBugNumber() {
    const id = new URLSearchParams(window.location.search).get("id");
    if (id && /^\d+$/.test(id)) return id;
    return document.title.match(/\bBug\s+(\d+)\b/i)?.[1] ?? null;
  }

  // Each Phabricator attachment row carries:
  //  - the D-number (from the schema.org meta name)
  //  - the canonical `creator` email (from a[data-user-email] in the
  //    attachments table row — Bugzilla renders the actual email here,
  //    no domain assumption needed)
  function getPhabAttachments() {
    return [...document.querySelectorAll(".attachment[data-id]")].flatMap((el) => {
      const dNumber = el
        .querySelector('meta[itemprop="name"]')
        ?.content?.match(PHAB_ATTACHMENT_RE)?.[1];
      if (!dNumber) return [];
      const attachmentId = el.dataset.id;
      const row = document.querySelector(`#attachments tr[data-attachment-id="${attachmentId}"]`);
      const creator = row?.querySelector("a[data-user-email]")?.dataset?.userEmail ?? null;
      return [{ attachmentId, dNumber, creator }];
    });
  }

  function injectDBadges(attachments) {
    for (const { attachmentId, dNumber } of attachments) {
      const actions = document.querySelector(
        `#attachments tr[data-attachment-id="${attachmentId}"] .attach-actions`,
      );
      if (!actions || actions.querySelector(".pt-bz-d-link")) continue;
      actions.prepend(" | ", window.ptExtLink(phabRevUrl(dNumber), `D${dNumber}`, "pt-bz-d-link"));
    }
  }

  function findInsertionPoint() {
    return (
      document.querySelector("#top-actions") ??
      document.querySelector("#comment-actions") ??
      document.querySelector("#comments") ??
      document.querySelector(".bz_comment_table") ??
      document.querySelector("#comment_table")
    );
  }

  function init() {
    const bugNumber = getBugNumber();
    if (!bugNumber) return;

    const attachments = getPhabAttachments();
    injectDBadges(attachments);

    const dNums = attachments.map((a) => a.dNumber);
    const dCreators = Object.fromEntries(
      attachments.filter((a) => a.creator).map((a) => [a.dNumber, a.creator]),
    );

    const payload = {
      bugNumber,
      ...(dNums.length >= 2 ? { dNumbers: dNums } : dNums.length ? { dNumber: dNums[0] } : {}),
      ...(Object.keys(dCreators).length && { dCreators }),
    };
    initTryPanel(payload, findInsertionPoint, window.ptCreateBugzillaPanel);
  }

  onDOMReady(init);
})();
