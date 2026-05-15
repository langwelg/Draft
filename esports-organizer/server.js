// Esports Organizer — tournament scheduling assistant
// LLM (OpenAI) + deterministic fallback scheduler + JSON-retry guardrail.
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';

config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Prompts (see BUILDLOG.md for v1/v2/v3 iteration history) ----------
export const SYSTEM_PROMPT = `You are an esports tournament scheduling assistant.

INPUTS
- bracket: rounds[] -> matches[] with id, teamA, teamB, optional durationMinutes (default 90), optional earliest/latest ISO windows.
- availability: { teamName: [{start, end}, ...] } in ISO 8601 UTC.

TASK
Place each match into a slot where BOTH teams are available, inside the match window if given, for at least durationMinutes. Prefer earlier slots. Never invent availability.

OUTPUT — JSON ONLY. No prose, no markdown fences. Shape:
{
  "schedule":   [{ "round","matchId","teamA","teamB","scheduledStart","scheduledEnd","source":"openai" }],
  "conflicts":  [{ "round","matchId","teamA","teamB","reason" }],
  "suggestions":[{ "round","matchId","suggestion" }],
  "reasoning":  "<= 2 sentences"
}

RULES
1. Datetimes MUST be ISO 8601 UTC ending in Z.
2. If a match cannot fit, put it in conflicts (not schedule) with a concrete reason citing the team names.
3. Never schedule a team in two overlapping matches.
4. If you are unsure, prefer conflict + suggestion over a guess.`;

// ---------- Helpers ----------
const parseJSON = (text) => { try { return JSON.parse(text); } catch { return null; } };
const isoParse  = (v) => { const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d; };
const overlap   = (a, b) => {
  const s = new Date(Math.max(a.start.getTime(), b.start.getTime()));
  const e = new Date(Math.min(a.end.getTime(),   b.end.getTime()));
  return s < e ? { start: s, end: e } : null;
};
const formatISO = (d) => d.toISOString().replace('.000Z', 'Z');

// ---------- Deterministic fallback scheduler ----------
// Used when no API key OR as ground truth in the eval harness.
export const fallbackSchedule = ({ bracket, availability }) => {
  const schedule = [], conflicts = [], suggestions = [];
  const teamBlocks = {};
  for (const [team, blocks] of Object.entries(availability)) {
    teamBlocks[team] = blocks
      .map(b => ({ start: isoParse(b.start), end: isoParse(b.end) }))
      .filter(b => b.start && b.end)
      .sort((a, b) => a.start - b.start);
  }
  // track team busy intervals to prevent double-booking
  const busy = {};
  const isBusy = (team, s, e) => (busy[team] || []).some(iv => overlap(iv, { start: s, end: e }));

  const findWindow = (m) => {
    if (m.earliest || m.latest) {
      return {
        start: isoParse(m.earliest) || new Date(0),
        end:   isoParse(m.latest)   || new Date(8640000000000000),
      };
    }
    return null;
  };

  for (const round of bracket.rounds || []) {
    for (const match of round.matches || []) {
      const { teamA, teamB } = match;
      const dur = (match.durationMinutes || 90) * 60000;
      const win = findWindow(match);
      let placed = null;
      // Earliest busy-end >= candidate start, for either team, within ov
      const nextFreeStart = (cand, end) => {
        const conflicts = [...(busy[teamA] || []), ...(busy[teamB] || [])]
          .filter(iv => iv.start < end && cand < iv.end);
        if (!conflicts.length) return cand;
        return new Date(Math.max(...conflicts.map(iv => iv.end.getTime())));
      };
      outer:
      for (const ba of teamBlocks[teamA] || []) {
        for (const bb of teamBlocks[teamB] || []) {
          let ov = overlap(ba, bb);
          if (!ov) continue;
          if (win) { ov = overlap(ov, win); if (!ov) continue; }
          // Walk forward past any busy intervals up to 5 times.
          let start = ov.start;
          for (let i = 0; i < 5; i++) {
            const end = new Date(start.getTime() + dur);
            if (end > ov.end) break;
            const adjusted = nextFreeStart(start, end);
            if (adjusted.getTime() === start.getTime()) { placed = { start, end }; break outer; }
            start = adjusted;
          }
        }
      }
      if (placed) {
        (busy[teamA] ||= []).push(placed);
        (busy[teamB] ||= []).push(placed);
        schedule.push({
          round: round.name, matchId: match.id || `${teamA}-vs-${teamB}`,
          teamA, teamB,
          scheduledStart: formatISO(placed.start),
          scheduledEnd:   formatISO(placed.end),
          source: 'fallback',
        });
      } else {
        conflicts.push({
          round: round.name, matchId: match.id || `${teamA}-vs-${teamB}`,
          teamA, teamB,
          reason: `No common availability of ${match.durationMinutes || 90}min for ${teamA} and ${teamB} in the given window.`,
        });
        suggestions.push({
          round: round.name, matchId: match.id || `${teamA}-vs-${teamB}`,
          suggestion: `Ask ${teamA} or ${teamB} to add an availability block, or widen the round window.`,
        });
      }
    }
  }
  return { schedule, conflicts, suggestions, reasoning: 'Deterministic fallback (no LLM).' };
};

