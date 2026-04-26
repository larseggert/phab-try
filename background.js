const TREEHERDER_BASE = "https://treeherder.mozilla.org";
const HG_TRY_BASE     = "https://hg.mozilla.org/try";
const PHAB_BASE        = "https://phabricator.services.mozilla.com";
const BUGZILLA_BASE    = "https://bugzilla.mozilla.org";
const CACHE_TTL_MS     = 2 * 60 * 1000;
const ONE_HOUR_SECS    = 60 * 60;

const PHAB_ATTACHMENT_MIME = "text/x-phabricator-request";
const PHAB_ATTACHMENT_RE   = /^phabricator-D(\d+)-url\.txt$/;

// Push-fetch tuning constants
const INITIAL_AUTHOR_PUSH_COUNT = 1000; // first fetch: maximise history
const DEFAULT_PUSH_COUNT        = 200;  // discovery / incremental fetches
const MAX_PARENT_WALK_PUSHES    = 10;   // hg parent-walk candidate pool
const PARENT_WALK_CONCURRENCY   = 3;    // concurrent hg fetches in parent walk
const ENRICH_CONCURRENCY        = 5;    // concurrent health-summary fetches
const KEEPALIVE_PERIOD_MINUTES  = 0.4;  // ~24 s — keeps background service worker alive

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
  const params = new URLSearchParams({ count: count ?? (author ? INITIAL_AUTHOR_PUSH_COUNT : DEFAULT_PUSH_COUNT) });
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

