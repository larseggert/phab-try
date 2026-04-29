// Implementation of the data model in DATA.md.
//
// Caches hold only canonical, verifiably immutable values; volatile data
// (search/merge results, in-flight `health`, bug `summary`, full Phabricator
// HTML) is recomputed on each panel render. Heuristic author guesses are not
// used: the canonical "patch creator" is the Bugzilla attachment `creator`,
// and the canonical "pusher" is the Treeherder push `author`.
//
// Search fans out across every tracked Mozilla repo (try + landings),
// surfacing each push with a `repo` field. A FetchErrorTracker records
// per-source failures so the panel can warn the user when results may be
// incomplete (e.g. hg-edge anti-bot 406, a Treeherder repo down).

// TREEHERDER_BASE, HG_TRY_BASE, PHAB_BASE, BUGZILLA_BASE,
// PHAB_ATTACHMENT_RE — globals from lib/pure.js.

// Repos surfaced in the panel. Order is preserved for display.
const TRACKED_REPOS = [
  "try", "autoland", "mozilla-central",
  "mozilla-beta", "mozilla-release",
  "mozilla-esr140", "mozilla-esr115",
];

const AUTHOR_HISTORY_COUNT   = 1000; // first author fetch
const AUTHOR_HISTORY_INCR    = 200;  // incremental fetch when cache exists
const RECENT_PUSHES_COUNT    = 500;  // recent-pushes scan window per repo
const AUTHOR_HISTORY_FRESH_S = 120;  // re-fetch threshold for author history
const ONE_HOUR_S             = 3600;
const ENRICH_CONCURRENCY     = 5;
// Walk concurrency reduced from 5 → 2 to avoid the Fastly anti-bot burst on
// hg-edge. Combined with the author filter on walk candidates, a typical
// first-load now incurs only single-digit hg-edge requests.
const WALK_CONCURRENCY       = 2;
const MAX_WALK_CANDIDATES    = 20;
const KEEPALIVE_PERIOD_MIN   = 0.4;

// All names referenced from this file are provided by lib/pure.js
// (loaded before this script per manifest.json): the regex/text helpers
// (extractDNums, extractBugNums, bugRegex, normSubject, stripPhabSuffix,
// titleMatchesSubjects, pushComments, tryWalkCandidates, subjectsFromPush,
// dedupById, byPushTimestampDesc, escapeHostName, MIN_TITLE_MATCH_LEN),
// the host/base constants (TREEHERDER_BASE, HG_TRY_BASE, PHAB_BASE,
// BUGZILLA_BASE, PHAB_HOST, BUGZILLA_HOST), the URL builders
// (treeherderJobsUrl, treeherderPushByRevUrl, treeherderHealthUrl,
// treeherderRecentUrl, treeherderAuthorHistoryUrl, hgRevUrl, phabRevUrl,
// bugAttachmentsUrl), the cache-key helpers (pushCacheKey,
// historyCacheKey), and FetchErrorTracker.

const BUG_URL_RE = new RegExp(`${escapeHostName(BUGZILLA_HOST)}\\/show_bug\\.cgi\\?id=(\\d+)`);

// `safely` lives in lib/pure.js — it's a global here.

// Errors thrown by fetchJson/fetchText carry the originating URL and HTTP
// status code (or `null` for browser-side errors like CORS / network / DNS).
// The error tracker uses these to display the failing URLs alongside their
// status code in the warning banner — no implementation labels.
class FetchError extends Error {
  constructor(url, status, message) {
    super(message ?? `Fetch ${url} → ${status ?? "(network error)"}`);
    this.url = url;
    this.status = status;
  }
}

// When a cross-origin response lacks `Access-Control-Allow-Origin`, fetch()
// rejects with a generic TypeError *before* exposing `r.status` to JS — so
// we'd report the failure as a "Network error" even though the wire-level
// status (e.g. 406 from hg-edge's anti-bot rules) is what the user actually
// wants to see. webRequest.onCompleted runs on the browser's network stack,
// fires before CORS rejection, and lets us capture the real statusCode.
const webRequestStatus = new Map();
const WEBREQUEST_MAX = 200;

