// src/lib/prefetch-opportunities.js
//
// Background prefetch for:
// 1) Opportunity titles/URLs via POST /api/seo/opportunities
// 2) Existing-page HTML content for the *top 2 blogs + top 2 pages* via POST /api/seo (providers:["content"])
// 3) Writes results into the SAME sessionStorage cache shape that OpportunitiesSection expects:
//
//   key:   drfizz.opps.v1:<normalizedDomain>
//   value: { ts, status: "running"|"complete", scanId, seoRows: [ { domain, content:{ blog:[slot], pages:[slot] } } ] }
//
// So when Dashboard mounts later, OpportunitiesSection hydrates instantly from cache (no long wait)
// and "Create from existing" opens instantly for those 4 items (slot.content is prefilled).

/* -------------------------------------------
   Cache + domain helpers (mirrors OpportunitiesSection)
-------------------------------------------- */

const OPPS_CLIENT_CACHE_TTL_MS = 1000 * 60 * 60 * 24; // 24h (client-side convenience)
const OPPS_PREFETCH_FLAG = "__drfizzOppsPrefetch__"; // window singleton for de-dupe

const normalizeDomain = (input = "") => {
  try {
    const url = input.includes("://") ? new URL(input) : new URL(`https://${input}`);
    let host = url.hostname.toLowerCase();
    if (host.startsWith("www.")) host = host.slice(4);
    return host;
  } catch {
    return String(input || "")
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .split("/")[0]
      .trim();
  }
};

const ensureHttpUrl = (value = "") => {
  const s = String(value || "").trim();
  if (!s) return "";
  if (s.startsWith("http://") || s.startsWith("https://")) return s;
  return `https://${s.replace(/^\/+/, "")}`;
};

const toWebsiteUrl = (domain) => ensureHttpUrl(domain);

const oppsCacheKey = (domain) => `drfizz.opps.v1:${normalizeDomain(domain || "")}`;

function readOppsCache(domain) {
  try {
    const raw = sessionStorage.getItem(oppsCacheKey(domain));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.ts || !parsed?.seoRows) return null;

    const age = Date.now() - Number(parsed.ts || 0);
    if (age > OPPS_CLIENT_CACHE_TTL_MS) return null;

    return parsed;
  } catch {
    return null;
  }
}

function writeOppsCache(domain, payload) {
  try {
    sessionStorage.setItem(oppsCacheKey(domain), JSON.stringify(payload));
  } catch {
    // ignore quota / private mode issues
  }
}

/* -------------------------------------------
   In-memory / window de-dupe
-------------------------------------------- */

function getPrefetchRegistry() {
  if (typeof window === "undefined") return null;

  // registry keyed by normalizedDomain
  // value: { startedAt, promise }
  if (!window[OPPS_PREFETCH_FLAG]) {
    window[OPPS_PREFETCH_FLAG] = Object.create(null);
  }
  return window[OPPS_PREFETCH_FLAG];
}

/* -------------------------------------------
   Network helpers
-------------------------------------------- */

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function pollScanComplete(scanId, { intervalMs = 2500, timeoutMs = 2 * 60 * 1000 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`/api/seo/scan/status?scanId=${encodeURIComponent(scanId)}`, {
        method: "GET",
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json?.status === "complete") return { ok: true, json };
    } catch {
      // ignore and keep polling
    }
    await sleep(intervalMs);
  }
  return { ok: false };
}

function buildRowFromOppsJson(json, domain) {
  // Server already returns arrays "blogs" and "pages"
  const blogs = Array.isArray(json?.blogs) ? json.blogs : [];
  const pages = Array.isArray(json?.pages) ? json.pages : [];

  // IMPORTANT: OpportunitiesSection itself picks top published + draft.
  // The server route already returns at most top 2 published + 2 draft per category,
  // but we’ll keep the mapping straightforward: use whatever it returns.
  const mapItemToSlot = (item, fallbackTitle, d) => {
    const title = item?.title || fallbackTitle || "Untitled";
    const urlFromApi = item?.url ? ensureHttpUrl(item.url) : "";
    return {
      title,
      priority: "Medium Priority",
      wordCount: typeof item?.wordCount === "number" ? item.wordCount : 0,
      keywords: 0,
      score: 0,
      status: item?.isDraft ? "Draft" : "Published",
      // This is the key for instant "Create from existing"
      content:
        (typeof item?.contentHtml === "string" && item.contentHtml.trim()) ||
        (typeof item?.content === "string" && item.content.trim()) ||
        "",
      slug: item?.slug ? String(item.slug) : "",
      primaryKeyword: null,
      lsiKeywords: [],
      plagiarism: typeof item?.plagiarism === "number" ? item.plagiarism : null,
      plagiarismSources: Array.isArray(item?.plagiarismSources) ? item.plagiarismSources : [],
      url: urlFromApi,
      meta: {
        originalTitle: item?.title || null,
        publishedAt: item?.publishedAt || null,
        isDraft: !!item?.isDraft,
      },
    };
  };

  const d = normalizeDomain(domain || json?.hostname || "");
  return {
    domain: normalizeDomain(json?.hostname || d),
    content: {
      blog: blogs.map((item, i) => mapItemToSlot(item, `Blog Opportunity ${i + 1}`, d)),
      pages: pages.map((item, i) => mapItemToSlot(item, `Page Opportunity ${i + 1}`, d)),
    },
  };
}

