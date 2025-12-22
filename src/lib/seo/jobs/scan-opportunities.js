// src/lib/seo/jobs/scan-opportunities.js
import {
  discoverOpportunitiesUrls,
  normalizeToHttps,
  getHostname,
} from "@/lib/seo/discovery";
import {
  createScan,
  completeScan,
  failScan,
  upsertOpportunitiesSnapshot,
} from "@/lib/seo/snapshots.store";

import { checkPlagiarismWithPerplexity } from "@/lib/perplexity/pipeline";

/**
 * In-flight dedupe (module-level, survives within a single Node process).
 * Keyed by hostname + allowSubdomains + mode.
 */
const IN_FLIGHT = new Map();

function makeInFlightKey({ hostname, allowSubdomains, mode }) {
  return `opportunities|${hostname}|sub=${allowSubdomains ? 1 : 0}|mode=${mode}`;
}

function clampPct(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(100, Math.round(x)));
}

function htmlToPlain(html) {
  const s = String(html || "");
  if (!s) return "";
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * ✅ NEW: Heuristic for "blog-like" urls when blogUrls are missing.
 */
function isBlogOrArticleLikeUrl(url) {
  try {
    const u = new URL(url);
    const p = (u.pathname || "").toLowerCase();

    if (
      /\/(blog|blogs)\b/.test(p) ||
      /\/(article|articles)\b/.test(p) ||
      /\/(news|press)\b/.test(p) ||
      /\/(insights|resources|stories|updates)\b/.test(p) ||
      /\/(posts)\b/.test(p)
    ) {
      return true;
    }

    if (u.searchParams.has("p") || u.searchParams.has("post_type")) return true;

    return false;
  } catch {
    return false;
  }
}

/**
 * ✅ NEW: If a title is empty/missing, generate a nicer fallback from the slug.
 */
function titleFromSlug(url) {
  try {
    const u = new URL(url);
    const parts = (u.pathname || "")
      .split("/")
      .map((s) => s.trim())
      .filter(Boolean);

    if (!parts.length) return "";

    let slug = parts[parts.length - 1].replace(/\.[a-z0-9]+$/i, "");
    slug = slug.replace(/[-_]+/g, " ").trim();
    if (!slug) return "";

    return slug
      .split(" ")
      .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
      .join(" ");
  } catch {
    return "";
  }
}

export function enqueueOpportunitiesScan({
  websiteUrl,
  allowSubdomains = false,
} = {}) {
  const normalized = normalizeToHttps(websiteUrl);
  const hostname = getHostname(normalized);
  if (!normalized || !hostname) throw new Error("Invalid websiteUrl");

  const mode = "published";
  const key = makeInFlightKey({ hostname, allowSubdomains, mode });

  const existing = IN_FLIGHT.get(key);
  if (existing?.scanId && (existing.status === "queued" || existing.status === "running")) {
    return existing;
  }

  const scan = createScan({
    kind: "opportunities",
    websiteUrl: normalized,
    hostname,
    allowSubdomains,
    mode,
  });

  upsertOpportunitiesSnapshot(hostname, {
    scanId: scan.scanId,
    status: "queued",
    mode,
    allowSubdomains,
    diagnostics: { stage: "queued" },
    blogs: [],
    pages: [],
  });

  IN_FLIGHT.set(key, { ...scan, status: "queued" });

  runOpportunitiesScan({
    inFlightKey: key,
    scanId: scan.scanId,
    websiteUrl: normalized,
    allowSubdomains,
    mode,
  }).catch(() => {});

  return scan;
}

async function runOpportunitiesScan({
  inFlightKey,
  scanId,
  websiteUrl,
  allowSubdomains,
  mode,
}) {
  const hostname = getHostname(websiteUrl);

  try {
    upsertOpportunitiesSnapshot(hostname, {
      scanId,
      status: "running",
      mode,
      allowSubdomains,
      diagnostics: { stage: "discovery" },
      blogs: [],
      pages: [],
    });
    IN_FLIGHT.set(inFlightKey, { scanId, status: "running" });
  } catch {}

  try {
    const discovery = await discoverOpportunitiesUrls({
      websiteUrl,
      allowSubdomains,
      crawlFallbackFn: simpleCrawlFallback,
    });

    let blogUrls = Array.isArray(discovery?.blogUrls) ? discovery.blogUrls : [];
    let pageUrls = Array.isArray(discovery?.pageUrls) ? discovery.pageUrls : [];

    const blogWasEmpty = blogUrls.length === 0;

    if (blogUrls.length === 0 && pageUrls.length > 0) {
      const inferredBlogs = pageUrls.filter(isBlogOrArticleLikeUrl);
      if (inferredBlogs.length > 0) blogUrls = inferredBlogs;
    }

    if (blogUrls.length === 0) {
      const crawled = await simpleCrawlFallback(hostname, {
        maxCrawlPages: 80,
        allowSubdomains,
      });

      const crawledBlogs = crawled.filter(isBlogOrArticleLikeUrl);
      if (crawledBlogs.length > 0) blogUrls = crawledBlogs.slice(0, 40);

      if (!pageUrls.length && crawled.length) {
        pageUrls = crawled.filter((u) => !isBlogOrArticleLikeUrl(u)).slice(0, 40);
      }
    }

    try {
      upsertOpportunitiesSnapshot(hostname, {
        scanId,
        status: "running",
        mode,
        allowSubdomains,
        diagnostics: {
          ...(discovery?.diagnostics || {}),
          stage: "fetch-meta",
          blogFallbackUsed: blogWasEmpty && blogUrls.length > 0,
        },
        blogs: [],
        pages: [],
      });
    } catch {}

    // ---- NEW: bounded plagiarism budget for the scan ----
    const PLAGIARISM_MAX_ITEMS = 12; // tune this
    let plagiarismBudgetRemaining = PLAGIARISM_MAX_ITEMS;

    const blogMeta = await fetchManyMeta(blogUrls, hostname, allowSubdomains, {
      getBudget: () => plagiarismBudgetRemaining,
      consumeBudget: () => (plagiarismBudgetRemaining = Math.max(0, plagiarismBudgetRemaining - 1)),
    });

    const pageMeta = await fetchManyMeta(pageUrls, hostname, allowSubdomains, {
      getBudget: () => plagiarismBudgetRemaining,
      consumeBudget: () => (plagiarismBudgetRemaining = Math.max(0, plagiarismBudgetRemaining - 1)),
    });

    upsertOpportunitiesSnapshot(hostname, {
      scanId,
      status: "complete",
      diagnostics: {
        ...(discovery?.diagnostics || {}),
        blogFallbackUsed: blogWasEmpty && blogUrls.length > 0,
      },
      mode,
      allowSubdomains,
      blogs: blogMeta,
      pages: pageMeta,
    });

    completeScan(scanId, { hostname, diagnostics: discovery?.diagnostics });
    IN_FLIGHT.set(inFlightKey, { scanId, status: "complete" });

    setTimeout(() => IN_FLIGHT.delete(inFlightKey), 30_000).unref?.();
  } catch (err) {
    try {
      upsertOpportunitiesSnapshot(hostname, {
        scanId,
        status: "failed",
        mode,
        allowSubdomains,
        diagnostics: { error: err?.message || "scan failed", stage: "failed" },
        blogs: [],
        pages: [],
      });
    } catch {}

    failScan(scanId, { error: err?.message || "scan failed" });
    IN_FLIGHT.set(inFlightKey, { scanId, status: "failed" });

    setTimeout(() => IN_FLIGHT.delete(inFlightKey), 30_000).unref?.();
  }
}

// ---------------------------
// Minimal controlled crawl fallback
// ---------------------------
async function simpleCrawlFallback(
  hostname,
  { maxCrawlPages = 60, allowSubdomains = false } = {}
) {
  const seed = `https://${hostname}/`;
  const visited = new Set();
  const queue = [seed];
  const results = [];

  while (queue.length && visited.size < maxCrawlPages) {
    const url = queue.shift();
    if (!url || visited.has(url)) continue;
    visited.add(url);

    const res = await safeFetch(url, { timeoutMs: 12000 });
    if (!res?.ok) continue;

    const html = await res.text().catch(() => "");
    if (!html) continue;

    results.push(url);

    const links = extractLinks(html, url);
    for (const link of links) {
      if (!link) continue;
      if (visited.has(link)) continue;

      try {
        const h = new URL(link).hostname.replace(/^www\./, "").toLowerCase();
        if (h !== hostname && !(allowSubdomains && h.endsWith(`.${hostname}`)))
          continue;
      } catch {
        continue;
      }

      queue.push(link);
      if (queue.length > maxCrawlPages * 4) break;
    }
  }

  return results;
}

function extractLinks(html, baseUrl) {
  const out = [];
  const matches = html.matchAll(/href\s*=\s*["']([^"']+)["']/gi);
  for (const m of matches) {
    const href = (m[1] || "").trim();
    if (!href) continue;
    if (
      href.startsWith("#") ||
      href.startsWith("mailto:") ||
      href.startsWith("tel:") ||
      href.startsWith("javascript:")
    )
      continue;

    try {
      out.push(new URL(href, baseUrl).toString());
    } catch {}
  }
  return out;
}

// ---------------------------
// Fetch + meta extraction
// ---------------------------
async function fetchManyMeta(urls, hostname, allowSubdomains, plagiarismBudgetApi) {
  const uniq = Array.from(new Set((urls || []).filter(Boolean)));

  const metas = [];
  for (const u of uniq) {
    const meta = await fetchMeta(u, hostname, allowSubdomains, plagiarismBudgetApi);
    if (meta) metas.push(meta);
  }

  const seen = new Set();
  return metas.filter((m) => {
    if (seen.has(m.url)) return false;
    seen.add(m.url);
    return true;
  });
}

async function fetchMeta(url, hostname, allowSubdomains, plagiarismBudgetApi) {
  try {
    const h = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    if (h !== hostname && !(allowSubdomains && h.endsWith(`.${hostname}`)))
      return null;
  } catch {
    return null;
  }

  const res = await safeFetch(url, { timeoutMs: 15000 });
  if (!res || !res.ok) return null;

  const html = await res.text().catch(() => "");
  if (!html) return null;

  const extractedTitle = extractTitle(html);
  const title = extractedTitle || titleFromSlug(url) || url;

  const description = extractMetaDescription(html) || "";
  const wordCount = estimateWordCount(html);

  const bodyInner = extractBodyInnerHtml(html);
  const contentHtml = sanitizeHtmlForEditor(bodyInner);

  // ---- NEW: precompute plagiarism (bounded) ----
  let plagiarism = 0;
  let plagiarismCheckedAt = null;
  let plagiarismSources = [];

  const budgetLeft = plagiarismBudgetApi?.getBudget?.() ?? 0;
  const shouldCheck =
    budgetLeft > 0 && wordCount >= 200 && contentHtml && contentHtml.length >= 1200;

  if (shouldCheck) {
    try {
      plagiarismBudgetApi?.consumeBudget?.();

      const draftText = htmlToPlain(contentHtml).slice(0, 9000);

      const out = await checkPlagiarismWithPerplexity({
        url,
        sourceUrl: url, // since this is the page itself
        draftText,
        sourceText: "", // no separate sourceText in scan mode
        cacheKey: "", // allow helper to derive stable key
      });

      plagiarism = clampPct(out?.plagiarism);
      plagiarismCheckedAt = out?.checkedAt || new Date().toISOString();
      plagiarismSources = Array.isArray(out?.sources) ? out.sources : [];
    } catch {
      // swallow plagiarism errors; keep scan resilient
    }
  }

  return {
    url,
    title,
    description,
    wordCount,
    contentHtml,
    isDraft: false,

    plagiarism,
    plagiarismCheckedAt,
    plagiarismSources,
  };
}

function extractTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeHtml(m[1]).trim() : "";
}