// ---------- LLM call with one JSON-retry (iteration #2 from build log) ----------
async function callOpenAI({ bracket, availability }) {
  const { OpenAI } = await import('openai');
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const userPrompt =
`Bracket:
${JSON.stringify(bracket, null, 2)}

Availability:
${JSON.stringify(availability, null, 2)}

Produce the JSON described in the system prompt.`;

  const ask = async (extra = '') => {
    const completion = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      temperature: 0.2,
      max_tokens: 1200,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT + extra },
        { role: 'user', content: userPrompt },
      ],
    });
    return completion.choices[0]?.message?.content || '';
  };

  let raw = await ask();
  let parsed = parseJSON(raw);
  if (!parsed) {
    // Retry once with a hard reminder — caught ~15% bad outputs in evals.
    raw = await ask('\n\nREMINDER: Return ONLY a valid JSON object. No prose, no fences.');
    parsed = parseJSON(raw);
  }
  if (!parsed) throw new Error('OpenAI returned non-JSON twice');
  return { ...parsed, prompt: userPrompt, method: 'openai' };
}

// ---------- API ----------
app.post('/api/schedule', async (req, res) => {
  try {
    const { bracketText, availabilityText } = req.body || {};
    const bracket = typeof bracketText === 'string' ? parseJSON(bracketText) : bracketText;
    const availability = typeof availabilityText === 'string' ? parseJSON(availabilityText) : availabilityText;
    if (!bracket || !Array.isArray(bracket.rounds)) return res.status(400).json({ error: 'Invalid bracket JSON.' });
    if (!availability || typeof availability !== 'object') return res.status(400).json({ error: 'Invalid availability JSON.' });

    if (!process.env.OPENAI_API_KEY) {
      return res.json({ ...fallbackSchedule({ bracket, availability }), prompt: null, method: 'fallback' });
    }
    const result = await callOpenAI({ bracket, availability });
    return res.json(result);
  } catch (err) {
    console.error(err);
    // Graceful degrade to fallback on LLM failure
    try {
      const bracket = parseJSON(req.body?.bracketText) || req.body?.bracketText;
      const availability = parseJSON(req.body?.availabilityText) || req.body?.availabilityText;
      const fb = fallbackSchedule({ bracket, availability });
      return res.json({ ...fb, method: 'fallback', warning: `LLM failed: ${err.message}` });
    } catch {
      return res.status(500).json({ error: 'Server error', details: err.message });
    }
  }
});

app.get('/api/health', (_, res) => res.json({ ok: true, hasKey: !!process.env.OPENAI_API_KEY }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Only listen when run directly (not when imported by tests)
if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  app.listen(port, () => console.log(`Server running at http://localhost:${port}`));
}

export default app;
