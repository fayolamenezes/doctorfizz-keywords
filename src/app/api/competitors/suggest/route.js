import { NextResponse } from "next/server";
import { getSiteProfile, getKeywordsFromProfile, getCompetitorsFromProfile } from "@/lib/perplexity/pipeline";
import { normalizeHost } from "@/lib/perplexity/utils";

export const runtime = "nodejs";

function buildLocation({ location, city, state, country }) {
  const direct = String(location || "").trim();
  if (direct) return direct;
  return [city, state, country].map((x) => String(x || "").trim()).filter(Boolean).join(", ");
}

function makeKey(domain, industry, location) {
  return [domain || "", industry || "", location || ""]
    .map((x) => String(x || "").trim().toLowerCase())
    .join("|");
}

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));

    const domain = normalizeHost(body?.domain || body?.site || body?.url || "");
    if (!domain) return NextResponse.json({ error: "Missing domain" }, { status: 400 });

    const industry = String(body?.industry || "").trim();
    const location = buildLocation({
      location: body?.location,
      city: body?.city,
      state: body?.state,
      country: body?.country,
    });

    const cacheKey = makeKey(domain, industry, location);

    const seedFromReq = Array.isArray(body?.seedKeywords) ? body.seedKeywords : [];
    const seedKeywords = seedFromReq.map((x) => String(x || "").trim()).filter(Boolean).slice(0, 12);

    const { profile, signals } = await getSiteProfile({
      input: domain,
      industry,
      location,
      cacheKey,
    });

    let finalSeeds = seedKeywords;
    if (!finalSeeds.length) {
      const kw = await getKeywordsFromProfile({ profile, signals, location, cacheKey });
      finalSeeds = (kw?.keywords || []).slice(0, 8);
    }

    const comp = await getCompetitorsFromProfile({
      profile,
      signals,
      seedKeywords: finalSeeds,
      cacheKey,
    });

    const bizSet = new Set((comp.businessCompetitors || []).map((x) => String(x).toLowerCase().trim()));
    const searchFiltered = (comp.searchCompetitors || []).filter(
      (x) => !bizSet.has(String(x).toLowerCase().trim())
    );

    return NextResponse.json(
      {
        domain: comp.domain,
        businessCompetitors: comp.businessCompetitors || [],
        searchCompetitors: searchFiltered,
        buckets: comp.buckets || {},
        profile: {
          businessType: profile.businessType,
          industry: profile.industry,
          primaryOffering: profile.primaryOffering,
          geoFocus: profile.geoFocus,
        },
      },
      { status: 200 }
    );
  } catch (e) {
    return NextResponse.json({ error: e?.message || "Competitor suggest failed" }, { status: 500 });
  }
}
