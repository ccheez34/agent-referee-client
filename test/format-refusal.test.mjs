// Receipts in a format this version doesn't know (the coming multi-part tiers) are refused clearly, never passed.
// The judge case is the dangerous one: a receipt that kept tier "judge-3" and only added receipt_format would pass the
// old checks, because the verdict recomputes from the votes. The Python client's tests/test_unit.py runs the same
// cases. Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canonicalJson, sha256Hex, verifyOutcome, verifyReviewOutcome, verifySeries } from "../src/index.mjs";

const fx = JSON.parse(readFileSync(new URL("./fixtures/receipts.json", import.meta.url), "utf8"));
const judge = fx.judge_3, review = fx.review_3, task = fx.review_3_task, output = fx.review_3_output;
const FORMAT_MSG = "format, which this version of agent-referee-client can't check, so nothing was confirmed. Update the client (";

async function reviewMulti() {
  const { output_sha256, ...r } = review;
  const pieces = [{ index: 1, name: "", sha256: await sha256Hex("a"), chars: 1 }, { index: 2, name: "", sha256: await sha256Hex("b"), chars: 1 }];
  return { ...r, tier: "review-3x2", receipt_format: "review-multi-v1", pieces, pieces_sha256: await sha256Hex(canonicalJson(pieces)) };
}

test("control: today's receipts still pass", async () => {
  assert.equal((await verifyOutcome(judge)).ok, true);
  assert.equal((await verifyReviewOutcome(review)).ok, true);
  assert.equal((await verifyReviewOutcome(review, { task, output, tier: "review-3" })).ok, true);
});

test("judge receipts with any format are refused, even as judge-3", async () => {
  for (const fmt of ["judge-multi-v1", null, "foo"]) {
    const c = await verifyOutcome({ ...judge, receipt_format: fmt });
    assert.equal(c.ok, false, String(fmt));
    assert.ok(c.problems[0].includes(FORMAT_MSG), c.problems[0]);
  }
  assert.ok((await verifyOutcome({ ...judge, receipt_format: null })).problems[0].includes("uses the null format")); // as Python prints it
  const c = await verifyOutcome({ ...judge, tier: "judge-3x2" });
  assert.equal(c.ok, false);
  assert.ok(c.problems[0].includes('Unknown tier "judge-3x2"'), c.problems[0]);
});

test("review receipts with any format are refused, with or without the texts", async () => {
  for (const r of [await reviewMulti(), { ...review, receipt_format: null }, { ...review, receipt_format: "foo" }]) {
    for (const opts of [{}, { task, output }]) {
      const c = await verifyReviewOutcome(r, opts);
      assert.equal(c.ok, false, `${r.receipt_format} ${JSON.stringify(Object.keys(opts))}`);
      assert.ok(c.problems[0].includes(FORMAT_MSG), c.problems[0]);
    }
  }
});

test("unknown review tiers are refused clearly", async () => {
  const c = await verifyReviewOutcome({ ...review, tier: "review-3x2" });
  assert.equal(c.ok, false);
  assert.ok(c.problems[0].includes("doesn't know the review-3x2 review tier, so nothing was confirmed. Update the client ("), c.problems[0]);
  assert.equal((await verifyReviewOutcome({ ...review, tier: ["review-3"] })).ok, false); // an odd tier value is refused, not a crash
});

test("a series with an unknown-format receipt anywhere is refused", async () => {
  for (const series of [[{ ...judge, receipt_format: "judge-multi-v1" }], [judge, { ...judge, receipt_format: null }], [judge, { ...judge, receipt_format: "foo" }]]) {
    const c = await verifySeries(series);
    assert.equal(c.ok, false);
    assert.ok(c.problems[0].includes(FORMAT_MSG), c.problems[0]);
  }
});
