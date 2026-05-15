# 🎮 Esports Organizer

A tournament scheduling assistant for esports brackets. Feed it a bracket and team availability windows; it returns a conflict-aware schedule, flags impossible matches, and suggests fixes.

**Live demo:** _add your Render URL after deploy_
**Why this exists:** college/club esports captains spend hours wrangling Discord DMs and spreadsheets to find a slot where 10 people are free. This tool does that in one shot.

---

## What it does

- Parses a JSON bracket (rounds → matches with optional time windows + duration).
- Parses per-team availability blocks.
- Places each match into a slot where **both** teams are available, inside the round window, for the full duration, without double-booking a team.
- Returns: `schedule[]`, `conflicts[]`, `suggestions[]`, `reasoning`.
- Two engines:
  - **LLM** (OpenAI, JSON-mode, single retry on bad JSON) — handles fuzzy reasoning + human-readable suggestions.
  - **Deterministic fallback** — exact scheduler used when no API key is set, when the LLM fails, and as ground truth in the eval harness.

## Run locally

```bash
npm install
cp .env.example .env   # paste your OPENAI_API_KEY (optional — fallback works without it)
npm start              # http://localhost:3000
```

## Run the eval suite

```bash
npm run eval           # fallback only (fast, no API cost)
npm run eval:llm       # also hits the LLM (requires server running + API key)
```

Cases live in `evals/cases/*.json`. Each case has `input` + `expect` (which match IDs should land in `schedule` vs `conflicts`, plus a `noOverlap` invariant for double-booking).

## Deploy

**Render (one-click via blueprint):** push to GitHub, then in Render → "New +" → "Blueprint" → point at this repo. `render.yaml` handles the rest. Set `OPENAI_API_KEY` in the dashboard.

Also works on Fly, Railway, or any platform that runs `npm start` and reads `PORT` from env.

---

## Build log — see [BUILDLOG.md](./BUILDLOG.md)

The build log documents the prompt iterations (v1 → v3), the bugs the eval suite caught, and the design tradeoffs (why a deterministic fallback exists, why JSON-mode + retry, why temperature 0.2).