function pickTop2Plus2(slots = []) {
  // Mirror the UX goal: prefetch what user can immediately click.
  // OpportunitiesSection shows 2 slots per category in the hero cards; this keeps it tight.
  // If slots > 4, keep first 4 (the list is already "top published + top draft" on server).
  return slots.slice(0, 4);
}

/* -------------------------------------------
   Content prefetch (/api/seo providers:["content"])
-------------------------------------------- */

async function fetchContentHtmlForUrl(url, { keyword = "", countryCode = "in", languageCode = "en" } = {}) {
  const u = ensureHttpUrl(url);
  if (!u) return "";

  try {
    const res = await fetch("/api/seo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // IMPORTANT: use only "content" provider to keep it lightweight
      body: JSON.stringify({
        url: u,
        keyword: keyword || "",
        countryCode,
        languageCode,
        providers: ["content"],
      }),
    });

    const json = await res.json().catch(() => ({}));
    if (!res.ok) return "";

    // Common shapes (defensive):
    // - json.content.html
    // - json.results.content.html
    // - json.contentHtml
    const html =
      (typeof json?.content?.html === "string" && json.content.html) ||
      (typeof json?.results?.content?.html === "string" && json.results.content.html) ||
      (typeof json?.contentHtml === "string" && json.contentHtml) ||
      "";

    return String(html || "");
  } catch {
    return "";
  }
}

function patchCacheWithContent(domain, { blogSlots = [], pageSlots = [] } = {}) {
  const d = normalizeDomain(domain);
  const cached = readOppsCache(d);
  if (!cached?.seoRows?.length) return;

  const row0 = cached.seoRows[0];
  const nextRow = {
    ...row0,
    content: {
      blog: Array.isArray(row0?.content?.blog) ? [...row0.content.blog] : [],
      pages: Array.isArray(row0?.content?.pages) ? [...row0.content.pages] : [],
    },
  };

  // Create a url->content map
  const urlToContent = new Map();
  [...blogSlots, ...pageSlots].forEach((s) => {
    const url = ensureHttpUrl(s?.url || "");
    const content = typeof s?.content === "string" ? s.content : "";
    if (url && content) urlToContent.set(url, content);
  });

  const apply = (slots) =>
    slots.map((s) => {
      const url = ensureHttpUrl(s?.url || "");
      const existing = typeof s?.content === "string" ? s.content : "";
      const patched = urlToContent.get(url);
      if (patched && !existing) return { ...s, content: patched };
      return s;
    });

  nextRow.content.blog = apply(nextRow.content.blog);
  nextRow.content.pages = apply(nextRow.content.pages);

  writeOppsCache(d, {
    ts: Date.now(),
    status: cached.status || "complete",
    scanId: cached.scanId || "",
    seoRows: [nextRow],
  });
}

/* -------------------------------------------
   Public API
-------------------------------------------- */

/**
 * Fire-and-forget prefetch.
 *
 * - Safe to call multiple times; it de-dupes per domain.
 * - Runs in background; do NOT await unless you want to gate UI.
 *
 * @param {string} domainOrUrl user entered domain (example.com) or URL
 * @param {object} options
 * @param {number} options.timeoutMs scan polling timeout
 * @param {number} options.concurrency number of parallel /api/seo content fetches (default 2)
 * @param {string} options.countryCode
 * @param {string} options.languageCode
 * @returns {Promise<{ok:boolean, fromCache?:boolean}>}
 */
