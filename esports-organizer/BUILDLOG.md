# Build Log

How this project actually got built — prompts I tried, things that broke, decisions I made.

## The problem

Esports captains coordinate matches across 8–16 players' calendars. The reasoning task is small but annoying: find a slot where both teams have an availability block long enough for a 90-minute match, inside the round window, without double-booking. I wanted to see whether an LLM could do this end-to-end with structured input — and where it would fall over.

## Architecture decision: dual engine

Early on I built a deterministic scheduler (`fallbackSchedule` in `server.js`) so I had ground truth to evaluate the LLM against. I kept it shipping in production for three reasons:
1. **Cost** — most schedules don't need an LLM.
2. **Determinism** — repeated calls give identical schedules; useful for "regenerate" buttons.
3. **Graceful degrade** — if OpenAI 5xxs or returns garbage, users still get a working schedule.

The LLM's real value is the `suggestions` and `reasoning` fields — natural-language fixes the deterministic scorer can't produce well.

## Prompt iterations

### v1 — naive
> "You are a scheduling assistant. Given a bracket and availability, return a schedule."

**Failure:** ~40% of outputs included markdown fences, prose preambles ("Sure, here's the schedule:"), or invented availability blocks for teams that had none. Also occasionally output dates in `MM/DD/YYYY`.

### v2 — structured + JSON-only
Added explicit output schema with key names, "JSON ONLY", "no prose", "ISO 8601 UTC".

**Improvement:** prose preambles dropped to ~5%. But ~15% of responses were still un-parseable JSON (trailing commas, fence leakage). Hallucinated availability went down but wasn't gone.

### v3 — current
- Switched to OpenAI's `response_format: { type: "json_object" }` (server-enforced).
- Added an explicit rule: **"Never invent availability"**.
- Added: "If unsure, prefer conflict + suggestion over a guess."
- Added a **single retry** with a hard reminder appended to the system prompt when the first response fails to parse. This caught the remaining ~15%.
- Set `temperature: 0.2` — high enough for varied suggestion phrasing, low enough that schedule placement is stable across calls.

System prompt is exported as `SYSTEM_PROMPT` from `server.js` so it's testable.

## Grounding strategy

All grounding is **structured input**, not retrieval. The user's bracket and availability JSON are dumped into the user message verbatim. The system prompt declares the input schema so the model knows how to read them. No RAG, no examples — the input itself is the context.

Why no few-shot examples? In tests they made the model copy the example team names ("FaZe", "TSM") into outputs about ~5% of the time. The schema-only system prompt was both shorter and more accurate.

## Eval harness

Five hand-built cases in `evals/cases/`:

1. **Trivial feasible** — should schedule.
2. **Tight window** — overlap exactly equals match duration.
3. **Fully infeasible** — zero overlap; should conflict.
4. **Duration too long** — overlap < duration; should conflict.
5. **No double-booking** — team A in two matches; both fit, but must not overlap each other.

Each case declares `expect.scheduled[]`, `expect.conflicts[]`, and an optional `noOverlap` invariant. `evals/run.mjs` scores both engines.

### Results (latest run)

| Engine | Cases | Checks passed |
|---|---|---|
| Fallback | 5/5 | 100% |
| LLM (gpt-4o-mini) | 5/5 | 100% on placement; 1 case had vaguer suggestion text |

Bugs the eval suite caught while building:
- **Double-booking bug** — original fallback could schedule team A in M1 and M2 at the same time. Caught by case 5. Fixed by tracking `busy[team]` intervals.
- **Off-by-one on tight windows** — `<` vs `<=` on the duration fit. Caught by case 2.
- **LLM JSON parse failure** — case 3 occasionally returned `null` for `scheduledStart` instead of omitting the entry. Fixed by tightening the system prompt rule #2.

## What's missing / where it breaks

- No support for venue/stream-channel constraints (only one match per channel at a time).
- No handling of best-of-N series (assumes single match per pairing).
- LLM occasionally produces friendly-but-wrong suggestions ("try Tuesday at 8pm") when no team has Tuesday availability. The deterministic fallback's suggestions are blunter but always grounded.
- No timezone display in the UI — everything is UTC.

## Future

- Pull availability from a Discord bot rather than typed JSON.
- Add a "regenerate with constraint X" loop using the LLM as a refiner over the deterministic schedule.
- Streamed responses for larger brackets (32+ teams).
