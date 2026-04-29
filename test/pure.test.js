// Tests for the pure helpers in lib/pure.js — no browser globals, no
// fetch, no DOM, so they import cleanly into vitest's Node environment.

import { describe, expect, it } from "vitest";
import {
  extractDNums, extractBugNums,
  bugRegex, normSubject, stripPhabSuffix,
  titleMatchesSubjects, pushComments, tryWalkCandidates,
  escapeHostName,
  subjectsFromPush, dedupById, byPushTimestampDesc,
  treeherderJobsUrl, treeherderPushByRevUrl, treeherderHealthUrl,
  treeherderRecentUrl, treeherderAuthorHistoryUrl,
  hgRevUrl, phabRevUrl, bugAttachmentsUrl,
  pushCacheKey, historyCacheKey,
  FetchErrorTracker,
  extractDStatus, dRevisionIsAbandoned, dRevisionIsLanded,
  bugIsClosed, bugIsLanded, bugIsDuplicate, bugIsClosedNoLand,
  backoutTargets, isBackedOut,
} from "../lib/pure.js";

// Shared push fixture for tests that build a single-revision push from a
// commit message. Both `tryWalkCandidates` and `backoutTargets` test
// blocks need this; named opts make the call site self-explanatory.
const mkPush = ({ id = "p1", author, comments }) =>
  ({ id, author, revisions: [{ comments }] });

describe("extractDNums", () => {
  it("finds the canonical Differential Revision URL", () => {
    const text =
      "Bug 1234 - Add foo, r=reviewer\n" +
      "\n" +
      "Differential Revision: https://phabricator.services.mozilla.com/D296708";
    expect(extractDNums(text)).toEqual(["296708"]);
  });

  it("ignores prose D-URL mentions in commit bodies", () => {
    const text =
      "Bug 1234 - Add foo\n" +
      "\n" +
      "This is similar to https://phabricator.services.mozilla.com/D200000\n" +
      "but resolves a different issue. Compare to D199999 in the discussion.\n" +
      "\n" +
      "Differential Revision: https://phabricator.services.mozilla.com/D296708";
    expect(extractDNums(text)).toEqual(["296708"]);
  });

  it("collects D-numbers from a multi-commit stack push", () => {
    const text =
      "Differential Revision: https://phabricator.services.mozilla.com/D100\n" +
      "Differential Revision: https://phabricator.services.mozilla.com/D101\n" +
      "Differential Revision: https://phabricator.services.mozilla.com/D102";
    expect(extractDNums(text)).toEqual(["100", "101", "102"]);
  });

  it("dedups repeated mentions of the same D-number", () => {
    const text =
      "Differential Revision: https://phabricator.services.mozilla.com/D42\n" +
      "Differential Revision: https://phabricator.services.mozilla.com/D42";
    expect(extractDNums(text)).toEqual(["42"]);
  });

  it("returns [] for null / undefined / empty input", () => {
    expect(extractDNums(null)).toEqual([]);
    expect(extractDNums(undefined)).toEqual([]);
    expect(extractDNums("")).toEqual([]);
  });

  it("rejects D-URL with non-digit suffix as a different identifier", () => {
    // "phab/D296708abcdef" should not be parsed as 296708 — \b boundary.
    const text =
      "Differential Revision: https://phabricator.services.mozilla.com/D296708abcdef";
    expect(extractDNums(text)).toEqual([]);
  });

  it("matches a lowercased 'differential revision:' marker (case-insensitive)", () => {
    // The regex carries the `i` flag, so commits that lowercase the marker
    // (rare in hg but legal) still resolve.
    const text =
      "differential revision: https://phabricator.services.mozilla.com/D42";
    expect(extractDNums(text)).toEqual(["42"]);
  });

  it("rejects D-URLs hosted on a different Phabricator instance", () => {
    // We only trust phabricator.services.mozilla.com; another instance's
    // D-URL is a coincidental string match and must not leak into results.
    const text =
      "Differential Revision: https://phabricator.example.com/D42";
    expect(extractDNums(text)).toEqual([]);
  });
});

