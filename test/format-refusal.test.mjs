// Receipts in a format this version doesn't know (the coming multi-part tiers) are refused clearly, never passed.
// The judge case matters most: a receipt that kept tier "judge-3" and only added receipt_format would otherwise pass,
// because the verdict recomputes from the votes. Run: node --test test/
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { verifyOutcome, verifyReviewOutcome, verifySeries } from "../src/index.mjs";

const fx = JSON.parse(readFileSync(new URL("./fixtures/receipts.json", import.meta.url), "utf8"));
const CANT = "this version of agent-referee-client can't check";

test("control: today's judge-3 and review-3 receipts still check out", async () => {
  assert.equal((await verifyOutcome(fx.judge_3)).ok, true);
  assert.equal((await verifyReviewOutcome(fx.review_3)).ok, true);
});

test("judge receipts with any receipt_format are refused, even with tier judge-3", async () => {
  for (const fmt of ["judge-multi-v1", null, "foo"]) {
    const r = await verifyOutcome({ ...fx.judge_3, receipt_format: fmt });
    assert.equal(r.ok, false);
    assert.match(r.problems[0], new RegExp(CANT));
  }
  assert.match((await verifyOutcome({ ...fx.judge_3, receipt_format: null })).problems[0], /the null format/); // as Python prints it
  assert.equal((await verifyOutcome({ ...fx.judge_3, tier: "judge-3x2" })).ok, false);
});

test("review-multi-v1 receipts are refused clearly, with or without the texts", async () => {
  const { output_sha256, ...rest } = fx.review_3;
  const multi = { ...rest, tier: "review-3x2", receipt_format: "review-multi-v1", pieces: [], pieces_sha256: "0".repeat(64) };
  for (const opts of [{}, { task: "t", output: "a" }]) {
    const r = await verifyReviewOutcome(multi, opts);
    assert.equal(r.ok, false);
    assert.match(r.problems[0], new RegExp(CANT));
  }
  const unknownTier = { ...rest, tier: "review-3x2" };
  const r = await verifyReviewOutcome(unknownTier);
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /doesn't know the review-3x2 review tier/);
});

test("a series containing an unknown-format receipt is refused", async () => {
  const r = await verifySeries([{ ...fx.judge_3, receipt_format: "judge-multi-v1" }]);
  assert.equal(r.ok, false);
  assert.match(r.problems[0], new RegExp(CANT));
});