const recordWebRequest = (url, status) => {
  if (status == null) return;
  if (webRequestStatus.size >= WEBREQUEST_MAX) {
    const oldest = webRequestStatus.keys().next().value;
    webRequestStatus.delete(oldest);
  }
  webRequestStatus.set(url, status);
};

// onHeadersReceived fires before the browser's CORS check rejects a
// cross-origin response — onCompleted does not fire when CORS blocks the
// response (onErrorOccurred fires instead, with no usable statusCode).
// Listening here ensures we capture the real HTTP status (e.g. 406) even
// when fetch() will subsequently reject with a generic NetworkError.
const FILTER = {
  urls: [
    "https://hg-edge.mozilla.org/*",
    "https://hg.mozilla.org/*",
    `${TREEHERDER_BASE}/*`,
    `${PHAB_BASE}/*`,
    `${BUGZILLA_BASE}/*`,
  ],
};

if (browser.webRequest?.onHeadersReceived) {
  try {
    const record = d => recordWebRequest(d.url, d.statusCode);
    for (const event of ["onHeadersReceived", "onCompleted", "onErrorOccurred"])
      browser.webRequest[event]?.addListener(record, FILTER);
  } catch (e) {
    console.warn("[phab-try] webRequest registration failed:", e.message);
  }
} else {
  console.warn("[phab-try] webRequest unavailable —",
    "the 'webRequest' permission may not be granted.");
}

const consumeRecordedStatus = url => {
  const s = webRequestStatus.get(url) ?? null;
  webRequestStatus.delete(url);
  return s;
};

// Wraps fetch() + status-tracking + ok-check; subclasses below pull
// either JSON or text out of the response. The webRequest listeners
// above record the wire-level status so we can report a real HTTP code
// (e.g. 406 from hg-edge anti-bot) when fetch() rejects with a generic
// CORS error before exposing r.status.
async function fetchOk(url) {
  let r;
  try { r = await fetch(url); }
  catch (e) {
    const status = consumeRecordedStatus(url);
    throw new FetchError(url, status, e.message);
  }
  consumeRecordedStatus(url);
  if (!r.ok) throw new FetchError(url, r.status);
  return r;
}

async function fetchJson(url) {
  const r = await fetchOk(url);
  try { return await r.json(); }
  catch (e) { throw new FetchError(url, r.status, `Invalid JSON: ${e.message}`); }
}

const fetchText = url => fetchOk(url).then(r => r.text());

async function mapCapped(items, fn, cap, onProgress) {
  const results = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(cap, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await safely(() => fn(items[idx]));
      onProgress?.();
    }
  }));
  return results.filter(r => r != null);
}

// dedupById, subjectsFromPush, FetchErrorTracker — globals from lib/pure.js.
// `tracked()` wraps a fetch with error-recording onto the tracker.

async function tracked(errors, fn) {
  try { return await fn(); }
  catch (e) {
    if (errors) {
      if (e instanceof FetchError) errors.record(e.url, e.status, e.message);
      else                         errors.record(null, null, e.message ?? String(e));
    }
    return null;
  }
}

// --- Cache (per DATA.md caching policy: only canonical immutable values) ---

const PFX = {
  dTitle:   "ptD-title:",     // dNumber → revisionTitle
  dBug:     "ptD-bug:",       // dNumber → bugNumber
  dCreator: "ptD-creator:",   // dNumber → patch-creator email
  push:     "ptPush:",        // ${repo}:${revision} → push object minus health
  health:   "ptHealth:",      // ${repo}:${revision} → health (only when complete)
  hg:       "ptHg:",          // hg revision hash → { desc, parents }
  history:  "ptAuthor:",      // ${repo}:${email} → { pushes, fetchedAt }
};

const dTitleCache   = new Map();
const dBugCache     = new Map();
const dCreatorCache = new Map();
const pushCache     = new Map();
const healthCache   = new Map();
const hgCache       = new Map();
const historyCache  = new Map();

const memCaches = [
  [dTitleCache,   PFX.dTitle],
  [dBugCache,     PFX.dBug],
  [dCreatorCache, PFX.dCreator],
  [pushCache,     PFX.push],
  [healthCache,   PFX.health],
  [hgCache,       PFX.hg],
  [historyCache,  PFX.history],
];

