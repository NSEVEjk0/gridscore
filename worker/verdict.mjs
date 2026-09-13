import { VERDICT } from "./env.mjs";
import { barList } from "./score.mjs";

/**
 * The Agent verdict. Exactly one of four options, 3 reasons drawn from the
 * bars, 2 things not checked. The text comes from an OpenAI-compatible
 * chat-completions endpoint when configured; otherwise a template built
 * directly from the bars. The model only ever sees the bars JSON — it does
 * not invent chain numbers.
 */

export const VERDICTS = [
  "Do not interact",
  "Test with dust only",
  "OK for small, known use",
  "Not enough data",
];

const SYSTEM_PROMPT = `You are the verdict writer for Gridscore, an address screening tool.
You receive JSON with rule-based bars computed from public blockchain RPC data.

Respond with JSON only, matching exactly:
{"verdict": "...", "reasons": ["...", "...", "..."], "notChecked": ["...", "..."]}

Rules:
- "verdict" must be EXACTLY one of: "Do not interact", "Test with dust only", "OK for small, known use", "Not enough data".
- "reasons" must contain EXACTLY 3 short sentences. Each must reference a concrete bar value from the JSON you received. Never invent numbers that are not in the JSON.
- "notChecked" must contain EXACTLY 2 short phrases for things Gridscore did not check.
- Use "Not enough data" when most bars are "unknown" or "na".
- Never use the words "safe", "legit", or "guaranteed scam". No public labels list exists in the data, so never claim a label.
- Do not give financial advice. Plain, calm language.`;

/** Build the exact JSON payload handed to the verdict endpoint. */
export function verdictInput(score) {
  return {
    overall: score.overall,
    meta: score.meta,
    bars: barList(score).map((b) => ({
      label: b.label,
      score: b.score,
      note: b.note,
    })),
  };
}

function parseVerdictJson(text) {
  const t = String(text || "").trim();
  const match = t.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

function cleanList(v, n) {
  if (!Array.isArray(v)) return null;
  const items = v
    .filter((x) => typeof x === "string")
    .map((x) => x.trim())
    .filter((x) => x.length > 0)
    .slice(0, n);
  return items.length === n ? items : null;
}

const BANNED = /\b(safe|legit|guaranteed scam)\b/i;

function validateVerdict(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  const verdict = typeof parsed.verdict === "string" ? parsed.verdict.trim() : "";
  if (!VERDICTS.includes(verdict)) return null;
  const reasons = cleanList(parsed.reasons, 3);
  const notChecked = cleanList(parsed.notChecked, 2);
  if (!reasons || !notChecked) return null;
  if (BANNED.test(verdict) || reasons.some((r) => BANNED.test(r))) return null;
  return { verdict, reasons, notChecked };
}

/** Call the configured chat-completions endpoint. Returns null on any failure. */
export async function llmVerdict(score) {
  if (!VERDICT.apiKey || !VERDICT.model || !VERDICT.baseUrl) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERDICT.timeoutMs);
  try {
    const res = await fetch(`${VERDICT.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${VERDICT.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: VERDICT.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(verdictInput(score)) },
        ],
        temperature: 0.2,
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = await res.json();
    const content = body?.choices?.[0]?.message?.content;
    return validateVerdict(parseVerdictJson(content));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---- Template verdict (no external calls) ----

function pickVerdict(score) {
  if (score.overall === "unknown" || score.meta.dataBars < 4) {
    return "Not enough data";
  }
  // An address with no footprint at all is a data question, not a warning.
  if (score.bars.activity.score === 10 && score.bars.presence.score <= 30) {
    return "Not enough data";
  }
  // The verdict follows the weakest signals: one catastrophic bar, or a
  // cluster of weak ones, pulls the whole verdict down.
  const numeric = Object.values(score.bars)
    .map((b) => b.score)
    .filter((s) => typeof s === "number");
  const worst = Math.min(...numeric);
  const weakCount = numeric.filter((s) => s < 50).length;
  if (worst < 30 || weakCount >= 3) return "Do not interact";
  if (worst < 50 || weakCount >= 1 || score.overall < 50) return "Test with dust only";
  return "OK for small, known use";
}

function templateReasons(score) {
  const list = barList(score)
    .filter((b) => typeof b.score === "number")
    .sort((a, b) => a.score - b.score);
  // Three reasons: the weakest bars, phrased from their own notes.
  const weakest = list.slice(0, 3);
  if (weakest.length === 0) {
    return [
      "No chain data could be observed for this address",
      "Every bar is Unknown or N/A",
      "Overall score could not be computed",
    ];
  }
  while (weakest.length < 3 && list.length > weakest.length) {
    weakest.push(list[weakest.length]);
  }
  return weakest.map(
    (b) => `${b.label}: ${b.score}/100 — ${b.note}.`
  );
}

const NOT_CHECKED_POOL = [
  "Source verification of contract code",
  "Transaction failure history",
  "Activity older than the observed log window",
  "Off-chain reputation and social reports",
  "Private or internal transfers",
  "Real-world identity of the controller",
];

function templateNotChecked() {
  return NOT_CHECKED_POOL.slice(0, 2);
}

export function templateVerdict(score) {
  return {
    verdict: pickVerdict(score),
    reasons: templateReasons(score),
    notChecked: templateNotChecked(),
  };
}

/** The Agent verdict: model when available, template otherwise. */
export async function agentVerdict(score) {
  const llm = await llmVerdict(score);
  if (llm) return { ...llm, source: "model" };
  return { ...templateVerdict(score), source: "template" };
}
