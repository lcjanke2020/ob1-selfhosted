import {
  CHAT_API_BASE,
  CHAT_API_KEY,
  CHAT_MODEL,
  CHAT_TIMEOUT_MS,
  ENABLE_FALLBACK_EXTRACTION,
  ENABLE_METADATA_EXTRACTION,
  ENABLE_PRIMARY_EXTRACTION,
  FALLBACK_CHAT_API_BASE,
  FALLBACK_CHAT_API_KEY,
  FALLBACK_CHAT_MODEL,
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

// Strict JSON-schema for structured output. Constrains the model to a valid
// object on every capture, so parsing can't fail on a runaway or partial
// generation the way prompt-only `json_object` mode could. The shape is the
// OpenAI `response_format: { type: "json_schema", json_schema }` envelope,
// which the local ollama `/v1` endpoint accepts identically.
const THOUGHT_METADATA_SCHEMA = {
  name: "thought_metadata",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["type", "topics", "people", "action_items", "dates_mentioned"],
    properties: {
      type: {
        type: "string",
        enum: ["observation", "task", "idea", "reference", "person_note"],
      },
      topics: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: 3,
      },
      people: { type: "array", items: { type: "string" } },
      action_items: { type: "array", items: { type: "string" } },
      dates_mentioned: { type: "array", items: { type: "string" } },
    },
  },
} as const;

interface ChatEndpoint {
  base: string;
  key: string;
  model: string;
}

// One classification attempt against a single OpenAI-compatible endpoint.
// Returns the parsed metadata object, or `null` on ANY failure (non-2xx,
// timeout/abort, missing/non-string content, unparseable or non-object JSON)
// so the caller can move on to the next endpoint or the stub. Never throws.
async function classifyOnce(
  text: string,
  { base, key, model }: ChatEndpoint,
): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (key) headers.Authorization = `Bearer ${key}`;

    const r = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: {
          type: "json_schema",
          json_schema: THOUGHT_METADATA_SCHEMA,
        },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: text },
        ],
      }),
      signal: controller.signal,
    });

    if (!r.ok) return null;
    const d = await r.json();
    const content = d?.choices?.[0]?.message?.content;
    if (typeof content !== "string") return null;
    const parsed = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as Record<string, unknown>;
  } catch {
    // Includes AbortError on timeout — treat as a failed attempt.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Extract structured metadata for one captured thought. Tries the primary chat
// endpoint first (e.g. a local GPU-served model — zero marginal cost, content
// stays on your network), then an optional fallback endpoint (e.g. a hosted
// model) if the primary fails, then a minimal stub so capture never breaks.
export async function extractMetadata(
  text: string,
): Promise<Record<string, unknown>> {
  if (!ENABLE_METADATA_EXTRACTION) return { ...FALLBACK };

  // Primary is opt-in (ENABLE_PRIMARY_EXTRACTION). Off by default so a
  // misconfigured/dangerous primary transport can't fire on the capture path;
  // when off we skip straight to the fallback.
  if (ENABLE_PRIMARY_EXTRACTION) {
    const primary = await classifyOnce(text, {
      base: CHAT_API_BASE,
      key: CHAT_API_KEY,
      model: CHAT_MODEL,
    });
    if (primary) return primary;
  }

  if (ENABLE_FALLBACK_EXTRACTION) {
    const fallback = await classifyOnce(text, {
      base: FALLBACK_CHAT_API_BASE,
      key: FALLBACK_CHAT_API_KEY,
      model: FALLBACK_CHAT_MODEL,
    });
    if (fallback) return fallback;
  }

  return { ...FALLBACK };
}
