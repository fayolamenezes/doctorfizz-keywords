export const PERPLEXITY_CHAT_URL = "https://api.perplexity.ai/chat/completions"; // :contentReference[oaicite:4]{index=4}

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

/**
 * Calls Perplexity Chat Completions API.
 * Uses response_format (JSON schema) when provided. :contentReference[oaicite:5]{index=5}
 */
export async function perplexityChat({
  messages,
  response_format,
  temperature = 0.2,
  max_tokens = 1100,
  timeoutMs = 30000,
} = {}) {
  const apiKey = mustEnv("PERPLEXITY_API_KEY");
  const model = process.env.PERPLEXITY_MODEL || "sonar-pro"; // :contentReference[oaicite:6]{index=6}

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(PERPLEXITY_CHAT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens,
        response_format,
      }),
      signal: ctrl.signal,
    });

    const text = await res.text().catch(() => "");
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // ignore
    }

    if (!res.ok) {
      throw new Error(
        `Perplexity error (${res.status}): ${json?.error?.message || text || "unknown"}`
      );
    }

    const content = json?.choices?.[0]?.message?.content ?? "";
    return { raw: json, content, model };
  } finally {
    clearTimeout(t);
  }
}
