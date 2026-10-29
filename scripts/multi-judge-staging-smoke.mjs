// Multi-part judge smoke test against STAGING (fake AI, payments off: costs nothing). Run from the agent-referee-client folder:
//   node scripts\multi-judge-staging-smoke.mjs
// Uses this folder's client (0.10.0). Plays a judge-3x2 and a judge-3x3 match end to end with two seats, checks both
// seats' receipts and acks, then that a changed piece is caught.
import { AgentReferee, verifyOutcome } from "../src/index.mjs";

const url = "https://agent-referee-staging.fairplayclub.workers.dev";
const STAGING_KEY = "HQxMeqRdQ3ARUm/WAhdIRWyp8HE/QJf6yHb+lwFxeUg="; // staging's own key (key ID 56906115c6857d27)
const a = new AgentReferee({ url, publicKeys: [STAGING_KEY], pollMs: 1000 });
const b = new AgentReferee({ url, publicKeys: [STAGING_KEY], pollMs: 1000 });
let failed = 0;
const ok = (cond, what) => { console.log(`${cond ? "PASS" : "FAIL"}  ${what}`); if (!cond) failed++; };

const rules = "The plan that costs less in all wins. If both cost the same, the one that ships sooner wins.";
const sides = {
  "judge-3x2": { alpha: ["Plan A: $40 in all.\n", "Ships in 2 days."], beta: ["Plan B: $35 in all.", "Ships in 5 days."] },
  "judge-3x3": {
    alpha: ["Plan A: $40 in all.", "Ships in 2 days.", "Notes: 日本語 and emoji 😀 count as UTF-16 units.\r\n"],
    beta: ["Plan B: $35 in all.", "Ships in 5 days.", "No extras."],
  },
};

for (const [tier, pieces] of Object.entries(sides)) {
  try {
    const m = await a.create({ tier, seats: ["alpha", "beta"], title: `staging smoke ${tier}`, rules });
    const sa = await a.join(m.match_id, "alpha");
    const sb = await b.join(m.match_id, "beta");
    const [ra, rb] = await Promise.all([sa.submit(pieces.alpha), sb.submit(pieces.beta)]);
    const p = ra.receipt?.payload;
    ok(ra.phase === "done" && ra.check?.ok, `${tier}: alpha's check passes (winner ${p?.outcome?.winner ?? "none"})${ra.check?.ok ? "" : ` (${ra.check?.problems?.join("; ")})`}`);
    ok(rb.check?.ok, `${tier}: beta's check passes${rb.check?.ok ? "" : ` (${rb.check?.problems?.join("; ")})`}`);
    ok(p?.receipt_format === "judge-multi-v1", `${tier}: receipt_format judge-multi-v1`);
    ok(Object.keys(p?.proof?.pieces ?? {}).length === 2, `${tier}: both sides' piece fingerprints in the receipt`);
    const changed = { alpha: pieces.alpha.map((t, i) => (i === 0 ? t + " " : t)) };
    const bad = await verifyOutcome(ra.receipt, { pieces: changed, acks: [...sa.acks, ...sb.acks] });
    ok(!bad.ok, `${tier}: a changed piece is caught (${bad.problems[0]})`);
  } catch (e) {
    ok(false, `${tier}: ${e.status ?? ""} ${e.message}`);
  }
}
console.log(failed ? `\n${failed} check(s) failed.` : "\nAll checks passed.");
process.exitCode = failed ? 1 : 0;
