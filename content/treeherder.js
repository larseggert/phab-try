/**
 * Content script for treeherder.mozilla.org/jobs?repo=try&revision=* pages.
 * Injects Phabricator / Bugzilla back-links into the push header.
 */

(async function () {
  "use strict";

  const PHAB_BASE     = "https://phabricator.services.mozilla.com";
  const BUGZILLA_BASE = "https://bugzilla.mozilla.org";

  const params   = new URLSearchParams(window.location.search);
  const revision = params.get("revision");
  if (!revision || params.get("repo") !== "try") return;

  // --- Fetch helpers ---

  async function fetchJson(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`${resp.status} ${url}`);
    return resp.json();
  }

  const safely = async fn => { try { return await fn(); } catch (_e) { return null; } };

  const fetchDTitle  = dNum   => safely(() =>
    browser.runtime.sendMessage({ type: "getDTitle", dNum }).then(r => r?.title));

  const fetchBugTitle = bugNum => safely(async () =>
    (await fetchJson(`${BUGZILLA_BASE}/rest/bug/${bugNum}?include_fields=summary`)).bugs?.[0]?.summary);

  async function fetchTitles({ dNums, bugNums }) {
    const toMap = (nums, fn) =>
      Promise.all(nums.map(async n => [n, await fn(n)]))
        .then(es => Object.fromEntries(es.filter(([, v]) => v)));
    const [d, bug] = await Promise.all([
      toMap(dNums,   fetchDTitle),
      toMap(bugNums, fetchBugTitle),
    ]);
    return { d, bug };
  }

  // --- DOM injection ---

  function makeLink(href, text, title) {
    return Object.assign(document.createElement("a"), {
      href, textContent: text, target: "_blank",
      rel: "noopener noreferrer", className: "btn btn-outline-secondary btn-sm",
      ...(title && { title }),
    });
  }

  function buildLinkBar({ dNums, bugNums }, { d: dTitles, bug: bugTitles }) {
    const bar = document.createElement("span");
    bar.setAttribute("data-pt-links", "1");
    bar.append(
      ...dNums.map(d   => makeLink(`${PHAB_BASE}/D${d}`, `D${d}`, dTitles[d])),
      ...bugNums.map(b => makeLink(`${BUGZILLA_BASE}/show_bug.cgi?id=${b}`, `Bug ${b}`, bugTitles[b])),
    );
    return bar;
  }

  const PUSH_HEADER_SEL = ".push-header[data-testid='push-header']";

  function tryInject(links, titles) {
    for (const header of document.querySelectorAll(PUSH_HEADER_SEL)) {
      const buttons = header.querySelector(".push-buttons");
      if (!buttons || buttons.querySelector("[data-pt-links]")) continue;
      buttons.prepend(buildLinkBar(links, titles));
    }
  }

  function allInjected() {
    const headers = document.querySelectorAll(PUSH_HEADER_SEL);
    return headers.length > 0 &&
      [...headers].every(h => h.querySelector(".push-buttons [data-pt-links]"));
  }

  // --- Main ---

  const links = await safely(() => browser.runtime.sendMessage({ type: "resolveLinks", revision }));
  if (!links) return;

  const titles = await fetchTitles(links);

  if (!allInjected()) {
    const inject = () => tryInject(links, titles);
    inject();

    // Watch for headers rendered after page load (React SPA).
    // Debounce via rAF so rapid React DOM batches collapse into one inject() call.
    // Disconnect once every visible push header has been processed.
    let rafPending = false;
    const observer = new MutationObserver(() => {
      if (!rafPending) {
        rafPending = true;
        requestAnimationFrame(() => {
          rafPending = false;
          inject();
          if (allInjected()) observer.disconnect();
        });
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

})().catch(_e => { /* silent — don't break the Treeherder page */ });