let memCacheLoad = null;
const loadMemCache = () => memCacheLoad ??= safely(async () => {
  const all = await browser.storage.local.get(null);
  for (const [k, v] of Object.entries(all ?? {})) {
    for (const [m, p] of memCaches)
      if (k.startsWith(p)) { m.set(k.slice(p.length), v); break; }
  }
});

// Persists ALL resolved values, including `null` — every cache here holds
// canonical immutable answers, so a "no value" outcome (e.g. a D with no
// linked bug, a deleted revision with no title) is itself the canonical
// answer and is worth caching. Callers must early-return on transient
// fetch failures *before* invoking setCache so we never persist a network
// blip as the canonical "no value".
const setCache = (mem, prefix, key, value) => {
  mem.set(key, value);
  safely(() => browser.storage.local.set({ [prefix + key]: value }));
};

// --- In-flight request dedup ---

const inFlight = new Map();
const withInFlight = (key, fn) => {
  if (inFlight.has(key)) return inFlight.get(key);
  const p = (async () => fn())();
  inFlight.set(key, p);
  p.finally(() => { if (inFlight.get(key) === p) inFlight.delete(key); });
  return p;
};

// --- Field-level fetchers (one per canonical source in DATA.md) ---

// HTTP-URL-level dedupe so concurrent callers needing different fields from
// the same response (title vs bug-link from /D{n} HTML, or different Ds'
// creators from the same bug-attachment list) trigger only one fetch.
const fetchPhabHtml = (d, errors) =>
  withInFlight(`phab-html:${d}`,
    () => tracked(errors, () => fetchText(phabRevUrl(d))));

const fetchBugAttachments = (bug, errors) =>
  withInFlight(`bug-atts:${bug}`,
    () => tracked(errors, () => fetchJson(bugAttachmentsUrl(bug)))
      .then(data => data?.bugs?.[bug] ?? []));

async function getDRevisionTitle(d, errors) {
  await loadMemCache();
  if (dTitleCache.has(d)) return dTitleCache.get(d);
  return withInFlight(`title:${d}`, async () => {
    const html = await fetchPhabHtml(d, errors);
    if (!html) return null;
    const raw = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1];
    const decoded = raw ? new DOMParser().parseFromString(raw, "text/html").body.textContent : null;
    const title = stripPhabSuffix(decoded);
    setCache(dTitleCache, PFX.dTitle, d, title);
    return title;
  });
}

// D-revision status (Abandoned, Closed, Needs Review, Accepted, …) — volatile
// (a revision can move between states), kept in-memory only and not persisted.
// Shares the underlying HTML fetch with title/bug-number resolvers.
// Cleared by handleFlushCaches so the manual Reload button refreshes status.
const dStatusCache = new Map();
async function getDStatus(d, errors) {
  if (dStatusCache.has(d)) return dStatusCache.get(d);
  return withInFlight(`status:${d}`, async () => {
    const html = await fetchPhabHtml(d, errors);
    if (!html) return null;   // transient fetch failure — don't cache
    const status = extractDStatus(html);
    dStatusCache.set(d, status);   // cache null too — "asked, no match"
    return status;
  });
}

async function getDBugNumber(d, errors) {
  await loadMemCache();
  if (dBugCache.has(d)) return dBugCache.get(d);
  return withInFlight(`bug:${d}`, async () => {
    const html = await fetchPhabHtml(d, errors);
    if (!html) return null;   // transient fetch failure — don't cache
    const bug = html.match(BUG_URL_RE)?.[1] ?? null;
    setCache(dBugCache, PFX.dBug, d, bug);
    return bug;
  });
}

async function getDCreator(d, bugHint, errors) {
  await loadMemCache();
  if (dCreatorCache.has(d)) return dCreatorCache.get(d);
  const bug = bugHint ?? await getDBugNumber(d, errors);
  if (!bug) return null;
  return withInFlight(`creator:${d}`, async () => {
    const atts = await fetchBugAttachments(bug, errors);
    // The same fetch yields creators for ALL Ds on this bug — all canonical.
    for (const a of atts) {
      if (a.is_obsolete) continue;
      const m = a.file_name.match(PHAB_ATTACHMENT_RE);
      if (m && a.creator) setCache(dCreatorCache, PFX.dCreator, m[1], a.creator);
    }
    return dCreatorCache.get(d) ?? null;
  });
}

