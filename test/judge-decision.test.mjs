// Re-deriving a judge decision (checkJudgeDecision and criteriaPick, through verifyOutcome) on receipts the tests
// change on purpose. The base is the server-made judge-3 payload in fixtures/receipts.json. Receipts are read from JSON
// text where a name matters: JSON.parse keeps "__proto__" as an own key, as a receipt read from the network does.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { verifyOutcome, verifyReviewOutcome } from "../src/index.mjs";

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

test('a score counts only from an own key: a criterion named "__proto__" with no score counts 0, as the service counts it', async () => {
  // Found by 5.0 (Nov 9, 16:24): s[c.name] for a criterion named "__proto__" read Object.prototype, every total became
  // NaN (null in a receipt), and the first party by name won. Since its fix (deployed Nov 9) the service counts a score
  // only from an own key, and an empty one as 0.
  const criteria = '[{"name":"__proto__","weight":5},{"name":"price","weight":1}]';
  const scores = '{"alpha":{"price":0},"beta":{"price":10}}';
  const fixed = singleReceipt(["alpha", "beta"], JSON.parse(`{"winner":"beta","criteria":${criteria},"scores":${scores},"totals":{"alpha":0,"beta":10}}`));
  assert.deepEqual((await verifyOutcome(fixed)).problems, []);
  // An empty own score counts 0, as before (a receipt built in code can hold undefined; JSON can't).
  const empty = singleReceipt(["alpha", "beta"], { ...JSON.parse(`{"winner":"beta","criteria":${criteria},"totals":{"alpha":0,"beta":10}}`), scores: { alpha: { price: undefined }, beta: { price: 10 } } });
  assert.deepEqual((await verifyOutcome(empty)).problems, []);
  // What the service signed before its fix: null totals and the first party by name. Now that is caught.
  const old = singleReceipt(["alpha", "beta"], JSON.parse(`{"winner":"alpha","criteria":${criteria},"scores":${scores},"totals":{"alpha":null,"beta":null}}`));
  assert.deepEqual((await verifyOutcome(old)).problems, [
    "The criteria totals don't match the judge's scores and the agreed weights.",
    "By the scores and agreed weights the winner should be beta.",
  ]);
  // A review vote's weighted total follows the same rule; an own "__proto__" score does count.
  const review = structuredClone(fx.review_3);
  review.criteria = JSON.parse(criteria);
  review.votes = review.votes.map((v, i) => ({ ...v, ...JSON.parse(i === 0 ? '{"scores":{"__proto__":2,"price":10},"total":20}' : '{"scores":{"price":7},"total":7}') }));
  assert.deepEqual((await verifyReviewOutcome(review)).problems, []);
  review.votes[1].total = 42;
  assert.deepEqual((await verifyReviewOutcome(review)).problems, ["Vote 2's weighted total doesn't match its scores."]);
});

test('majority: mistrial votes never count for a party, even one named "mistrial"', async () => {
  // The same hole 5.0 found in the service (Nov 9, 16:24): a party named "mistrial" shares the tally's mistrial
  // entry, so two mistrial votes made it the winner. The service refuses that name since its fix; the check counts
  // a party's own votes.
  const tally = { a: 1, mistrial: 2 };
  const twoMistrials = panelReceipt(["a", "mistrial"], "majority", [null, null, "a"], { winner: "mistrial", tally });
  assert.deepEqual((await verifyOutcome(twoMistrials)).problems, ["By the majority rule the panel's decision should be a mistrial."]);
  assert.deepEqual((await verifyOutcome(panelReceipt(["a", "mistrial"], "majority", [null, null, "a"], { winner: null, tally }))).problems, []);
  // Two real votes for that party still make it the winner.
  assert.deepEqual((await verifyOutcome(panelReceipt(["a", "mistrial"], "majority", ["mistrial", "mistrial", "a"], { winner: "mistrial", tally }))).problems, []);
});
