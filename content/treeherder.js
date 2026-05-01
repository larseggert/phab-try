/**
 * Content script for treeherder.mozilla.org/jobs?repo=try&revision=* pages.
 * Injects Phabricator / Bugzilla back-links into each push header.
 *
 * Fetches are lazy: data is requested only when at least one push-header
 * (with an empty push-buttons child) actually appears in the DOM. URLs
 * matching the glob that don't render any push headers (deleted try push,
 * not-yet-rendered React state, etc.) trigger no network activity.
 */

(function () {
  "use strict";

  // PHAB_BASE / BUGZILLA_BASE / phabRevUrl / safely come from lib/pure.js.

  const params = new URLSearchParams(window.location.search);
  const revision = params.get("revision");
  if (!revision || params.get("repo") !== "try") return;

  // --- Fetch helpers ---

  async function fetchJson(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`${resp.status} ${url}`);
    return resp.json();
  }

  // Returns { title, status } for a D-revision (status from background's
  // Phab HTML scrape) or null on failure.
  const fetchDInfo = (dNum) =>
    safely(() => browser.runtime.sendMessage({ type: "getDTitle", dNum }));

  // Returns { title, status, resolution, isOpen, dupeOf } for a bug.
  const fetchBugInfo = async (bugNum) =>
    safely(async () => {
      const data = await fetchJson(
        `${BUGZILLA_BASE}/rest/bug/${bugNum}?include_fields=summary,status,resolution,is_open,dupe_of`,
      );
      const b = data.bugs?.[0];
      return b
        ? {
            title: b.summary,
            status: b.status,
            resolution: b.resolution,
            isOpen: b.is_open,
            dupeOf: b.dupe_of,
          }
        : null;
    });

  async function fetchInfos({ dNums, bugNums }) {
    const toMap = (nums, fn) =>
      Promise.all(nums.map(async (n) => [n, await fn(n)])).then((es) =>
        Object.fromEntries(es.filter(([, v]) => v)),
      );
    const [d, bug] = await Promise.all([toMap(dNums, fetchDInfo), toMap(bugNums, fetchBugInfo)]);
    return { d, bug };
  }

  // --- DOM injection ---

  // Shared inline-SVG builder lives in lib/icons.js. Treeherder ships no
  // FA font, so font-class icons don't render here — SVG bypasses that.
  const appendIcon = (node, name) => node.append(" ", window.ptIconSvg(name));

  // External-link helper lives in lib/icons.js as window.ptExtLink. The
  // wrapper here just adds the optional title attribute.
  function makeLink(href, text, title) {
    const a = window.ptExtLink(href, text, "pt-push-dlink");
    if (title) a.title = title;
    return a;
  }

  // Bug-info shape from Bugzilla REST uses `is_open`; the pure helpers
  // accept either that or the camelCase `isOpen` we use elsewhere — pass
  // the raw object directly.
  const bugInfoForHelpers = (info) =>
    info && {
      status: info.status,
      resolution: info.resolution,
      is_open: info.isOpen,
    };

  function dLinkEl(d, info) {
    const a = makeLink(phabRevUrl(d), `D${d}`, info?.title);
    if (dRevisionIsAbandoned(info?.status)) {
      a.classList.add("pt-push-dlink-abandoned", "pt-strike");
    } else if (dRevisionIsLanded(info?.status)) {
      a.classList.add("pt-push-dlink-landed");
      appendIcon(a, "plane-arrival");
    }
    return a;
  }

  function bugLinkEl(b, info) {
    const a = makeLink(`${BUGZILLA_BASE}/show_bug.cgi?id=${b}`, `Bug ${b}`, info?.title);
    const bug = bugInfoForHelpers(info);
    if (bugIsLanded(bug)) {
      a.classList.add("pt-push-dlink-landed");
      appendIcon(a, "plane-arrival");
    } else if (bugIsDuplicate(bug)) {
      a.classList.add("pt-push-dlink-abandoned", "pt-strike");
      if (info?.dupeOf) a.title = `${info.title ?? ""} → duplicate of Bug ${info.dupeOf}`.trim();
      appendIcon(a, "clone");
    } else if (bugIsClosedNoLand(bug)) {
      a.classList.add("pt-push-dlink-abandoned", "pt-strike");
    }
    return a;
  }

  function buildLinkBar({ dNums, bugNums }, { d: dInfos, bug: bugInfos }) {
    const bar = document.createElement("span");
    bar.dataset.ptLinks = "1";
    bar.append(
      ...dNums.map((d) => dLinkEl(d, dInfos[d])),
      ...bugNums.map((b) => bugLinkEl(b, bugInfos[b])),
    );
    return bar;
  }

  const PUSH_HEADER_SEL = ".push-header[data-testid='push-header']";

  // The set of `.push-buttons` elements that need a link bar prepended —
  // i.e. those whose parent header has no `[data-pt-links]` yet.
  const findTargets = () =>
    [...document.querySelectorAll(PUSH_HEADER_SEL)]
      .map((h) => h.querySelector(".push-buttons"))
      .filter((b) => b && !b.querySelector("[data-pt-links]"));

  // The data fetch is kicked off the first time at least one target exists,
  // and reused for every subsequent inject (React re-renders, new headers).
  let dataPromise = null;
  const ensureData = () =>
    (dataPromise ??= (async () => {
      const links = await safely(() =>
        browser.runtime.sendMessage({ type: "resolveLinks", revision }),
      );
      if (!links) return null;
      return { links, infos: await fetchInfos(links) };
    })());

  async function tryInject() {
    const targets = findTargets();
    if (!targets.length) return;
    const data = await ensureData();
    if (!data) return;
    for (const buttons of targets) {
      // Re-check inside the loop: another tryInject() invocation may have
      // raced ahead while we awaited ensureData().
      if (buttons.querySelector("[data-pt-links]")) continue;
      buttons.prepend(buildLinkBar(data.links, data.infos));
    }
  }

  tryInject();

  // Watch for headers added / re-rendered after page load. inject() is
  // idempotent (skips headers that already have [data-pt-links]), so it is
  // safe to call on every DOM mutation. Never disconnect — React can
  // recreate headers (e.g. selectedTaskRun opening the job-detail panel).
  let rafPending = false;
  const observer = new MutationObserver(() => {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      tryInject();
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });
})();
