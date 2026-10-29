// Receipts in a format this version doesn't know (judge-multi-v1, until the judge tiers are added) are refused clearly, never passed.
// The judge case is the dangerous one: a receipt that kept tier "judge-3" and only added receipt_format would pass the
// old checks, because the verdict recomputes from the votes. The Python client's tests/test_unit.py runs the same
// cases. Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canonicalJson, sha256Hex, verifyOutcome, verifyReviewOutcome, verifySeries } from "../src/index.mjs";

const fx = JSON.parse(readFileSync(new URL("./fixtures/receipts.json", import.meta.url), "utf8"));
const judge = fx.judge_3, review = fx.review_3, task = fx.review_3_task, output = fx.review_3_output;
const UPDATE = "Update the client (npm install agent-referee-client@latest).";
const FALSY_AND_ODD = [null, "", 0, false, "foo"]; // every one is refused, not just truthy strings
const formatMsg = (shown) => `This receipt uses the ${shown} format, which this version of agent-referee-client can't check, so nothing was confirmed. ${UPDATE}`;

async function reviewMulti() {
  const { output_sha256, ...r } = review;
  const pieces = [{ index: 1, name: "", sha256: await sha256Hex("a"), chars: 1 }, { index: 2, name: "", sha256: await sha256Hex("b"), chars: 1 }];
  return { ...r, tier: "review-3x2", receipt_format: "review-multi-v1", pieces, pieces_sha256: await sha256Hex(canonicalJson(pieces)) };
}

test("control: today's receipts still pass", async () => {
  assert.equal((await verifyOutcome(judge)).ok, true);
  assert.equal((await verifyReviewOutcome(review)).ok, true);
  assert.equal((await verifyReviewOutcome(review, { task, output, tier: "review-3" })).ok, true);
  assert.equal((await verifySeries([judge])).ok, true); // so the series refusals below aren't a check that refuses everything
});

test("judge receipts with an unknown format are refused; judge-multi-v1 only on its own tiers", async () => {
  // Since 0.10.0 judge-multi-v1 is checked (test/multi-judge.test.mjs runs the server's vectors), but only on
  // judge-3x2 and judge-3x3: on judge-3 it would otherwise recompute from the votes and pass.
  for (const fmt of ["judge-multi-v2", "review-multi-v1", ...FALSY_AND_ODD]) {
    const c = await verifyOutcome({ ...judge, receipt_format: fmt });
    assert.equal(c.ok, false, String(fmt));
    assert.deepEqual(c.problems, [formatMsg(String(fmt))]);
  }
  const j3 = await verifyOutcome({ ...judge, receipt_format: "judge-multi-v1" });
  assert.deepEqual(j3.problems, ["A judge-multi-v1 receipt must be for a multi-part judge tier (judge-3x2 or judge-3x3), not judge-3."]);
  const noFmt = await verifyOutcome({ ...judge, tier: "judge-3x2" });
  assert.deepEqual(noFmt.problems, ["A judge-3x2 receipt must say receipt_format judge-multi-v1; this one doesn't, so it can't be checked."]);
  for (const tier of ["judge-9x9", ["judge-3"]]) {
    const c = await verifyOutcome({ ...judge, tier });
    assert.equal(c.ok, false);
    assert.deepEqual(c.problems, [`Unknown tier "${String(tier)}".`]);
  }
});

test("review receipts with an unknown format are refused, with or without the texts", async () => {
  for (const r of [{ ...review, receipt_format: "judge-multi-v1" }, ...FALSY_AND_ODD.map((f) => ({ ...review, receipt_format: f }))]) {
    for (const opts of [{}, { task, output }]) {
      const c = await verifyReviewOutcome(r, opts);
      assert.equal(c.ok, false, `${r.receipt_format} ${JSON.stringify(Object.keys(opts))}`);
      assert.deepEqual(c.problems, [formatMsg(String(r.receipt_format))]);
    }
  }
});

test("review-multi-v1 is checked, never passed on a shortcut: an incomplete or mislabelled one fails", async () => {
  // Since 0.9.0 the client knows review-multi-v1 (test/multi-review.test.mjs runs the server's vectors). A receipt
  // built from a single-piece one is still refused: its votes lack issues_dropped, and it has no pieces to match.
  const m = await verifyReviewOutcome(await reviewMulti(), { task, pieces: [{ text: "a" }, { text: "b" }] });
  assert.equal(m.ok, false);
  assert.ok(m.problems.some((x) => /issues_dropped/.test(x)), JSON.stringify(m.problems));
  const old = await verifyReviewOutcome({ ...review, receipt_format: "review-multi-v1" }, { task, output });
  assert.deepEqual(old.problems, ["A review-multi-v1 receipt must be for a multi-part tier (review-3x2 or review-3x3), not review-3."]);
  const j = await verifyOutcome({ ...judge, receipt_format: "review-multi-v1" }); // a review format on a match receipt
  assert.deepEqual(j.problems, [formatMsg("review-multi-v1")]);
});

test("unknown review tiers are refused clearly", async () => {
  const c = await verifyReviewOutcome({ ...review, tier: "review-9x9" });
  assert.equal(c.ok, false);
  assert.deepEqual(c.problems, [`This client doesn't know the review-9x9 review tier, so nothing was confirmed. ${UPDATE}`]);
  assert.equal((await verifyReviewOutcome({ ...review, tier: ["review-3"] })).ok, false); // an odd tier value is refused, not a crash
});

test("a series with an unknown-format receipt anywhere is refused", async () => {
  const bad = (f) => ({ ...judge, receipt_format: f });
  for (const [series, fmt] of [[[bad("judge-multi-v9")], "judge-multi-v9"], [[judge, bad(null)], null], [[judge, judge, bad("foo")], "foo"], [[bad(""), judge], ""]]) {
    const c = await verifySeries(series);
    assert.equal(c.ok, false);
    assert.deepEqual(c.problems, [formatMsg(String(fmt))]);
  }
});
