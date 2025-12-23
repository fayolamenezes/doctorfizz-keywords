// src/lib/seo/extraction.js
import { extractPageText } from "@/lib/seo/apyhub";

// ✅ MAIN-CONTENT extraction (Readability)
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

// ---------------------------
// Small helpers
// ---------------------------
export function safeTrim(s, max = 140) {
  const x = (s || "").toString().trim();
  if (!x) return "";
  return x.length > max ? x.slice(0, max - 1) + "…" : x;
}

export function decodeHtmlEntities(str = "") {
  return String(str)
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ");
}

function htmlTextLen(html = "") {
  const text = String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length;
}

function getBrowserlessBase() {
  // Region endpoint tends to be more stable than chrome.browserless.io on serverless
  return process.env.BROWSERLESS_ENDPOINT_BASE || "https://production-sfo.browserless.io";
}

function withResidentialProxyIfEnabled(url) {
  // Optional: requires Browserless plan that supports it
  // Set BROWSERLESS_USE_RESIDENTIAL="1" in Vercel env if you want it.
  const useRes = String(process.env.BROWSERLESS_USE_RESIDENTIAL || "").trim() === "1";
  return useRes ? `${url}&proxy=residential` : url;
}

/**
 * ✅ REAL browser rendering via Browserless (Vercel-friendly)
 * Strategy:
 * 1) Try /content with wait+scroll for JS + lazy-load pages.
 * 2) If response is still too "thin", retry via /unblock (anti-bot) with content: true.
 */
export async function fetchHtml(url) {
  const token = process.env.BROWSERLESS_TOKEN;
  if (!token) throw new Error("Missing BROWSERLESS_TOKEN env variable");

  const base = getBrowserlessBase();

  // ---------- 1) /content (fast path) ----------
  const contentEndpoint = withResidentialProxyIfEnabled(`${base}/content?token=${token}`);

  const contentPayload = {
    url,
    gotoOptions: { waitUntil: "domcontentloaded", timeout: 45000 },
    rejectResourceTypes: ["image", "font", "media"],
    bestAttempt: true,
    waitForFunction: {
      timeout: 45000,
      fn: `
        async () => {
          const sleep = (ms) => new Promise(r => setTimeout(r, ms));

          await sleep(1500);

          // Scroll to trigger lazy-loaded blocks
          let lastH = -1;
          for (let i = 0; i < 18; i++) {
            window.scrollTo(0, document.body.scrollHeight);
            await sleep(700);
            const h = document.body.scrollHeight;
            if (h === lastH) break;
            lastH = h;
          }

          await sleep(800);

          // Must have meaningful text (avoid header/menu shell)
          const textLen = (document.body.innerText || "").trim().length;

          // "Some" main container exists
          const hasMain =
            document.querySelector("article") ||
            document.querySelector("[itemprop='articleBody']") ||
            document.querySelector(".entry-content") ||
            document.querySelector(".post-content") ||
            document.querySelector(".blog-content") ||
            document.querySelector("main");

          return Boolean(hasMain) && textLen > 2500;
        }
      `,
    },
  };

  let html = "";
  try {
    const res = await fetch(contentEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cache-control": "no-cache",
      },
      body: JSON.stringify(contentPayload),
    });

    if (res.ok) {
      html = await res.text().catch(() => "");
    } else {
      // don't throw yet, we'll try /unblock next
      html = "";
    }
  } catch {
    html = "";
  }

  // If we got meaningful HTML, return it
  if (html && htmlTextLen(html) > 2500) {
    return { ok: true, status: 200, html, finalUrl: url, headers: {} };
  }

  // ---------- 2) /unblock (anti-bot path) ----------
  const unblockEndpoint = withResidentialProxyIfEnabled(`${base}/unblock?token=${token}`);

  const unblockPayload = {
    url,
    content: true,
    cookies: false,
    browserWSEndpoint: false,
    bestAttempt: true,
  };

  const res2 = await fetch(unblockEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cache-control": "no-cache",
    },
    body: JSON.stringify(unblockPayload),
  });

  if (!res2.ok) {
    const t = await res2.text().catch(() => "");
    throw new Error(`Browserless /unblock failed (${res2.status}): ${t.slice(0, 250)}`);
  }

  const json = await res2.json().catch(() => ({}));
  const unblockHtml =
    typeof json?.content === "string"
      ? json.content
      : typeof json?.html === "string"
      ? json.html
      : "";

  return {
    ok: true,
    status: 200,
    html: unblockHtml || "",
    finalUrl: url,
    headers: {},
  };
}

