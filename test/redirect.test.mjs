// The client never follows a redirect, so a payment proof (X-PAYMENT) can't be carried to another host.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AgentReferee, RefereeError, captureFetch } from "../src/index.mjs";

function listen(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, "127.0.0.1", () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}` }));
  });
}

// The "other host": records every request it gets.
async function thief() {
  const got = [];
  const t = await listen((req, res) => {
    got.push({ url: req.url, payment: req.headers["x-payment"] ?? null });
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  return { ...t, got };
}

// Like a payment wrapper: on a 402, sends the same request again with X-PAYMENT, keeping the caller's options.
const payingFetch = (base) => async (input, init = {}) => {
  const res = await base(input, init);
  if (res.status !== 402) return res;
  return base(input, { ...init, headers: { ...(init.headers || {}), "X-PAYMENT": "proof-123" } });
};

test("a redirect is refused with a clear error, and the other host gets nothing", async () => {
  const t = await thief();
  const s = await listen((req, res) => {
    res.writeHead(307, { location: `${t.url}/stolen` });
    res.end();
  });
  try {
    const ref = new AgentReferee({ url: s.url });
    await assert.rejects(ref.info(), (e) => {
      assert.ok(e instanceof RefereeError);
      assert.equal(e.status, 307);
      assert.match(e.message, /redirect \(HTTP 307 to http:\/\/127\.0\.0\.1:\d+\/stolen\)/);
      assert.match(e.message, /never follows redirects/);
      return true;
    });
    assert.equal(t.got.length, 0);
  } finally {
    s.srv.close();
    t.srv.close();
  }
});

test("a paid request that gets a redirect never sends X-PAYMENT to the other host", async () => {
  const t = await thief();
  let calls = 0;
  const s = await listen((req, res) => {
    calls++;
    if (!req.headers["x-payment"]) {
      res.writeHead(402, { "content-type": "application/json" });
      return res.end(JSON.stringify({ x402Version: 1, accepts: [] }));
    }
    res.writeHead(302, { location: `${t.url}/join` });
    res.end();
  });
  try {
    const capture = captureFetch(globalThis.fetch.bind(globalThis));
    const ref = new AgentReferee({ url: s.url, fetch: payingFetch(capture.fetch), capture });
    await assert.rejects(ref._call("POST", "/matches/abc/join", { match_id: "abc", seat: "alpha" }), (e) => {
      assert.ok(e instanceof RefereeError);
      assert.equal(e.status, 302);
      return true;
    });
    assert.equal(calls, 2, "the unpaid request, then the paid one, both to the service");
    assert.deepEqual(t.got, [], "nothing reached the other host");
  } finally {
    s.srv.close();
    t.srv.close();
  }
});

test("ordinary answers are unchanged", async () => {
  const s = await listen((req, res) => {
    res.writeHead(req.url === "/" ? 200 : 404, { "content-type": "application/json" });
    res.end(req.url === "/" ? JSON.stringify({ service: "x" }) : JSON.stringify({ error: "not here" }));
  });
  try {
    const ref = new AgentReferee({ url: s.url });
    assert.deepEqual(await ref.info(), { service: "x" });
    await assert.rejects(ref._call("GET", "/nope"), (e) => e instanceof RefereeError && e.status === 404 && e.message === "not here");
  } finally {
    s.srv.close();
  }
});