// Extract the revision author's mozilla.com email from the cached Phabricator HTML.
const phabAuthor = dNum =>
  fetchPhabHtml(dNum).then(html => {
    if (!html) return null;
    const doc = new DOMParser().parseFromString(html, "text/html");
    for (const key of doc.querySelectorAll(".phui-property-list-key")) {
      if (!/\bAuthor\b/i.test(key.textContent)) continue;
      const row  = key.closest("tr") ?? key.parentElement;
      const link = row?.querySelector("a[href^='/p/']")
                ?? row?.nextElementSibling?.querySelector("a[href^='/p/']");
      const m = link?.getAttribute("href")?.match(/^\/p\/([^/]+)\//);
      if (m) return `${m[1]}@mozilla.com`;
    }
    // Fallback: search raw HTML for /p/username/ near "Author"
    const m = html.match(/Author[\s\S]{0,200}?\/p\/([^/"]+)\//);
    return m ? `${m[1]}@mozilla.com` : null;
  });

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
        .filter(a => a.content_type === PHAB_ATTACHMENT_MIME && !a.is_obsolete)
        .map(a => a.file_name.match(PHAB_ATTACHMENT_RE)?.[1])
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
  const enrich = async (links, subjects) => withDNums(await withBugNums(links), subjects);

  // Fire the hg parent-desc fetch speculatively, in parallel with the Treeherder
  // push fetch. For mach-try-auto pushes where the patch isn't in push.revisions,
  // this pre-warms the slow CDN origin fetch so we only wait once instead of twice.
  const hgDescPromise = safely(() => fetchHgParentDesc(revision));

  const [push] = await fetchTryPushes({ revision });
  if (!push) return null;

  const links = extractLinks(pushComments(push));
  if (links) return enrich(links, revisionSubjects(push));

  // Fallback: use the already-in-flight hg parent fetch.
  const desc = await hgDescPromise;
  if (!desc) return null;
  const hgLinks = extractLinks(desc);
  return hgLinks ? enrich(hgLinks, [desc.split('\n')[0]]) : null;
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

// Register a promise in an in-flight map, evicting it when settled (identity-checked
// so a forced-reload overwrite doesn't delete the newer promise).
function registerInFlight(map, key, promise) {
  map.set(key, promise);
  promise.finally(() => { if (map.get(key) === promise) map.delete(key); });
  return promise;
}

// --- Persistent author-push store ---
// Keeps the full author push list in browser.storage.local so it survives
// browser restarts and accumulates history beyond the per-request fetch limit.
// On first use it fetches up to 1000 pushes; subsequent calls only fetch
// pushes since the last successful fetch (with a 1-hour overlap for safety).

const AUTHOR_CACHE_FRESH_SECS = 120;

// Deduplicates concurrent getAuthorPushes calls for the same author (e.g. from
// doFetchMulti which calls doFetch in parallel for each D-number).
const authorInFlight = new Map();

async function getAuthorPushes(author) {
  if (authorInFlight.has(author)) return authorInFlight.get(author);

  const promise = (async () => {
    const key = `push-store:${author}`;
    const nowSecs = Math.floor(Date.now() / 1000);

    const stored = await safely(() => browser.storage.local.get(key).then(r => r[key] ?? null));

    if (stored && nowSecs - stored.fetchedAt < AUTHOR_CACHE_FRESH_SECS) return stored.pushes;

    // Fetch only pushes since the last successful fetch (minus a 1-hour buffer).
    // On first use, fetch up to 1000 to maximise initial history.
    const fresh = await fetchTryPushes(
      stored
        ? { author, count: DEFAULT_PUSH_COUNT, since: stored.fetchedAt - ONE_HOUR_SECS }
        : { author, count: INITIAL_AUTHOR_PUSH_COUNT }
    );

    const all = mergePushes(fresh, stored?.pushes ?? []);
    await safely(() => browser.storage.local.set({ [key]: { pushes: all, fetchedAt: nowSecs } }));
    return all;
  })();

  return registerInFlight(authorInFlight, author, promise);
}

// --- Concurrency helper ---

async function mapCapped(items, fn, cap = ENRICH_CONCURRENCY) {
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

// Cache hg commit descriptions persistently — commit data is immutable so entries
// never go stale. In-memory map is pre-populated from storage.local on first use.
const hgRevCache = new Map();
let   hgCacheLoad = null; // Promise; set once so concurrent calls share the same load

const loadHgCache = () => hgCacheLoad ??= safely(() =>
  browser.storage.local.get("hgRevCache").then(r => {
    if (r.hgRevCache) Object.entries(r.hgRevCache).forEach(([k, v]) => hgRevCache.set(k, v));
  }));

function saveHgCache(key, value) {
  hgRevCache.set(key, value);
  safely(() => browser.storage.local.get("hgRevCache")
    .then(r => browser.storage.local.set({
      hgRevCache: { ...(r.hgRevCache ?? {}), [key]: value },
    })));
}


// Fetch JSON from hg.mozilla.org, following any CDN redirect automatically.
// The Accept: application/json header is required — it changes the CDN cache key
// and ensures the redirected response includes CORS headers.
const fetchHgJson = path => safely(() =>
  fetch(`${HG_TRY_BASE}${path}`, { headers: { "Accept": "application/json" } })
    .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
);

// Fetch the parent commit description in one request using hg's ~1 (parent) syntax,
// avoiding the two-step tip→parent chain.
async function fetchHgParentDesc(revision) {
  if (!HEX_RE.test(revision)) return null;
  await loadHgCache();
  const cacheKey = `~${revision}`;  // synthetic key: "parent desc of revision"
  if (hgRevCache.has(cacheKey)) return hgRevCache.get(cacheKey);
  const data  = await fetchHgJson(`/json-log?rev=${revision}~1&limit=1`);
  const entry = data?.entries?.[0];
  if (entry) {
    const desc = entry.desc ?? null;
    saveHgCache(cacheKey, desc);
    if (entry.node) saveHgCache(entry.node, { desc: desc ?? "", parents: [] });
    return desc;
  }
  hgRevCache.set(cacheKey, null);  // cache miss so we don't retry on next call
  return null;
}

async function findMatchesByParentCommit(pushes, dNumber, exclude = new Set()) {
  const needle = phabNeedle(dNumber);
  const recent = pushes
    .toSorted((a, b) => b.push_timestamp - a.push_timestamp)
    .filter(p => !exclude.has(p.id))
    .slice(0, MAX_PARENT_WALK_PUSHES);
  return mapCapped(recent, async push => {
    const desc = await fetchHgParentDesc(push.revision);
    return desc?.includes(needle) ? push : undefined;
  }, PARENT_WALK_CONCURRENCY);
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
    const recentPushes  = await fetchTryPushes({ count: DEFAULT_PUSH_COUNT });
    const recentMatches = filterPushes(recentPushes, dNumber, bugNumber)
      .filter(p => p.author?.includes("@"));

    const realEmail = recentMatches[0]?.author;
    if (realEmail) authorPushes = await getAuthorPushes(realEmail);
    allMatches = realEmail
      ? mergePushes(filterPushes(authorPushes, dNumber, bugNumber), recentMatches)
      : recentMatches;

    // When no direct match was found (e.g. mach-try-auto commits), use the recent
    // pushes as the candidate pool for the hg parent-walk below.
    if (!authorPushes && dNumber) authorPushes = recentPushes;
  }

  // Also check recent unmatched pushes via hg parent-walk to catch mach-try-auto runs.
  if (dNumber && authorPushes?.length) {
    const exclude      = new Set(allMatches.map(p => p.id));
    const parentWalked = await findMatchesByParentCommit(authorPushes, dNumber, exclude);

    // When no effectiveAuthor was available we used recent pushes (limited pool).
    // If the parent-walk found a match, we now know the real author — fetch their
    // full push history and walk again to catch any older pushes that were missed.
    if (!effectiveAuthor && parentWalked.length) {
      const discoveredEmail = parentWalked[0]?.author;
      if (discoveredEmail) {
        const discoveredPushes = await getAuthorPushes(discoveredEmail);
        const exclude2         = new Set([...allMatches, ...parentWalked].map(p => p.id));
        const moreMatches      = await findMatchesByParentCommit(discoveredPushes, dNumber, exclude2);
        allMatches = mergePushes(allMatches, parentWalked, moreMatches);
      } else {
        allMatches = mergePushes(allMatches, parentWalked);
      }
    } else {
      allMatches = mergePushes(allMatches, parentWalked);
    }
  }

  allMatches.sort((a, b) => b.push_timestamp - a.push_timestamp);

  const enriched = await mapCapped(allMatches, async push => ({
    id: push.id,
    revision: push.revision,
    push_timestamp: push.push_timestamp,
    author: push.author,
    treeherder_url: `${TREEHERDER_BASE}/jobs?repo=try&revision=${push.revision}`,
    health: await safely(() => fetchPushHealthSummary(push.revision)),
  }), ENRICH_CONCURRENCY);

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
  return registerInFlight(inFlight, cacheKey, fn());
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
  }, ENRICH_CONCURRENCY));

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
  // Prefer the Phabricator revision author when a D-number is available — they are
  // the actual try pusher regardless of who is browsing. Fall back to stored email
  // (user's own setting) or the content-script hint for bug-number-only searches.
  const storedEmail    = await getStoredEmail();
  const phabRevAuthor  = dNumber  ? await safely(() => phabAuthor(dNumber))
                       : dNumbers ? await safely(() => phabAuthor(dNumbers[0]))
                       : null;
  const effectiveAuthor = phabRevAuthor || storedEmail || author || null;

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
  if (msg.type === "resolveLinks")  return resolveLinks(msg.revision);
  if (msg.type === "getDTitle")     return getDTitle(msg.dNum);
  if (msg.type === "getTryPushes")  return handleGetTryPushes(msg);
  if (msg.type === "flushCaches") {
    cache.clear();
    hgRevCache.clear();
    phabHtmlCache.clear();
    hgCacheLoad = null;  // force reload from storage on next use
    return Promise.resolve({ ok: true });
  }
});

// Keep the service worker alive so content-script messages are never dropped.
browser.alarms.create("keepalive", { periodInMinutes: KEEPALIVE_PERIOD_MINUTES });
browser.alarms.onAlarm.addListener(() => {});
