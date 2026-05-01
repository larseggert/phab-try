// Globals exported: ptCreatePanel, ptStartAutoRefresh, ptIsRunning,
//                   ptCreateBugzillaPanel deps (ptEl/ptNest/ptWithAction/
//                   ptFaIcon/ptBuildPushRow/ptBuildPushTable/ptBuildWarning/
//                   ptProgressBar/ptApplyResult/ptExtLink/ptSetDInfos/
//                   ptNoPushesMsg).

(function () {
  "use strict";

  const AUTO_REFRESH_MS = 120_000; // 2 minutes — matches background cache TTL

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

  // External-link helper lives in lib/icons.js — alias it locally for
  // brevity at the call sites in this IIFE.
  const extLink = window.ptExtLink;

  // Determinate <progress> when done/total are valid; indeterminate otherwise.
  function progressBar(done, total) {
    const bar = el("progress");
    if (done !== undefined && total > 0) { bar.max = total; bar.value = done; }
    return bar;
  }

  // visual-only + aria-hidden: Phabricator's decorative icon convention.
  function faIcon(faClass) {
    const icon = el("span", `visual-only phui-icon-view phui-font-fa ${faClass}`);
    icon.setAttribute("aria-hidden", "true");
    return icon;
  }

  // --- Data helpers ---

  // Relative timestamp ("5 minutes ago" / "Just now") with the absolute
  // local timestamp on hover via the title attr. The .rel-time class makes
  // Bugzilla's bug_modal.js auto-tick this every 60 s on the Bugzilla
  // panel — harmless on the Phab panel where that loop doesn't run.
  const _rtf   = new Intl.RelativeTimeFormat(undefined, { numeric: "always" });
  const _units = [
    ["year",  365 * 86400], ["month", 30 * 86400],
    ["day",   86400],       ["hour",  3600], ["minute", 60],
  ];
  function relTime(epochSecs) {
    const elapsed = Math.floor(Date.now() / 1000) - epochSecs;
    const [unit, secs] = _units.find(([, s]) => elapsed >= s) ?? ["second", 1];
    const rel = elapsed < 10 ? "Just now" : _rtf.format(-Math.round(elapsed / secs), unit);

    const span = el("span", "rel-time", rel);
    span.dataset.time = String(epochSecs);
    span.title = new Date(epochSecs * 1000).toLocaleString(undefined, {
      weekday: "short", year: "numeric", month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
      timeZoneName: "short",
    });
    return span;
  }

  function shortRev(r) { return r ? r.slice(0, 8) : "?"; }

  // Per-repo pill. Uses our own classes (not Phabricator's phui-tag-view
  // markup) so we have full control over width and aren't competing with
  // the host's combo-class rules that kept overriding our sizing.
  // Visually still matches the phui-tag-shade aesthetic (light tinted
  // background, dark same-hue text, soft border).
  const REPO_PILL = {
    "try":              { label: "try",      color: "blue"   },
    "autoland":         { label: "autoland", color: "green"  },
    "mozilla-central":  { label: "central",  color: "violet" },
    "mozilla-beta":     { label: "beta",     color: "orange" },
    "mozilla-release":  { label: "release",  color: "red"    },
    "mozilla-esr140":   { label: "esr140",   color: "pink"   },
    "mozilla-esr115":   { label: "esr115",   color: "indigo" },
  };
  function repoPill(repo) {
    const cfg = REPO_PILL[repo] ?? { label: repo ?? "?", color: "grey" };
    return el("span", `pt-repo-pill pt-repo-pill-${cfg.color}`, cfg.label);
  }

  function statusSummary(health) {
    if (!health?.status) return null;
    const s = health.status;
    const c = s.completed || 0;
    const total = c + (s.pending || 0) + (s.running || 0);
    const parts = [];
    if (total) parts.push(`${c}/${total} completed`);
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

  // --- Status badge ---

  // Confirmed from the live Phabricator page HTML:
  //   tagCls  — e.g. "phui-tag-green"  (background tint, NOT "phui-tag-shade-green")
  //   iconCls — e.g. "green"           (FA icon colour class, same pattern as fa-check green
  //                                     and fa-headphones red in the Similar-revisions tab)
  // The "pending" state uses fa-clock (FA5+) plus its FA4 alias fa-clock-o
  // — same codepoint (\f017) and same Solid-weight glyph in FA Free, so it
  // matches the visual width of the other badges on both panels without
  // depending on Pro-only Regular-weight fonts.
  const RESULT_STYLE = {
    pass:    { fa: "fa-check-circle",        tagCls: "phui-tag-green",  iconCls: "green"  },
    fail:    { fa: "fa-times-circle",        tagCls: "phui-tag-red",    iconCls: "red"    },
    running: { fa: "fa-refresh",             tagCls: "phui-tag-yellow", iconCls: "orange" },
    pending: { fa: "fa-clock-o fa-clock",    tagCls: "phui-tag-grey",   iconCls: "grey"   },
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
    core.append(faIcon(`${style.fa} ${style.iconCls}`), ` ${label}`);
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
  // Rendered as a <tr> inside a <table> on both panels. Tables auto-size
  // their columns to widest content per column and don't overflow when the
  // panel narrows, which the previous flex layout did. The same row markup
  // is reused on the Bugzilla panel via window.ptBuildPushRow.
  //
  // Column order: date | repo | hash | covered-Ds | metric pills | status.

  // Shared inline-SVG builder lives in lib/icons.js as window.ptIconSvg.
  const statusIcon = window.ptIconSvg;

  // D-infos map ({ d → { title, status } }) primed by the background search
  // and forwarded via panel-controller.js → ctrl.setDInfos(...). Used
  // synchronously by buildDLink so the abandoned/landed indicator lands
  // with the row instead of fluttering in a second later.
  let currentDInfos = {};
  function setDInfos(infos) { currentDInfos = infos ?? {}; }

  function buildHashCell(push) {
    const td = el("td", "pt-push-hash");
    const a = extLink(push.treeherder_url, shortRev(push.revision));
    if (push.backedOut) {
      a.classList.add("pt-strike");
      a.append(" ", statusIcon("fast-backward", "Backed out"));
    }
    td.append(a);
    return td;
  }

  function buildDLink(d) {
    const info = currentDInfos[d];
    const a = extLink(phabRevUrl(d), `D${d}`, "pt-push-dlink");
    if (info?.title) a.title = info.title;
    if (dRevisionIsAbandoned(info?.status)) {
      a.classList.add("pt-push-dlink-abandoned", "pt-strike");
    } else if (dRevisionIsLanded(info?.status)) {
      a.classList.add("pt-push-dlink-landed");
      a.append(" ", statusIcon("plane-arrival", "Landed"));
    }
    return a;
  }

  // Pick the per-push D-list to display: full stack first, otherwise
  // any labelled subset, otherwise the lone labelled D.
  function dsForPush(push) {
    if (push.stackDNums?.length) return push.stackDNums;
    if (push.dNumbers?.length)   return push.dNumbers;
    if (push.dNumber)            return [push.dNumber];
    return [];
  }

  // D-revisions cell — full stack of Ds in this push, on both Phab and
  // Bugzilla pages. Each D renders as a compact badge so the row reads
  // "🏷 🏷 🏷" rather than "D…, D…, D…"; spacing comes from a small
  // trailing margin per badge.
  function buildCoveredCell(push) {
    const td = el("td", "pt-push-covered");
    for (const d of dsForPush(push)) td.append(buildDLink(d));
    return td;
  }

  // All three metric badges in one cell so they wrap together as the
  // panel narrows. Empty slots are skipped.
  function buildMetricsCell(push) {
    const td = el("td", "pt-push-metrics");
    for (const [label, key] of METRICS) {
      const result = resolveMetricResult(push, key);
      if (!result || result === "none") continue;
      if (td.childNodes.length) td.append(" ");
      td.append(createBadge(label, result));
    }
    return td;
  }

  // Builds the <table>/<tbody> wrapper for a list of push rows. Both
   // panel factories use this to swap the table into their content slot
   // — keeps the markup in one place so column changes are one edit.
  function buildPushTable(pushes) {
    const tbody = el("tbody");
    for (const p of pushes) tbody.append(buildPushRow(p));
    return nest(el("table", "pt-push-table"), tbody);
  }

  function buildPushRow(push) {
    const tr = el("tr", "pt-push-row");
    tr.dataset.revision = push.revision;

    const summary = statusSummary(push.health);

    tr.append(
      nest(el("td", "pt-push-time greytext"),     relTime(push.push_timestamp)),
      nest(el("td", "pt-push-repo"),              repoPill(push.repo)),
      buildHashCell(push),
      buildCoveredCell(push),
      buildMetricsCell(push),
      el("td", "pt-push-status greytext", summary ?? ""),
    );
    return tr;
  }

  // --- Warning banner ---
  // Renders a non-fatal "results may be incomplete" notice above the push
  // list. Distinct from setError() (a full failure that replaces the list).
  // The details panel lists each failing URL with its corresponding error
  // code; the code is a link to MDN's reference page for that status (or
  // to MDN's CORS-errors page for the "Network error" bucket — used when
  // no HTTP status was readable, e.g. CORS-blocked responses, DNS, etc.).
  // Reused by bugzilla-panel.js via window.ptBuildWarning.

  const CORS_ERRORS_URL = "https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS/Errors";
  const statusReference = status =>
    (status && status !== 200)
      ? `https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/${status}`
      : CORS_ERRORS_URL;

  function buildWarningEntry({ url, status }) {
    const li = el("li", "pt-warning-entry");
    // HTTP 200 here means the server replied but the browser refused the
    // response due to CORS — the wire-level 200 was recorded by webRequest
    // before the CORS check ran. Label it the same as a pure network error.
    const isCors = !status || status === 200;
    const code = el("a", "pt-warning-status",
      isCors ? "CORS blocked" : `HTTP ${status}`);
    code.href = statusReference(status);
    code.target = "_blank";
    code.rel = "noopener noreferrer";
    code.title = isCors
      ? "Browser blocked this request (missing CORS headers) — open MDN CORS-errors reference"
      : `HTTP ${status} — open MDN reference for this status code`;

    // Each failing URL is itself a clickable link so the user can inspect
    // the request directly (open in browser → see the response, headers,
    // etc.). For unknown URLs (rare — would require a non-fetch error)
    // fall back to a plain text label.
    const urlNode = url
      ? extLink(url, url, "pt-warning-url")
      : el("span", "pt-warning-url", "(unknown URL)");

    li.append(code, urlNode);
    return li;
  }

  function buildWarning(errors) {
    if (!errors?.length) return null;
    const wrap = el("div", "pt-warning");

    const list = el("ul", "pt-warning-list");
    for (const e of errors) list.append(buildWarningEntry(e));

    const details = el("div", "pt-warning-details");
    details.hidden = true;
    details.append(list);

    const total = errors.length;
    const ws = total === 1 ? "" : "es";
    const header = el("div", "pt-warning-summary");
    const toggle = withAction(el("a", null, "Details"),
      () => { details.hidden = !details.hidden; });
    header.append(
      faIcon("fa-exclamation-triangle"),
      ` Some pushes may be missing — ${total} fetch${ws} failed. `,
      toggle,
    );

    wrap.append(header, details);
    return wrap;
  }

  // --- Panel shell ---

  function buildShell(onReload) {
    const panel = el("div",
      "phui-box phui-box-border phui-object-box mlt mll mlr phui-box-blue-property pt-panel");

    const titleText = el("span", "pt-panel-title-text", "Pushes");

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

    // Direct children of the phui-box panel, no property-list wrappers —
    // Phabricator's float-based property-list layout was forcing the
    // table into a narrower content box and causing the pill column to
    // overlap the hash column. Plain block flow gives the table the full
    // panel width to lay out its columns.
    const warning = el("div", "pt-warning-slot");
    const status = el("div", "pt-status-slot");
    const list = el("div", "pt-push-list");
    panel.append(warning, status, list);

    const setTitle = text => { titleText.textContent = text; };
    return { panel, list, warning, status, setTitle };
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
    const { panel, list, warning, status, setTitle } = buildShell(onReload);

    const resetTitle = () => setTitle("Pushes");

    function setLoading(message, done, total) {
      resetTitle();
      const row = stateRow(list, message, "greytext pt-state-loading");
      row.append(progressBar(done, total));
    }

    function setError(message) {
      resetTitle();
      const msg = stateRow(list, message, "red pt-state-error");
      msg.append(withAction(el("a", null, " Retry"), onReload));
    }

    function setPushes(pushes) {
      setTitle(`Pushes (${pushes.length})`);
      if (pushes.length) list.replaceChildren(buildPushTable(pushes));
      else               stateRow(list, window.ptNoPushesMsg, "greytext pt-state-error");
    }

    function setWarning(errors) {
      const banner = buildWarning(errors);
      if (banner) warning.replaceChildren(banner);
      else        warning.replaceChildren();
    }

    function setStatus(message, done, total) {
      if (!message) { status.replaceChildren(); return; }
      const row = nest(el("div", "pt-status-row greytext", message), progressBar(done, total));
      status.replaceChildren(row);
    }

    const ctrl = { el: panel, setLoading, setError, setPushes, setWarning, setStatus, setDInfos };
    panel.dataset.ptPanel = "1";
    panel._ptCtrl = ctrl;  // lets updatePanel reach the controller without re-querying the DOM
    return ctrl;
  };

  // Shared utilities for bugzilla-panel.js
  window.ptFaIcon              = faIcon;
  window.ptNest                = nest;
  window.ptEl                  = el;
  window.ptWithAction          = withAction;
  window.ptBuildPushRow        = buildPushRow;
  window.ptBuildPushTable      = buildPushTable;
  window.ptBuildWarning        = buildWarning;
  window.ptProgressBar         = progressBar;
  window.ptApplyResult         = applyResult;
  // ptExtLink is provided by lib/icons.js (loaded first per manifest.json).
  // Bugzilla panel shares panel.js's buildDLink, which reads
  // `currentDInfos` from this IIFE's module scope. Expose the setter so
  // bugzilla-panel.js can prime it before calling setPushes.
  window.ptSetDInfos           = setDInfos;
  window.ptNoPushesMsg      = "No pushes found for this revision.";

  // Apply a result payload (dInfos + errors + pushes) to a controller in
  // the order setDInfos → setWarning → setPushes. setDInfos must run
  // first so the row builders see the per-D status map and can decorate
  // synchronously; missing this order is the classic "icons flutter in
  // a second after the rows" regression.
  function applyResult(ctrl, { pushes, errors, dInfos }) {
    ctrl.setDInfos?.(dInfos);
    ctrl.setWarning?.(errors);
    ctrl.setPushes(pushes);
  }

  function updatePanel(panelEl, payload) {
    if (panelEl._ptCtrl) applyResult(panelEl._ptCtrl, payload);
  }

  window.ptStartAutoRefresh = function (panelEl, msgPayload, fetchFn) {
    let handle = null;
    let stopped = false;
    async function tick() {
      if (!document.contains(panelEl)) { stop(); return; }
      try {
        // silent=true: no progress flash, no setStatus indicator. The
        // panel keeps the previously rendered rows visible until fresh
        // results arrive, then updates in place.
        const result = await fetchFn(msgPayload, true, true);
        if (stopped) return;   // reload() fired while we were awaiting — discard result
        updatePanel(panelEl, result);
        if (result.pushes.every(p => !isRunning(p))) stop();
      } catch (e) { console.warn("[phab-try] auto-refresh failed", e); }
    }
    function stop() { stopped = true; clearInterval(handle); handle = null; }
    handle = setInterval(tick, AUTO_REFRESH_MS);
    return stop;
  };
})();
