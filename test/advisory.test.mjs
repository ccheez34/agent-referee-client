// Judge spec §9: judge receipts carry the service's own advisory sentence and human_review: "required", inside the
// signed part. The client accepts them, shows the receipt's own text, and passes the server's new answers on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import { AgentReferee, RefereeError, judgeAdvisory, verifyOutcome, verifySignature } from "../src/index.mjs";

const vectors = JSON.parse(readFileSync(new URL("./fixtures/multi-judge-vectors.json", import.meta.url), "utf8"));
const valid = vectors.cases.filter((c) => c.expect.ok);

test("the regenerated vectors carry advisory and human_review, signed, on every case", async () => {
  for (const c of vectors.cases) {
    assert.equal(typeof c.receipt.payload.advisory, "string", c.id);
    assert.equal(c.receipt.payload.human_review, "required", c.id);
  }
  assert.ok(valid.length >= 3);
  for (const c of valid) assert.equal(await verifySignature(c.receipt, [vectors.public_key]), true, `${c.id} verifies with the new fields`);
});

test("no Claude judge sits on the regenerated panels", () => {
  for (const c of vectors.cases) {
    const text = JSON.stringify(c.receipt.payload.proof?.judge ?? {}) + JSON.stringify(c.receipt.payload.outcome?.votes ?? []);
    assert.doesNotMatch(text, /claude|anthropic/i, c.id);
  }
});

test("verifyOutcome shows the receipt's own advisory text and the review marker", async () => {
  for (const c of valid) {
    const check = await verifyOutcome(c.receipt, { pieces: c.given?.pieces, acks: c.given?.acks });
    assert.equal(check.ok, true, c.id);
    assert.equal(check.advisory, c.receipt.payload.advisory, "the receipt's words, not a copy kept in the client");
    assert.equal(check.humanReview, "required");
    assert.ok(check.trusts.includes(c.receipt.payload.advisory));
    assert.ok(check.trusts.some((t) => /person's review/.test(t)));
  }
});

test("judgeAdvisory reads a receipt, a payload or a status, and is empty elsewhere", () => {
  const r = valid[0].receipt;
  for (const doc of [r, r.payload, { phase: "done", advisory: r.payload.advisory, human_review: "required" }]) {
    const a = judgeAdvisory(doc);
    assert.equal(a.advisory, r.payload.advisory);
    assert.equal(a.humanReviewRequired, true);
  }
  assert.deepEqual(judgeAdvisory({ payload: { tier: "rps" } }), { advisory: null, humanReview: null, humanReviewRequired: false });
  assert.deepEqual(judgeAdvisory(null), { advisory: null, humanReview: null, humanReviewRequired: false });
});

test("a receipt without the fields (older judge receipts, other tiers) gets no advisory line", async () => {
  const c = valid[0];
  const { advisory, human_review, ...older } = c.receipt.payload;
  const check = await verifyOutcome(older, { pieces: c.given?.pieces });
  assert.equal(check.advisory, null);
  assert.equal(check.humanReview, null);
  assert.ok(!check.trusts.some((t) => /person's review/.test(t)));
});

function listen(status, body) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
    srv.listen(0, "127.0.0.1", () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}` }));
  });
}

test("the server's own text for the new 400 and 503 answers reaches the caller", async () => {
  const cases = [
    [400, "Claude models aren't offered as judges for now. Name models from other companies; GET /judge lists them."],
    [503, "judge-3 is closed for now: judge-3 needs a third AI company; agents can name one themselves (GET /judge)"],
  ];
  for (const [status, error] of cases) {
    const { srv, url } = await listen(status, { error });
    try {
      const ref = new AgentReferee({ url });
      await assert.rejects(ref.create({ tier: "judge-3", seats: ["a", "b"], rules: "r" }), (e) => {
        assert.ok(e instanceof RefereeError);
        assert.equal(e.status, status);
        assert.equal(e.message, error);
        return true;
      });
    } finally {
      srv.close();
    }
  }
});
