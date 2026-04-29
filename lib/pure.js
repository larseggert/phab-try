// Pure helpers — no browser globals, no fetch, no DOM. Loaded into the
// extension's global script scope by manifest.json (so background.js sees
// these as bare names) and also CommonJS-exported at the bottom so the
// vitest suite under test/ can import this file directly.

const PHAB_HOST     = "phabricator.services.mozilla.com";
const BUGZILLA_HOST = "bugzilla.mozilla.org";

// Bugzilla attachment file_name pattern that marks a Phab "Run on try"
// link attachment — captures the D-number it points at. Same shape on
// every bug since Lando/Phabricator generate the filename canonically.
const PHAB_ATTACHMENT_RE = /^phabricator-D(\d+)-url\.txt$/;

const TREEHERDER_BASE = "https://treeherder.mozilla.org";
// hg-edge directly: hg.mozilla.org redirects cross-origin to the CDN edge
// and that redirect path returns 406 from cached states.
const HG_TRY_BASE     = "https://hg-edge.mozilla.org/try";
const PHAB_BASE       = `https://${PHAB_HOST}`;
const BUGZILLA_BASE   = `https://${BUGZILLA_HOST}`;

function escapeHostName(host) {
  return host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A D-revision is canonically named only on a "Differential Revision: <URL>"
// line of a commit message; prose mentions of D-URLs anywhere else are
// ignored.
function makePhabDRe() {
  return new RegExp(
    `Differential Revision:\\s*https?:\\/\\/${escapeHostName(PHAB_HOST)}\\/D(\\d+)\\b`, "gi");
}

function extractDNums(text) {
  return [...new Set([...(text ?? "").matchAll(makePhabDRe())].map(m => m[1]))];
}

// Extracts bug numbers from canonical "Bug N - subject" commit subject
// lines only — line-anchored (^Bug…) so prose mentions in commit bodies
// like "(Bug 2035650)" or "regression of Bug 12345" don't surface as
// backlinks for a push that doesn't actually carry that bug.
function extractBugNums(text) {
  return [...new Set([...(text ?? "").matchAll(/^Bug\s+(\d+)\b/gim)].map(m => m[1]))];
}

// "Bug NNN - subject" is the canonical commit subject prefix; line-anchored
// so mid-line prose like "regression of Bug 12345" doesn't match.
function bugRegex(b) {
  return new RegExp(`^Bug\\s+${b}\\b`, "im");
}

function normSubject(line) {
  return (line ?? "")
    .replace(/^\s*Bug\s+\d+\s*[-–—]\s*/i, "")
    .replace(/\s+r=\S+\s*$/i, "")
    .trim().toLowerCase();
}

function stripPhabSuffix(t) {
  return (t ?? "")
    .replace(/\s*[-–—·•]\s*(Differential\s*[-–—·•]\s*)?Phabricator\s*$/i, "")
    .trim() || null;
}

const MIN_TITLE_MATCH_LEN = 15;

function titleMatchesSubjects(title, subjects) {
  const t = normSubject((title ?? "").replace(/^D\d+\s+/i, ""));
  if (!t || t.length < MIN_TITLE_MATCH_LEN) return false;
  return subjects.some(s => s.length >= MIN_TITLE_MATCH_LEN && (s.includes(t) || t.includes(s)));
}

function pushComments(push) {
  return (push.revisions ?? []).map(r => r.comments ?? "").join("\n");
}

// --- Status classification ---

// D-revision status text appears inside <div class="phui-header-subheader">
// as the first <span class="phui-tag-core">…<icon-span></icon-span>STATUS</span>.
// Returns the trimmed status text ("Abandoned", "Closed", "Needs Review",
// "Accepted", "Changes Planned", "Draft", …) or null.
//
// Anchored on the literal `<div class="phui-header-subheader"` opener so a
// stray `class="phui-header-subheader` substring inside an inline <style>
// or a data-* attribute earlier in the document can't redirect the lazy
// scan into the wrong section.
function extractDStatus(html) {
  const m = (html ?? "").match(
    /<div class="phui-header-subheader[\s\S]*?<span class="phui-tag-core[^"]*"[^>]*>(?:<span [^>]*aria-hidden="true"[^>]*><\/span>)?\s*([^<]+?)\s*<\/span>/);
  return m ? m[1].trim() : null;
}

const dRevisionIsAbandoned = status => status === "Abandoned";
const dRevisionIsLanded    = status => status === "Closed";

// Bugzilla bug states — closed / open / specific-resolution helpers.
// Input shape: { status, resolution, is_open } as returned by /rest/bug.
const BUG_OPEN_STATUSES = new Set(["UNCONFIRMED", "NEW", "ASSIGNED", "REOPENED"]);

function bugIsClosed(bug) {
  if (!bug) return false;
  if (typeof bug.is_open === "boolean") return !bug.is_open;
  return bug.status != null && !BUG_OPEN_STATUSES.has(bug.status);
}

const bugIsLanded         = bug => bugIsClosed(bug) && bug?.resolution === "FIXED";
const bugIsDuplicate      = bug => bugIsClosed(bug) && bug?.resolution === "DUPLICATE";
// "Closed without landing" — the resolution buckets that mean the bug went
// away without a fix being shipped.
const bugIsClosedNoLand   = bug => bugIsClosed(bug) && bug?.resolution !== "FIXED";

// --- Backout detection ---

// Mercurial/Lando backout commit subjects. Matches "Backed out N changesets"
// and the per-line "Backed out changeset HASH" entries inside the body.
// Returns the set of 12-char target-hash prefixes (lowercased) referenced
// from any "Backed out" commit in the pool.
function backoutTargets(pool) {
  const targets = new Set();
  for (const p of pool ?? []) {
    for (const r of p.revisions ?? []) {
      const text = r.comments ?? "";
      // Only mine commits whose first line is a Backout subject. This also
      // rules out prose mentions ("we should back out X") in unrelated
      // commit bodies.
      if (!/^Back(?:ed)? out\b/im.test(text)) continue;
      for (const m of text.matchAll(/\b[a-f0-9]{12,40}\b/gi)) {
        targets.add(m[0].toLowerCase().slice(0, 12));
      }
    }
  }
  return targets;
}

// 12 chars chosen to match Mercurial's short-hash convention: backout
// commits cite the target as a 12-char prefix, while Treeherder push
// objects carry the full 40-char SHA. Truncating both sides aligns the
// comparison. (48 bits of entropy makes accidental collisions across a
// per-repo recent-pushes window negligible — don't tighten this without
// rechecking that.)
const isBackedOut = (set, revision) =>
  !!set && set.has((revision ?? "").toLowerCase().slice(0, 12));

// Pre-filter for the hg parent-walk: a candidate is a try push with no
// canonical Diff Rev URL anywhere in its commits, authored by one of the
// known patch creators, and not already a direct match.
function tryWalkCandidates(tryPool, creators, directIds) {
  const creatorSet = new Set(creators);
  return tryPool.filter(p =>
    !directIds.has(p.id)
    && creatorSet.has(p.author)
    && extractDNums(pushComments(p)).length === 0
  );
}

// First-line commit subject of every revision on a push, normalized and
// non-empty. Used to fuzzy-match Phab revision titles against pushes that
// carry no Diff Rev URL.
function subjectsFromPush(push) {
  return (push.revisions ?? [])
    .map(r => normSubject((r.comments ?? "").split("\n")[0]))
    .filter(Boolean);
}

// Dedup by `.id`, preserving first occurrence; null/undefined entries drop.
function dedupById(arr) {
  const seen = new Set();
  return (arr ?? []).filter(p => p && !seen.has(p.id) && seen.add(p.id));
}

// Newest-first comparator for Treeherder push objects.
const byPushTimestampDesc = (a, b) => b.push_timestamp - a.push_timestamp;

// Run an async fn and swallow its error, returning null. Useful for
// fire-and-forget operations whose failure shouldn't tear down the
// caller (DOM event-listener handlers, cache priming, etc.).
const safely = async fn => { try { return await fn(); } catch (_e) { return null; } };

// --- URL builders (one per Treeherder/hg/Phab/Bugzilla endpoint we hit) ---
//
// Pure string assembly, isolated here so a typo in a repo name or a path
// is unit-testable. The query-string params are the same shape the
// canonical sources document in DATA.md.

const treeherderJobsUrl =
  (repo, rev) => `${TREEHERDER_BASE}/jobs?repo=${repo}&revision=${rev}`;

const treeherderPushByRevUrl =
  (repo, rev) => `${TREEHERDER_BASE}/api/project/${repo}/push/?revision=${rev}`;

const treeherderHealthUrl =
  (repo, rev) => `${TREEHERDER_BASE}/api/project/${repo}/push/health_summary/?revision=${rev}`;

const treeherderRecentUrl =
  (repo, count) => `${TREEHERDER_BASE}/api/project/${repo}/push/?count=${count}`;

// Author history takes a URLSearchParams (or any string-coercible) so the
// caller can vary author/count/since with a single builder.
const treeherderAuthorHistoryUrl =
  (repo, params) => `${TREEHERDER_BASE}/api/project/${repo}/push/?${params}`;

const hgRevUrl = rev => `${HG_TRY_BASE}/json-rev/${rev}`;

const phabRevUrl = d => `${PHAB_BASE}/D${d}`;

const bugAttachmentsUrl = bug =>
  `${BUGZILLA_BASE}/rest/bug/${bug}/attachment?include_fields=file_name,is_obsolete,creator`;

// Cache-key formatters (per DATA.md caching policy).
const pushCacheKey    = (repo, rev)   => `${repo}:${rev}`;
const historyCacheKey = (repo, email) => `${repo}:${email}`;

// --- Fetch error tracking ---
//
// Each search constructs one tracker and passes it to per-fetch helpers;
// `toJSON()` is what the panel renders as a non-fatal warning banner.

class FetchErrorTracker {
  constructor() { this.entries = []; }
  record(url, status, message) {
    this.entries.push({ url, status, message });
  }
  toJSON() { return this.entries; }
}

// CommonJS export for the test suite. Browsers ignore this branch — `module`
// is undefined in extension script scope, so the assignment is skipped.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    PHAB_HOST, BUGZILLA_HOST, PHAB_ATTACHMENT_RE,
    TREEHERDER_BASE, HG_TRY_BASE, PHAB_BASE, BUGZILLA_BASE,
    escapeHostName, extractDNums, extractBugNums,
    bugRegex, normSubject, stripPhabSuffix,
    titleMatchesSubjects, pushComments, tryWalkCandidates,
    extractDStatus, dRevisionIsAbandoned, dRevisionIsLanded,
    bugIsClosed, bugIsLanded, bugIsDuplicate, bugIsClosedNoLand,
    BUG_OPEN_STATUSES,
    backoutTargets, isBackedOut,
    subjectsFromPush, dedupById, byPushTimestampDesc, safely,
    treeherderJobsUrl, treeherderPushByRevUrl, treeherderHealthUrl,
    treeherderRecentUrl, treeherderAuthorHistoryUrl,
    hgRevUrl, phabRevUrl, bugAttachmentsUrl,
    pushCacheKey, historyCacheKey,
    FetchErrorTracker,
    MIN_TITLE_MATCH_LEN,
  };
}
