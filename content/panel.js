/**
 * Shared panel UI for phab-try.
 *
 * Mirrors the exact HTML structure of the "Details" box on Phabricator
 * differential pages so all visual styling is inherited automatically.
 *
 * Globals exported: ptCreatePanel, ptStartAutoRefresh, ptIsRunning
 */

(function () {
  "use strict";

  // --- DOM helpers ---

  /** Concise element factory. */
  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls)  node.className   = cls;
    if (text) node.textContent = text;
    return node;
  }

  /** Append children to parent and return parent. */
  function nest(parent, ...children) {
    children.forEach(c => parent.appendChild(c));
    return parent;
  }

  /**
   * Decorative FontAwesome icon span using Phabricator's classes.
   * `visual-only` follows the same pattern Phabricator uses throughout its UI;
   * `aria-hidden="true"` hides it from screen readers (surrounding text provides
   * the accessible label).
   */
  function faIcon(faClass) {
    const icon = el("span", `visual-only phui-icon-view phui-font-fa ${faClass}`);
    icon.setAttribute("aria-hidden", "true");
    return icon;
  }

  // --- Data helpers ---

  /**
   * Build a timestamp element matching Phabricator's screen-only / print-only
   * pattern from the timeline:
   *   <span class="screen-only">Tue, Apr 14, 12:12</span>
   *   <span class="print-only" aria-hidden="true">2026-04-14 12:12:17 (UTC+3)</span>
   */
  function buildTimestamp(epochSecs) {
    const d = new Date(epochSecs * 1000);

    const screen = el("span", "screen-only");
    screen.textContent = d.toLocaleString(undefined, {
      weekday: "short", month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit", hour12: false,
    });

    const pad = n => String(n).padStart(2, "0");
    const off  = -d.getTimezoneOffset();
    const offH = Math.floor(Math.abs(off) / 60);
    const offM = Math.abs(off) % 60;
    const tz   = `UTC${off >= 0 ? "+" : "-"}${offH}${offM ? `:${pad(offM)}` : ""}`;
    const iso = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ` +
                `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} (${tz})`;

    const print = el("span", "print-only", iso);
    print.setAttribute("aria-hidden", "true");

    const frag = document.createDocumentFragment();
    frag.appendChild(screen);
    frag.appendChild(print);
    return frag;
  }

  function shortRev(r) { return r ? r.slice(0, 8) : "?"; }

  function statusSummary(health) {
    if (!health?.status) return null;
    const s = health.status;
    const total = (s.completed || 0) + (s.pending || 0) + (s.running || 0);
    const parts = [];
    if (total)        parts.push(`${s.completed || 0}/${total} completed`);
    if (s.testfailed) parts.push(`${s.testfailed} failed`);
    if (s.busted)     parts.push(`${s.busted} busted`);
    if (s.exception)  parts.push(`${s.exception} exception`);
    if (s.running)    parts.push(`${s.running} running`);
    if (s.pending)    parts.push(`${s.pending} pending`);
    return parts.join(", ") || null;
  }

  function isRunning(push) {
    const s = push.health?.status;
    return s && (s.pending || 0) + (s.running || 0) > 0;
  }

  /** Panel title including count, e.g. "Try Pushes (5)" or "Try Pushes (0)". */
  function titleFor(pushes) {
    return `Try Pushes (${pushes.length})`;
  }

  function clearEl(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  // --- Status badge ---

  // Confirmed from the live Phabricator page HTML:
  //   tagCls  — e.g. "phui-tag-green"  (background tint, NOT "phui-tag-shade-green")
  //   iconCls — e.g. "green"           (FA icon colour class, same pattern as fa-check green
  //                                     and fa-headphones red in the Similar-revisions tab)
  const RESULT_STYLE = {
    pass:    { fa: "fa-check-circle",  tagCls: "phui-tag-green",  iconCls: "green"  },
    fail:    { fa: "fa-times-circle",  tagCls: "phui-tag-red",    iconCls: "red"    },
    running: { fa: "fa-refresh",       tagCls: "phui-tag-yellow", iconCls: "orange" },
    pending: { fa: "fa-circle-o",      tagCls: "phui-tag-grey",   iconCls: "grey"   },
  };

  // The three Treeherder metric keys and their display labels, in column order.
  const METRICS = [["Builds", "builds"], ["Lint", "linting"], ["Tests", "tests"]];

  function createBadge(label, result) {
    // Empty slot keeps column alignment even when the metric has no data.
    const badge = el("span", "pt-push-badge");
    if (!result || result === "none") return badge;
    const style = RESULT_STYLE[result.toLowerCase()] || RESULT_STYLE.pending;
    // Native Phabricator tag structure (confirmed from page HTML):
    //   phui-tag-view phui-tag-type-shade phui-tag-{color} phui-tag-shade
    //   phui-tag-slim (compact) + phui-tag-icon-view (has an icon)
    badge.className = `pt-push-badge phui-tag-view phui-tag-type-shade ${style.tagCls} phui-tag-shade phui-tag-slim phui-tag-icon-view`;
    const core = el("span", "phui-tag-core phui-tag-name");
    core.appendChild(faIcon(`${style.fa} ${style.iconCls}`));
    core.appendChild(document.createTextNode("\u00a0" + label));
    badge.appendChild(core);
    return badge;
  }

  // --- Push row ---
  // Timestamp and hash are in the SAME flex container so they align
  // automatically — no float/float-adjacent positioning issues.

  function buildPushRow(push) {
    const item = el("div", "pt-push-item");
    item.dataset.revision = push.revision;

    const timeSpan = el("span", "pt-push-time phui-property-list-key greytext");
    timeSpan.appendChild(buildTimestamp(push.push_timestamp));

    const hashLink = el("a", null, shortRev(push.revision));
    hashLink.href   = push.treeherder_url;
    hashLink.target = "_blank";
    hashLink.rel    = "noopener noreferrer";
    const hashWrap = nest(el("span", "pt-push-hash"), hashLink);

    // Detect decision-task failure: all metrics "none" but busted/exception jobs present.
    const m = push.health?.metrics ?? {};
    const s = push.health?.status;
    const allNone = METRICS.every(([, key]) => !m[key]?.result || m[key].result === "none");
    const hasFailed = allNone && s &&
      ((s.busted || 0) + (s.exception || 0) + (s.testfailed || 0)) > 0;

    // Single flex row: [timestamp] [hash] [Builds] [Lint] [Tests]
    const row = nest(el("div", "pt-push-row"), timeSpan, hashWrap,
      ...METRICS.map(([label, key]) =>
        createBadge(label, hasFailed && key === "builds" ? "fail" : m[key]?.result)));
    item.appendChild(row);

    const summary = statusSummary(push.health);
    if (summary) item.appendChild(el("div", "pt-push-note greytext", summary));

    return item;
  }

  // --- Panel shell ---

  function buildShell(onReload) {
    const panel = el("div",
      "phui-box phui-box-border phui-object-box mlt mll mlr phui-box-blue-property pt-try-panel");

    // Header — identical structure to Phabricator's "Details" box
    const titleText = el("span", "pt-panel-title-text", "Try Pushes");

    const reloadLink = el("a", "phui-header-action-link");
    reloadLink.href = "#";
    reloadLink.addEventListener("click", e => { e.preventDefault(); onReload(); });
    nest(reloadLink, faIcon("fa-refresh"), document.createTextNode(" Reload"));

    panel.appendChild(
      nest(el("div", "phui-header-shell"),
        nest(el("h1", "phui-header-view"),
          nest(el("div", "phui-header-row"),
            nest(el("div", "phui-header-col2"),
              nest(el("span", "phui-header-header"), titleText)),
            nest(el("div", "phui-header-col3"), reloadLink))))
    );

    // Same nested wrapper structure as the Details box: section → container → wrap
    const list = el("div", "pt-push-list");
    panel.appendChild(
      nest(el("div", "phui-property-list-section"),
        nest(el("div", "phui-property-list-container grouped"),
          nest(el("div", "phui-property-list-properties-wrap"), list)))
    );

    return { panel, list, setTitle: text => { titleText.textContent = text; } };
  }

  // --- State rows ---

  function stateRow(list, text, cls) {
    clearEl(list);
    const msg = el("div", cls);
    msg.textContent = text;
    list.appendChild(msg);
    return msg;
  }

  // --- Public API ---

  window.ptIsRunning = isRunning;

  window.ptCreatePanel = function (onReload) {
    const { panel, list, setTitle } = buildShell(onReload);

    function setLoading(message) {
      setTitle("Try Pushes");
      stateRow(list, message, "greytext pt-state-loading");
    }

    function setError(message) {
      setTitle("Try Pushes");
      const msg = stateRow(list, message, "red pt-state-error");
      const retry = el("a", null, " Retry");
      retry.href = "#";
      retry.addEventListener("click", e => { e.preventDefault(); onReload(); });
      msg.appendChild(retry);
    }

    function setPushes(pushes) {
      clearEl(list);
      setTitle(titleFor(pushes));
      if (pushes.length)
        for (const push of pushes) list.appendChild(buildPushRow(push));
      else stateRow(list, "No try pushes found for this revision.", "greytext pt-state-error");
    }

    // Store controller on the element so updatePanel can delegate without
    // querying the DOM or duplicating the title/repopulate logic.
    const ctrl = { el: panel, setLoading, setError, setPushes };
    panel._ptCtrl = ctrl;
    // Caller (panel-controller.js) sets the initial loading message.
    return ctrl;
  };

  // Delegates to the stored controller — no DOM querying or duplicated logic.
  function updatePanel(panelEl, pushes) {
    panelEl._ptCtrl?.setPushes(pushes);
  }

  window.ptStartAutoRefresh = function (panelEl, msgPayload, fetchFn) {
    let handle = null;
    async function tick() {
      try {
        const pushes = await fetchFn(msgPayload, true);
        updatePanel(panelEl, pushes);
        if (pushes.every(p => !isRunning(p))) stop();
      } catch (e) { console.warn("[phab-try] auto-refresh failed", e); }
    }
    function stop() { clearInterval(handle); handle = null; }
    handle = setInterval(tick, 60_000);
    return stop;
  };
})();