// /json-rev/{hash} returns the revision's metadata including `parents[]`.
// Only used for try (mach-try-auto parent walk); other repos always have
// the canonical Differential Revision URL in their commits.
async function getHgRev(rev, errors) {
  await loadMemCache();
  if (hgCache.has(rev)) return hgCache.get(rev);
  return withInFlight(`hg:${rev}`, async () => {
    const data = await tracked(errors,
      () => fetchJson(hgRevUrl(rev)));
    if (!data) return null;
    const value = { desc: data.desc ?? "", parents: data.parents ?? [] };
    setCache(hgCache, PFX.hg, rev, value);
    return value;
  });
}

async function getHgParentDesc(rev, errors) {
  const meta = await getHgRev(rev, errors);
  const parentHash = meta?.parents?.[0];
  if (!parentHash) return null;
  const parent = await getHgRev(parentHash, errors);
  return parent?.desc ?? null;
}

async function getPushObject(repo, rev, errors) {
  await loadMemCache();
  const key = pushCacheKey(repo, rev);
  if (pushCache.has(key)) return pushCache.get(key);
  return withInFlight(`push:${key}`, async () => {
    const data = await tracked(errors,
      () => fetchJson(treeherderPushByRevUrl(repo, rev)));
    const p = data?.results?.[0];
    if (!p) return null;
    const stripped = {
      id: p.id, revision: p.revision, push_timestamp: p.push_timestamp,
      author: p.author, revisions: p.revisions ?? [],
    };
    setCache(pushCache, PFX.push, key, stripped);
    return stripped;
  });
}

async function getPushHealth(repo, rev, errors) {
  await loadMemCache();
  const key = pushCacheKey(repo, rev);
  if (healthCache.has(key)) return healthCache.get(key);
  return withInFlight(`health:${key}`, async () => {
    const data = await tracked(errors,
      () => fetchJson(treeherderHealthUrl(repo, rev)));
    const h = Array.isArray(data) ? data[0] : data;
    if (!h) return null;
    const s = h.status ?? {};
    if ((s.running || 0) === 0 && (s.pending || 0) === 0)
      setCache(healthCache, PFX.health, key, h);
    return h;
  });
}

async function getAuthorPushHistory(repo, email, errors) {
  await loadMemCache();
  const key = historyCacheKey(repo, email);
  return withInFlight(`history:${key}`, async () => {
    const cached = historyCache.get(key);
    const now = Math.floor(Date.now() / 1000);
    if (cached && now - cached.fetchedAt < AUTHOR_HISTORY_FRESH_S) return cached.pushes;

    const params = new URLSearchParams({
      author: email,
      count: String(cached ? AUTHOR_HISTORY_INCR : AUTHOR_HISTORY_COUNT),
    });
    if (cached) params.set("push_timestamp__gt", String(cached.fetchedAt - ONE_HOUR_S));

    const data = await tracked(errors,
      () => fetchJson(treeherderAuthorHistoryUrl(repo, params)));
    // Transient fetch failure — return whatever we have without bumping
    // fetchedAt, so the next call retries instead of sitting on stale
    // data for AUTHOR_HISTORY_FRESH_S (and persisting that staleness to
    // storage.local across SW restarts).
    if (!data) return cached?.pushes ?? [];
    const fresh = data.results ?? [];
    const merged = dedupById([...fresh, ...(cached?.pushes ?? [])]);
    setCache(historyCache, PFX.history, key, { pushes: merged, fetchedAt: now });
    return merged;
  });
}

const getRecentPushes = (repo, count, errors) =>
  withInFlight(`recent:${repo}:${count}`, () => tracked(errors,
    () => fetchJson(treeherderRecentUrl(repo, count)))
    .then(d => d?.results ?? []));

// --- Cache-priming entry points (called from content-script DOM data) ---

const primeDTitle   = (d, t) => setCache(dTitleCache,   PFX.dTitle,   d, t);
const primeDBug     = (d, b) => setCache(dBugCache,     PFX.dBug,     d, b);
const primeDCreator = (d, c) => setCache(dCreatorCache, PFX.dCreator, d, c);

// --- Push enrichment ---

