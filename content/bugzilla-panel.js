/* exported ptCreateBugzillaPanel */
"use strict";

// Creates a panel styled as a Bugzilla section.module, matching the
// Categories / People / Phabricator Revisions sections on bug pages.
// Relies on panel.js being loaded first for shared utilities.
window.ptCreateBugzillaPanel = (function () {

  const { ptEl: el, ptWithAction: withAction, ptShortRev: shortRev,
          ptMetrics, ptStatusSummary, ptResolveMetricResult, ptNoTryPushesMsg } = window;

  // FA5 icon with aria-hidden, matching Bugzilla's decorative icon pattern.
  function bzIcon(cls) {
    const i = el("i", cls);
    i.setAttribute("aria-hidden", "true");
    return i;
  }

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
    const td = el("td", "pt-bz-metric");
    if (!result || result === "none") return td;   // skip badge for missing metrics
    const st = STATUS_STYLE[result.toLowerCase()] ?? STATUS_STYLE.pending;
    const box = el("span", `revision-status-box-${st.box}`);
    box.append(el("span", `revision-status-icon-${st.icon}`), el("span", null, label));
    td.appendChild(box);
    return td;
  }

  function buildPushRow(push) {
    const tdTime = el("td", "pt-bz-time");
    tdTime.appendChild(bzRelTime(push.push_timestamp));

    const a = el("a", null, shortRev(push.revision));
    a.href   = push.treeherder_url;
    a.target = "_blank";
    a.rel    = "noopener noreferrer";
    const tdHash = el("td", "pt-bz-hash");
    tdHash.appendChild(a);

    const tdNote = el("td", "pt-bz-note");
    const note = ptStatusSummary(push.health);
    if (note) tdNote.textContent = note;

    const tr = document.createElement("tr");
    tr.append(tdTime, tdHash,
      ...ptMetrics.map(([label, key]) =>
        buildMetricCell(label, ptResolveMetricResult(push, key))),
      tdNote);
    return tr;
  }

  return function (onReload) {
    const ID = "module-try-pushes";

    const section = el("section", "module");
    section.id = ID;

    // Declare content first so spinner can reference content.id for aria-controls.
    const content = el("div", "module-content");
    content.id = `${ID}-content`;

    const latch = el("div", "module-latch");
    latch.dataset.labelExpanded  = "Collapse Try Pushes section";
    latch.dataset.labelCollapsed = "Expand Try Pushes section";

    const spinner = el("div", "module-spinner");
    spinner.setAttribute("role", "button");
    spinner.setAttribute("tabindex", "0");
    spinner.setAttribute("aria-controls", content.id);
    spinner.setAttribute("aria-expanded", "true");
    spinner.setAttribute("aria-label", latch.dataset.labelExpanded);

    const titleEl = el("h2", "module-title", "Try Pushes");
    titleEl.id = `${ID}-title`;

    const subtitle = el("h3", "module-subtitle");
    subtitle.id = `${ID}-subtitle`;

    latch.append(spinner, titleEl, subtitle);

    const reloadBtn = withAction(el("a", "pt-bz-reload"), onReload);
    reloadBtn.append(bzIcon("fas fa-sync"), " Reload");

    // Flex layout for header is in panel.css (#module-try-pushes .module-header)
    const header = el("header", "module-header");
    header.append(latch, reloadBtn);
    section.append(header, content);

    // Collapse/expand — wired manually since our section is added after
    // Bugzilla's init_module_visibility() has already run.
    function toggleCollapse() {
      const nowExpanded = spinner.getAttribute("aria-expanded") === "false";
      spinner.setAttribute("aria-expanded", String(nowExpanded));
      spinner.setAttribute("aria-label",
        latch.dataset[nowExpanded ? "labelExpanded" : "labelCollapsed"]);
      content.style.display = nowExpanded ? "" : "none";
    }
    spinner.addEventListener("click", toggleCollapse);
    spinner.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleCollapse(); }
    });

    function setTitle(text)    { titleEl.textContent = text; }
    function setSubtitle(text) { subtitle.textContent = text ? `(${text})` : ""; }
    function resetTitle()      { setTitle("Try Pushes"); setSubtitle(""); }

    function setLoading(msg) {
      resetTitle();
      content.replaceChildren(el("p", "pt-bz-msg pt-bz-msg-loading", msg));
    }

    function setError(msg) {
      resetTitle();
      const p = el("p", "pt-bz-msg pt-bz-msg-error", msg);
      p.appendChild(withAction(el("a", null, " Retry"), onReload));
      content.replaceChildren(p);
    }

    function setPushes(pushes) {
      setTitle(`Try Pushes (${pushes.length})`);
      setSubtitle(`${pushes.length} push${pushes.length !== 1 ? "es" : ""}`);
      if (!pushes.length) {
        content.replaceChildren(el("p", "pt-bz-msg pt-bz-msg-empty", ptNoTryPushesMsg));
        return;
      }
      const table = el("table", "layout-table");
      table.append(...pushes.map(buildPushRow));
      content.replaceChildren(table);
    }

    const ctrl = { el: section, setLoading, setError, setPushes };
    section.dataset.ptPanel = "1";
    section._ptCtrl = ctrl;
    return ctrl;
  };
})();
