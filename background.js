const TREEHERDER_BASE = "https://treeherder.mozilla.org";
const HG_TRY_BASE     = "https://hg.mozilla.org/try";

async function fetchJson(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Fetch failed: ${resp.status} (${url})`);
  return resp.json();
}

async function fetchTryPushes({ author, count } = {}) {
  const params = new URLSearchParams({ count: count ?? (author ? 500 : 200) });
  if (author) params.set("author", author);
  return (await fetchJson(`${TREEHERDER_BASE}/api/project/try/push/?${params}`)).results ?? [];
}

async function fetchPushHealthSummary(revision) {
  // Endpoint returns an array; take the first element
  const data = await fetchJson(
    `${TREEHERDER_BASE}/api/project/try/push/health_summary/?revision=${revision}`
  );
  return (Array.isArray(data) ? data[0] : data) ?? null;
}

function pushComments(push) {
  return (push.revisions || []).map(r => r.comments || "").join("\n");
}

const phabNeedle = dNumber => `phabricator.services.mozilla.com/D${dNumber}`;

function filterPushesForRevision(pushes, dNumber) {
  return pushes.filter(push => pushComments(push).includes(phabNeedle(dNumber)));
}

function filterPushesForBug(pushes, bugNumber) {
  const re = new RegExp(`\\bBug\\s+${bugNumber}\\b`, "i");
  return pushes.filter(push => re.test(pushComments(push)));
}

function filterPushes(pushes, dNumber, bugNumber) {
  if (dNumber)   return filterPushesForRevision(pushes, dNumber);
  if (bugNumber) return filterPushesForBug(pushes, bugNumber);
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

// --- Concurrency helper ---

async function mapCapped(items, fn, cap = 5) {
  const results = [];
  let i = 0;
  async function next() {
    while (i < items.length) {
      const idx = i++;
      try { results[idx] = await fn(items[idx]); } catch (_e) { /* skip failed items */ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(cap, items.length) }, next));
  return results.filter(r => r !== undefined);
}

// --- hg parent-commit correlation ---

// When mach try auto is used, the try tip commit has a generic message with no
// D-number, but its parent commit (the user's patch) has the full message including
// "Differential Revision: https://phabricator.services.mozilla.com/D{N}".
// Walking one level up via hg.mozilla.org lets us correlate those pushes.

async function fetchHgRevMeta(revision) {
  const data = await fetchJson(`${HG_TRY_BASE}/json-rev/${revision}`);
  return { desc: data?.desc ?? "", parents: data?.parents ?? [] };
}

async function findMatchesByParentCommit(pushes, dNumber) {
  const needle = phabNeedle(dNumber);
  const recent = pushes.toSorted((a, b) => b.push_timestamp - a.push_timestamp).slice(0, 10);
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

async function getStoredEmail() {
  try {
    const { email } = await browser.storage.sync.get("email");
    return email || null;
  } catch (_e) {
    return null;
  }
}

// --- Message handler ---

// Deduplicates concurrent requests for the same key so multiple open tabs
// sharing the same revision don't each fire independent Treeherder fetches.
const inFlight = new Map();

async function doFetch(effectiveAuthor, dNumber, bugNumber, cacheKey) {
  let allMatches;
  let authorPushes;  // kept for the hg parent-commit fallback below

  if (effectiveAuthor) {
    authorPushes = await fetchTryPushes({ author: effectiveAuthor });
    allMatches = filterPushes(authorPushes, dNumber, bugNumber);
  } else {
    const recentMatches = filterPushes(await fetchTryPushes({ count: 200 }), dNumber, bugNumber)
      .filter(p => p.author?.includes("@"));

    const realEmail = recentMatches[0]?.author;
    allMatches = realEmail
      ? mergePushes(
          filterPushes(await fetchTryPushes({ author: realEmail }), dNumber, bugNumber),
          recentMatches)
      : recentMatches;
  }

  // If no commit-message matches but we have a D-number and author pushes,
  // walk the parent commit of each recent push via hg-edge to find ones whose
  // parent message contains the Phabricator revision link (e.g. mach try auto).
  if (allMatches.length === 0 && dNumber && authorPushes?.length)
    allMatches = await findMatchesByParentCommit(authorPushes, dNumber);

  allMatches.sort((a, b) => b.push_timestamp - a.push_timestamp);

  const enriched = await mapCapped(allMatches, async push => {
    let health = null;
    try { health = await fetchPushHealthSummary(push.revision); } catch (_e) { /* skip */ }
    return {
      id: push.id,
      revision: push.revision,
      push_timestamp: push.push_timestamp,
      author: push.author,
      treeherder_url: `${TREEHERDER_BASE}/jobs?repo=try&revision=${push.revision}`,
      health,
    };
  }, 5);

  cacheSet(cacheKey, enriched);
  return { pushes: enriched };
}

browser.runtime.onMessage.addListener((msg, _sender) => {
  if (msg.type !== "getTryPushes") return;

  const { author, dNumber, bugNumber, force } = msg;

  return (async () => {
    // Stored email (user setting) takes precedence over any content-script hint.
    const effectiveAuthor = (await getStoredEmail()) || author || null;
    const cacheKey = `${effectiveAuthor ?? ""}:${dNumber ?? ""}:${bugNumber ?? ""}`;

    if (!force) {
      const cached = cacheGet(cacheKey);
      if (cached) return { pushes: cached };
    }

    // Reuse an in-flight request for the same key rather than firing duplicates
    // (e.g. multiple tabs open for the same revision, or concurrent auto-refresh).
    if (inFlight.has(cacheKey)) return inFlight.get(cacheKey);

    const promise = doFetch(effectiveAuthor, dNumber, bugNumber, cacheKey);
    inFlight.set(cacheKey, promise);
    promise.finally(() => inFlight.delete(cacheKey));
    return promise;
  })();
});