async function computeStackDNums(push, repo, errors) {
  const ds = extractDNums(pushComments(push));
  // Parent walk only needed for try (mach-try-auto pattern). Non-try repo
  // pushes always carry the canonical Diff Rev URL in revisions[].comments.
  if (ds.length || repo !== "try") return ds;
  const desc = await getHgParentDesc(push.revision, errors);
  return desc ? extractDNums(desc) : [];
}

async function enrichPush(push, repo, label, errors, backoutSets) {
  const [health, stackDNums] = await Promise.all([
    getPushHealth(repo, push.revision, errors),
    computeStackDNums(push, repo, errors),
  ]);
  return {
    id: push.id, repo, revision: push.revision, push_timestamp: push.push_timestamp,
    author: push.author, treeherder_url: treeherderJobsUrl(repo, push.revision),
    health, stackDNums,
    backedOut: isBackedOut(backoutSets?.[repo], push.revision),
    ...label,
  };
}

// Walks parent commits for try candidates that have no D-URL anywhere in
// their own commits (mach-try-auto pattern) and keeps those whose
// parentDesc satisfies `predicate`. Caller pre-filters candidates by author
// to keep N small; the cap below is just a defensive ceiling.
//
// `onMatch(push)` is invoked the moment a candidate's parent matches, so
// the search can emit incremental updates while remaining walks are still
// in flight. The function still returns the full list of matches once
// every candidate has been checked.
async function walkParentDescs(candidates, predicate, errors, reportProgress, onMatch) {
  if (!candidates.length) return [];
  const slice = candidates
    .toSorted(byPushTimestampDesc)
    .slice(0, MAX_WALK_CANDIDATES);
  reportProgress?.(`Checking parent commits (0/${slice.length})…`, 0, slice.length);
  let done = 0;
  return mapCapped(slice, async p => {
    const desc = await getHgParentDesc(p.revision, errors);
    if (!desc || !predicate(desc)) return null;
    if (onMatch) await safely(() => onMatch(p));
    return p;
  }, WALK_CONCURRENCY,
    () => reportProgress?.(`Checking parent commits (${++done}/${slice.length})…`, done, slice.length));
}

// --- Per-repo search primitives ---
//
// The search runs in three explicit phases so the cheap, reliable
// Treeherder data lands before anything that could trigger anti-bot
// pushback on a failure-prone host:
//
//   Phase 1 — Treeherder push lists (recent + author history) across all
//             tracked repos, fan out in parallel.
//   Phase 2 — hg-edge parent walks for mach-try-auto candidates on try
//             only. Starts only after every phase-1 fetch has settled.
//   Phase 3 — Treeherder health-summary enrichment, in newest-first order.
//
// `gatherFromRepo` does only phase 1's work for one repo: returns the raw
// push pool (history ∪ recent for try, recent only for landing repos) so
// the caller can sequence walks and enrichment afterwards.
async function gatherFromRepo(repo, creators, errors) {
  if (repo === "try") {
    const [histories, recent] = await Promise.all([
      Promise.all(creators.map(c => getAuthorPushHistory(repo, c, errors))),
      getRecentPushes(repo, RECENT_PUSHES_COUNT, errors),
    ]);
    return dedupById([...histories.flatMap(h => h ?? []), ...(recent ?? [])]);
  }
  // Landing repos (autoland, mozilla-central, beta, release, esr*): patches
  // always carry their canonical Diff Rev URL in commit messages, so a
  // single recent-pushes scan suffices.
  const recent = await getRecentPushes(repo, RECENT_PUSHES_COUNT, errors);
  return recent ?? [];
}

// tryWalkCandidates lives in lib/pure.js — picks out try mach-try-auto
// candidates from a try push pool (creator-authored, no Diff Rev URL).

// --- Top-level search algorithms ---
//
// Both algorithms are progressive: they `emit({ pushes, errors })` after the
// fast Treeherder phase + enrichment completes (so the panel renders direct
// matches in seconds), then continue walking hg-edge for mach-try-auto
// candidates in the background and `emit()` again with the combined set
// once those slower fetches resolve. The panel updates each render
// without blocking on hg-edge.

async function enrichEntries(entries, errors, reportProgress, backoutSets, label = "Loading health") {
  if (!entries.length) return [];
  reportProgress?.(`${label} (0/${entries.length})…`, 0, entries.length);
  let done = 0;
  return mapCapped(entries,
    ({ _repo, _push, _label }) => enrichPush(_push, _repo, _label ?? {}, errors, backoutSets),
    ENRICH_CONCURRENCY,
    () => reportProgress?.(`${label} (${++done}/${entries.length})…`, done, entries.length));
}