export function extractTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return "";
  return decodeHtmlEntities(m[1].replace(/\s+/g, " ").trim());
}

export function extractMetaDescription(html) {
  const m = html.match(
    /<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["'][^>]*>/i
  );
  if (!m) return "";
  return decodeHtmlEntities(m[1].replace(/\s+/g, " ").trim());
}

/**
 * ✅ NEW: Extract MAIN article/page content from rendered HTML using Mozilla Readability.
 *
 * Returns:
 * { title: string, contentHtml: string, text: string, excerpt: string, length: number }
 *
 * Notes:
 * - Works best on a full, rendered HTML document (which you already fetch via Browserless).
 * - We remove obvious non-content nodes before Readability to improve precision.
 * - If it can't find meaningful content, it returns empty strings.
 */
export function extractMainContentHtml(fullHtml, url = "https://example.com") {
  try {
    const html = String(fullHtml || "");
    if (!html) return { title: "", contentHtml: "", text: "", excerpt: "", length: 0 };

    const dom = new JSDOM(html, { url });
    const doc = dom.window.document;

    // Remove obvious noise before parsing
    doc.querySelectorAll(
      "header, nav, footer, aside, form, script, style, noscript, iframe, canvas, svg"
    ).forEach((n) => n.remove());

    // Also remove common “chrome” containers if present
    doc.querySelectorAll(
      "[role='navigation'], [role='banner'], [role='contentinfo'], .navbar, .nav, .header, .footer, .sidebar"
    ).forEach((n) => n.remove());

    const reader = new Readability(doc, {
      keepClasses: false,
    });

    const article = reader.parse();
    // article: { title, content (HTML), textContent, length, excerpt, ... }
    const contentHtml = String(article?.content || "").trim();
    const text = String(article?.textContent || "").trim();

    // Guard: if too small, treat as failure
    // (tune thresholds if you want; this avoids returning menu shells)
    if (!contentHtml || text.length < 400) {
      return { title: "", contentHtml: "", text: "", excerpt: "", length: 0 };
    }

    return {
      title: String(article?.title || "").trim(),
      contentHtml,
      text,
      excerpt: String(article?.excerpt || "").trim(),
      length: Number(article?.length || text.length || 0) || 0,
    };
  } catch {
    return { title: "", contentHtml: "", text: "", excerpt: "", length: 0 };
  }
}

/**
 * Build the same “card” you currently return from /opportunities.
 * Returns: { url, title, description, wordCount }
 */
export async function buildOpportunityCard(url) {
  let html = "";
  let title = "";
  let description = "";

  try {
    const fetched = await fetchHtml(url);
    html = fetched.html || "";
    title = extractTitle(html);
    description = extractMetaDescription(html);
  } catch {
    // ignore
  }

  let wordCount = 0;
  try {
    const extracted = await extractPageText(url);
    const text = extracted?.apyhub?.text || "";
    wordCount = text ? text.trim().split(/\s+/).filter(Boolean).length : 0;
  } catch {
    wordCount = 0;
  }

  const fallbackFromPath =
    decodeHtmlEntities(
      new URL(url).pathname
        .split("/")
        .filter(Boolean)
        .slice(-1)[0]
        ?.replace(/[-_]/g, " ")
        ?.trim() || ""
    ) || "Untitled";

  const cleanTitle = title || fallbackFromPath;

  return {
    url,
    title: safeTrim(cleanTitle, 70),
    description: safeTrim(description || "", 110),
    wordCount,
  };
}

/**
 * Used by scan-draft job.
 * Returns: { title, description, wordCount }
 */
export async function extractSeoData(url) {
  let html = "";
  let title = "";
  let description = "";

  try {
    const fetched = await fetchHtml(url);
    html = fetched.html || "";
    title = extractTitle(html);
    description = extractMetaDescription(html);
  } catch {
    // ignore
  }

  let wordCount = 0;
  try {
    const extracted = await extractPageText(url);
    const text = extracted?.apyhub?.text || "";
    wordCount = text ? text.trim().split(/\s+/).filter(Boolean).length : 0;
  } catch {
    wordCount = 0;
  }

  return {
    title: safeTrim(title || "", 70),
    description: safeTrim(description || "", 110),
    wordCount,
  };
}
