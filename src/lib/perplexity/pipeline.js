import { perplexityChat } from "@/lib/perplexity/client";
import { SiteProfileSchema, KeywordsSchema, CompetitorsSchema } from "@/lib/perplexity/schemas";
import { extractJsonObjectLoose, cleanList, toDomainish, normalizeHost } from "@/lib/perplexity/utils";
import { collectPublicSignals } from "@/lib/perplexity/publicSignals";

/**
 * Step 1: Force the model to correctly classify what the business is,
 * using public signals + its own web browsing capability (Sonar models). :contentReference[oaicite:8]{index=8}
 */
export async function getSiteProfile({ input, industry = "", location = "" }) {
  const signals = await collectPublicSignals(input);

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

Robots/sitemaps (may help identify platform/content):
- robots ok: ${signals.robots.ok} status: ${signals.robots.status}
- sitemap candidates: ${signals.robots.sitemaps.join(", ")}

TASK:
1) Identify what this business sells/offers (primaryOffering).
2) Choose businessType (product/service/marketplace/publisher/community/saas/unknown).
3) Provide 5–10 short "offerings" terms that define its universe.
4) Provide confidence 0..1.
5) List the public signals/sources you used (URLs or source titles).
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
  return {
    profile: {
      domain: parsed.domain || signals.domain,
      businessType: parsed.businessType || "unknown",
      primaryOffering: parsed.primaryOffering || "",
      industry: parsed.industry || "",
      offerings: cleanList(parsed.offerings, { max: 12 }),
      geoFocus: parsed.geoFocus || "",
      confidence:
        typeof parsed.confidence === "number" ? parsed.confidence : 0.35,
      publicSignalsUsed: Array.isArray(parsed.publicSignalsUsed) ? parsed.publicSignalsUsed : [],
      assumptions: Array.isArray(parsed.assumptions) ? parsed.assumptions : [],
    },
    signals,
  };
}

/**
 * Step 2: Keywords grounded to the profile universe (Perplexity-only).
 */
export async function getKeywordsFromProfile({ profile, signals, location = "" }) {
  const system = `
You are an SEO keyword strategist.
Return ONLY valid JSON matching the schema.

Hard rules:
- Keywords must match the business universe described by offerings/primaryOffering.
- Prefer real search phrases (2–5 words).
- Include a mix: informational, commercial, transactional.
- Avoid irrelevant industries even if the brand name is ambiguous.
`.trim();

  const user = `
Domain: ${profile.domain}
Business type: ${profile.businessType}
Industry: ${profile.industry}
Primary offering: ${profile.primaryOffering}
Offerings universe tokens: ${profile.offerings.join(", ")}
Geo focus hint: ${location || profile.geoFocus || "none"}

(For grounding) Homepage title: ${signals.homepage.title}
Homepage meta: ${signals.homepage.metaDescription}

TASK:
Generate 20 keyword phrases that a real user would search to find this business category.
Also produce up to 6 clusters with short names and cluster keywords.
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
  return {
    domain: profile.domain,
    keywords: cleanList(parsed.keywords, { max: 24 }),
    clusters: Array.isArray(parsed.clusters) ? parsed.clusters : [],
    assumptions: Array.isArray(parsed.assumptions) ? parsed.assumptions : [],
  };
}

/**
 * Step 3: Competitors grounded to the profile universe (Perplexity-only).
 * Business competitors MUST be same universe sellers/providers.
 * Search competitors can include aggregators/rank-holders.
 */
export async function getCompetitorsFromProfile({ profile, signals, seedKeywords = [] }) {
  const system = `
You are an SEO competitive research engine.
Return ONLY valid JSON matching the schema.

Definitions:
- businessCompetitors: direct substitutes offering similar products/services (same universe).
- searchCompetitors: domains that often rank for these keywords (aggregators allowed).

Hard rules:
- businessCompetitors MUST be in the same universe as offerings/primaryOffering.
- searchCompetitors should represent SERP real-estate owners: directories, review platforms, coupon sites, publishers, affiliate blogs, marketplaces, etc.
- Prefer domains (example.com). If unsure, provide brand name.
`.trim();

  const seeds = seedKeywords.slice(0, 8).join(", ");

  const user = `
Domain: ${profile.domain}
Business type: ${profile.businessType}
Industry: ${profile.industry}
Primary offering: ${profile.primaryOffering}
Offerings universe tokens: ${profile.offerings.join(", ")}

(For grounding) Homepage title: ${signals.homepage.title}
Homepage meta: ${signals.homepage.metaDescription}

Seed keywords (if any): ${seeds || "none"}

TASK:
1) Suggest 8 businessCompetitors (direct substitutes).
2) Suggest 12 searchCompetitors (SERP aggregators & rank-holders).
3) Bucket search competitors into:
directSellers, marketplaces, couponSites, affiliateBlogs, directories, publishers, reviewPlatforms, other.
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

  const businessCompetitors = cleanList(
    (parsed.businessCompetitors || []).map(toDomainish),
    { max: 12 }
  ).filter((x) => normalizeHost(x) !== domain);

  const searchCompetitors = cleanList(
    (parsed.searchCompetitors || []).map(toDomainish),
    { max: 20 }
  ).filter((x) => normalizeHost(x) !== domain);

  const buckets = parsed.buckets && typeof parsed.buckets === "object" ? parsed.buckets : {};

  return {
    domain,
    businessCompetitors,
    searchCompetitors,
    buckets,
    assumptions: Array.isArray(parsed.assumptions) ? parsed.assumptions : [],
  };
}