// Build per-repo target-hash sets from all "Backed out" commits in each
// repo's recently-fetched push pool.
const computeBackoutSets = perRepo =>
  Object.fromEntries(perRepo.map(({ repo, all }) => [repo, backoutTargets(all)]));

// Prime { title, status } for every D-revision the panel will surface.
// The Phab HTML fetch is shared with title/bug-number/creator resolvers via
// withInFlight, so this is essentially free when those have already run.
// Returning the map alongside the pushes lets the panel render strike +
// icon synchronously at row-build time, instead of doing a per-D IPC
// lookup that would land a second after the rows are already on screen.
function collectDsFromPushes(pushes) {
  const ds = new Set();
  for (const p of pushes ?? []) {
    for (const d of p.stackDNums ?? []) ds.add(d);
    if (p.dNumber)  ds.add(p.dNumber);
    if (p.dNumbers) for (const d of p.dNumbers) ds.add(d);
  }
  return ds;
}

// `dInfos` is mutated in place — pass the same object back in on
// subsequent walk emits and we'll only resolve the *new* Ds, instead of
// rebuilding the whole map each time `combined` grows.
async function mergeDInfos(dInfos, pushes, errors) {
  const fresh = [...collectDsFromPushes(pushes)].filter(d => !(d in dInfos));
  if (!fresh.length) return dInfos;
  await Promise.all(fresh.map(async d => {
    const [title, status] = await Promise.all([
      getDRevisionTitle(d, errors), getDStatus(d, errors),
    ]);
    dInfos[d] = { title, status };
  }));
  return dInfos;
}

// Phab D-page algorithm (DATA.md §"Phabricator D-page").
// Shared 4-phase search body used by both findPushesForD and
// findPushesForBug. Caller supplies:
//   - errors:        a FetchErrorTracker (so any failures it reports
//                    earlier — e.g. creator resolution — are forwarded)
//   - creators:      patch-creator emails to scope try author-history
//                    fetches and the mach-try-auto walk candidates
//   - matchText:     predicate that decides whether a push's joined
//                    commit text contains the search target
//   - labelFor:      optional async (push, repo) → label-fields object
//                    (Bugzilla path uses this to pick which of the
//                    bug's Ds each push covers; Phab path passes none)
//   - reportProgress / emit: progress + result callbacks
async function runMultiRepoSearch({ errors, creators, matchText, labelFor, reportProgress, emit }) {
  // Phase 1 — every Treeherder push list, fan out in parallel.
  reportProgress?.(`Searching ${TRACKED_REPOS.length} repos…`, 0, TRACKED_REPOS.length);
  let repoDone = 0;
  const perRepo = await Promise.all(TRACKED_REPOS.map(async repo => {
    const all = await gatherFromRepo(repo, creators, errors);
    reportProgress?.(`Searching ${TRACKED_REPOS.length} repos…`, ++repoDone, TRACKED_REPOS.length);
    return { repo, all };
  }));

  // Phase 2 — direct matches (Diff Rev URL or canonical Bug-N subject)
  // across every repo's recently-fetched pool.
  const direct = perRepo.flatMap(({ repo, all }) =>
    all.filter(p => matchText(pushComments(p))).map(p => ({ _repo: repo, _push: p }))
  );
  direct.sort((a, b) => b._push.push_timestamp - a._push.push_timestamp);

  // Backout target sets per repo, mined from the same pools we fetched.
  const backoutSets = computeBackoutSets(perRepo);

  // Phase 3 — label (Bugzilla only), enrich, and emit direct matches.
  const labeled = labelFor
    ? await Promise.all(direct.map(async ({ _repo, _push }) =>
        ({ _repo, _push, _label: await labelFor(_push, _repo) })))
    : direct;
  const enrichedDirect = await enrichEntries(labeled, errors, reportProgress, backoutSets);
  const dInfos = await mergeDInfos({}, enrichedDirect, errors);
  emit({ pushes: enrichedDirect, errors: errors.toJSON(), dInfos });

  // Phase 4 — hg-edge walks for try mach-try-auto. Each match is enriched
  // and emitted incrementally so the panel folds new pushes in as they
  // resolve, rather than waiting for the whole walk to finish.
  const tryEntry = perRepo.find(e => e.repo === "try");
  const directTryIds = new Set(direct.filter(e => e._repo === "try").map(e => e._push.id));
  const candidates = tryWalkCandidates(tryEntry?.all ?? [], creators, directTryIds);
  if (!candidates.length) return;

  // Concurrent walks (WALK_CONCURRENCY > 1) can resolve in any order;
  // each emit snapshots the current `combined` array which is always
  // sorted, so the panel observes a monotonically growing set of pushes.
  const combined = [...enrichedDirect];
  const onMatch = async push => {
    const label = labelFor ? await labelFor(push, "try") : {};
    const enriched = await enrichPush(push, "try", label, errors, backoutSets);
    if (!enriched) return;
    combined.push(enriched);
    combined.sort(byPushTimestampDesc);
    await mergeDInfos(dInfos, [enriched], errors);
    emit({ pushes: [...combined], errors: errors.toJSON(), dInfos });
  };
  await walkParentDescs(candidates, matchText, errors, reportProgress, onMatch);

  // Final emit so any errors recorded after the last match (or if no
  // matches found at all) reach the panel.
  emit({ pushes: [...combined], errors: errors.toJSON(), dInfos });
}