export function prefetchOpportunitiesAndContent(
  domainOrUrl,
  { timeoutMs = 2 * 60 * 1000, concurrency = 2, countryCode = "in", languageCode = "en" } = {}
) {
  const d = normalizeDomain(domainOrUrl || "");
  if (!d || d === "example.com") return Promise.resolve({ ok: false });

  // If we already have a complete cache, nothing to do.
  const cached = typeof window !== "undefined" ? readOppsCache(d) : null;
  if (cached?.status === "complete" && cached?.seoRows?.length) {
    // If content already present for top items, we're done.
    const row0 = cached.seoRows[0];
    const blogs = pickTop2Plus2(row0?.content?.blog || []);
    const pages = pickTop2Plus2(row0?.content?.pages || []);
    const allHaveContent = [...blogs, ...pages].every(
      (s) => typeof s?.content === "string" && s.content.trim()
    );
    if (allHaveContent) return Promise.resolve({ ok: true, fromCache: true });
  }

  const reg = getPrefetchRegistry();
  if (!reg) return Promise.resolve({ ok: false });

  if (reg[d]?.promise) return reg[d].promise;

  const promise = (async () => {
    // 1) Fetch opportunities (titles/urls). Handle 202 scan-in-progress.
    let scanId = "";
    let oppsJson = null;

    try {
      const websiteUrl = toWebsiteUrl(d);

      const res = await fetch("/api/seo/opportunities", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ websiteUrl, allowSubdomains: true }),
      });

      const json = await res.json().catch(() => ({}));

      if (res.status === 202) {
        scanId = json?.source?.scanId || "";
        // write a "running" cache so Dashboard can show "Scanning..." but keep any old rows
        writeOppsCache(d, {
          ts: Date.now(),
          status: "running",
          scanId,
          seoRows: cached?.seoRows || [],
        });

        if (scanId) {
          await pollScanComplete(scanId, { timeoutMs });
          // refetch now that scan is complete
          const res2 = await fetch("/api/seo/opportunities", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ websiteUrl, allowSubdomains: true }),
          });
          const json2 = await res2.json().catch(() => ({}));
          if (res2.ok) {
            oppsJson = json2;
            scanId = json2?.source?.scanId || scanId;
          } else {
            return { ok: false };
          }
        } else {
          return { ok: false };
        }
      } else if (res.ok) {
        oppsJson = json;
        scanId = json?.source?.scanId || "";
      } else {
        return { ok: false };
      }
    } catch {
      return { ok: false };
    }

    if (!oppsJson) return { ok: false };

    // 2) Build seoRows in the same shape OpportunitiesSection expects and write complete cache ASAP
    const row = buildRowFromOppsJson(oppsJson, d);

    writeOppsCache(d, {
      ts: Date.now(),
      status: "complete",
      scanId,
      seoRows: [row],
    });

    // 3) Prefetch HTML for top 2 blogs + top 2 pages (only if missing content)
    const blogSlots = pickTop2Plus2(row?.content?.blog || []).filter(
      (s) => !(typeof s?.content === "string" && s.content.trim()) && s?.url
    );
    const pageSlots = pickTop2Plus2(row?.content?.pages || []).filter(
      (s) => !(typeof s?.content === "string" && s.content.trim()) && s?.url
    );

    const targets = [...blogSlots.map((s) => ({ kind: "blog", slot: s })), ...pageSlots.map((s) => ({ kind: "page", slot: s }))];

    if (!targets.length) return { ok: true };

    // simple concurrency pool
    let idx = 0;
    const results = [];

    const worker = async () => {
      while (idx < targets.length) {
        const current = targets[idx++];
        const html = await fetchContentHtmlForUrl(current.slot.url, {
          keyword: d,
          countryCode,
          languageCode,
        });
        if (html && html.trim()) {
          results.push({
            ...current.slot,
            content: html,
            url: ensureHttpUrl(current.slot.url),
          });
        }
      }
    };

    const workers = Array.from({ length: Math.max(1, Math.min(concurrency, targets.length)) }, worker);
    await Promise.all(workers);

    // 4) Patch cache with fetched HTML so "Create from existing" becomes instant
    if (results.length) {
      const patchedBlogs = results.filter((r) => blogSlots.some((b) => ensureHttpUrl(b.url) === ensureHttpUrl(r.url)));
      const patchedPages = results.filter((r) => pageSlots.some((p) => ensureHttpUrl(p.url) === ensureHttpUrl(r.url)));
      patchCacheWithContent(d, { blogSlots: patchedBlogs, pageSlots: patchedPages });
    }

    return { ok: true };
  })().finally(() => {
    // keep registry entry so subsequent calls re-use completion state,
    // but drop the promise to allow re-run for a new day/domain if you want.
    if (reg[d]) {
      reg[d].finishedAt = Date.now();
      reg[d].promise = null;
    }
  });

  reg[d] = { startedAt: Date.now(), promise };

  return promise;
}
