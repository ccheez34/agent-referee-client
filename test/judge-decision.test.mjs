// Re-deriving a judge decision (checkJudgeDecision and criteriaPick, through verifyOutcome) on receipts the tests
// change on purpose. The base is the server-made judge-3 payload in fixtures/receipts.json. Receipts are read from JSON
// text where a name matters: JSON.parse keeps "__proto__" as an own key, as a receipt read from the network does.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { verifyOutcome } from "../src/index.mjs";

const fx = JSON.parse(readFileSync(new URL("./fixtures/receipts.json", import.meta.url), "utf8"));

/** The fixture's judge-3 receipt with these parties, rule and picks (one per panelist, null for a mistrial vote). */
function panelReceipt(parties, rule, picks, extra = {}) {
  const p = structuredClone(fx.judge_3);
  p.parties = parties;
  p.proof.judge.decision_rule = rule;
  p.outcome = { decision_rule: rule, votes: p.outcome.votes.map((v, i) => ({ ...v, winner: picks[i] })), ...extra };
  return p;
}

/** A one-judge receipt (tier "judge") with scores on agreed criteria. */
const singleReceipt = (parties, outcome) => ({ tier: "judge", parties, outcome, proof: { judge: { model: "openai/gpt-6-luna" } } });

test("the base receipt checks clean", async () => {
  assert.deepEqual((await verifyOutcome(fx.judge_3)).problems, []);
});

test("unanimous: every vote must pick the same party; a common pick that names no party is no winner", async () => {
  const party = panelReceipt(["buyer", "seller"], "unanimous", ["buyer", "buyer", "buyer"], { winner: "buyer", tally: { buyer: 3, seller: 0, mistrial: 0 } });
  assert.deepEqual((await verifyOutcome(party)).problems, []);
  // Found in the clean-work check (Nov 4): three votes for "zed", which is no party, made "zed" the winner.
  const nonParty = panelReceipt(["buyer", "seller"], "unanimous", ["zed", "zed", "zed"], { winner: "zed" });
  const r = await verifyOutcome(nonParty);
  assert.equal(r.ok, false);
  assert.deepEqual(r.problems, ["By the unanimous rule the panel's decision should be a mistrial."]);
  // Split votes are still no winner, and a receipt that says so checks clean.
  const split = panelReceipt(["buyer", "seller"], "unanimous", ["buyer", "seller", "buyer"], { winner: null, tally: { buyer: 2, seller: 1, mistrial: 0 } });
  assert.deepEqual((await verifyOutcome(split)).problems, []);
});

test('criteria totals keep every party\'s own key, one named "__proto__" included', async () => {
  // Found in the clean-work check (Nov 4): on a plain {}, totals["__proto__"] = 9 set the prototype, so that party's
  // total was dropped and "__proto__" 9 against "b" 1 gave no pick.
  const one = singleReceipt(
    JSON.parse('["__proto__","b"]'),
    JSON.parse('{"winner":"__proto__","criteria":[{"name":"price","weight":1}],"scores":{"__proto__":{"price":9},"b":{"price":1}},"totals":{"__proto__":9,"b":1}}'),
  );
  assert.deepEqual((await verifyOutcome(one)).problems, []);
  const wrong = structuredClone(one);
  wrong.outcome = JSON.parse('{"winner":"b","criteria":[{"name":"price","weight":1}],"scores":{"__proto__":{"price":9},"b":{"price":1}},"totals":{"__proto__":9,"b":1}}');
  assert.deepEqual((await verifyOutcome(wrong)).problems, ["By the scores and agreed weights the winner should be __proto__."]);
  // On a panel, each vote's pick comes from its own scores, and the tally keeps the party's own key too.
  const scores = JSON.parse('{"__proto__":{"price":9},"b":{"price":1}}');
  const panel = panelReceipt(JSON.parse('["__proto__","b"]'), "majority", [null, null, null], JSON.parse('{"winner":"__proto__","criteria":[{"name":"price","weight":1}],"tally":{"__proto__":3,"b":0,"mistrial":0}}'));
  panel.outcome.votes = panel.outcome.votes.map((v) => ({ ...v, winner: "__proto__", scores: structuredClone(scores) }));
  assert.deepEqual((await verifyOutcome(panel)).problems, []);
});
