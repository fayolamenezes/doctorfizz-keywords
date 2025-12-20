import { perplexityChat } from "@/lib/perplexity/client";
import { SiteProfileSchema, KeywordsSchema, CompetitorsSchema } from "@/lib/perplexity/schemas";
import { extractJsonObjectLoose, cleanList, toDomainish, normalizeHost } from "@/lib/perplexity/utils";
import { collectPublicSignals } from "@/lib/perplexity/publicSignals";
import { cacheGet, cacheSet } from "@/lib/perplexity/cache";

/* ----------------- helpers (NEW) ----------------- */
function escapeRegex(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripTrailingGeo(kw, geoTokens) {
  let s = String(kw || "").trim();
  if (!s) return s;

  for (const t of geoTokens) {
    if (!t) continue;
    const re = new RegExp(`([,\\s]+)${escapeRegex(t)}$`, "i");
    s = s.replace(re, "").trim();
  }

  // cleanup trailing punctuation
  s = s.replace(/[,\-–—]+$/, "").trim();
  return s;
}

export async function getSiteProfile({ input, industry = "", location = "", cacheKey = "" }) {
  if (cacheKey) {
    const cachedSignals = cacheGet(`signals:${cacheKey}`);
    const cachedProfile = cacheGet(`profile:${cacheKey}`);
    if (cachedSignals && cachedProfile) return { profile: cachedProfile, signals: cachedSignals };
  }

  const signals = (cacheKey && cacheGet(`signals:${cacheKey}`)) || (await collectPublicSignals(input));
  if (cacheKey) cacheSet(`signals:${cacheKey}`, signals);

  const system = `
You are an SEO intelligence engine.
You MUST determine what the business ACTUALLY is using public information:
- The website content provided
- And your own web search / public sources (do not rely only on guesses)

Return ONLY valid JSON matching the schema.
If uncertain, set businessType="unknown" and lower confidence.
`.trim();

  const user = `
Input: ${input}
Domain: ${signals.domain}
Optional industry hint (from user): ${industry || "none"}
Optional location hint (from user): ${location || "none"}

PUBLIC WEBSITE SIGNALS:
Homepage URL: ${signals.homepage.finalUrl}
Homepage title: ${signals.homepage.title}
Homepage meta description: ${signals.homepage.metaDescription}
Homepage snippet (truncated): ${signals.homepage.snippet}

Internal pages (truncated):
${signals.internalPages
  .map(
    (p, i) =>
      `#${i + 1} ${p.url}\n- title: ${p.title}\n- meta: ${p.metaDescription}\n- snippet: ${p.snippet}`
  )
  .join("\n\n")}

Robots/sitemaps:
- robots ok: ${signals.robots.ok} status: ${signals.robots.status}
- sitemap candidates: ${signals.robots.sitemaps.join(", ")}

TASK:
1) Identify what this business sells/offers (primaryOffering).
2) Choose businessType (product/service/marketplace/publisher/community/saas/unknown).
3) Provide 5–10 short "offerings" terms that define its universe.
4) Provide confidence 0..1.
5) List the public signals/sources you used.
`.trim();

  const { content } = await perplexityChat({
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    response_format: SiteProfileSchema,
    temperature: 0.15,
    max_tokens: 900,
  });

  const parsed = extractJsonObjectLoose(content) || {};
  const profile = {
    domain: parsed.domain || signals.domain,
    businessType: parsed.businessType || "unknown",
    primaryOffering: parsed.primaryOffering || "",
    industry: parsed.industry || industry || "",
    offerings: cleanList(parsed.offerings, { max: 12 }),
    geoFocus: parsed.geoFocus || location || "",
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.35,
    publicSignalsUsed: Array.isArray(parsed.publicSignalsUsed) ? parsed.publicSignalsUsed : [],
    assumptions: Array.isArray(parsed.assumptions) ? parsed.assumptions : [],
  };

  if (cacheKey) cacheSet(`profile:${cacheKey}`, profile);

  return { profile, signals };
}

export async function getKeywordsFromProfile({ profile, signals, location = "", cacheKey = "" }) {
  if (cacheKey) {
    const cached = cacheGet(`keywords:${cacheKey}`);
    if (cached) return cached;
  }

  // NEW: better instructions so location isn't appended everywhere
  const system = `
You are an SEO keyword strategist.
Return ONLY valid JSON matching the schema.

Hard rules:
- Keywords must match the business universe described by offerings/primaryOffering.
- Prefer real search phrases (2–5 words).
- Include a mix: informational, commercial, transactional.
- DO NOT append location to every keyword.
- Mix geo naturally:
  - ~70% keywords should be NON-geo (no city/state/country)
  - ~30% keywords can be geo-modified (include location naturally)
