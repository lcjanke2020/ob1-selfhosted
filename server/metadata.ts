import {
  CHAT_API_BASE,
  CHAT_API_KEY,
  CHAT_MODEL,
  ENABLE_METADATA_EXTRACTION,
  FETCH_TIMEOUT_MS,
} from "./config.ts";

const SYSTEM_PROMPT =
  `You extract structured metadata from one captured thought. Return ONLY a JSON object with:
- "type": exactly one of "observation" | "task" | "idea" | "reference" | "person_note".
- "topics": 1-3 short lowercase topic tags (always at least one).
- "people": names of people mentioned (empty array if none).
- "action_items": for a "task", the pending to-dos; for an "observation", an empty array.
- "dates_mentioned": dates as YYYY-MM-DD (empty array if none).

Classify "type" by TENSE and INTENT, and LEAN toward "task" when genuinely ambiguous:
- "observation": use ONLY when there is a positive completed/ongoing-state signal -- explicit past/present-tense reporting ("I set up...", "X happened", "uses Y") OR a trailing log-style date stamp like "(2026-05-18)". Completed work reported this way is an observation with no action_items.
- "task": the DEFAULT for an imperative or ambiguous capture with no completion signal (e.g. a bare "Email Dana the key"). If the author might still need to do it, it is a task -- list its action_items.
- "idea": a proposal, hypothesis, or "what if".
- "reference": a fact/link/snippet saved for lookup.
- "person_note": primarily about a person.

Never fabricate to-dos from a clearly completed-work report. But do not let a bare imperative fall to "observation" -- absent a completion signal, prefer "task".

Examples:
"Set up openbrain with indexing enabled, using the gpt-5.4-mini model. (2026-05-18)" -> {"type":"observation","topics":["openbrain","setup"],"people":[],"action_items":[],"dates_mentioned":["2026-05-18"]}
"Tomorrow set up openbrain indexing and email Dana the API key." -> {"type":"task","topics":["openbrain","setup"],"people":["Dana"],"action_items":["Set up openbrain indexing","Email Dana the API key"],"dates_mentioned":[]}
"Email Dana the API key." -> {"type":"task","topics":["email"],"people":["Dana"],"action_items":["Email Dana the API key"],"dates_mentioned":[]}

Extract only what is explicitly present. Do not invent.`;

const FALLBACK = { topics: ["uncategorized"], type: "observation" } as const;

export async function extractMetadata(
  text: string,
): Promise<Record<string, unknown>> {
  if (!ENABLE_METADATA_EXTRACTION) return { ...FALLBACK };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (CHAT_API_KEY) headers.Authorization = `Bearer ${CHAT_API_KEY}`;

    const r = await fetch(`${CHAT_API_BASE}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: CHAT_MODEL,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: text },
        ],
      }),
      signal: controller.signal,
    });

    if (!r.ok) return { ...FALLBACK };
    const d = await r.json();
    const content = d?.choices?.[0]?.message?.content;
    if (typeof content !== "string") return { ...FALLBACK };
    const parsed = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null) return { ...FALLBACK };
    return parsed as Record<string, unknown>;
  } catch {
    // Includes AbortError on timeout — silently fall back so capture
    // continues even when the metadata endpoint is slow or unreachable.
    return { ...FALLBACK };
  } finally {
    clearTimeout(timer);
  }
}