function extractMetaDescription(html) {
  const m =
    html.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i) ||
    html.match(/<meta\s+content=["']([^"']+)["']\s+name=["']description["']/i);
  return m ? decodeHtml(m[1]).trim() : "";
}

function estimateWordCount(html) {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return 0;
  return text.split(" ").filter(Boolean).length;
}

function decodeHtml(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function extractBodyInnerHtml(fullHtml) {
  const html = String(fullHtml || "");
  if (!html) return "";
  const m = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  return m ? m[1] : html;
}

function sanitizeHtmlForEditor(inputHtml) {
  let html = String(inputHtml || "");
  if (!html) return "";

  html = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<svg[\s\S]*?<\/svg>/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
    .replace(/<canvas[\s\S]*?<\/canvas>/gi, "")
    .replace(/<form[\s\S]*?<\/form>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");

  html = html
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<aside[\s\S]*?<\/aside>/gi, "");

  html = html
    .replace(/<figure[\s\S]*?<\/figure>/gi, "")
    .replace(/<picture[\s\S]*?<\/picture>/gi, "")
    .replace(/<img\b[^>]*>/gi, "")
    .replace(/<source\b[^>]*>/gi, "")
    .replace(/<video[\s\S]*?<\/video>/gi, "")
    .replace(/<audio[\s\S]*?<\/audio>/gi, "");

  html = html
    .replace(/\son\w+\s*=\s*["'][\s\S]*?["']/gi, "")
    .replace(/\sstyle\s*=\s*["'][\s\S]*?["']/gi, "");

  html = html.replace(/<a\b([^>]*)>/gi, (m, attrs) => {
    const href = (attrs.match(/\shref\s*=\s*["'][^"']*["']/i) || [])[0] || "";
    const title = (attrs.match(/\stitle\s*=\s*["'][^"']*["']/i) || [])[0] || "";
    const target = (attrs.match(/\starget\s*=\s*["'][^"']*["']/i) || [])[0] || "";
    const rel = (attrs.match(/\srel\s*=\s*["'][^"']*["']/i) || [])[0] || "";
    return `<a${href}${title}${target}${rel}>`;
  });

  const allowed = new Set([
    "p",
    "br",
    "strong",
    "b",
    "em",
    "i",
    "u",
    "s",
    "blockquote",
    "code",
    "pre",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "ul",
    "ol",
    "li",
    "hr",
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
    "a",
    "span",
    "div",
  ]);

  html = html.replace(/<([a-z0-9]+)\b([^>]*)>/gi, (m, tag) => {
    const t = String(tag).toLowerCase();
    if (t === "a") return m;
    if (!allowed.has(t)) return `<div>`;
    return `<${t}>`;
  });

  html = html
    .replace(/<p>\s*(?:&nbsp;|\s|<br\s*\/?>)*\s*<\/p>/gi, "")
    .replace(/<div>\s*(?:&nbsp;|\s|<br\s*\/?>)*\s*<\/div>/gi, "")
    .trim();

  if (html.length > 120_000) html = html.slice(0, 120_000);

  return html;
}

// ---------------------------
// Fetch with timeout
// ---------------------------
async function safeFetch(url, { timeoutMs = 12000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        "user-agent": "DoctorFizzBot/1.0 (+https://example.com)",
        accept: "text/html,application/xhtml+xml",
      },
    });
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}
