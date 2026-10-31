// Ledger 3.0-D86: @x402/fetch 2.x (checked against coinbase/x402 at 0e6e8c5, packages/http/fetch 2.28.0) builds
// `new Request(input, init)` and sends its paid retry as fetch(request), with no options. captureFetch must still see
// the proof (X-PAYMENT for x402 v1, PAYMENT-SIGNATURE for v2) and key it by the request's own body.
import { test } from "node:test";
import assert from "node:assert/strict";
import { captureFetch } from "../src/index.mjs";

const URL_JOIN = "https://agentreferee.ai/join";
const BODY = JSON.stringify({ match_id: "m1", seat: "alpha" });

function setup() {
  const saved = [];
  const removed = [];
  const sent = [];
  const store = { save: async (k, p, info) => saved.push({ k, p, info }), remove: async (k) => removed.push(k) };
  const base = async (input, init) => {
    sent.push({ isRequest: input instanceof Request, redirect: init?.redirect, bodyLeft: input instanceof Request ? await input.text() : init?.body });
    return new Response("{}", { status: 200 });
  };
  return { cap: captureFetch(base, { store }), saved, removed, sent };
}

// The same shape as @x402/fetch's paid retry: a Request with the payment header set on it, no options.
const paidRequest = (header, value) => {
  const r = new Request(URL_JOIN, { method: "POST", headers: { "content-type": "application/json" }, body: BODY, redirect: "manual" });
  r.headers.set(header, value);
  return r;
};

for (const header of ["X-PAYMENT", "PAYMENT-SIGNATURE"]) {
  test(`a Request object with ${header} and no options: the proof is saved first, keyed by the body, then cleared`, async () => {
    const { cap, saved, removed, sent } = setup();
    await cap.fetch(paidRequest(header, "proof-123"));
    assert.equal(saved.length, 1);
    assert.equal(saved[0].p, "proof-123");
    assert.deepEqual(saved[0].info, { url: URL_JOIN, match_id: "m1", seat: "alpha" });
    assert.equal(cap.lastPayment(URL_JOIN, BODY), "proof-123");
    assert.deepEqual(removed, [saved[0].k]);
    assert.equal(sent[0].bodyLeft, BODY, "the request still carries its body");
    assert.equal(sent[0].redirect, "manual");
  });
}

test("the old way (a URL string and options) still works", async () => {
  const { cap, saved } = setup();
  await cap.fetch(URL_JOIN, { method: "POST", headers: { "X-PAYMENT": "proof-9" }, body: BODY });
  assert.equal(saved[0].p, "proof-9");
  assert.equal(cap.lastPayment(URL_JOIN, BODY), "proof-9");
});

test("no payment header: nothing saved", async () => {
  const { cap, saved } = setup();
  await cap.fetch(new Request(URL_JOIN, { method: "POST", body: BODY }));
  assert.equal(saved.length, 0);
});
