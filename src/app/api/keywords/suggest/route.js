import { NextResponse } from "next/server";
import { getSiteProfile, getKeywordsFromProfile } from "@/lib/perplexity/pipeline";
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

    // Step 2: keywords grounded to profile
    const out = await getKeywordsFromProfile({
      profile,
      signals,
      location,
    });

    return NextResponse.json({
      ...out,
      source: "perplexity",
      profile,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e?.message || "keywords suggest failed" },
      { status: 500 }
    );
  }
}