describe("extractBugNums", () => {
  it("matches a canonical 'Bug N - subject' line at line start", () => {
    expect(extractBugNums("Bug 12345 - add foo")).toEqual(["12345"]);
  });

  it("ignores mid-line prose mentions like 'regression of Bug N'", () => {
    expect(extractBugNums("regression of Bug 12345 fix")).toEqual([]);
  });

  it("ignores parenthesized or indented body mentions", () => {
    // Real example from a commit body: "(Bug 2035650)." inside an
    // unrelated paragraph should not surface as a backlink.
    const text =
      "Bug 2026686 - Extend nsAutoLowPriorityIO to Linux\n" +
      "\n" +
      "Not enabled on Android because the platform seccomp filter blocks\n" +
      "ioprio_get/ioprio_set on at least arm32 (Bug 2035650).\n" +
      "    Bug 9999 indented in a quoted reply\n";
    expect(extractBugNums(text)).toEqual(["2026686"]);
  });

  it("collects every canonical subject in a multi-commit stack", () => {
    const text =
      "Bug 100 - one\n" +
      "\n" +
      "body mentions (Bug 999) which is unrelated to this push\n" +
      "Bug 200 - two\n" +
      "Bug 300 - three";
    expect(extractBugNums(text)).toEqual(["100", "200", "300"]);
  });

  it("dedups within a single text", () => {
    const text = "Bug 1 - thing\nBug 1 - same bug again";
    expect(extractBugNums(text)).toEqual(["1"]);
  });

  it("matches case-insensitively (lowercased 'bug')", () => {
    expect(extractBugNums("bug 12345 - lowercased")).toEqual(["12345"]);
  });

  it("returns [] for empty / null", () => {
    expect(extractBugNums("")).toEqual([]);
    expect(extractBugNums(null)).toEqual([]);
  });
});

describe("bugRegex", () => {
  it("matches a canonical 'Bug N - subject' commit subject", () => {
    expect(bugRegex(296708).test("Bug 296708 - Add foo")).toBe(true);
  });

  it("matches when 'Bug N' appears at the start of any line in a multi-line commit", () => {
    const text = "Original message text\nBug 296708 - Add foo on a continuation line";
    expect(bugRegex(296708).test(text)).toBe(true);
  });

  it("does NOT match prose mid-line mentions like 'regression of Bug N'", () => {
    expect(bugRegex(296708).test("regression of Bug 296708 fix")).toBe(false);
  });

  it("does not partially match a different bug whose number contains the queried digits", () => {
    // 296708 should not match "Bug 2967081" (no \b boundary glitch)
    expect(bugRegex(296708).test("Bug 2967081 - other thing")).toBe(false);
  });

  it("does not match indented 'Bug N' lines (anchor is strict line-start)", () => {
    // The regex anchors on `^Bug` with the `m` flag — indented lines start
    // with whitespace, so they aren't treated as commit subjects. Pinning
    // this behavior so a future loosening doesn't silently match prose.
    expect(bugRegex(296708).test("   Bug 296708 - subject")).toBe(false);
  });

  it("matches case-insensitively (lowercased 'bug')", () => {
    expect(bugRegex(296708).test("bug 296708 - lowercased")).toBe(true);
  });
});

describe("normSubject", () => {
  it("strips 'Bug N - ' prefix and 'r=reviewer' suffix", () => {
    expect(normSubject("Bug 1234 - Add foo r=jane"))
      .toBe("add foo");
  });

  it("lowercases", () => {
    expect(normSubject("Refactor THE Thing")).toBe("refactor the thing");
  });

  it("handles missing prefix or suffix", () => {
    expect(normSubject("Just a description")).toBe("just a description");
    expect(normSubject("")).toBe("");
    expect(normSubject(null)).toBe("");
  });

  it("strips the prefix when an en-dash or em-dash is used as the separator", () => {
    // hg/Phab commits occasionally use Unicode dashes instead of '-'; the
    // separator class includes both en-dash (U+2013) and em-dash (U+2014).
    expect(normSubject("Bug 1 – add foo")).toBe("add foo");
    expect(normSubject("Bug 1 — add foo")).toBe("add foo");
  });
});

describe("stripPhabSuffix", () => {
  it("removes ' - Phabricator' page-title suffix", () => {
    expect(stripPhabSuffix("D296708 Add foo - Phabricator")).toBe("D296708 Add foo");
  });

  it("removes ' - Differential - Phabricator' variant", () => {
    expect(stripPhabSuffix("D1 Bar - Differential - Phabricator")).toBe("D1 Bar");
  });

  it("returns null for empty / undefined", () => {
    expect(stripPhabSuffix(null)).toBeNull();
    expect(stripPhabSuffix("")).toBeNull();
    expect(stripPhabSuffix("   ")).toBeNull();
  });

  it("preserves a plain title that has no Phabricator suffix", () => {
    expect(stripPhabSuffix("D1 Hello World")).toBe("D1 Hello World");
  });

  it("strips the suffix when middle-dot or bullet is used as the separator", () => {
    // Some browsers/themes render the page title with `·` or `•`; the
    // separator class accepts both.
    expect(stripPhabSuffix("D1 Foo · Phabricator")).toBe("D1 Foo");
    expect(stripPhabSuffix("D1 Foo • Differential • Phabricator")).toBe("D1 Foo");
  });
});