// Phab D-page algorithm (DATA.md §"Phabricator D-page").
async function findPushesForD(dNumber, bugHint, reportProgress, emit) {
  const errors = new FetchErrorTracker();
  reportProgress?.("Resolving patch creator…");
  const creator = await getDCreator(dNumber, bugHint, errors);
  return runMultiRepoSearch({
    errors,
    creators: creator ? [creator] : [],
    // Match by D only — bug-N would surface sibling-D pushes for the same bug.
    matchText: text => extractDNums(text).includes(dNumber),
    labelFor: null,
    reportProgress, emit,
  });
}

// Bugzilla bug-page algorithm (DATA.md §"Bugzilla bug page").
async function findPushesForBug(bugNumber, dNumbers, reportProgress, emit) {
  const errors = new FetchErrorTracker();

  // Resolve creators for each D (DOM-primed when on the bug page; otherwise
  // a single Bugzilla attachment fetch yields creators for all Ds at once).
  const creators = [...new Set(
    (await Promise.all(dNumbers.map(d => getDCreator(d, bugNumber, errors)))).filter(Boolean)
  )];

  // Prime title fetches in parallel — used for the untagged-push relabel
  // fallback in labelFor when no D-URL appears in the commit text.
  const titlesPromise = Promise.all(dNumbers.map(async d =>
    [d, await getDRevisionTitle(d, errors)]));

  const dSet = new Set(dNumbers);
  const bugRe = bugRegex(bugNumber);

  return runMultiRepoSearch({
    errors, creators,
    matchText: text => extractDNums(text).some(d => dSet.has(d)) || bugRe.test(text),
    labelFor: async (push, repo) => {
      const stack = await computeStackDNums(push, repo, errors);
      const covers = stack.filter(d => dSet.has(d));
      if (covers.length > 1)   return { dNumbers: [...covers].sort() };
      if (covers.length === 1) return { dNumber: covers[0] };
      const subjects = subjectsFromPush(push);
      const titles = Object.fromEntries(await titlesPromise);
      const m = dNumbers.find(d => titleMatchesSubjects(titles[d], subjects));
      return m ? { dNumber: m } : {};
    },
    reportProgress, emit,
  });
}

