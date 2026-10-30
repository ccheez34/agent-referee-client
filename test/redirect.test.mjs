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

// A payment wrapper that rebuilds the request options for its paid request (drops `redirect`).
const rebuildingPayFetch = (base) => async (input, init = {}) => {
  const res = await base(input, init);
  if (res.status !== 402) return res;
  return base(input, { method: init.method, body: init.body, headers: { ...(init.headers || {}), "X-PAYMENT": "proof-456" } });
};

test("in browsers an opaque redirect is refused too, with the target unknown", async () => {
  const opaque = async () => ({ type: "opaqueredirect", status: 0, ok: false, redirected: false, headers: new Headers(), json: async () => ({}) });
  const ref = new AgentReferee({ url: "https://example.test", fetch: opaque });
  await assert.rejects(ref.info(), (e) => {
    assert.ok(e instanceof RefereeError);
    assert.equal(e.status, 0);
    assert.deepEqual(e.body, { redirect: true, location: null });
    assert.match(e.message, /status hidden by the browser\)/);
    assert.doesNotMatch(e.message, / to (\?|null)/);
    return true;
  });
});

test("captureFetch keeps a saved proof after a redirect or a 5xx, and removes it after a 2xx or 4xx", async () => {
  const cases = [[302, true], [0, true], [503, true], [200, false], [404, false]];
  for (const [status, kept] of cases) {
    const calls = [];
    const store = { save: async (k) => calls.push(["save", k]), remove: async (k) => calls.push(["remove", k]) };
    const base = async () => ({ status, ok: status >= 200 && status < 300, type: status === 0 ? "opaqueredirect" : "basic", headers: new Headers() });
    const cap = captureFetch(base, { store });
    await cap.fetch("https://example.test/join/rps", { method: "POST", body: '{"match_id":"m","seat":"alpha"}', headers: { "X-PAYMENT": "p" } });
    assert.deepEqual(calls.map((c) => c[0]), kept ? ["save"] : ["save", "remove"], `status ${status}`);
  }
});

test("captureFetch under a wrapper that drops `redirect` still never sends X-PAYMENT to the other host", async () => {
  const t = await thief();
  const s = await listen((req, res) => {
    if (!req.headers["x-payment"]) {
      res.writeHead(402, { "content-type": "application/json" });
      return res.end("{}");
    }
    res.writeHead(307, { location: `${t.url}/join` });
    res.end();
  });
  try {
    const capture = captureFetch(globalThis.fetch.bind(globalThis));
    const ref = new AgentReferee({ url: s.url, fetch: rebuildingPayFetch(capture.fetch), capture });
    await assert.rejects(ref._call("POST", "/join/rps", { match_id: "m", seat: "alpha" }), (e) => e instanceof RefereeError && e.status === 307);
    assert.deepEqual(t.got, []);
  } finally {
    s.srv.close();
    t.srv.close();
  }
});

test("if a fetch below the client follows a redirect anyway, the answer from the other host isn't used", async () => {
  const t = await thief();
  const s = await listen((req, res) => {
    res.writeHead(307, { location: `${t.url}/join` });
    res.end();
  });
  try {
    // No captureFetch: the wrapper's rebuilt options let fetch follow the redirect (the leak this can't prevent).
    const followAll = (input, init = {}) => globalThis.fetch(input, { method: init.method, body: init.body, headers: init.headers });
    const ref = new AgentReferee({ url: s.url, fetch: followAll });
    await assert.rejects(ref._call("POST", "/join/rps", { match_id: "m", seat: "alpha" }), (e) => {
      assert.ok(e instanceof RefereeError);
      assert.equal(e.body.redirect, true);
      assert.match(e.message, /redirect was followed below the client/);
      return true;
    });
    assert.equal(t.got.length, 1, "the other host got the request; the client refused its answer");
  } finally {
    s.srv.close();
    t.srv.close();
  }
});

test("join() stops after one recovery attempt when the paid join is redirected (one payment signed)", async () => {
  const t = await thief();
  let paid = 0;
  const s = await listen((req, res) => {
    if (req.method === "GET" && req.url === "/matches/m1") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ match_id: "m1", tier: "rps", seats: [] }));
    }
    if (req.url === "/matches/m1/recover") {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "no such payment" }));
    }
    if (!req.headers["x-payment"]) {
      res.writeHead(402, { "content-type": "application/json" });
      return res.end("{}");
    }
    paid++;
    res.writeHead(302, { location: `${t.url}/join` });
    res.end();
  });
  try {
    const capture = captureFetch(globalThis.fetch.bind(globalThis));
    const ref = new AgentReferee({ url: s.url, fetch: payingFetch(capture.fetch), capture });
    await assert.rejects(ref.join("m1", "alpha"), (e) => e instanceof RefereeError && e.status === 302 && e.body.redirect === true);
    assert.equal(paid, 1);
    assert.deepEqual(t.got, []);
  } finally {
    s.srv.close();
    t.srv.close();
  }
});
