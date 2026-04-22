const TREEHERDER_BASE = "https://treeherder.mozilla.org";

async function fetchTryPushes({ author, count } = {}) {
  const params = new URLSearchParams({ count: count ?? (author ? 500 : 200) });
  if (author) params.set("author", author);
  const resp = await fetch(`${TREEHERDER_BASE}/api/project/try/push/?${params}`);
  if (!resp.ok) throw new Error(`Treeherder fetch failed: ${resp.status}`);
  return (await resp.json()).results ?? [];
}

async function fetchPushHealthSummary(revision) {
  const resp = await fetch(
    `${TREEHERDER_BASE}/api/project/try/push/health_summary/?revision=${revision}`
  );
  if (!resp.ok) throw new Error(`Health fetch failed: ${resp.status}`);
  const data = await resp.json();
  // Endpoint returns an array; take the first element
  return (Array.isArray(data) ? data[0] : data) ?? null;
}

function pushComments(push) {
  return (push.revisions || []).map(r => r.comments || "").join("\n");
}

function filterPushesForRevision(pushes, dNumber) {
  const needle = `phabricator.services.mozilla.com/D${dNumber}`;
  return pushes.filter(push => pushComments(push).includes(needle));
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
    while (i < items.length) { const idx = i++; results[idx] = await fn(items[idx]); }
  }
  await Promise.all(Array.from({ length: Math.min(cap, items.length) }, next));
  return results;
}

// --- Push merging ---

function mergePushes(...arrays) {
  const seen = new Set();
  const merged = [];
  for (const arr of arrays)
    for (const p of arr)
      if (!seen.has(p.id)) { seen.add(p.id); merged.push(p); }
  return merged;
}

// --- Message handler ---

browser.runtime.onMessage.addListener((msg, _sender) => {
  if (msg.type !== "getTryPushes") return;

  const { author, dNumber, bugNumber, force } = msg;
  const cacheKey = `${author ?? ""}:${dNumber ?? ""}:${bugNumber ?? ""}`;

  if (!force) {
    const cached = cacheGet(cacheKey);
    if (cached) return Promise.resolve({ pushes: cached });
  }

  return (async () => {
    let allMatches;

    if (author) {
      allMatches = filterPushes(await fetchTryPushes({ author }), dNumber, bugNumber);
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

    allMatches.sort((a, b) => b.push_timestamp - a.push_timestamp);

    const enriched = await mapCapped(allMatches, async push => {
      let health = null;
      try { health = await fetchPushHealthSummary(push.revision); } catch (_e) { /* skip */ }

      return {
        id: push.id,
        revision: push.revision,
        push_timestamp: push.push_timestamp,
        author: push.author,
        treeherder_url: `https://treeherder.mozilla.org/jobs?repo=try&revision=${push.revision}`,
        health,
      };
    }, 5);

    cacheSet(cacheKey, enriched);
    return { pushes: enriched };
  })();
});