// Treeherder-page link resolver. Currently only invoked on `try` pages
// (manifest content_scripts glob); see DATA.md §"Treeherder try page".
async function resolveLinks(revision) {
  const errors = new FetchErrorTracker();
  const hgPromise = getHgParentDesc(revision, errors);
  const push = await getPushObject("try", revision, errors);
  if (!push) return null;

  const text = pushComments(push);
  let dNums   = extractDNums(text);
  let bugNums = extractBugNums(text);

  if (!dNums.length && !bugNums.length) {
    const desc = await hgPromise;
    if (desc) {
      dNums   = extractDNums(desc);
      bugNums = extractBugNums(desc);
    }
  }

  if (dNums.length && !bugNums.length) {
    const bugs = await Promise.all(dNums.map(d => getDBugNumber(d, errors)));
    bugNums = [...new Set(bugs.filter(Boolean))];
  }

  if (bugNums.length && !dNums.length) {
    const subjects = subjectsFromPush(push);
    const candidates = (await Promise.all(bugNums.map(async b => {
      const atts = await fetchBugAttachments(b, errors);
      return atts.filter(a => !a.is_obsolete)
        .map(a => a.file_name.match(PHAB_ATTACHMENT_RE)?.[1])
        .filter(Boolean);
    }))).flat();
    const matched = await Promise.all([...new Set(candidates)].map(async d =>
      titleMatchesSubjects(await getDRevisionTitle(d, errors), subjects) ? d : null));
    dNums = matched.filter(Boolean);
  }

  return (dNums.length || bugNums.length) ? { dNums, bugNums } : null;
}

// --- Message routing ---

async function handleGetTryPushes(msg, reportProgress, emit) {
  const { dNumber, dNumbers, bugNumber, dCreators, revisionTitle } = msg;

  // Cache priming from DOM data (URL → DOM tier of DATA.md priority order).
  if (revisionTitle && dNumber) primeDTitle(dNumber, revisionTitle);
  if (bugNumber && dNumber)     primeDBug(dNumber, bugNumber);
  if (bugNumber && dNumbers) for (const d of dNumbers) primeDBug(d, bugNumber);
  if (dCreators) for (const [d, c] of Object.entries(dCreators)) primeDCreator(d, c);

  if (dNumbers?.length >= 2 && bugNumber)
    return findPushesForBug(bugNumber, dNumbers, reportProgress, emit);

  const d = dNumber ?? dNumbers?.[0];
  if (d) return findPushesForD(d, bugNumber, reportProgress, emit);

  // Bug page with no Phabricator attachments: bug-N scan over recent
  // pushes across all tracked repos. No author history (no creators), no
  // walk (tryWalkCandidates returns empty when creatorSet is empty), so
  // runMultiRepoSearch reduces to "recent + filter + enrich + emit".
  if (bugNumber) {
    const errors = new FetchErrorTracker();
    const re = bugRegex(bugNumber);
    return runMultiRepoSearch({
      errors, creators: [],
      matchText: text => re.test(text),
      labelFor: null,
      reportProgress, emit,
    });
  }

  emit({ pushes: [], errors: [], dInfos: {} });
}

async function handleGetDTitle(d) {
  const [title, status] = await Promise.all([getDRevisionTitle(d), getDStatus(d)]);
  return { title, status };
}

async function handleFlushCaches() {
  for (const [m] of memCaches) m.clear();
  dStatusCache.clear();   // in-memory-only volatile cache, not in memCaches
  memCacheLoad = null;
  await safely(() => browser.storage.local.clear());
  return { ok: true };
}

browser.runtime.onMessage.addListener((msg, _sender) => {
  if (msg.type === "resolveLinks") return resolveLinks(msg.revision);
  if (msg.type === "getDTitle")    return handleGetDTitle(msg.dNum);
  if (msg.type === "flushCaches")  return handleFlushCaches();
  // getTryPushes is intentionally not handled here: it's progressive and
  // uses the port-based onConnect path below to support multiple emits.
});

browser.runtime.onConnect.addListener(port => {
  if (port.name !== "getTryPushes") return;
  port.onMessage.addListener(async msg => {
    const report = (m, done, total) =>
      safely(() => port.postMessage({ type: "progress", message: m, done, total }));
    // emit() can be called multiple times — once for direct matches, again
    // for the combined set after walks. The panel re-renders on each.
    const emit = ({ pushes, errors, dInfos }) =>
      safely(() => port.postMessage({ type: "result", pushes, errors, dInfos }));
    try {
      await handleGetTryPushes(msg, report, emit);
      port.postMessage({ type: "complete" });
    } catch (e) {
      console.error("[phab-try] handleGetTryPushes threw:", e);
      port.postMessage({ type: "error", message: e.message });
    }
  });
});

// Keep the service worker alive so content-script messages aren't dropped.
browser.alarms.create("keepalive", { periodInMinutes: KEEPALIVE_PERIOD_MIN });
browser.alarms.onAlarm.addListener(() => {});
