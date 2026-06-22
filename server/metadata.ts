import {
  CHAT_API_BASE,
  CHAT_API_KEY,
  CHAT_MODEL,
  CHAT_TIMEOUT_MS,
  ENABLE_FALLBACK_EXTRACTION,
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

// Minimal metadata stamped when no chat endpoint produces a result (extraction
// disabled, or every configured endpoint failed). Named *_STUB to keep it
// distinct from the fallback *endpoint* concept below.
const METADATA_STUB = {
  topics: ["uncategorized"],
  type: "observation",
} as const;

// Strict JSON-schema for structured output. A schema-constrained model returns
// a valid object far more reliably than prompt-only `json_object` mode, which
// could emit a runaway or partial generation. Enforcement is serving-stack
// dependent, so the JSON.parse + shape guards in classifyOnce stay load-bearing.
// The shape is the OpenAI `response_format: { type: "json_schema", json_schema }`
// envelope, which local ollama / LM Studio `/v1` endpoints accept identically.
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
// timeout/abort, missing/non-string content, unparseable or non-object JSON —
// including a JSON array) so the caller can move on to the next endpoint or the
// stub. Never throws.
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
    // typeof [] === "object", so arrays would otherwise slip through and flow
    // downstream as metadata; reject them along with null/non-objects.
    if (
      typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
    ) {
      return null;
    }
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
// model) if the primary is disabled or fails, then a minimal stub so capture
// never breaks. Either endpoint may be omitted: with both off it stamps the
// stub; with only the fallback configured it is a fallback-only deployment.
//
// Each outcome logs one line (no thought content) so the two otherwise-silent
// degradations are visible in the logs: every capture quietly stamping the stub
// (no working endpoint), and every capture quietly going off-box via the
// fallback (primary disabled/down while a hosted fallback is configured).
export async function extractMetadata(
  text: string,
): Promise<Record<string, unknown>> {
  // Primary is opt-in (ENABLE_PRIMARY_EXTRACTION, which also requires the
  // CHAT_* endpoint to be configured). Off by default so a misconfigured or
  // dangerous primary transport can't fire on the capture path; when off we
  // skip straight to the fallback.
  if (ENABLE_PRIMARY_EXTRACTION) {
    const primary = await classifyOnce(text, {
      base: CHAT_API_BASE,
      key: CHAT_API_KEY,
      model: CHAT_MODEL,
    });
    if (primary) {
      console.log("[metadata] classified via primary endpoint");
      return primary;
    }
    console.warn("[metadata] primary endpoint failed");
  }

  // Fallback runs whenever it is configured — after a primary failure OR as the
  // sole extractor in a fallback-only deployment. NB this path can send thought
  // content off-box (the privacy trade-off documented in .env.example).
  if (ENABLE_FALLBACK_EXTRACTION) {
    const fallback = await classifyOnce(text, {
      base: FALLBACK_CHAT_API_BASE,
      key: FALLBACK_CHAT_API_KEY,
      model: FALLBACK_CHAT_MODEL,
    });
    if (fallback) {
      console.warn(
        "[metadata] classified via FALLBACK endpoint — thought content left the local network",
      );
      return fallback;
    }
    console.warn("[metadata] fallback endpoint failed");
  }

  console.warn(
    "[metadata] no endpoint produced metadata; stamping uncategorized stub",
  );
  return { ...METADATA_STUB };
}