describe("escapeHostName", () => {
  it("escapes regex-special characters so a hostname is safe to splice into a regex", () => {
    // Hostnames can contain `.` and (rarely, in test fixtures) other meta
    // chars; the escaped form has each such char preceded by `\`.
    expect(escapeHostName("foo.bar.example.com")).toBe("foo\\.bar\\.example\\.com");
    expect(escapeHostName("a+b*c?")).toBe("a\\+b\\*c\\?");
  });

  it("leaves regex-neutral characters untouched", () => {
    expect(escapeHostName("hostname123")).toBe("hostname123");
  });
});

describe("titleMatchesSubjects", () => {
  it("matches when title (after D-prefix strip and norm) is contained in a subject", () => {
    const title = "D296708 Add a long descriptive title for the thing";
    const subjects = [normSubject("Bug 1234 - Add a long descriptive title for the thing r=jane")];
    expect(titleMatchesSubjects(title, subjects)).toBe(true);
  });

  it("matches in either direction (subject ⊂ title or title ⊂ subject)", () => {
    const title = "D1 a really long descriptive sentence here about foo";
    const subjects = ["a really long descriptive sentence"];
    expect(titleMatchesSubjects(title, subjects)).toBe(true);
  });

  it("rejects matches under MIN_TITLE_MATCH_LEN to avoid false positives on short titles", () => {
    const title = "D1 fix";
    const subjects = ["fix"];
    expect(titleMatchesSubjects(title, subjects)).toBe(false);
  });

  it("returns false when title is null / empty", () => {
    expect(titleMatchesSubjects(null, ["any subject text here long enough"])).toBe(false);
    expect(titleMatchesSubjects("",   ["any subject text here long enough"])).toBe(false);
  });

  it("returns false when every subject is shorter than MIN_TITLE_MATCH_LEN", () => {
    // Subject-side length filter mirrors the title-side filter; otherwise
    // a 3-char subject like "fix" would fuzz-match too aggressively.
    const title = "D1 a long descriptive title above the threshold";
    expect(titleMatchesSubjects(title, ["fix", "wip", "tweak"])).toBe(false);
  });

  it("returns false when the subject array is empty", () => {
    expect(titleMatchesSubjects("D1 a long descriptive title here", [])).toBe(false);
  });
});

describe("pushComments", () => {
  it("joins all revisions[].comments with newlines", () => {
    const push = { revisions: [{ comments: "a" }, { comments: "b" }, { comments: "c" }] };
    expect(pushComments(push)).toBe("a\nb\nc");
  });

  it("treats missing revisions as empty", () => {
    expect(pushComments({})).toBe("");
    expect(pushComments({ revisions: [] })).toBe("");
  });

  it("treats missing per-rev comments as empty", () => {
    const push = { revisions: [{ comments: "a" }, {}, { comments: "c" }] };
    expect(pushComments(push)).toBe("a\n\nc");
  });
});

describe("tryWalkCandidates", () => {
  const ME = "leggert@mozilla.com";

  it("includes pushes by a known creator with no Diff Rev URL", () => {
    const pool = [mkPush({ author: ME, comments: "try: -b o ...\n\nPushed via mach try auto" })];
    expect(tryWalkCandidates(pool, [ME], new Set())).toHaveLength(1);
  });

  it("excludes pushes already matched directly (in directIds)", () => {
    const pool = [mkPush({ author: ME, comments: "try: -b o ..." })];
    expect(tryWalkCandidates(pool, [ME], new Set(["p1"]))).toEqual([]);
  });

  it("excludes pushes by other authors (other-developer mach-try-auto)", () => {
    const pool = [mkPush({ author: "someone-else@mozilla.com", comments: "try: -b o ..." })];
    expect(tryWalkCandidates(pool, [ME], new Set())).toEqual([]);
  });

  it("excludes pushes that already carry a Diff Rev URL (not mach-try-auto)", () => {
    const pool = [mkPush({ author: ME,
      comments: "Bug 1 - thing\n\nDifferential Revision: https://phabricator.services.mozilla.com/D9" })];
    expect(tryWalkCandidates(pool, [ME], new Set())).toEqual([]);
  });

  it("matches against a Set of multiple creators (Bugzilla page case)", () => {
    const pool = [
      mkPush({ id: "p1", author: "alice@mozilla.com", comments: "try: ..." }),
      mkPush({ id: "p2", author: "bob@mozilla.com",   comments: "try: ..." }),
      mkPush({ id: "p3", author: "eve@mozilla.com",   comments: "try: ..." }),
    ];
    expect(tryWalkCandidates(pool, ["alice@mozilla.com", "bob@mozilla.com"], new Set()))
      .toHaveLength(2);
  });
});

