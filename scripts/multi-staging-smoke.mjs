// Multi-part smoke test against STAGING (fake AI, payments off: costs nothing). Run from the agent-referee-client folder:
//   node scripts\multi-staging-smoke.mjs
// Uses this folder's client (0.9.0). Checks review-3x2 and review-3x3 end to end, then that a changed piece fails.
import { AgentReferee, verifyReviewOutcome } from "../src/index.mjs";

const url = "https://agent-referee-staging.fairplayclub.workers.dev";
const STAGING_KEY = "HQxMeqRdQ3ARUm/WAhdIRWyp8HE/QJf6yHb+lwFxeUg="; // staging's own key (key ID 56906115c6857d27)
const ref = new AgentReferee({ url, publicKeys: [STAGING_KEY] });
let failed = 0;
const ok = (cond, what) => { console.log(`${cond ? "PASS" : "FAIL"}  ${what}`); if (!cond) failed++; };

const task = "Write a retry helper that tries up to 4 times and never runs past 240 seconds, with tests for both rules.";
const p2 = [
  { name: "retry.js", text: "export async function retry(fn) {\n  for (let i = 0; i < 4; i++) { try { return await fn(); } catch {} }\n}\n" },
  { name: "retry.test.js", text: "// tests: four tries, and the 240-second limit\n" },
];
const p3 = [...p2, { text: "Notes: 日本語 and emoji 😀 count as UTF-16 units.\r\n" }];

for (const [tier, pieces] of [["review-3x2", p2], ["review-3x3", p3]]) {
  try {
    const r = await ref.review({ tier, task, pieces, title: "staging smoke" });
    ok(r.check.ok, `${tier}: verdict ${r.result.verdict}, receipt checks out${r.check.ok ? "" : ` (${r.check.problems.join("; ")})`}`);
    ok(r.receipt?.payload?.receipt_format === "review-multi-v1", `${tier}: receipt_format review-multi-v1`);
    ok(r.receipt?.payload?.pieces?.length === pieces.length, `${tier}: ${pieces.length} piece fingerprints in the receipt`);
    const changed = pieces.map((x, i) => (i === 0 ? { ...x, text: x.text + " " } : x));
    const bad = await verifyReviewOutcome(r.receipt, { task, pieces: changed });
    ok(!bad.ok, `${tier}: a changed piece is caught (${bad.problems[0]})`);
  } catch (e) {
    ok(false, `${tier}: ${e.status ?? ""} ${e.message}`);
  }
}
console.log(failed ? `\n${failed} check(s) failed.` : "\nAll checks passed.");
process.exitCode = failed ? 1 : 0;
