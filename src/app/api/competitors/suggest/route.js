import { NextResponse } from "next/server";
import { getSiteProfile, getKeywordsFromProfile, getCompetitorsFromProfile } from "@/lib/perplexity/pipeline";
import { normalizeHost } from "@/lib/perplexity/utils";

export const runtime = "nodejs";

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));

    const domainOrUrl = body?.domain || body?.url || body?.website || body?.site || "";
    const domain = normalizeHost(domainOrUrl);

    if (!domain) {
      return NextResponse.json({ error: "domain/url is required" }, { status: 400 });
    }

    const industry = String(body?.industry || "").trim();
    const location = String(body?.location || "").trim();

    // Step 1: profile
    const { profile, signals } = await getSiteProfile({
      input: domainOrUrl,
      industry,
      location,
    });

    // Step 2: keywords (used as seeds for competitor SERP landscape)
    const kw = await getKeywordsFromProfile({
      profile,
      signals,
      location,
    });

    // Step 3: competitors
    const out = await getCompetitorsFromProfile({
      profile,
      signals,
      seedKeywords: kw.keywords,
    });

    return NextResponse.json({
      ...out,
      source: "perplexity",
      profile,
      keywordSeeds: kw.keywords.slice(0, 12),
    });
  } catch (e) {
    return NextResponse.json(
      { error: e?.message || "competitors suggest failed" },
      { status: 500 }
    );
  }
}
