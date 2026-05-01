/* exported ptCreateBugzillaPanel */
"use strict";

// Creates a panel styled as a Bugzilla section.module, matching the
// Categories / People / Phabricator Revisions sections on bug pages.
// Relies on panel.js being loaded first for shared utilities.
window.ptCreateBugzillaPanel = (function () {
  // Row markup is shared with the Phabricator panel via window.ptBuildPushRow
  // — same <tr>/<td> structure, same pill/badge/cell classes — so both
  // panels render identically and we only have one place to maintain.
  const {
    ptFaIcon: faIcon,
    ptNest: nest,
    ptEl: el,
    ptWithAction: withAction,
    ptBuildPushTable: buildPushTable,
    ptBuildWarning: buildWarning,
    ptProgressBar: progressBar,
    ptNoPushesMsg,
  } = window;

  return function (onReload) {
    const ID = "module-pushes";

    // Declare content first so spinner can reference content.id for aria-controls.
    const content = Object.assign(el("div", "module-content"), { id: `${ID}-content` });
    const titleEl = Object.assign(el("h2", "module-title", "Pushes"), { id: `${ID}-title` });
    const subtitle = Object.assign(el("h3", "module-subtitle"), { id: `${ID}-subtitle` });

    const LABEL_EXP = "Collapse Pushes section";
    const LABEL_COL = "Expand Pushes section";

    const spinner = Object.assign(el("div", "module-spinner"), {
      role: "button",
      tabIndex: 0,
      ariaExpanded: "true",
      ariaLabel: LABEL_EXP,
    });
    spinner.setAttribute("aria-controls", content.id);

    const reloadBtn = nest(
      withAction(el("a", "pt-bz-reload"), onReload),
      faIcon("fas fa-sync"),
      " Reload",
    );

    // Flex layout for header is in panel.css (#module-pushes .module-header)
    const section = Object.assign(el("section", "module"), { id: ID });
    section.append(
      nest(
        el("header", "module-header"),
        nest(el("div", "module-latch"), spinner, titleEl, subtitle),
        reloadBtn,
      ),
      content,
    );

    // Collapse/expand — wired manually since our section is added after
    // Bugzilla's init_module_visibility() has already run.
    function toggleCollapse() {
      const nowExpanded = spinner.getAttribute("aria-expanded") === "false";
      spinner.setAttribute("aria-expanded", String(nowExpanded));
      spinner.setAttribute("aria-label", nowExpanded ? LABEL_EXP : LABEL_COL);
      content.hidden = !nowExpanded;
    }
    spinner.addEventListener("click", toggleCollapse);
    spinner.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleCollapse();
      }
    });

    function setTitle(text) {
      titleEl.textContent = text;
    }
    function setSubtitle(text) {
      subtitle.textContent = text ? `(${text})` : "";
    }
    function resetTitle() {
      setTitle("Pushes");
      setSubtitle("");
    }

    // The warning banner is kept as a separate node and re-attached on each
    // setPushes / setLoading / setError call so it persists across content
    // replacement. It lives at the top of the module-content area.
    let warningEl = null;
    let statusEl = null;
    const reattachOverlays = () => {
      if (statusEl) content.prepend(statusEl);
      if (warningEl) content.prepend(warningEl);
    };

    const showMsg = (...children) => {
      resetTitle();
      content.replaceChildren(...children);
      reattachOverlays();
    };
    const setLoading = (msg, done, total) =>
      showMsg(el("p", "pt-bz-msg pt-bz-msg-loading", msg), progressBar(done, total));
    const setError = (msg) =>
      showMsg(
        nest(
          el("p", "pt-bz-msg pt-bz-msg-error", msg),
          withAction(el("a", null, " Retry"), onReload),
        ),
      );

    function setPushes(pushes) {
      setTitle(`Pushes (${pushes.length})`);
      setSubtitle(`${pushes.length} push${pushes.length !== 1 ? "es" : ""}`);
      content.replaceChildren(
        pushes.length
          ? buildPushTable(pushes)
          : el("p", "pt-bz-msg pt-bz-msg-empty", ptNoPushesMsg),
      );
      reattachOverlays();
    }

    function setWarning(errors) {
      const banner = buildWarning(errors);
      if (banner) {
        // Render as a top-level div in module-content (no <p> wrapper —
        // the warning contains block-level elements and would break out
        // of a paragraph parent, collapsing layout).
        warningEl = banner;
        reattachOverlays();
      } else if (warningEl) {
        warningEl.remove();
        warningEl = null;
      }
    }

    function setStatus(message, done, total) {
      if (statusEl) {
        statusEl.remove();
        statusEl = null;
      }
      if (!message) return;
      statusEl = nest(
        el("div", "pt-status-row pt-bz-status greytext"),
        document.createTextNode(message + " "),
        progressBar(done, total),
      );
      reattachOverlays();
    }

    const ctrl = {
      el: section,
      setLoading,
      setError,
      setPushes,
      setWarning,
      setStatus,
      setDInfos: window.ptSetDInfos,
    };
    section.dataset.ptPanel = "1";
    section._ptCtrl = ctrl;
    return ctrl;
  };
})();
