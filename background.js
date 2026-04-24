const TREEHERDER_BASE = "https://treeherder.mozilla.org";
const HG_TRY_BASE     = "https://hg.mozilla.org/try";
const PHAB_BASE       = "https://phabricator.services.mozilla.com";

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
  const dNums   = uniq(/phabricator\.services\.mozilla\.com\/D(\d+)/g);
  const bugNums = uniq(/\bBug\s+(\d+)\b/gi);
  return (dNums.length || bugNums.length) ? { dNums, bugNums } : null;
}

async function resolveLinks(revision) {
  const [push] = await fetchTryPushes({ revision });
  if (!push) return null;

  const links = extractLinks(pushComments(push));
  if (links) return links;

  // Fallback: walk the hg parent commit for mach-try-auto pushes
  return safely(async () => {
    const { parents } = await fetchHgRevMeta(revision);
    if (!parents[0]) return null;
    const { desc } = await fetchHgRevMeta(parents[0]);
    return extractLinks(desc);
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
const CACHE_TTL_MS = 2 * 60 * 1000;

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
  safely(async () => {
    const resp = await fetch(`${PHAB_BASE}/D${dNum}`);
    if (!resp.ok || !resp.url.startsWith(`${PHAB_BASE}/D`)) return null;
    const m = (await resp.text()).match(/<title[^>]*>([^<]+)<\/title>/i);
    if (!m) return null;
    // Decode HTML entities, then strip " - Differential - Phabricator" suffixes
    const raw = new DOMParser().parseFromString(m[1], "text/html").body.textContent ?? m[1];
    return raw.replace(/\s*[-–—·•]\s*(Differential\s*[-–—·•]\s*)?Phabricator\s*$/i, "").trim() || null;
  }).then(title => ({ title }));

// Deduplicates concurrent requests for the same key so multiple open tabs
// sharing the same revision don't each fire independent Treeherder fetches.
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

async function handleGetTryPushes({ author, dNumber, bugNumber, force }) {
  // Stored email (user setting) takes precedence over any content-script hint.
  const effectiveAuthor = (await getStoredEmail()) || author || null;
  const cacheKey = `${effectiveAuthor ?? ""}:${dNumber ?? ""}:${bugNumber ?? ""}`;

  if (!force) {
    const cached = cacheGet(cacheKey);
    if (cached) return { pushes: cached };
  }

  // Reuse an in-flight request for the same key rather than firing duplicates
  // (e.g. multiple tabs open for the same revision, or concurrent auto-refresh).
  // Skip dedup for forced reloads so an explicit user action always starts a fresh fetch.
  if (!force && inFlight.has(cacheKey)) return inFlight.get(cacheKey);

  const promise = doFetch(effectiveAuthor, dNumber, bugNumber, cacheKey);
  inFlight.set(cacheKey, promise);
  promise.finally(() => inFlight.delete(cacheKey));
  return promise;
}

browser.runtime.onMessage.addListener((msg, _sender) => {
  if (msg.type === "resolveLinks") return resolveLinks(msg.revision);
  if (msg.type === "getDTitle")    return getDTitle(msg.dNum);
  if (msg.type === "getTryPushes") return handleGetTryPushes(msg);
});
