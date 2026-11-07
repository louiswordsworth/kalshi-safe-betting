// Thin wrapper over any OpenAI-compatible chat-completions endpoint
// (Lovable AI gateway, OpenAI, OpenRouter, etc.). Configure with secrets:
//   LLM_API_URL  e.g. https://ai.gateway.lovable.dev/v1/chat/completions (check Lovable's docs)
//   LLM_API_KEY  (falls back to LOVABLE_API_KEY)
//   LLM_MODEL    e.g. google/gemini-2.5-flash or gpt-4o-mini
// If no key is set, callers fall back to rules/templates so the demo never breaks.

export function llmConfigured(): boolean {
  return Boolean(Deno.env.get("LLM_API_KEY") ?? Deno.env.get("LOVABLE_API_KEY"));
}

export async function chatJson<T>(system: string, user: string, timeoutMs = 12_000): Promise<T | null> {
  const key = Deno.env.get("LLM_API_KEY") ?? Deno.env.get("LOVABLE_API_KEY");
  if (!key) return null;
  const url = Deno.env.get("LLM_API_URL") ?? "https://ai.gateway.lovable.dev/v1/chat/completions";
  const model = Deno.env.get("LLM_MODEL") ?? "google/gemini-2.5-flash";

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
      }),
    });
    if (!res.ok) {
      console.error("LLM error", res.status, await res.text());
      return null;
    }
    const data = await res.json();
    const text: string = data.choices?.[0]?.message?.content ?? "";
    const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    return JSON.parse(json) as T;
  } catch (e) {
    console.error("LLM call failed", e);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
