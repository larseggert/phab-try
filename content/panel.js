// Globals exported: ptCreatePanel, ptStartAutoRefresh, ptIsRunning
//                   ptEl, ptWithAction, ptShortRev, ptMetrics, ptStatusSummary, ptResolveMetricResult, ptNoTryPushesMsg

(function () {
  "use strict";

  // --- DOM helpers ---

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls)  node.className   = cls;
    if (text) node.textContent = text;
    return node;
  }

  function nest(parent, ...children) {
    parent.append(...children);
    return parent;
  }

  // Sets href="#" and attaches a click handler that calls fn() without navigating.
  function withAction(node, fn) {
    node.href = "#";
    node.addEventListener("click", e => { e.preventDefault(); fn(); });
    return node;
  }

  // visual-only + aria-hidden: Phabricator's decorative icon convention.
  function faIcon(faClass) {
    const icon = el("span", `visual-only phui-icon-view phui-font-fa ${faClass}`);
    icon.setAttribute("aria-hidden", "true");
    return icon;
  }

  // --- Data helpers ---

  // screen-only/print-only mirrors Phabricator's timeline timestamp pattern.
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
    frag.append(screen, print);
    return frag;
  }

  function shortRev(r) { return r ? r.slice(0, 8) : "?"; }

  function statusSummary(health) {
    if (!health?.status) return null;
    const s = health.status;
    const total = (s.completed || 0) + (s.pending || 0) + (s.running || 0);
    const parts = [];
    if (total) parts.push(`${s.completed || 0}/${total} completed`);
    for (const [key, label] of [
      ["testfailed", "failed"], ["busted", "busted"],
      ["exception", "exception"], ["running", "running"], ["pending", "pending"],
    ]) if (s[key]) parts.push(`${s[key]} ${label}`);
    return parts.join(", ") || null;
  }

  function isRunning(push) {
    const s = push.health?.status;
    return s && (s.pending || 0) + (s.running || 0) > 0;
  }

  function titleFor(pushes) {
    return `Try Pushes (${pushes.length})`;
  }

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
    core.append(faIcon(`${style.fa} ${style.iconCls}`), `\u00a0${label}`);
    badge.append(core);
    return badge;
  }

  // Resolves the result for a single metric, including decision-task failure detection:
  // when all metrics are "none" but busted/exception jobs exist, builds → "fail".
  function resolveMetricResult(push, key) {
    const m = push.health?.metrics ?? {};
    const s = push.health?.status;
    const allNone = METRICS.every(([, k]) => !m[k]?.result || m[k].result === "none");
    const hasFailed = allNone && s &&
      ((s.busted || 0) + (s.exception || 0) + (s.testfailed || 0)) > 0;
    return (hasFailed && key === "builds") ? "fail" : (m[key]?.result ?? null);
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

    const row = nest(el("div", "pt-push-row"), timeSpan, hashWrap,
      ...METRICS.map(([label, key]) => createBadge(label, resolveMetricResult(push, key))));
    item.append(row);

    const summary = statusSummary(push.health);
    if (summary) item.append(el("div", "pt-push-note greytext", summary));

    return item;
  }

  // --- Panel shell ---

  function buildShell(onReload) {
    const panel = el("div",
      "phui-box phui-box-border phui-object-box mlt mll mlr phui-box-blue-property pt-try-panel");

    const titleText = el("span", "pt-panel-title-text", "Try Pushes");

    const reloadLink = withAction(el("a", "phui-header-action-link"), onReload);
    nest(reloadLink, faIcon("fa-refresh"), document.createTextNode(" Reload"));

    panel.append(
      nest(el("div", "phui-header-shell"),
        nest(el("h1", "phui-header-view"),
          nest(el("div", "phui-header-row"),
            nest(el("div", "phui-header-col2"),
              nest(el("span", "phui-header-header"), titleText)),
            nest(el("div", "phui-header-col3"), reloadLink))))
    );

    const list = el("div", "pt-push-list");
    panel.append(
      nest(el("div", "phui-property-list-section"),
        nest(el("div", "phui-property-list-container grouped"),
          nest(el("div", "phui-property-list-properties-wrap"), list)))
    );

    return { panel, list, setTitle: text => { titleText.textContent = text; } };
  }

  // --- State rows ---

  function stateRow(list, text, cls) {
    const msg = el("div", cls, text);
    list.replaceChildren(msg);
    return msg;
  }

  // --- Public API ---

  window.ptIsRunning = isRunning;

  window.ptCreatePanel = function (onReload) {
    const { panel, list, setTitle } = buildShell(onReload);

    const resetTitle = () => setTitle("Try Pushes");

    function setLoading(message) {
      resetTitle();
      stateRow(list, message, "greytext pt-state-loading");
    }

    function setError(message) {
      resetTitle();
      const msg = stateRow(list, message, "red pt-state-error");
      msg.append(withAction(el("a", null, " Retry"), onReload));
    }

    function setPushes(pushes) {
      setTitle(titleFor(pushes));
      if (pushes.length)
        list.replaceChildren(...pushes.map(buildPushRow));
      else stateRow(list, window.ptNoTryPushesMsg, "greytext pt-state-error");
    }

    const ctrl = { el: panel, setLoading, setError, setPushes };
    panel.dataset.ptPanel = "1";
    panel._ptCtrl = ctrl;  // lets updatePanel reach the controller without re-querying the DOM
    return ctrl;
  };

  // Shared utilities for bugzilla-panel.js
  window.ptEl                  = el;
  window.ptWithAction          = withAction;
  window.ptShortRev            = shortRev;
  window.ptNoTryPushesMsg      = "No try pushes found for this revision.";
  window.ptMetrics             = METRICS;
  window.ptStatusSummary       = statusSummary;
  window.ptResolveMetricResult = resolveMetricResult;

  function updatePanel(panelEl, pushes) {
    panelEl._ptCtrl?.setPushes(pushes);
  }

  window.ptStartAutoRefresh = function (panelEl, msgPayload, fetchFn) {
    let handle = null;
    let stopped = false;
    async function tick() {
      if (!document.contains(panelEl)) { stop(); return; }
      try {
        const pushes = await fetchFn(msgPayload, true);
        if (stopped) return;   // reload() fired while we were awaiting — discard result
        updatePanel(panelEl, pushes);
        if (pushes.every(p => !isRunning(p))) stop();
      } catch (e) { console.warn("[phab-try] auto-refresh failed", e); }
    }
    function stop() { stopped = true; clearInterval(handle); handle = null; }
    handle = setInterval(tick, 60_000);
    return stop;
  };
})();
