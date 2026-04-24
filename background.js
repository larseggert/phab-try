const TREEHERDER_BASE  = "https://treeherder.mozilla.org";
const HG_TRY_BASE      = "https://hg.mozilla.org/try";
const PHAB_BASE        = "https://phabricator.services.mozilla.com";
const BUGZILLA_BASE    = "https://bugzilla.mozilla.org";
const CACHE_TTL_MS     = 2 * 60 * 1000;

// Derive regex patterns from URL constants to avoid duplicating hostname strings.
const escapeHost   = url => new URL(url).host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const PHAB_D_SRC   = `${escapeHost(PHAB_BASE)}\\/D(\\d+)`;
const phabDRe      = () => new RegExp(PHAB_D_SRC, "g");  // fresh instance per call (g-flag is stateful)
const BUG_URL_RE   = new RegExp(`${escapeHost(BUGZILLA_BASE)}\\/show_bug\\.cgi\\?id=(\\d+)`);

const safely = async fn => { try { return await fn(); } catch (_e) { return null; } };

async function fetchJson(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Fetch failed: ${resp.status} (${url})`);
  return resp.json();
}

async function fetchTryPushes({ author, count, since, revision } = {}) {
  const params = new URLSearchParams({ count: count ?? (author ? 1000 : 200) });
  if (author)   params.set("author", author);
  if (since)    params.set("push_timestamp__gt", since);
  if (revision) params.set("revision", revision);
  return (await fetchJson(`${TREEHERDER_BASE}/api/project/try/push/?${params}`)).results ?? [];
}

async function fetchPushHealthSummary(revision) {
  // Endpoint returns an array; take the first element
  const data = await fetchJson(
    `${TREEHERDER_BASE}/api/project/try/push/health_summary/?revision=${revision}`
  );
  return (Array.isArray(data) ? data[0] : data) ?? null;
}

const pushComments = push => (push.revisions ?? []).map(r => r.comments ?? "").join("\n");

const phabNeedle = dNumber => `${PHAB_BASE}/D${dNumber}`;

function extractLinks(text) {
  const uniq    = re => [...new Set([...text.matchAll(re)].map(m => m[1]))];
  const dNums   = uniq(phabDRe());
  const bugNums = uniq(/\bBug\s+(\d+)\b/gi);
  return (dNums.length || bugNums.length) ? { dNums, bugNums } : null;
}

// Shared Phabricator HTML cache: avoids duplicate fetches between resolveLinks
// (bug-number lookup) and getDTitle (title extraction) for the same D-number.
// Entries expire after CACHE_TTL_MS to avoid accumulating unbounded HTML blobs.
const phabHtmlCache = new Map();
const fetchPhabHtml = dNum => {
  const entry = phabHtmlCache.get(dNum);
  if (entry && Date.now() - entry.ts < CACHE_TTL_MS) return entry.promise;
  const promise = safely(async () => {
    const resp = await fetch(`${PHAB_BASE}/D${dNum}`);
    if (!resp.ok || !resp.url.startsWith(`${PHAB_BASE}/D`)) return null;
    return resp.text();
  });
  phabHtmlCache.set(dNum, { promise, ts: Date.now() });
  promise.then(html => { if (html == null) phabHtmlCache.delete(dNum); });
  return promise;
};

// Normalize a single commit subject line for title-matching:
// strip optional "Bug N -" prefix, "r=..." reviewer suffix, then lowercase.
const normalizeSubject = line => (line ?? "")
  .replace(/^\s*Bug\s+\d+\s*[-–—]\s*/i, "")
  .replace(/\s+r=\S+\s*$/i, "")
  .trim().toLowerCase();

// Extract the first (subject) line of each revision in a push.
const revisionSubjects = push =>
  (push.revisions ?? []).map(r => (r.comments ?? "").split('\n')[0].trim()).filter(Boolean);

// Extract and decode the Phabricator page title, stripping site/section suffixes.
const extractPhabTitle = html => {
  const m = html?.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (!m) return null;
  const raw = new DOMParser().parseFromString(m[1], "text/html").body.textContent ?? m[1];
  return raw.replace(/\s*[-–—·•]\s*(Differential\s*[-–—·•]\s*)?Phabricator\s*$/i, "").trim() || null;
};

// Revision title normalised for matching: strip leading "D{n} " identifier, then apply
// the same subject normalisation used for commit lines (Bug prefix, r= suffix, lowercase).
const phabTitle = dNum =>
  fetchPhabHtml(dNum).then(html =>
    normalizeSubject(extractPhabTitle(html)?.replace(/^D\d+\s+/i, "")) || null);

// True if the normalized D-revision title overlaps with any of the commit subjects.
// Require a minimum length to avoid false positives from very short titles (e.g. "fix").
const MIN_TITLE_MATCH_LEN = 15;
const titleMatchesSubjects = (title, normSubjects) =>
  title?.length >= MIN_TITLE_MATCH_LEN &&
  normSubjects.some(s => s.length >= MIN_TITLE_MATCH_LEN && (s.includes(title) || title.includes(s)));

const augmentLinks = (links, key, vals) => vals.length ? { ...links, [key]: vals } : links;

// If links has D-numbers but no bug numbers, look up bug numbers from Phabricator pages.
async function withBugNums(links) {
  if (!links || links.bugNums.length) return links;
  const found = await Promise.all(
    links.dNums.map(d => fetchPhabHtml(d).then(
      html => html?.match(BUG_URL_RE)?.[1] ?? null
    ))
  );
  return augmentLinks(links, "bugNums", [...new Set(found.filter(Boolean))]);
}

// If links has bug numbers but no D-numbers, look up candidates from Bugzilla attachments
// and match each against the per-revision subject lines via Phabricator title comparison.
async function withDNums(links, subjects) {
  if (!links || links.dNums.length || !links.bugNums.length) return links;
  const normSubjects = subjects.map(normalizeSubject).filter(Boolean);

  const candidates = (await Promise.all(
    links.bugNums.map(b => safely(async () => {
      const data = await fetchJson(
        `${BUGZILLA_BASE}/rest/bug/${b}/attachment?include_fields=file_name,content_type,is_obsolete`
      );
      return (data.bugs?.[b] ?? [])
        .filter(a => a.content_type === "text/x-phabricator-request" && !a.is_obsolete)
        .map(a => a.file_name.match(/^phabricator-D(\d+)-url\.txt$/)?.[1])
        .filter(Boolean);
    }))
  )).flat().filter(Boolean);

  const unique = [...new Set(candidates)];
  const dNums = normSubjects.length
    ? (await Promise.all(unique.map(async d =>
        titleMatchesSubjects(await phabTitle(d), normSubjects) ? d : null
      ))).filter(Boolean)
    : unique;  // no subjects to compare — include all candidates

  return augmentLinks(links, "dNums", dNums);
}

async function resolveLinks(revision) {
  const [push] = await fetchTryPushes({ revision });
  if (!push) return null;

  const enrich = async (links, subjects) => withDNums(await withBugNums(links), subjects);

  const links = extractLinks(pushComments(push));
  if (links) return enrich(links, revisionSubjects(push));

  // Fallback: walk the hg parent commit for mach-try-auto pushes
  return safely(async () => {
    const { parents } = await fetchHgRevMeta(revision);
    if (!parents[0]) return null;
    const { desc } = await fetchHgRevMeta(parents[0]);
    const hgLinks = extractLinks(desc);
    return hgLinks ? enrich(hgLinks, [desc.split('\n')[0]]) : null;
  });
}

function filterPushes(pushes, dNumber, bugNumber) {
  if (dNumber)   return pushes.filter(p => pushComments(p).includes(phabNeedle(dNumber)));
  if (bugNumber && /^\d+$/.test(bugNumber)) {
    const re = new RegExp(`\\bBug\\s+${bugNumber}\\b`, "i");
    return pushes.filter(p => re.test(pushComments(p)));
  }
  return [];
}

// --- Cache ---

const cache = new Map();

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) { cache.delete(key); return null; }
  return entry.value;
}

function cacheSet(key, value) {
  cache.set(key, { ts: Date.now(), value });
}

// --- Persistent author-push store ---
// Keeps the full author push list in browser.storage.local so it survives
// browser restarts and accumulates history beyond the per-request fetch limit.
// On first use it fetches up to 1000 pushes; subsequent calls only fetch
// pushes since the last successful fetch (with a 1-hour overlap for safety).

const AUTHOR_CACHE_FRESH_SECS = 120;

async function getAuthorPushes(author) {
  const key = `push-store:${author}`;
  const nowSecs = Math.floor(Date.now() / 1000);

  const stored = await safely(() => browser.storage.local.get(key).then(r => r[key] ?? null));

  if (stored && nowSecs - stored.fetchedAt < AUTHOR_CACHE_FRESH_SECS) return stored.pushes;

  // Fetch only pushes since the last successful fetch (minus a 1-hour buffer).
  // On first use, fetch up to 1000 to maximise initial history.
  const fresh = await fetchTryPushes(
    stored
      ? { author, count: 200, since: stored.fetchedAt - 3600 }
      : { author, count: 1000 }
  );

  const all = mergePushes(fresh, stored?.pushes ?? []);
  await safely(() => browser.storage.local.set({ [key]: { pushes: all, fetchedAt: nowSecs } }));
  return all;
}

// --- Concurrency helper ---

async function mapCapped(items, fn, cap = 5) {
  const results = [];
  let i = 0;
  const next = async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await safely(() => fn(items[idx]));
    }
  };
  await Promise.all(Array.from({ length: Math.min(cap, items.length) }, next));
  return results.filter(r => r != null);
}

// --- hg parent-commit correlation ---

// When mach try auto is used, the try tip commit has a generic message with no
// D-number, but its parent commit (the user's patch) has the full message including
// "Differential Revision: https://phabricator.services.mozilla.com/D{N}".
// Walking one level up via hg.mozilla.org lets us correlate those pushes.

const HEX_RE = /^[0-9a-f]{12,40}$/i;

async function fetchHgRevMeta(revision) {
  if (!HEX_RE.test(revision)) throw new Error(`Invalid revision: ${revision}`);
  const data = await fetchJson(`${HG_TRY_BASE}/json-rev/${revision}`);
  return { desc: data?.desc ?? "", parents: data?.parents ?? [] };
}

async function findMatchesByParentCommit(pushes, dNumber, exclude = new Set()) {
  const needle = phabNeedle(dNumber);
  const recent = pushes
    .toSorted((a, b) => b.push_timestamp - a.push_timestamp)
    .filter(p => !exclude.has(p.id))
    .slice(0, 10);
  return mapCapped(recent, async push => {
    const { parents } = await fetchHgRevMeta(push.revision);
    const desc = parents[0] && (await fetchHgRevMeta(parents[0])).desc;
    return desc?.includes(needle) ? push : undefined;
  }, 3);
}

// --- Push merging ---

function mergePushes(...arrays) {
  const seen = new Set();
  return arrays.flat().filter(p => !seen.has(p.id) && seen.add(p.id));
}

// --- Stored settings ---

const getStoredEmail = () =>
  safely(() => browser.storage.sync.get("email").then(({ email }) => email || null));

// --- Message handler ---

const getDTitle = dNum =>
  fetchPhabHtml(dNum).then(html => ({ title: extractPhabTitle(html) }));

const inFlight = new Map();

async function doFetch(effectiveAuthor, dNumber, bugNumber, cacheKey) {
  let allMatches, authorPushes;

  if (effectiveAuthor) {
    authorPushes = await getAuthorPushes(effectiveAuthor);
    allMatches = filterPushes(authorPushes, dNumber, bugNumber);
  } else {
    const recentMatches = filterPushes(await fetchTryPushes({ count: 200 }), dNumber, bugNumber)
      .filter(p => p.author?.includes("@"));

    const realEmail = recentMatches[0]?.author;
    if (realEmail) authorPushes = await getAuthorPushes(realEmail);
    allMatches = realEmail
      ? mergePushes(filterPushes(authorPushes, dNumber, bugNumber), recentMatches)
      : recentMatches;
  }

  // Also check recent unmatched pushes via hg parent-walk to catch mach-try-auto runs.
  if (dNumber && authorPushes?.length)
    allMatches = mergePushes(allMatches,
      await findMatchesByParentCommit(authorPushes, dNumber, new Set(allMatches.map(p => p.id))));

  allMatches.sort((a, b) => b.push_timestamp - a.push_timestamp);

  const enriched = await mapCapped(allMatches, async push => ({
    id: push.id,
    revision: push.revision,
    push_timestamp: push.push_timestamp,
    author: push.author,
    treeherder_url: `${TREEHERDER_BASE}/jobs?repo=try&revision=${push.revision}`,
    health: await safely(() => fetchPushHealthSummary(push.revision)),
  }), 5);

  cacheSet(cacheKey, enriched);
  return { pushes: enriched };
}

// Deduplicates concurrent requests for the same key so multiple open tabs
// sharing the same revision don't each fire independent Treeherder fetches.
// Skip dedup for forced reloads so an explicit user action always starts a fresh fetch.
function withCacheAndInFlight(cacheKey, force, fn) {
  if (!force) {
    const cached = cacheGet(cacheKey);
    if (cached) return { pushes: cached };
    if (inFlight.has(cacheKey)) return inFlight.get(cacheKey);
  }
  const promise = fn();
  inFlight.set(cacheKey, promise);
  promise.finally(() => inFlight.delete(cacheKey));
  return promise;
}

// For pushes that have no dNumber after the per-D merge (e.g. commits that include
// "Bug N" but omitted the "Differential Revision:" URL), fetch their commit text and
// match against D-revision titles to assign the correct label.
async function labelUntagged(pushes, dNumbers) {
  const untagged = pushes.filter(p => !p.dNumber);
  if (!untagged.length) return pushes;

  const dTitles = new Map(await Promise.all(
    dNumbers.map(async d => [d, await phabTitle(d)])
  ));

  const relabeled = new Map(await mapCapped(untagged, async p => {
    const [raw] = (await safely(() => fetchTryPushes({ revision: p.revision }))) ?? [];
    if (!raw) return [p.id, p];
    const subjects = revisionSubjects(raw).map(normalizeSubject).filter(Boolean);
    const match = [...dTitles].find(([, t]) => titleMatchesSubjects(t, subjects));
    return [p.id, match ? { ...p, dNumber: match[0] } : p];
  }, 5));

  return pushes.map(p => relabeled.get(p.id) ?? p);
}

async function doFetchMulti(effectiveAuthor, dNumbers, bugNumber, cacheKey) {
  const [perD, perBug] = await Promise.all([
    Promise.all(dNumbers.map(d =>
      safely(() => doFetch(effectiveAuthor, d, bugNumber, `${effectiveAuthor ?? ""}:${d}:${bugNumber ?? ""}`))
        .then(r => r ?? { pushes: [] }))),
    safely(() => doFetch(effectiveAuthor, null, bugNumber, `${effectiveAuthor ?? ""}::${bugNumber ?? ""}`))
      .then(r => r ?? { pushes: [] }),
  ]);
  // Label per-D pushes, then merge with bug-only pushes (dedup keeps labeled version first).
  const merged = await labelUntagged(
    mergePushes(
      ...perD.map((r, i) => r.pushes.map(p => ({ ...p, dNumber: dNumbers[i] }))),
      perBug.pushes,
    ),
    dNumbers,
  );
  merged.sort((a, b) => b.push_timestamp - a.push_timestamp);
  cacheSet(cacheKey, merged);
  return { pushes: merged };
}

async function handleGetTryPushes({ author, dNumber, dNumbers, bugNumber, force }) {
  // Stored email (user setting) takes precedence over any content-script hint.
  const effectiveAuthor = (await getStoredEmail()) || author || null;

  // Multiple D-numbers (bug with several revisions): fetch per D-number, merge and label.
  if (dNumbers?.length >= 2) {
    const cacheKey = `${effectiveAuthor ?? ""}:multi:${[...dNumbers].sort().join(",")}:${bugNumber ?? ""}`;
    return withCacheAndInFlight(cacheKey, force,
      () => doFetchMulti(effectiveAuthor, dNumbers, bugNumber, cacheKey));
  }

  const cacheKey = `${effectiveAuthor ?? ""}:${dNumber ?? ""}:${bugNumber ?? ""}`;
  return withCacheAndInFlight(cacheKey, force,
    () => doFetch(effectiveAuthor, dNumber, bugNumber, cacheKey));
}

browser.runtime.onMessage.addListener((msg, _sender) => {
  if (msg.type === "resolveLinks") return resolveLinks(msg.revision);
  if (msg.type === "getDTitle")    return getDTitle(msg.dNum);
  if (msg.type === "getTryPushes") return handleGetTryPushes(msg);
});
