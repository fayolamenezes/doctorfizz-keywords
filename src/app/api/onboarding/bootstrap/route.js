// src/app/api/onboarding/bootstrap/route.js
import { NextResponse } from "next/server";
import { getSiteProfile, getKeywordsFromProfile, getCompetitorsFromProfile } from "@/lib/perplexity/pipeline";
import { normalizeHost } from "@/lib/perplexity/utils";
import { cacheGet, cacheSet } from "@/lib/perplexity/cache";

export const runtime = "nodejs";

function makeKey(domain, industry, location) {
  return [domain || "", industry || "", location || ""]
    .map((x) => String(x || "").trim().toLowerCase())
    .join("|");
}

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const domain = normalizeHost(body.domain || body.site || body.url || "");
    const industry = String(body.industry || "").trim();
    const location = String(body.location || "").trim();
    const language = String(body.language || "").trim();

    if (!domain) return NextResponse.json({ error: "Missing domain" }, { status: 400 });

    const cacheKey = makeKey(domain, industry, location);
    const cached = cacheGet(`bootstrap:${cacheKey}`);
    if (cached) return NextResponse.json(cached);

    const { profile, signals } = await getSiteProfile({ input: domain, industry, location, cacheKey });
    const keywords = await getKeywordsFromProfile({ profile, signals, location, cacheKey });
    const competitors = await getCompetitorsFromProfile({
      profile,
      signals,
      seedKeywords: keywords.keywords || [],
      cacheKey,
    });

    const payload = {
      cacheKey,
      domain,
      industry,
      location,
      language,
      profile,
      keywords,
      competitors,
      generatedAt: new Date().toISOString(),
    };

    cacheSet(`bootstrap:${cacheKey}`, payload);
    return NextResponse.json(payload);
  } catch (e) {
    return NextResponse.json({ error: e?.message || "Bootstrap error" }, { status: 500 });
  }
}
