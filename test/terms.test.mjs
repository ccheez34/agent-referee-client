// Terms acceptance, option A of research\specs\terms-binding-2026-10-31\SPEC.md: the owner's accepted Terms version
// travels as x-accept-terms, and receipts that record it can be read back. Off unless acceptTerms is set.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentReferee, RefereeError, receiptTerms, isTermsRefusal, verifyReviewOutcome } from "../src/index.mjs";

function recorder(answer = () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })) {
  const seen = [];
  const fetch = async (url, init) => (seen.push({ url, headers: { ...init.headers } }), answer(url, init));
  return { seen, fetch };
}

test("acceptTerms unset: no x-accept-terms header is sent", async () => {
  const r = recorder();
  await new AgentReferee({ url: "https://agentreferee.ai", fetch: r.fetch }).info();
  assert.equal("x-accept-terms" in r.seen[0].headers, false);
});

test("acceptTerms set: every request carries it; a malformed version is refused at construction", async () => {
  const r = recorder();
  const ref = new AgentReferee({ url: "https://agentreferee.ai", fetch: r.fetch, acceptTerms: "v2026-11-01" });
  await ref.info();
  await ref._call("POST", "/review", { task: "x".repeat(20), output: "y" }).catch(() => {});
  assert.deepEqual(r.seen.map((s) => s.headers["x-accept-terms"]), ["v2026-11-01", "v2026-11-01"]);
  for (const bad of ["2026-11-01", "v26-11-01", "latest", "v2026-11-01; drop"]) assert.throws(() => new AgentReferee({ acceptTerms: bad }), /acceptTerms/);
});

test("a refusal over the Terms is recognised, and its text passes through", async () => {
  const msg = "send x-accept-terms: v2026-11-01 to accept https://agentreferee.ai/terms; nothing was charged";
  const r = recorder(() => new Response(JSON.stringify({ error: msg }), { status: 428 }));
  const err = await new AgentReferee({ url: "https://agentreferee.ai", fetch: r.fetch }).info().catch((e) => e);
  assert.ok(err instanceof RefereeError);
  assert.equal(isTermsRefusal(err), true);
  assert.match(err.message, /nothing was charged/);
  assert.equal(isTermsRefusal(new RefereeError("busy", 503)), false);
  assert.equal(isTermsRefusal(new Error(msg)), false);
});

test("receiptTerms reads the signed version; older receipts give null; extra signed fields don't break checks", async () => {
  const sha = "a".repeat(64);
  assert.deepEqual(receiptTerms({ payload: { terms_version: "v2026-11-01", terms_sha256: sha } }), { version: "v2026-11-01", sha256: sha, matches: null });
  assert.equal(receiptTerms({ payload: { terms_version: "v2026-11-01" } }, "v2026-11-01").matches, true);
  assert.equal(receiptTerms({ payload: { terms_version: "v2026-11-01", terms_sha256: "nothex" } }, "v2026-12-01").matches, false);
  assert.equal(receiptTerms({ payload: {} }), null);
  assert.equal(receiptTerms(null), null);
  // A review receipt that also carries the terms fields still verifies.
  const { readFile } = await import("node:fs/promises");
  const fx = JSON.parse(await readFile(new URL("./fixtures/receipts.json", import.meta.url), "utf8"));
  const base = fx.review_3;
  const withTerms = { ...base, payload: { ...(base.payload ?? base), terms_version: "v2026-11-01", terms_sha256: sha } };
  const plain = await verifyReviewOutcome(base, { task: fx.review_3_task, output: fx.review_3_output });
  const extra = await verifyReviewOutcome(withTerms, { task: fx.review_3_task, output: fx.review_3_output });
  assert.equal(plain.ok, true, JSON.stringify(plain.problems));
  assert.equal(extra.ok, true, JSON.stringify(extra.problems));
});
