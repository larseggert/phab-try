// Inline-SVG icon builder shared by every content script. Sits next to
// lib/fa-icons.js (auto-generated path data) so each content_scripts entry
// gets one builder instead of duplicating the createElementNS dance.
//
// Returns a fresh <svg> element, sized via explicit width/height attrs
// (CSS `width: auto` doesn't always compute from viewBox in inline SVG).
// Caller appends. Falls back to an empty text node if `name` is unknown
// so call sites can splice the result into a DocumentFragment / .append
// without a null check.

(function () {
  "use strict";

  // External link in a new tab — sets href + the standard noopener
  // relation. Shared between every content script (panel + treeherder +
  // the Bugzilla-page bug.js); previously each had its own near-copy.
  window.ptExtLink = function (href, text, className) {
    return Object.assign(document.createElement("a"), {
      href, textContent: text, target: "_blank", rel: "noopener noreferrer",
      ...(className && { className }),
    });
  };

  const NS = "http://www.w3.org/2000/svg";
  window.ptIconSvg = function (name, title) {
    const data = FA_ICONS[name];
    if (!data) return document.createTextNode("");
    const [, , w, h] = data.viewBox.split(" ").map(Number);
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", data.viewBox);
    svg.setAttribute("class", "pt-status-icon");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("width",  String(Math.round(w / h * 14)));
    svg.setAttribute("height", "14");
    if (title) {
      const t = document.createElementNS(NS, "title");
      t.textContent = title;
      svg.appendChild(t);
    }
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", data.path);
    svg.appendChild(path);
    return svg;
  };
})();