`.trim();

  const user = `
Domain: ${profile.domain}
Business type: ${profile.businessType}
Industry: ${profile.industry}
Primary offering: ${profile.primaryOffering}
Offerings universe tokens: ${profile.offerings.join(", ")}
Geo focus (use for SOME keywords only): ${location || profile.geoFocus || "none"}

Homepage title: ${signals.homepage.title}
Homepage meta: ${signals.homepage.metaDescription}

TASK:
Generate:
- 20 keyword phrases (70% non-geo, 30% geo-modified).
- Up to 6 clusters.
`.trim();

  const { content } = await perplexityChat({
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    response_format: KeywordsSchema,
    temperature: 0.22,
    max_tokens: 1100,
  });

  const parsed = extractJsonObjectLoose(content) || {};
  const out = {
    domain: profile.domain,
    keywords: cleanList(parsed.keywords, { max: 24 }),
    clusters: Array.isArray(parsed.clusters) ? parsed.clusters : [],
    assumptions: Array.isArray(parsed.assumptions) ? parsed.assumptions : [],
  };

  // NEW: safety net post-processing to avoid geo at the end for all keywords
  const geo = String(location || profile.geoFocus || "").trim();
  const geoTokens = geo
    ? geo.split(",").map((x) => x.trim()).filter(Boolean)
    : [];

  if (geoTokens.length && out.keywords.length) {
    // detect which keywords end with any geo token
    const geoLike = [];
    const nonGeo = [];

    for (const k of out.keywords) {
      const lower = String(k || "").toLowerCase();
      const hasGeoAtEnd = geoTokens.some((t) => lower.endsWith(t.toLowerCase()));
      if (hasGeoAtEnd) geoLike.push(k);
      else nonGeo.push(k);
    }

    const keepGeoCount = Math.max(3, Math.round(out.keywords.length * 0.3)); // ~30% keep geo
    const keptGeo = geoLike.slice(0, keepGeoCount);

    // everything else becomes non-geo (strip trailing geo)
    const cleaned = nonGeo
      .concat(geoLike.slice(keepGeoCount))
      .map((k) => stripTrailingGeo(k, geoTokens));

    out.keywords = cleanList([...cleaned, ...keptGeo], { max: 24 });
  }

  if (cacheKey) cacheSet(`keywords:${cacheKey}`, out);
  return out;
}

export async function getCompetitorsFromProfile({ profile, signals, seedKeywords = [], cacheKey = "" }) {
  if (cacheKey) {
    const cached = cacheGet(`competitors:${cacheKey}`);
    if (cached) return cached;
  }

  const system = `
You are an SEO competitive research engine.
Return ONLY valid JSON matching the schema.

Definitions:
- businessCompetitors: direct substitutes offering similar products/services.
- searchCompetitors: domains that often rank for these keywords (aggregators allowed).

Hard rules:
- businessCompetitors MUST be same universe as offerings.
- searchCompetitors MUST be different from businessCompetitors.
`.trim();

  const seeds = seedKeywords.slice(0, 8).join(", ");

  const user = `
Domain: ${profile.domain}
Business type: ${profile.businessType}
Industry: ${profile.industry}
Primary offering: ${profile.primaryOffering}
Offerings universe tokens: ${profile.offerings.join(", ")}

Homepage title: ${signals.homepage.title}
Homepage meta: ${signals.homepage.metaDescription}

Seed keywords: ${seeds || "none"}

TASK:
1) 8 businessCompetitors
2) 12 searchCompetitors
3) Buckets for search competitors
`.trim();

  const { content } = await perplexityChat({
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    response_format: CompetitorsSchema,
    temperature: 0.22,
    max_tokens: 1200,
  });

  const parsed = extractJsonObjectLoose(content) || {};
  const domain = profile.domain;

  const businessCompetitors = cleanList((parsed.businessCompetitors || []).map(toDomainish), { max: 12 }).filter(
    (x) => normalizeHost(x) !== domain
  );

  const bizSet = new Set(businessCompetitors.map((x) => normalizeHost(x)));

  const searchCompetitors = cleanList((parsed.searchCompetitors || []).map(toDomainish), { max: 20 })
    .filter((x) => normalizeHost(x) !== domain)
    .filter((x) => !bizSet.has(normalizeHost(x)));

  const buckets = parsed.buckets && typeof parsed.buckets === "object" ? parsed.buckets : {};

  const out = {
    domain,
    businessCompetitors,
    searchCompetitors,
    buckets,
    assumptions: Array.isArray(parsed.assumptions) ? parsed.assumptions : [],
  };

  if (cacheKey) cacheSet(`competitors:${cacheKey}`, out);
  return out;
}