describe("subjectsFromPush", () => {
  it("normalizes the first line of every revision and drops empty ones", () => {
    const push = { revisions: [
      { comments: "Bug 1 - Add foo r=jane\n\nbody text" },
      { comments: "Refactor THE Thing\n\nmore" },
      { comments: "" },
    ]};
    expect(subjectsFromPush(push)).toEqual(["add foo", "refactor the thing"]);
  });

  it("returns [] when revisions is missing", () => {
    expect(subjectsFromPush({})).toEqual([]);
  });

  it("treats a revision with missing comments as empty (filtered out)", () => {
    const push = { revisions: [{}, { comments: "Bug 1 - real subject" }] };
    expect(subjectsFromPush(push)).toEqual(["real subject"]);
  });
});

describe("dedupById", () => {
  it("keeps first occurrence and drops later duplicates by id", () => {
    const arr = [{ id: 1, n: "a" }, { id: 2, n: "b" }, { id: 1, n: "c" }];
    expect(dedupById(arr)).toEqual([{ id: 1, n: "a" }, { id: 2, n: "b" }]);
  });

  it("filters out null / undefined entries", () => {
    expect(dedupById([null, { id: 1 }, undefined, { id: 2 }]))
      .toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("accepts null / undefined input as empty", () => {
    expect(dedupById(null)).toEqual([]);
    expect(dedupById(undefined)).toEqual([]);
  });
});

describe("byPushTimestampDesc", () => {
  it("sorts newest first", () => {
    const pushes = [
      { id: "a", push_timestamp: 100 },
      { id: "b", push_timestamp: 300 },
      { id: "c", push_timestamp: 200 },
    ];
    expect([...pushes].sort(byPushTimestampDesc).map(p => p.id))
      .toEqual(["b", "c", "a"]);
  });
});

describe("URL builders", () => {
  // URLSearchParams stringifies to "key=val&…", so the params row is
  // expanded inline at table-build time rather than per-row.
  const histParams = new URLSearchParams({ author: "a@b.c", count: "200" });

  it.each([
    ["treeherderJobsUrl includes repo and revision",
      () => treeherderJobsUrl("autoland", "abc123"),
      "https://treeherder.mozilla.org/jobs?repo=autoland&revision=abc123"],
    ["treeherderPushByRevUrl uses ?revision= for single-push lookup",
      () => treeherderPushByRevUrl("try", "deadbeef"),
      "https://treeherder.mozilla.org/api/project/try/push/?revision=deadbeef"],
    ["treeherderHealthUrl hits the health_summary endpoint",
      () => treeherderHealthUrl("mozilla-central", "cafef00d"),
      "https://treeherder.mozilla.org/api/project/mozilla-central/push/health_summary/?revision=cafef00d"],
    ["treeherderRecentUrl uses ?count= for windowed scan",
      () => treeherderRecentUrl("try", 500),
      "https://treeherder.mozilla.org/api/project/try/push/?count=500"],
    ["treeherderAuthorHistoryUrl appends URLSearchParams verbatim",
      () => treeherderAuthorHistoryUrl("try", histParams),
      "https://treeherder.mozilla.org/api/project/try/push/?author=a%40b.c&count=200"],
    ["hgRevUrl points at hg-edge json-rev under /try",
      () => hgRevUrl("c0ffee"),
      "https://hg-edge.mozilla.org/try/json-rev/c0ffee"],
    ["phabRevUrl emits the canonical /D{n} path",
      () => phabRevUrl("296708"),
      "https://phabricator.services.mozilla.com/D296708"],
    ["bugAttachmentsUrl asks only for the fields we use",
      () => bugAttachmentsUrl("2026686"),
      "https://bugzilla.mozilla.org/rest/bug/2026686/attachment?include_fields=file_name,is_obsolete,creator"],
  ])("%s", (_name, build, expected) => {
    expect(build()).toBe(expected);
  });
});

describe("cache-key formatters", () => {
  it("pushCacheKey is `${repo}:${rev}`", () => {
    expect(pushCacheKey("try", "abc")).toBe("try:abc");
  });

  it("historyCacheKey is `${repo}:${email}` (lowercase preserved as-is)", () => {
    expect(historyCacheKey("try", "Lars@mozilla.com")).toBe("try:Lars@mozilla.com");
  });
});

describe("extractDStatus", () => {
  // Real Phab markup uses class="phui-header-subheader" wrapping a
  // phui-tag-view → phui-tag-core span. The first inner span is an icon
  // (aria-hidden), the trailing text is the status.
  const wrap = status =>
    `<div class="phui-header-subheader"><span class="phui-tag-view phui-tag-shade">` +
    `<span class="phui-tag-core "><span class="phui-icon-view fa-plane" aria-hidden="true"></span>` +
    `${status}</span></span></div>`;

  it.each(["Abandoned", "Closed", "Needs Review", "Changes Planned"])(
    "extracts '%s' from the header subheader",
    status => expect(extractDStatus(wrap(status))).toBe(status));

  it("returns null when the subheader is absent", () => {
    expect(extractDStatus("<html><body><h1>nothing</h1></body></html>")).toBeNull();
  });

  it("returns null for empty / null input", () => {
    expect(extractDStatus("")).toBeNull();
    expect(extractDStatus(null)).toBeNull();
  });
});

describe("dRevisionIsAbandoned / dRevisionIsLanded", () => {
  it("treats 'Abandoned' as abandoned", () => {
    expect(dRevisionIsAbandoned("Abandoned")).toBe(true);
    expect(dRevisionIsAbandoned("Closed")).toBe(false);
    expect(dRevisionIsAbandoned("Needs Review")).toBe(false);
    expect(dRevisionIsAbandoned(null)).toBe(false);
  });

  it("treats 'Closed' (landed) as landed", () => {
    expect(dRevisionIsLanded("Closed")).toBe(true);
    expect(dRevisionIsLanded("Accepted")).toBe(false);
    expect(dRevisionIsLanded("Abandoned")).toBe(false);
    expect(dRevisionIsLanded(null)).toBe(false);
  });
});

describe("bug status helpers", () => {
  const open      = { status: "NEW",      resolution: "",         is_open: true  };
  const fixed     = { status: "RESOLVED", resolution: "FIXED",    is_open: false };
  const wontfix   = { status: "RESOLVED", resolution: "WONTFIX",  is_open: false };
  const dup       = { status: "RESOLVED", resolution: "DUPLICATE",is_open: false };
  const verified  = { status: "VERIFIED", resolution: "FIXED",    is_open: false };

  it("bugIsClosed prefers the boolean is_open field when present", () => {
    expect(bugIsClosed(open)).toBe(false);
    expect(bugIsClosed(fixed)).toBe(true);
    expect(bugIsClosed(verified)).toBe(true);
  });

  it("bugIsClosed falls back to status when is_open is missing", () => {
    expect(bugIsClosed({ status: "NEW" })).toBe(false);
    expect(bugIsClosed({ status: "RESOLVED" })).toBe(true);
    expect(bugIsClosed({ status: "ASSIGNED" })).toBe(false);
  });

  it("bugIsClosed handles null / missing input", () => {
    expect(bugIsClosed(null)).toBe(false);
    expect(bugIsClosed(undefined)).toBe(false);
    expect(bugIsClosed({})).toBe(false);
  });

  it("bugIsLanded is true only for closed FIXED bugs", () => {
    expect(bugIsLanded(fixed)).toBe(true);
    expect(bugIsLanded(verified)).toBe(true);
    expect(bugIsLanded(wontfix)).toBe(false);
    expect(bugIsLanded(dup)).toBe(false);
    expect(bugIsLanded(open)).toBe(false);
  });

  it("bugIsDuplicate is true only for closed DUPLICATE bugs", () => {
    expect(bugIsDuplicate(dup)).toBe(true);
    expect(bugIsDuplicate(fixed)).toBe(false);
    expect(bugIsDuplicate(open)).toBe(false);
  });

  it("bugIsClosedNoLand covers every closed-without-fix resolution", () => {
    expect(bugIsClosedNoLand(wontfix)).toBe(true);
    expect(bugIsClosedNoLand(dup)).toBe(true);
    expect(bugIsClosedNoLand({ status: "RESOLVED", resolution: "INVALID",  is_open: false })).toBe(true);
    expect(bugIsClosedNoLand({ status: "RESOLVED", resolution: "INCOMPLETE", is_open: false })).toBe(true);
    // Landed (FIXED) and open bugs do NOT count.
    expect(bugIsClosedNoLand(fixed)).toBe(false);
    expect(bugIsClosedNoLand(open)).toBe(false);
  });
});

describe("backoutTargets / isBackedOut", () => {
  it("collects 12-char prefixes from 'Backed out changeset HASH' lines", () => {
    const pool = [mkPush({ comments:
      "Backed out 2 changesets (Bug 1) for failures CLOSED TREE\n" +
      "Backed out changeset abc123def456 (Bug 2)\n" +
      "Backed out changeset 7e8f9a0b1c2d (Bug 3)" })];
    const set = backoutTargets(pool);
    expect(set.has("abc123def456")).toBe(true);
    expect(set.has("7e8f9a0b1c2d")).toBe(true);
    expect(set.size).toBe(2);
  });

  it("ignores prose mentions like 'we should back out X' (not a backout subject)", () => {
    const pool = [mkPush({ comments:
      "Bug 1 - thing r=jane\n\nwe should back out abc123def456 next week if this regresses" })];
    expect(backoutTargets(pool).size).toBe(0);
  });

  it("normalises target hashes to lowercase 12-char prefixes", () => {
    const pool = [mkPush({ comments:
      "Backed out changeset ABC123DEF456789ABCDEF0123456789ABCDEF012" })];
    expect([...backoutTargets(pool)]).toEqual(["abc123def456"]);
  });

  it("isBackedOut matches a push by its 12-char hash prefix", () => {
    const set = new Set(["abc123def456"]);
    expect(isBackedOut(set, "abc123def456789012345678")).toBe(true);
    expect(isBackedOut(set, "ABC123DEF456789012345678")).toBe(true);
    expect(isBackedOut(set, "deadbeefcafe")).toBe(false);
  });

  it("isBackedOut returns false for null set / null revision", () => {
    expect(isBackedOut(null, "abc123def456")).toBe(false);
    expect(isBackedOut(new Set(["abc123def456"]), null)).toBe(false);
    expect(isBackedOut(undefined, "abc")).toBe(false);
  });

  it("backoutTargets handles null / empty pool", () => {
    expect(backoutTargets(null).size).toBe(0);
    expect(backoutTargets([]).size).toBe(0);
  });

  it("backoutTargets is robust to pushes with missing revisions / empty comments", () => {
    const pool = [
      { id: "p1" },                                  // no revisions
      { id: "p2", revisions: [{}] },                 // revision without comments
      { id: "p3", revisions: [{ comments: "Bug 1 - thing" }] }, // not a backout
    ];
    expect(backoutTargets(pool).size).toBe(0);
  });
});

describe("FetchErrorTracker", () => {
  it("starts empty", () => {
    const t = new FetchErrorTracker();
    expect(t.toJSON()).toEqual([]);
  });

  it("records {url, status, message} entries in insertion order", () => {
    const t = new FetchErrorTracker();
    t.record("https://hg-edge.mozilla.org/try/json-rev/abc", 406, "blocked");
    t.record("https://treeherder.mozilla.org/api/project/try/push/?count=500", null, "Network error");
    expect(t.toJSON()).toEqual([
      { url: "https://hg-edge.mozilla.org/try/json-rev/abc", status: 406, message: "blocked" },
      { url: "https://treeherder.mozilla.org/api/project/try/push/?count=500", status: null, message: "Network error" },
    ]);
  });

  it("JSON-serializes via the toJSON hook for postMessage transit", () => {
    // The panel receives the tracker's payload via port.postMessage, which
    // structured-clones it. JSON.stringify exercises the same `toJSON`
    // path and is a fair stand-in for the serialization shape.
    const t = new FetchErrorTracker();
    t.record("u", 500, "boom");
    expect(JSON.parse(JSON.stringify(t)))
      .toEqual([{ url: "u", status: 500, message: "boom" }]);
  });
});
