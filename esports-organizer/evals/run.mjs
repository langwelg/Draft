// Eval harness — runs every case against the deterministic scheduler
// and (if OPENAI_API_KEY is set) against the LLM, then scores both.
import { readdirSync, readFileSync } from 'fs';
import { fallbackSchedule } from '../server.js';

const casesDir = new URL('./cases/', import.meta.url);
const cases = readdirSync(casesDir).filter(f => f.endsWith('.json')).sort()
  .map(f => JSON.parse(readFileSync(new URL(f, casesDir), 'utf8')));

function score(result, expect) {
  const scheduledIds = new Set((result.schedule || []).map(s => s.matchId));
  const conflictIds  = new Set((result.conflicts || []).map(c => c.matchId));
  const checks = [];
  for (const id of expect.scheduled || []) checks.push({ name:`scheduled:${id}`, pass: scheduledIds.has(id) });
  for (const id of expect.conflicts || []) checks.push({ name:`conflict:${id}`,  pass: conflictIds.has(id) });
  if (expect.noOverlap) {
    const byTeam = {};
    for (const m of result.schedule || []) {
      for (const t of [m.teamA, m.teamB]) {
        const iv = { s:new Date(m.scheduledStart), e:new Date(m.scheduledEnd) };
        const clash = (byTeam[t] || []).some(x => iv.s < x.e && x.s < iv.e);
        if (clash) checks.push({ name:`no-double-book:${t}`, pass:false });
        (byTeam[t] ||= []).push(iv);
      }
    }
    if (!checks.some(c => c.name.startsWith('no-double-book'))) checks.push({ name:'no-double-book', pass:true });
  }
  return checks;
}

async function callLLM(input) {
  const r = await fetch('http://localhost:3000/api/schedule', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ bracketText: JSON.stringify(input.bracket), availabilityText: JSON.stringify(input.availability) }),
  });
  return r.json();
}

const useLLM = process.argv.includes('--llm');
let total = 0, passed = 0;
console.log(`\nRunning ${cases.length} eval cases (${useLLM ? 'LLM + fallback' : 'fallback only'})\n`);
for (const c of cases) {
  const fb = fallbackSchedule(c.input);
  const fbChecks = score(fb, c.expect);
  const fbPass = fbChecks.filter(x => x.pass).length, fbTotal = fbChecks.length;
  total += fbTotal; passed += fbPass;
  const ok = fbPass === fbTotal ? '✓' : '✗';
  console.log(`${ok} [fallback] ${c.name}  ${fbPass}/${fbTotal}`);
  if (fbPass !== fbTotal) for (const ch of fbChecks.filter(x=>!x.pass)) console.log(`     · failed: ${ch.name}`);

  if (useLLM) {
    try {
      const llm = await callLLM(c.input);
      const lc = score(llm, c.expect);
      const lp = lc.filter(x=>x.pass).length, lt = lc.length;
      total += lt; passed += lp;
      console.log(`${lp===lt?'✓':'✗'} [llm]      ${c.name}  ${lp}/${lt}  (method=${llm.method})`);
    } catch (e) { console.log(`✗ [llm]      ${c.name}  ERROR ${e.message}`); }
  }
}
console.log(`\nTOTAL: ${passed}/${total} checks passed (${Math.round(100*passed/total)}%)\n`);
process.exit(passed === total ? 0 : 1);
