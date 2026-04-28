/* exported ptCreateBugzillaPanel */
"use strict";

// Creates a panel styled as a Bugzilla section.module, matching the
// Categories / People / Phabricator Revisions sections on bug pages.
// Relies on panel.js being loaded first for shared utilities.
window.ptCreateBugzillaPanel = (function () {

  const { ptPhabBase: PHAB_BASE, ptFaIcon: bzIcon, ptNest: nest,
          ptEl: el, ptWithAction: withAction, ptShortRev: shortRev,
          ptMetrics, ptStatusSummary, ptResolveMetricResult, ptNoTryPushesMsg } = window;

  // Matches Bugzilla's rel-time span pattern. bug_modal.js runs
  // setInterval(relativeTimer, 60_000) over $('.rel-time'), so our spans
  // are kept up-to-date automatically after the first tick.
  const _rtf   = new Intl.RelativeTimeFormat(undefined, { numeric: "always" });
  const _units = [
    ["year",  365 * 86400], ["month", 30 * 86400],
    ["day",   86400],       ["hour",  3600], ["minute", 60],
  ];

  function bzRelTime(epochSecs) {
    const elapsed = Math.floor(Date.now() / 1000) - epochSecs;
    const [unit, secs] = _units.find(([, s]) => elapsed >= s) ?? ["second", 1];
    const rel = elapsed < 10 ? "Just now" : _rtf.format(-Math.round(elapsed / secs), unit);

    const span = el("span", "rel-time", rel);
    span.dataset.time = String(epochSecs);
    span.title = new Date(epochSecs * 1000).toLocaleString(undefined, {
      year: "numeric", month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
    return span;
  }

  // Uses Bugzilla's own phabricator.css classes (revision-status-box-* /
  // revision-status-icon-*) so metric badges match the Phabricator Revisions table.
  const STATUS_STYLE = {
    pass:    { box: "accepted",       icon: "accepted"       },
    fail:    { box: "needs-revision", icon: "needs-revision" },
    running: { box: "needs-review",   icon: "needs-review"   },
    pending: { box: "abandoned",      icon: "abandoned"      },
  };

  function buildMetricCell(label, result) {
    if (!result || result === "none") return el("td", "pt-bz-metric");
    const st = STATUS_STYLE[result.toLowerCase()] ?? STATUS_STYLE.pending;
    return nest(el("td", "pt-bz-metric"),
      nest(el("span", `revision-status-box-${st.box}`),
        el("span", `revision-status-icon-${st.icon}`), el("span", null, label)));
  }

  const bzLink = (cls, text, href) =>
    Object.assign(el("a", cls, text), { href, target: "_blank", rel: "noopener noreferrer" });

  const dLink = d => bzLink("pt-bz-d-label", `D${d}`, `${PHAB_BASE}/D${d}`);

  const buildRevCell = push => {
    if (push.dNumbers)
      return nest(el("td", "pt-bz-rev"),
        ...push.dNumbers.flatMap((d, i) => i === 0 ? [dLink(d)] : [", ", dLink(d)]));
    if (push.dNumber)
      return nest(el("td", "pt-bz-rev"), dLink(push.dNumber));
    return el("td", "pt-bz-rev");
  };

  const buildPushRow = (push, showRevCol) => nest(el("tr"),
    ...(showRevCol ? [buildRevCell(push)] : []),
    nest(el("td", "pt-bz-time"), bzRelTime(push.push_timestamp)),
    nest(el("td", "pt-bz-hash"), bzLink(null, shortRev(push.revision), push.treeherder_url)),
    ...ptMetrics.map(([label, key]) => buildMetricCell(label, ptResolveMetricResult(push, key))),
    el("td", "pt-bz-note", ptStatusSummary(push.health)),
  );

  return function (onReload) {
    const ID = "module-try-pushes";

    // Declare content first so spinner can reference content.id for aria-controls.
    const content  = Object.assign(el("div",      "module-content"), { id: `${ID}-content` });
    const titleEl  = Object.assign(el("h2", "module-title",   "Try Pushes"), { id: `${ID}-title` });
    const subtitle = Object.assign(el("h3", "module-subtitle"),               { id: `${ID}-subtitle` });

    const LABEL_EXP = "Collapse Try Pushes section";
    const LABEL_COL = "Expand Try Pushes section";

    const spinner = Object.assign(el("div", "module-spinner"),
      { role: "button", tabIndex: 0, ariaExpanded: "true", ariaLabel: LABEL_EXP });
    spinner.setAttribute("aria-controls", content.id);

    const reloadBtn = nest(withAction(el("a", "pt-bz-reload"), onReload), bzIcon("fas fa-sync"), " Reload");

    // Flex layout for header is in panel.css (#module-try-pushes .module-header)
    const section = Object.assign(el("section", "module"), { id: ID });
    section.append(
      nest(el("header", "module-header"),
        nest(el("div", "module-latch"), spinner, titleEl, subtitle),
        reloadBtn),
      content);

    // Collapse/expand — wired manually since our section is added after
    // Bugzilla's init_module_visibility() has already run.
    function toggleCollapse() {
      const nowExpanded = spinner.getAttribute("aria-expanded") === "false";
      spinner.setAttribute("aria-expanded", String(nowExpanded));
      spinner.setAttribute("aria-label", nowExpanded ? LABEL_EXP : LABEL_COL);
      content.hidden = !nowExpanded;
    }
    spinner.addEventListener("click", toggleCollapse);
    spinner.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleCollapse(); }
    });

    function setTitle(text)    { titleEl.textContent = text; }
    function setSubtitle(text) { subtitle.textContent = text ? `(${text})` : ""; }
    function resetTitle()      { setTitle("Try Pushes"); setSubtitle(""); }

    const showMsg = (...children) => { resetTitle(); content.replaceChildren(...children); };
    const setLoading = (msg, done, total) => {
      const bar = el("progress");
      if (done !== undefined && total > 0) { bar.max = total; bar.value = done; }
      showMsg(el("p", "pt-bz-msg pt-bz-msg-loading", msg), bar);
    };
    const setError = msg => showMsg(nest(el("p", "pt-bz-msg pt-bz-msg-error", msg),
      withAction(el("a", null, " Retry"), onReload)));

    function setPushes(pushes) {
      setTitle(`Try Pushes (${pushes.length})`);
      setSubtitle(`${pushes.length} push${pushes.length !== 1 ? "es" : ""}`);
      const showRevCol = pushes.some(p => p.dNumber);
      content.replaceChildren(pushes.length
        ? nest(el("table", "layout-table"), ...pushes.map(p => buildPushRow(p, showRevCol)))
        : el("p", "pt-bz-msg pt-bz-msg-empty", ptNoTryPushesMsg));
    }

    const ctrl = { el: section, setLoading, setError, setPushes };
    section.dataset.ptPanel = "1";
    section._ptCtrl = ctrl;
    return ctrl;
  };
})();
