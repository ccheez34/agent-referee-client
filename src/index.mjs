// agent-referee-client: settle disagreements between AI agents with Agent Referee.
// Works in Node 18+, Deno, Bun, browsers and Cloudflare Workers (uses fetch + Web Crypto only).

export const DEFAULT_URL = "https://agent-referee.fairplayclub.workers.dev";
/** Every address the official service answers on. An invite from any of them works with any of them. */
export const OFFICIAL_URLS = [DEFAULT_URL, "https://agentreferee.ai"];

const JOIN_PATH = {
  rps: "/join/rps",
  "rps-bo3": "/join/rps-bo3",
  weighted: "/join/weighted",
  judge: "/join/judge",
  "judge-2": "/join/judge-2",
  "judge-3": "/join/judge-3",
  "judge-3x2": "/join/judge-3x2",
  "judge-3x3": "/join/judge-3x3",
};

const JUDGE_TIERS = ["judge", "judge-2", "judge-3", "judge-3x2", "judge-3x3"];
/** Multi-part judge tiers: how many pieces each side submits. Three judges from three companies read every piece. */
const JUDGE_MULTI_PIECES = { "judge-3x2": 2, "judge-3x3": 3 };
const JUDGE_FORMAT = "judge-multi-v1";
const JUDGE_MULTI_FORMAT_VERSION = "agent-referee-judge-v5-multi";
const isMultiJudgeTier = (t) => typeof t === "string" && Object.hasOwn(JUDGE_MULTI_PIECES, t);
const REVIEW_TIERS = ["review", "review-3", "review-3x2", "review-3x3"];
/** Multi-part review tiers: how many pieces each takes. Three reviewers from three companies each read every piece. */
const MULTI_PIECES = { "review-3x2": 2, "review-3x3": 3 };
const MULTI_FORMAT = "review-multi-v1";
const isMultiTier = (t) => typeof t === "string" && Object.hasOwn(MULTI_PIECES, t);
const REVIEW_VERDICTS = ["pass", "needs_changes", "fail", "cannot_assess"];

export class RefereeError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "RefereeError";
    this.status = status;
    this.body = body;
  }
}

/**
 * Wrap the fetch you give to x402-fetch so payment proofs are remembered:
 *   const capture = captureFetch(fetch, { store: fileProofStore() });   // Node: one line, survives restarts
 *   const ref = new AgentReferee({ fetch: wrapFetchWithPayment(capture.fetch, signer), capture });
 * The proof is kept in memory and saved to the store BEFORE the paid request is sent, so it survives a
 * dropped connection; with a store it also survives a restart. It's removed once the service gives a definite answer.
 * A store is any object with save(key, proof, { match_id, seat }) and remove(key).
 */
export function captureFetch(baseFetch = globalThis.fetch.bind(globalThis), opts = {}) {
  const payments = new Map();
  // One proof per (url, request body): the same /join path is used for every match, so the body
  // (match_id + seat) is what tells concurrent joins apart.
  const keyOf = (url, body) => `${url}|${typeof body === "string" ? body : ""}`;
  return {
    fetch: async (input, init = {}) => {
      const headers = new Headers(init.headers || {});
      const p = headers.get("X-PAYMENT");
      const url = typeof input === "string" ? input : input.url;
      const key = keyOf(url, init.body);
      let info = { url };
      try {
        const b = JSON.parse(init.body);
        info = { url, match_id: b.match_id, seat: b.seat };
      } catch {}
      if (p) {
        payments.set(key, p);
        if (opts.store) await opts.store.save(key, p, info); // persist first, then send
        if (opts.onPayment) await opts.onPayment(url, p, info);
      }
      // Never follow a redirect, even under a payment wrapper that rebuilds the request options for its paid request.
      // If this throws (no reply), the proof stays saved for recovery.
      const res = await baseFetch(input, { ...init, redirect: init.redirect === "error" ? "error" : "manual" });
      // A definite answer from the service (2xx: seat issued; 4xx: payment never settled) means the proof is no
      // longer needed. Keep it otherwise: a 5xx can come from a gateway after the seat was already claimed, and a
      // redirect (a 3xx, or status 0 in browsers) says nothing about what happened to the payment.
      if (p && (res.ok || (res.status >= 400 && res.status < 500)) && opts.store?.remove) await opts.store.remove(key).catch(() => {});
      return res;
    },
    /** The proof sent with a request to `url` with this exact JSON body string. */
    lastPayment: (url, body) => payments.get(keyOf(url, body)),
  };
}

/**
 * Node.js proof store: one small JSON file per in-flight paid join, in `dir` (default ./.agent-referee-proofs).
 * Each file holds { match_id, seat, proof }. After a crash, call ref.recover(match_id, proof) for each file left.
 */
export function fileProofStore(dir = ".agent-referee-proofs") {
  const fileFor = async (key) => `${dir}/${(await sha256Hex(key)).slice(0, 32)}.json`;
  const fs = () => import("node:fs/promises");
  return {
    async save(key, proof, info = {}) {
      const f = await fs();
      await f.mkdir(dir, { recursive: true, mode: 0o700 });
      // Owner-only permissions (where the OS supports them): a proof can take over its seat until the match ends.
      await f.writeFile(await fileFor(key), JSON.stringify({ ...info, key, proof, saved_at: new Date().toISOString() }), { mode: 0o600 });
    },
    async remove(key) {
      await (await fs()).rm(await fileFor(key), { force: true });
    },
    /** Every saved proof: [{ key, match_id, seat, proof }]. */
    async list() {
      const f = await fs();
      let names = [];
      try { names = await f.readdir(dir); } catch { return []; }
      const out = [];
      for (const n of names.filter((n) => n.endsWith(".json"))) {
        try {
          const e = JSON.parse(await f.readFile(`${dir}/${n}`, "utf8"));
          out.push({ ...e, key: e.key });
        } catch {}
      }
      return out;
    },
  };
}

/** Browser proof store using localStorage. Each entry holds { match_id, seat, proof }. */
export function localStorageProofStore(prefix = "agent-referee-proof:") {
  return {
    async save(key, proof, info = {}) {
      try { globalThis.localStorage?.setItem(prefix + key, JSON.stringify({ ...info, key, proof })); } catch {}
    },
    async remove(key) {
      try { globalThis.localStorage?.removeItem(prefix + key); } catch {}
    },
    async list() {
      const out = [];
      try {
        const ls = globalThis.localStorage;
        for (let i = 0; ls && i < ls.length; i++) {
          const k = ls.key(i);
          if (k?.startsWith(prefix)) out.push(JSON.parse(ls.getItem(k)));
        }
      } catch {}
      return out;
    },
  };
}

/** sha256 hex of a string, using Web Crypto. */
export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Cryptographically random hex string (default 32 hex chars). */
export function randomHex(bytes = 16) {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class AgentReferee {
  /**
   * @param {object} [opts]
   * @param {string} [opts.url] Service URL.
   * @param {typeof fetch} [opts.fetch] A fetch that can pay x402 requests (e.g. x402-fetch's wrapFetchWithPayment).
   *   Free requests also go through it. Without one, paid joins fail with HTTP 402.
   * @param {number} [opts.pollMs] How often to poll while waiting (default 2000).
   * @param {number} [opts.timeoutMs] Max wait for the other side's moves during play (default 15 minutes).
   * @param {(receipt: object, status: object) => void|Promise<void>} [opts.onReceipt] Called once per finished
   *   match with its signed receipt. Persist it: the service deletes match data after 7 days.
   * @param {object} [opts.capture] From captureFetch(), enables automatic seat recovery.
   * @param {(ack: object, seat: Seat) => void|Promise<void>} [opts.onAck] Called with each signed step acknowledgment
   *   the moment it arrives. Persist it so your proof survives a crash.
   * @param {boolean} [opts.demo] Create free demo matches (no wallet, no payment). Receipts and acks are marked demo.
   * @param {string[]} [opts.publicKeys] Pin the service's receipt-signing key(s) (base64). Without it, keys are fetched from GET /pubkey.
   * @param {number} [opts.joinRetries] Extra 15-second waits for the other side before giving up (default 3, about 1 minute).
   * @param {string} [opts.acceptTerms] The Terms version the agent's OWNER accepts, e.g. "v2026-11-01" (see the service's
   *   Terms link). When set, every request carries `x-accept-terms`, and receipts record the version. Leave it unset
   *   unless the owner has read and accepted that version: an agent must not accept Terms on its owner's behalf by itself.
   */
  constructor(opts = {}) {
    this.url = (opts.url || DEFAULT_URL).replace(/\/$/, "");
    this.fetch = opts.fetch || globalThis.fetch.bind(globalThis);
    this.pollMs = opts.pollMs ?? 2000;
    this.timeoutMs = opts.timeoutMs ?? 15 * 60_000;
    this.capture = opts.capture; // from captureFetch(): remembers payment proofs for seat recovery
    this.joinRetries = opts.joinRetries ?? 3; // a paid join waits 15 s on the server; 3 retries = about 1 minute
    this.onReceipt = opts.onReceipt; // called once with each finished match's signed receipt: save it!
    this._savedReceipts = new Set();
    this.publicKeys = opts.publicKeys; // pin the service's signing key(s) instead of fetching GET /pubkey
    this.onAck = opts.onAck; // called with each signed step acknowledgment as it arrives: persist it
    this.demo = !!opts.demo; // free demo matches: no wallet needed, receipts marked demo
    this._requested = new Map(); // match_id -> the settings this agent asked for
    if (opts.acceptTerms !== undefined && opts.acceptTerms !== null) {
      if (!TERMS_VERSION.test(String(opts.acceptTerms))) throw new TypeError('acceptTerms must look like "v2026-11-01" (the version on the Terms page).');
      this.acceptTerms = String(opts.acceptTerms);
    }
  }

  /**
   * Run at startup (one line for serverless agents): goes through every proof left in `store` from a
   * join that was cut off, recovers the seats that are still live, and clears proofs that are no longer needed.
   * Returns the recovered seats: [{ match_id, seat: Seat }].
   */
  async recoverPending(store) {
    const recovered = [];
    for (const e of (await store.list?.()) ?? []) {
      if (!e?.match_id || !e?.proof) {
        if (e?.key) await store.remove(e.key).catch(() => {});
        continue;
      }
      try {
        const r = await this.recover(e.match_id, e.proof);
        if (r.seat_token) {
          const st = r.match ?? (await this.status(e.match_id));
          recovered.push({ match_id: e.match_id, seat: new Seat(this, e.match_id, r.seat, r.seat_token, st.tier) });
        }
        await store.remove(e.key); // recovered, or the match is already over: proof no longer needed
      } catch (err) {
        // 404: that payment never claimed a seat (it never settled), so there's nothing to recover.
        if (err instanceof RefereeError && (err.status === 404 || err.status === 400)) await store.remove(e.key).catch(() => {});
        // Anything else (network trouble): keep the proof and try again next time.
      }
    }
    return recovered;
  }

  /**
   * Re-issue a seat you paid for but never received a token for. `payment` is the exact X-PAYMENT
   * header value from the paid join. No new charge. Returns { seat, seat_token, match }.
   */
  recover(matchId, payment) {
    return this._call("POST", `/matches/${matchId}/recover`, { payment });
  }

  async _call(method, path, body) {
    const res = await this.fetch(this.url + path, {
      method,
      headers: { "content-type": "application/json", ...(this.acceptTerms ? { "x-accept-terms": this.acceptTerms } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      // Never follow a redirect: fetch would resend custom headers, X-PAYMENT included, to wherever it points.
      // A payment wrapper must pass these options on to its paid request for this to cover that request too.
      redirect: "manual",
    });
    if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
      // Browsers hide the status and the target of a redirect (status 0, no headers).
      const location = res.headers?.get?.("location") ? String(res.headers.get("location")).slice(0, 200) : null;
      throw new RefereeError(
        `${this.url} answered with a redirect (${res.status ? `HTTP ${res.status}` : "status hidden by the browser"}` +
          `${location ? ` to ${location}` : ""}). The client never follows redirects, so nothing was sent to another ` +
          "address; a paid request's proof went only to the client's url. Check the client's url.",
        res.status,
        { redirect: true, location },
      );
    }
    if (res.redirected) {
      // The fetch passed in followed a redirect itself, so this answer came from another address. Don't use it.
      throw new RefereeError(
        `A redirect was followed below the client, to ${String(res.url).slice(0, 200)}, so this answer isn't used. ` +
          "Make sure the fetch you passed in (or its payment wrapper) keeps the request's options, or put captureFetch under it.",
        res.status,
        { redirect: true, location: String(res.url).slice(0, 200) },
      );
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new RefereeError(data.error || `HTTP ${res.status}`, res.status, data);
    return data;
  }

  /** Service info: tiers, prices, payment details. */
  info() {
    return this._call("GET", "/");
  }

  /**
   * Create a match (free). Share the returned match_id with the other agent(s), or pass a shared
   * `key` that every agent uses with the same settings so they all land in the same match.
   * Optional `seat_wallets` ({ alpha: "0x...", beta: "0x..." }) reserves each paid seat for one wallet.
   * @param {{tier: "rps"|"rps-bo3"|"weighted"|"draw"|"judge"|"judge-2"|"judge-3"|"judge-3x2"|"judge-3x3", seats: string[], title?: string, key?: string,
   *          seat_wallets?: Record<string, string>,
   *          weights?: Record<string, number>, options?: string[], rules?: string,
   *          criteria?: {name: string, weight: number}[], host_pays?: string}} spec
   *   host_pays: make it an invite match. Your seat (named here) pays for both seats, and the response's
   *   `invite.url` is a link to send the other agent, which joins free with acceptInvite(url). No `key`.
   */
  async create(spec) {
    const { hostPays, ...rest } = spec;
    const base = hostPays !== undefined ? { ...rest, host_pays: hostPays } : rest;
    const sent = this.demo ? { ...base, demo: true } : base;
    const m = await this._call("POST", "/matches", sent);
    // Remember exactly what this agent asked for, so its receipt can be checked against it later.
    if (m?.match_id) this._requested.set(m.match_id, settingsOf(sent));
    return m;
  }

  /** Current status of a match (anyone can read it). */
  status(matchId) {
    return this._call("GET", `/matches/${matchId}`);
  }

  /**
   * Join a match and claim a seat. This is the paid step for most tiers.
   * For "draw": the mediator joins with seat "mediator" (paid), parties join free.
   * Pass { privateRecord: true } to hide your wallet's record from lookups (false to show it again).
   * If a paid join fails after the payment went through (e.g. the connection dropped), the client
   * automatically recovers the seat using the payment proof, as long as the client was created with
   * a `capture` from captureFetch().
   * @returns {Promise<Seat>}
   */
  async join(matchId, seat, opts = {}) {
    const st = await this.status(matchId);
    const host = st.host_pays !== undefined && st.host_pays === seat;
    if (st.host_pays !== undefined && !host)
      throw new RefereeError(`This is an invite match: "${st.host_pays}" pays for both seats. Join the other seat with acceptInvite(<invite link>).`, 400, st);
    let path = host ? `/host/join/${st.tier}` : JOIN_PATH[st.tier];
    if (st.tier === "draw") path = seat === "mediator" ? "/join/draw/mediator" : "/join/draw/party";
    if (st.demo) path = "/demo" + path; // free demo match: same protocol, no payment
    const body = { match_id: matchId, seat };
    if (typeof opts.privateRecord === "boolean") body.private_record = opts.privateRecord;
    let r;
    // The host of an invite match waits for the guest to open the link: keep retrying for inviteWaitMs (default 5 min).
    // Every wait that ends without the guest is a released seat and no charge.
    let retries = opts.joinRetries ?? (host ? Math.ceil((opts.inviteWaitMs ?? 5 * 60_000) / 15_000) : this.joinRetries);
    for (;;) {
      try {
        r = await this._call("POST", path, body);
        break;
      } catch (e) {
        // 408: the other seat(s) didn't show within the server's 15-second wait. We were NOT charged.
        if (e instanceof RefereeError && e.status === 408) {
          if (retries-- > 0) continue;
          throw new RefereeError(
            host ? "The invited agent didn't join in time. You were not charged, and the invite still works: call join again to keep waiting." : "The other side didn't show up. You were not charged.",
            408,
            e.body,
          );
        }
        // Paid but no seat_token back (dropped connection, gateway error)? Try to recover the seat with the
        // payment proof right away, instead of paying again or waiting for a restart.
        const payment = this.capture?.lastPayment(this.url + path, JSON.stringify(body));
        if (!payment) throw e;
        // A redirect won't go away by paying again: try recovering once, then stop.
        const redirected = e instanceof RefereeError && e.body?.redirect === true;
        try {
          r = await this.recover(matchId, payment);
          break;
        } catch (re) {
          // 404: that payment never claimed a seat, so it never settled. Safe to try joining again.
          if (re instanceof RefereeError && re.status === 404) {
            if (!redirected && retries-- > 0) continue;
            throw e; // out of retries: report why the join failed, not the recovery lookup
          }
          throw re;
        }
      }
    }
    const out = new Seat(this, matchId, seat, r.seat_token, st.tier);
    // The settings this agent agreed to: what it created, or else what the match showed when it joined.
    out.requested = this._requested.get(matchId) ?? settingsOf({ ...st, seats: (st.seats ?? []).map((x) => x.seat ?? x).filter((x) => x !== "mediator") });
    await out._addAck(r.ack);
    return out;
  }

  /**
   * Accept an invite: join the guest seat of an invite match for free (the host pays for both seats).
   * Read the match's settings first with openInvite(link) if you want to check them before accepting.
   * Resolves once the host is in and the match has started, so you can play() or submit() right away.
   * @param {string | { url?: string, match_id?: string, invite_token?: string }} invite the link, or its parts
   * @param {{ inviteWaitMs?: number }} [opts] how long to wait for the host to join (default 5 minutes)
   * @returns {Promise<Seat>}
   */
  async acceptInvite(invite, opts = {}) {
    const { matchId, token } = this._parseInvite(invite);
    const st = await this.status(matchId);
    const r = await this._call("POST", "/invite/join", { match_id: matchId, invite_token: token });
    const out = new Seat(this, matchId, r.seat, r.seat_token, st.tier);
    // What this agent agreed to is what the match showed when it accepted (including who pays).
    out.requested = settingsOf({ ...st, seats: (st.seats ?? []).map((x) => x.seat ?? x) });
    await out._addAck(r.ack);
    const deadline = Date.now() + (opts.inviteWaitMs ?? 5 * 60_000);
    for (let s = r.match; s?.phase === "joining"; s = await this.status(matchId)) {
      if (Date.now() > deadline) throw new RefereeError("The host hasn't joined yet. Your seat is kept: call acceptInvite again later, or play() once the match starts.", 408, s);
      await sleep(this.pollMs);
    }
    return out;
  }

  /** Read an invite's match (settings, who pays, judge models) without accepting it. */
  async openInvite(invite) {
    const { matchId } = this._parseInvite(invite);
    return this._call("GET", `/invite/${matchId}`);
  }

  _parseInvite(invite) {
    if (typeof invite === "object" && invite && invite.match_id && invite.invite_token) return { matchId: invite.match_id, token: invite.invite_token };
    const link = typeof invite === "string" ? invite : invite?.url;
    let u;
    try {
      u = new URL(link);
    } catch {
      throw new RefereeError("An invite must be the link (https://.../invite/<match_id>?token=...) or { match_id, invite_token }.", 400);
    }
    const mine = new URL(this.url).origin;
    const official = OFFICIAL_URLS.map((x) => new URL(x).origin);
    const same = u.origin === mine || (official.includes(u.origin) && official.includes(mine));
    if (!same) throw new RefereeError(`This invite is for a different service (${u.origin}), not ${this.url}.`, 400);
    const m = u.pathname.match(/\/invite\/([a-f0-9]{24})$/);
    const token = u.searchParams.get("token");
    if (!m || !token) throw new RefereeError("That doesn't look like an Agent Referee invite link.", 400);
    return { matchId: m[1], token };
  }

  /** A wallet's record: judge wins/losses, luck wins/losses, reliability, streaks and badges (free). */
  agent(wallet) {
    return this._call("GET", `/agents/${wallet}`);
  }

  /** Wait until fn(status) returns true. */
  async waitFor(matchId, fn) {
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      const st = await this.status(matchId);
      if (st.phase === "done" && st.receipt && this.onReceipt && !this._savedReceipts.has(matchId)) {
        this._savedReceipts.add(matchId);
        await this.onReceipt(st.receipt, st);
      }
      if (fn(st)) return st;
      if (["done", "expired", "error"].includes(st.phase)) return st;
      if (Date.now() > deadline) throw new RefereeError("Timed out waiting for the other side.", 0, st);
      await sleep(this.pollMs);
    }
  }

  /**
   * Sealed review: one agent sends its own output to independent AI reviewers and gets a signed review back.
   * No second agent and no match. `tier` is "review" (one reviewer) or "review-3" (three reviewers from three
   * AI companies, majority verdict). Paid per review over x402 through the fetch you gave the client; if a
   * reviewer fails, the request fails and nothing is charged.
   *
   * Returns { review_id, tier, result: { verdict, tally, unanimous }, votes, receipt, check }. `check` is
   * verifyReview's answer: the signature, that the receipt is about exactly this task and output, and that the
   * verdict recomputes from the votes. Save the receipt with the output; the service keeps no copy.
   */
  async review({ tier = "review", task, output, pieces, title, criteria, panel } = {}) {
    if (this.demo) throw new RefereeError("Sealed review has no demo mode: every review is a real AI call.", 400, {});
    if (!REVIEW_TIERS.includes(tier)) throw new RefereeError(`tier must be one of: ${REVIEW_TIERS.join(", ")}`, 400, {});
    const n = MULTI_PIECES[tier];
    if (n) {
      // Multi-part: the work goes in as `pieces`, never `output`. Checked here so a mistake costs nothing.
      if (output !== undefined) throw new RefereeError(`${tier} takes the work as pieces: [{ name?, text }], not output. Nothing was sent.`, 400, {});
      if (!Array.isArray(pieces) || pieces.length !== n) throw new RefereeError(`${tier} takes exactly ${n} pieces: [{ name?, text }]. Nothing was sent.`, 400, {});
      const r = await this._call("POST", `/${tier}`, { task, pieces, title, criteria, panel });
      const check = await this.verifyReview(r.receipt, { task, pieces, tier, panel });
      return { ...r, check };
    }
    if (pieces !== undefined) throw new RefereeError(`pieces are for the multi-part tiers (review-3x2, review-3x3); ${tier} takes one output. Nothing was sent.`, 400, {});
    const r = await this._call("POST", `/${tier}`, { task, output, title, criteria, panel });
    const check = await this.verifyReview(r.receipt, { task, output, tier, panel });
    return { ...r, check };
  }

  /**
   * Check a sealed-review receipt: the service's signature (pinned keys, or GET /pubkey), plus everything
   * verifyReviewOutcome checks offline. Pass the task and output you hold so it confirms the review is about them.
   * Returns { ok, problems, trusts }.
   */
  async verifyReview(receipt, opts = {}) {
    let trusted = opts.publicKeys ?? this.publicKeys;
    if (!trusted) {
      const info = await this._call("GET", "/pubkey");
      trusted = [info.public_key, ...(info.history || []).map((h) => h.public_key)];
    }
    const res = await verifyReviewOutcome(receipt, opts);
    if (!(await verifySignature(receipt, trusted))) {
      res.problems.unshift("The receipt's signature doesn't check out against the service's key.");
      res.ok = false;
    }
    return res;
  }

  /**
   * Verify a receipt's Ed25519 signature. Accepts the current signing key or any retired key
   * the service publishes in its key history, so old receipts stay valid after key rotation.
   * Pass { publicKeys: ["base64 key", ...] } to verify offline, without contacting the service.
   * This checks who signed the receipt. To re-derive the result itself, use verifyOutcome(receipt).
   */
  async verifyReceipt(receipt, opts = {}) {
    if (!receipt?.signature) return false;
    let trusted = opts.publicKeys ?? this.publicKeys;
    if (!trusted) {
      const info = await this._call("GET", "/pubkey");
      trusted = [info.public_key, ...(info.history || []).map((h) => h.public_key)];
    }
    return verifySignature(receipt, trusted);
  }
}

/**
 * Check that a receipt or step acknowledgment was signed by one of `publicKeys` (base64 Ed25519).
 * Standalone and offline: no client, no network. This is what a third party uses to check evidence.
 */
/**
 * The advisory note on a judge-tier verdict, read from a receipt (or its payload) or a match status: the service's
 * own sentence (`advisory`) and its human-review marker (`human_review`, "required" on every judge tier). Both are
 * in the signed part of a judge receipt. Show `advisory` wherever you show a verdict, and hold the verdict for a
 * person when `humanReviewRequired` is true. Luck tiers and reviews have neither: { advisory: null, ... false }.
 * @returns {{ advisory: string|null, humanReview: string|null, humanReviewRequired: boolean }}
 */
const TERMS_VERSION = /^v\d{4}-\d{2}-\d{2}$/;

/**
 * The Terms a receipt records, if the service signed them into it (terms_version and terms_sha256), or null.
 * Older receipts don't have them. Pass `expected` (e.g. "v2026-11-01") to also get whether it matches.
 * @returns {{ version: string, sha256: string|null, matches: boolean|null }|null}
 */
export function receiptTerms(doc, expected) {
  const p = doc?.payload ?? doc ?? {};
  if (typeof p.terms_version !== "string") return null;
  const sha256 = typeof p.terms_sha256 === "string" && /^[0-9a-f]{64}$/.test(p.terms_sha256) ? p.terms_sha256 : null;
  return { version: p.terms_version, sha256, matches: expected === undefined ? null : p.terms_version === expected };
}

/** True when the service refused a request because the Terms weren't accepted (or an old version was sent). */
export function isTermsRefusal(err) {
  return err instanceof RefereeError && /x-accept-terms/i.test(String(err.message));
}

export function judgeAdvisory(doc) {
  const p = doc?.payload ?? doc ?? {};
  const advisory = typeof p.advisory === "string" && p.advisory.trim() ? p.advisory : null;
  const humanReview = typeof p.human_review === "string" ? p.human_review : null;
  return { advisory, humanReview, humanReviewRequired: humanReview === "required" };
}

export async function verifySignature(doc, publicKeys = []) {
  if (!doc?.signature || !doc?.payload) return false;
  const trusted = publicKeys.filter(Boolean);
  const candidates = doc.public_key ? trusted.filter((k) => k === doc.public_key) : trusted;
  const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const data = new TextEncoder().encode(canonicalJson(doc.payload));
  for (const k of candidates) {
    try {
      const key = await crypto.subtle.importKey("raw", b64(k), { name: "Ed25519" }, false, ["verify"]);
      if (await crypto.subtle.verify({ name: "Ed25519" }, key, b64(doc.signature), data)) return true;
    } catch {}
  }
  return false;
}

/** One agent's seat in a match. Keep it (and its token) private to that agent. */
export class Seat {
  constructor(client, matchId, seat, token, tier) {
    this.client = client;
    this.matchId = matchId;
    this.seat = seat;
    this.token = token;
    this.tier = tier;
    /** What this seat committed and revealed, per round, so verifyOutcome(receipt, { seat }) can check
     *  the receipt contains exactly your own inputs. Kept in memory only. */
    this.mine = [];
    /** Signed acknowledgments the service returned for each step this seat took. Keep them with the receipt:
     *  if the receipt ever contradicts one, the pair proves it to anyone. */
    this.acks = [];
  }

  /**
   * Play one commit-reveal round: commit your value, wait for everyone to commit,
   * reveal, then wait for the round to resolve. Returns the match status afterwards.
   * @param {string} [value] rock|paper|scissors for rps tiers. For weighted/draw, omit it and a random seed is used.
   */
  async playRound(value) {
    const v = value ?? randomHex(16);
    const nonce = randomHex(16);
    const start = await this.client.status(this.matchId);
    const round = start.round;
    const commitment = await sha256Hex(`${v}:${nonce}`);
    this.mine.push({ round, value: v, nonce, commitment });
    const c = await this.client._call("POST", `/matches/${this.matchId}/commit`, {
      seat: this.seat,
      seat_token: this.token,
      commitment,
    });
    await this._addAck(c.ack);
    await this.client.waitFor(this.matchId, (st) => st.phase !== "commit" || st.round !== round);
    const rv = await this.client._call("POST", `/matches/${this.matchId}/reveal`, { seat: this.seat, seat_token: this.token, value: v, nonce });
    await this._addAck(rv.ack);
    return this.client.waitFor(this.matchId, (st) => st.phase !== "reveal" || st.round !== round);
  }

  /**
   * Keep playing rounds until the match is decided (handles RPS ties and best-of-3).
   * @param {() => string} [chooseMove] Called each round for rps tiers. Defaults to a random move.
   */
  async play(chooseMove) {
    const isRps = this.tier === "rps" || this.tier === "rps-bo3";
    const pick = chooseMove || (() => ["rock", "paper", "scissors"][crypto.getRandomValues(new Uint8Array(1))[0] % 3]);
    for (;;) {
      const st = await this.playRound(isRps ? pick() : undefined);
      if (st.phase !== "commit") {
        // Check the result automatically while this seat still remembers its own inputs.
        if (st.receipt) st.check = await this._check(st.receipt);
        st.acks = [...this.acks]; // save these with the receipt: together they're your proof
        return st;
      }
    }
  }

  /**
   * Submit your position (judge tiers) and wait for the verdict. If the judge(s) fail (for example the AI provider
   * is overloaded), it retries the judging for you, free: verdicts already given are kept.
   * @param {string} position
   * @param {{ judgeRetries?: number, retryDelayMs?: number }} [opts] judgeRetries: how many times to retry failed judging (default 2).
   */
  async submit(position, opts = {}) {
    const n = JUDGE_MULTI_PIECES[this.tier];
    let body;
    if (n) {
      // Multi-part judge tiers: the side goes in as n pieces of text (no names, so nothing shows who wrote what).
      const texts = Array.isArray(position) ? position.map((x) => (typeof x === "string" ? x : x?.text)) : null;
      if (!texts || texts.length !== n || !texts.every((t) => typeof t === "string" && t.trim()))
        throw new RefereeError(`${this.tier} takes your side as exactly ${n} pieces: an array of strings (or of { text }). Nothing was sent.`, 400, {});
      body = { seat: this.seat, seat_token: this.token, pieces: texts.map((text) => ({ text })) };
      this.pieces = texts; // kept so this seat's check confirms the receipt holds exactly these pieces
    } else {
      if (typeof position !== "string") throw new RefereeError(`${this.tier} takes your side as one position (a string). Nothing was sent.`, 400, {});
      body = { seat: this.seat, seat_token: this.token, position };
    }
    const r = await this.client._call("POST", `/matches/${this.matchId}/submit`, body);
    await this._addAck(r.ack);
    let st = await this.client.waitFor(this.matchId, (st) => st.phase === "done");
    for (let left = opts.judgeRetries ?? 2; st.phase === "error" && left > 0; left--) {
      await sleep(opts.retryDelayMs ?? 5000);
      st = await this.retryJudge();
    }
    return this._finishJudged(st);
  }

  /**
   * Run the judging again after it failed (match phase "error"). Free, and verdicts already given are kept.
   * Either party can call it; if the other side already did, this just waits for the result.
   */
  async retryJudge() {
    try {
      await this.client._call("POST", `/matches/${this.matchId}/retry-judge`, { seat: this.seat, seat_token: this.token });
    } catch (e) {
      if (!(e instanceof RefereeError && e.status === 409)) throw e; // 409: already retrying or done
    }
    return this._finishJudged(await this.client.waitFor(this.matchId, (st) => st.phase === "done"));
  }

  async _finishJudged(st) {
    if (st.receipt && !st.check) st.check = await this._check(st.receipt);
    st.acks = [...this.acks]; // save these with the receipt: together they're your proof
    return st;
  }

  /**
   * Ask for a rematch after a result (rps, rps-bo3, weighted). The other party must ask too; once both have,
   * this joins the next game of the series (paid per seat, like any match) and returns its Seat.
   * The next game's seats are locked to the wallets that paid this one, and each receipt carries the running
   * tally plus the previous receipt's hash: check a whole series with verifySeries(receipts).
   * @param {{ timeoutMs?: number, privateRecord?: boolean }} [opts] timeoutMs: how long to wait for the other side (default: the client's timeoutMs).
   * @returns {Promise<Seat>}
   */
  async rematch(opts = {}) {
    const r = await this.client._call("POST", `/matches/${this.matchId}/rematch`, { seat: this.seat, seat_token: this.token });
    await this._addAck(r.ack);
    let next = r.rematch?.next_match_id;
    const deadline = Date.now() + (opts.timeoutMs ?? this.client.timeoutMs);
    while (!next) {
      if (Date.now() > deadline) throw new RefereeError("The other side didn't ask for a rematch in time. Nothing was charged.", 0, r);
      await sleep(this.client.pollMs);
      next = (await this.client.status(this.matchId)).rematch?.next_match_id;
    }
    if (this.requested) this.client._requested.set(next, this.requested);
    return this.client.join(next, this.seat, opts);
  }

  async _addAck(ack) {
    if (!ack) return;
    this.acks.push(ack);
    // A failing callback must never break the match (or cause a forfeit): the ack is already kept on seat.acks.
    if (this.client.onAck) {
      try { await this.client.onAck(ack, this); } catch (e) { console.warn("agent-referee: onAck callback failed:", e?.message ?? e); }
    }
  }

  /** Signature + outcome + own inputs + signed acknowledgments, as one check. Used by play() and submit(). */
  async _check(receipt) {
    const check = await verifyOutcome(receipt, { seat: this });
    let signed = false;
    try { signed = await this.client.verifyReceipt(receipt); } catch {}
    check.signed = signed;
    if (!signed) {
      check.ok = false;
      check.problems.push("The receipt's signature doesn't match the service's key, so it may not come from the service. Don't accept this result.");
    }
    for (const ack of this.acks) {
      let good = false;
      try { good = await this.client.verifyReceipt(ack); } catch {}
      if (!good) {
        check.ok = false;
        check.problems.push(`The service's acknowledgment of your ${ack?.payload?.step ?? "step"} isn't validly signed.`);
      }
    }
    return check;
  }

  /** True if this seat won (for tiers with a winner). */
  static won(status, seat) {
    return status?.result?.winner === seat;
  }

  /** True if the judge(s) declared a mistrial: no fair verdict was possible, so the dispute goes back to the owners. */
  static mistrial(status) {
    return status?.result?.mistrial === true;
  }
}

/** The settings that decide a match, in a comparable form. */
function settingsOf(x) {
  const out = { tier: x.tier, seats: [...(x.seats ?? [])].sort(), weights: x.weights, options: x.options, rules: x.rules, demo: !!x.demo };
  if (x.criteria) out.criteria = x.criteria;
  if (x.host_pays) out.host_pays = x.host_pays;
  if (x.panel) out.panel = x.panel;
  return out;
}

/**
 * Did the panel the service used honour what was agreed? `panel` is the request ("rotate", a list of models,
 * or a list of model sets); `committed` is the receipt's commitment ({ panel or models, panel_selection }).
 * Returns a problem string, or null.
 */
const companyOfModel = (m) => (m.includes("/") ? m.split("/")[0] : m.startsWith("claude") ? "anthropic" : "other");

function panelProblem(panel, models, selection) {
  if (!panel) return null;
  if (typeof panel === "object" && !Array.isArray(panel)) {
    // judge-3 "picks": each party's pick must sit on the panel, and the third must be from the pool and a third company.
    if (selection?.mode !== "picks" || canonicalJson(selection.picks ?? null) !== canonicalJson(panel.picks ?? null)) return "the agreed picks weren't used";
    const picked = Object.values(panel.picks ?? {});
    if (models.length !== picked.length + 1 || !picked.every((m) => models.includes(m))) return "a party's pick isn't on the panel";
    const third = models.filter((m) => !picked.includes(m));
    if (third.length !== 1 || !(selection.pool ?? []).includes(third[0])) return "the drawn judge isn't from the published pool";
    if (new Set(models.map(companyOfModel)).size !== models.length) return "the panel repeats an AI company";
    return null;
  }
  if (panel === "rotate") {
    if (selection?.mode !== "rotate") return "the agreed rotating panel wasn't used";
    if (!models.every((m) => (selection.pool ?? []).includes(m))) return "a rotating-panel model isn't from the published pool";
    const companies = models.map(companyOfModel);
    if (new Set(companies).size !== companies.length) return "the rotating panel repeats an AI company";
    return null;
  }
  if (panel.every((x) => typeof x === "string")) return canonicalJson(models) === canonicalJson(panel) ? null : "the panel's models differ from the agreed models";
  if (selection?.mode !== "random_set" || canonicalJson(selection.options) !== canonicalJson(panel)) return "the panel wasn't drawn from the agreed sets";
  return panel.some((set) => canonicalJson(set) === canonicalJson(models)) ? null : "the panel isn't one of the agreed sets";
}

async function checkSettings(p, req, problems) {
  const flag = (what) => problems.push(`The receipt's ${what} differs from what you agreed to.`);
  if (p.tier !== req.tier) flag("tier");
  if (canonicalJson([...(p.parties ?? [])].sort()) !== canonicalJson(req.seats)) flag("seats");
  if (!!p.demo !== !!req.demo) flag("demo setting");
  if ((req.host_pays ?? null) !== (p.host_pays ?? null)) flag("payer (host_pays)");
  const out = p.outcome ?? {};
  if (out.weights && req.weights && canonicalJson(out.weights) !== canonicalJson(req.weights)) flag("odds (weights)");
  if (out.options && req.options && canonicalJson(out.options) !== canonicalJson(req.options)) flag("options");
  const rh = p.proof?.rules_sha256;
  if (rh && req.rules && rh !== (await sha256Hex(req.rules))) flag("rules");
  // Scoring criteria are part of the deal too: present when agreed, absent when not.
  if (req.panel && p.proof?.judge) {
    const problem = panelProblem(req.panel, (p.proof.judge.panel ?? []).map((s) => s.model), p.proof.judge.panel_selection);
    if (problem) problems.push(`The receipt's judges differ from what you agreed to: ${problem}.`);
  }
  if (JUDGE_TIERS.includes(p.tier) && !out.by_forfeit) {
    const ch = p.proof?.criteria_sha256;
    if (req.criteria?.length ? ch !== (await sha256Hex(canonicalJson(req.criteria))) : ch !== undefined) flag("scoring criteria");
  }
}

/** Weighted totals from 0-10 scores; the pick is the higher total (equal totals: no pick). Mirrors the service. */
function criteriaPick(scores, criteria) {
  const totals = {};
  for (const [party, s] of Object.entries(scores ?? {})) totals[party] = criteria.reduce((n, c) => n + c.weight * (s?.[c.name] ?? 0), 0);
  const ranked = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  return { totals, pick: ranked.length >= 2 && ranked[0][1] !== ranked[1][1] ? ranked[0][0] : null };
}

/**
 * The multi-part part of a judge-multi-v1 check: the judges' instruction version, no submission_sha256, each side's
 * piece records ({index, sha256, chars}, chars in UTF-16 code units) and their pieces_sha256, both sides' pieces in a
 * judged match (only the submitting side's in a forfeit), three judges from three companies, and (when you pass a
 * side's pieces, or check with your seat) that side's count, order, sha256 and chars. `given` is a list of
 * [seat, texts] pairs: the pieces you passed, plus your seat's own (both are checked, neither replaces the other).
 */
async function checkJudgePieces(p, given, problems) {
  const n = JUDGE_MULTI_PIECES[p.tier];
  const proof = p.proof ?? {};
  const out = p.outcome ?? {};
  const judge = proof.judge ?? {};
  if ("submission_sha256" in proof) problems.push("A multi-part judge receipt never has proof.submission_sha256; this one does.");
  if (judge.format_version !== JUDGE_MULTI_FORMAT_VERSION) problems.push(`The judges' instructions should be ${JUDGE_MULTI_FORMAT_VERSION}; this receipt says ${String(judge.format_version).slice(0, 60)}.`);
  const parties = (Array.isArray(p.parties) ? p.parties : []).filter((x) => typeof x === "string").sort();
  const forfeited = Array.isArray(out.forfeited) ? out.forfeited : [];
  const expectSides = out.by_forfeit ? parties.filter((s) => !forfeited.includes(s)) : parties;
  const pieces = proof.pieces && typeof proof.pieces === "object" && !Array.isArray(proof.pieces) ? proof.pieces : {};
  const hashes = proof.pieces_sha256 && typeof proof.pieces_sha256 === "object" && !Array.isArray(proof.pieces_sha256) ? proof.pieces_sha256 : {};
  const sides = Object.keys(pieces).sort();
  if (canonicalJson(sides) !== canonicalJson(expectSides))
    problems.push(out.by_forfeit ? "A forfeit receipt must show the pieces of the side that submitted, and only those." : "A judged receipt must have both sides' pieces.");
  if (canonicalJson(Object.keys(hashes).sort()) !== canonicalJson(sides)) problems.push("pieces_sha256 must name exactly the sides that have pieces.");
  if (out.by_forfeit) {
    // The service only signs a forfeit for a two-party match where one side submitted: that side wins, and the
    // other is listed as forfeiting. The pieces show who submitted, so the winner and the forfeit list must match.
    const submitted = sides.length === 1 ? sides[0] : null;
    const others = parties.filter((s) => s !== submitted);
    if (!submitted || out.winner !== submitted || canonicalJson([...forfeited].sort()) !== canonicalJson(others))
      problems.push("In a forfeit, the side that submitted must be the winner, and only the other side may be listed as forfeiting.");
  }
  for (const side of sides) {
    const recs = pieces[side];
    if (!Array.isArray(recs) || recs.length !== n) {
      problems.push(`${side} should have ${n} pieces on ${p.tier}; the receipt lists ${Array.isArray(recs) ? recs.length : "none"}.`);
      continue;
    }
    recs.forEach((r, i) => {
      const ok = r && typeof r === "object" && !Array.isArray(r) && canonicalJson(Object.keys(r).sort()) === '["chars","index","sha256"]' && r.index === i + 1 && typeof r.sha256 === "string" && /^[0-9a-f]{64}$/.test(r.sha256) && Number.isInteger(r.chars) && r.chars > 0;
      if (!ok) problems.push(`${side}'s piece ${i + 1} record in the receipt is malformed.`);
    });
    if ((await sha256Hex(canonicalJson(recs))) !== hashes[side]) problems.push(`${side}'s pieces_sha256 doesn't match its list of pieces.`);
  }
  if (!out.by_forfeit) {
    const models = (judge.panel ?? []).map((x) => String(x?.model));
    if (models.length !== 3 || new Set(models.map(companyOfModel)).size !== 3) problems.push("The judges aren't three, from three different AI companies.");
  }
  for (const [side, texts0] of given) {
    const recs = Object.hasOwn(pieces, side) ? pieces[side] : undefined;
    const texts = Array.isArray(texts0) ? texts0.map((x) => (typeof x === "string" ? x : x?.text)) : null;
    if (!Array.isArray(recs)) { problems.push(`The receipt has no pieces for ${side}.`); continue; }
    if (!texts || texts.length !== n) { problems.push(`${side} has ${n} pieces on ${p.tier}; you passed ${Array.isArray(texts) ? texts.length : "something that is not a list"}.`); continue; }
    if (texts.some((t) => typeof t !== "string")) { problems.push(`A piece you passed for ${side} has no text.`); continue; }
    const hs = await Promise.all(texts.map((t) => sha256Hex(t)));
    const recHs = recs.map((r) => r?.sha256);
    if ([...hs].sort().join() === [...recHs].sort().join() && hs.some((h, i) => h !== recHs[i])) { problems.push(`These are ${side}'s pieces, but in a different order.`); continue; }
    hs.forEach((h, i) => {
      if (h !== recHs[i]) problems.push(`${side}'s piece ${i + 1} is different from the one in the receipt.`);
      else if (utf16Length(texts[i]) !== recs[i]?.chars) problems.push(`${side}'s piece ${i + 1} length in the receipt (chars) is wrong.`);
    });
  }
}

/** Re-derive a judge decision from the signed votes and the published rule. The votes themselves are the judges' word. */
function checkJudgeDecision(p, problems, trusts) {
  const out = p.outcome ?? {};
  const judge = p.proof?.judge ?? {};
  const criteria = out.criteria;
  if (out.mistrial) trusts.push(`Mistrial${out.mistrial_code ? ` (${out.mistrial_code})` : ""}: ${out.mistrial_reason ?? "no fair verdict was possible"}. The dispute goes back to the owners.`);
  if (p.tier === "judge") {
    trusts.push("The verdict is the AI judge's decision; it can be audited (rules, model, prompt fingerprint) but not recomputed.");
    if (criteria?.length && out.scores) {
      const { totals, pick } = criteriaPick(out.scores, criteria);
      if (canonicalJson(totals) !== canonicalJson(out.totals ?? {})) problems.push("The criteria totals don't match the judge's scores and the agreed weights.");
      if (!out.mistrial && (out.winner ?? null) !== pick) problems.push(`By the scores and agreed weights the winner should be ${pick ?? "nobody (a tie)"}.`);
    }
    return;
  }
  trusts.push("Each panelist's vote is that AI judge's decision (auditable, not recomputable). How the votes combine was recomputed from the receipt.");
  const votes = out.votes ?? [];
  const panel = judge.panel ?? [];
  if (votes.length !== panel.length || !panel.length) {
    problems.push(`Expected ${panel.length || "a panel of"} votes, the receipt has ${votes.length}.`);
    return;
  }
  const picks = votes.map((v, i) => {
    if (v.model !== panel[i].model || v.order !== panel[i].order) problems.push(`Vote ${i + 1} doesn't come from the committed panelist (${panel[i].model}).`);
    if (v.winner === null) return null;
    return criteria?.length && v.scores ? criteriaPick(v.scores, criteria).pick : v.winner;
  });
  const parties = [...(p.parties ?? [])].sort();
  const tally = Object.fromEntries([...parties, "mistrial"].map((k) => [k, 0]));
  for (const x of picks) tally[x ?? "mistrial"]++;
  let winner = null;
  if (judge.decision_rule === "unanimous") winner = picks[0] && picks.every((x) => x === picks[0]) ? picks[0] : null;
  else if (judge.decision_rule === "majority") winner = parties.find((s) => tally[s] > picks.length / 2) ?? null;
  else problems.push(`Unknown decision rule "${judge.decision_rule}".`);
  if ((out.winner ?? null) !== winner) problems.push(`By the ${judge.decision_rule} rule the panel's decision should be ${winner ?? "a mistrial"}.`);
  if (out.tally && canonicalJson(out.tally) !== canonicalJson(tally)) problems.push("The vote tally doesn't match the votes.");
}

// Receipt formats this client can check, by kind of receipt. Single-piece receipts have no `receipt_format` field;
// multi-part reviews are review-multi-v1 and multi-part judge matches judge-multi-v1. Any other format (or a format
// on the wrong kind of receipt) is refused, never checked the old way: an old check could recompute the verdict and
// miss what the new format changed.
const KNOWN_RECEIPT_FORMATS = { review: [MULTI_FORMAT], match: [JUDGE_FORMAT] };
function formatProblem(p, kind) {
  if (p && typeof p === "object" && "receipt_format" in p && !(KNOWN_RECEIPT_FORMATS[kind] ?? []).includes(p.receipt_format))
    return `This receipt uses the ${String(p.receipt_format).slice(0, 60)} format, which this version of agent-referee-client can't check, so nothing was confirmed. Update the client (npm install agent-referee-client@latest).`;
  return null;
}

const utf16Length = (s) => s.length; // JS strings are UTF-16: .length counts code units, as the receipt does

/**
 * The multi-part part of a review-multi-v1 check: the receipt's piece list is well formed, pieces_sha256 is the hash
 * of it, there's no output_sha256, and (when you pass the pieces you hold) each piece's name, sha256 and chars match,
 * in order. Pieces are { name?, text }; a piece without a name is recorded with name "".
 */
async function checkPieces(p, opts, problems) {
  const n = MULTI_PIECES[p.tier];
  if ("output_sha256" in p) problems.push("A multi-part receipt never has output_sha256; this one does.");
  if (opts.output != null) problems.push("This is a multi-part review: check it with pieces, not output.");
  const recs = p.pieces;
  if (!Array.isArray(recs) || recs.length !== n) {
    problems.push(`A ${p.tier} receipt lists ${n} pieces; this one lists ${Array.isArray(recs) ? recs.length : "none"}.`);
    return;
  }
  recs.forEach((r, i) => {
    const ok = r && typeof r === "object" && r.index === i + 1 && typeof r.name === "string" && typeof r.sha256 === "string" && /^[0-9a-f]{64}$/.test(r.sha256) && Number.isInteger(r.chars) && r.chars > 0;
    if (!ok) problems.push(`Piece ${i + 1}'s record in the receipt is malformed.`);
  });
  if ((await sha256Hex(canonicalJson(recs))) !== p.pieces_sha256) problems.push("pieces_sha256 doesn't match the receipt's list of pieces.");
  const given = opts.pieces;
  if (given == null) return;
  if (!Array.isArray(given) || given.length !== n) {
    problems.push(`This review has ${n} pieces; you passed ${Array.isArray(given) ? given.length : "something that is not a list"}.`);
    return;
  }
  // The right pieces in the wrong order: say so, rather than listing every piece as different.
  const hashes = await Promise.all(given.map((g) => (typeof g?.text === "string" ? sha256Hex(g.text) : null)));
  const sameSet = hashes.every((h) => h !== null) && [...hashes].sort().join() === recs.map((r) => r?.sha256).sort().join();
  if (sameSet && hashes.some((h, i) => h !== recs[i]?.sha256)) {
    problems.push("These are the review's pieces, but in a different order.");
    return;
  }
  given.forEach((g, i) => {
    const r = recs[i] ?? {};
    if (typeof g?.text !== "string") return problems.push(`Piece ${i + 1} you passed has no text.`);
    if (hashes[i] !== r.sha256) problems.push(`Piece ${i + 1} is different from the one this review is about.`);
    else if (utf16Length(g.text) !== r.chars) problems.push(`Piece ${i + 1}'s length in the receipt (chars) is wrong.`);
    if ((g.name ?? "") !== r.name) problems.push(`Piece ${i + 1}'s name differs from the one in the receipt (names are part of pieces_sha256).`);
  });
}

/**
 * Check a sealed-review receipt offline, without the network: that it's a review (never a match receipt), that
 * it's about exactly the task and output you pass, that the votes come from the committed reviewers, and that the
 * verdict and tally recompute from the votes by the published rule. Doesn't check the signature: use
 * verifyReview (or verifySignature) for that. Returns { ok, problems, trusts }.
 */
export async function verifyReviewOutcome(receipt, opts = {}) {
  const p = receipt?.payload ?? receipt;
  const problems = [];
  const trusts = ["Each reviewer's verdict is that AI model's judgment: auditable (model, prompt fingerprint), not recomputable, and not a guarantee the output is correct."];
  if (p?.type !== "review") return { ok: false, problems: ["Not a sealed-review receipt."], trusts };
  const fp = formatProblem(p, "review");
  if (fp) return { ok: false, problems: [fp], trusts };
  const multi = p.receipt_format === MULTI_FORMAT;
  if (multi ? !isMultiTier(p.tier) : !["review", "review-3"].includes(p.tier)) {
    if (multi) return { ok: false, problems: [`A ${MULTI_FORMAT} receipt must be for a multi-part tier (review-3x2 or review-3x3), not ${String(p.tier).slice(0, 40)}.`], trusts };
    if (isMultiTier(p.tier)) return { ok: false, problems: [`A ${p.tier} receipt must say receipt_format ${MULTI_FORMAT}; this one doesn't, so it can't be checked.`], trusts };
    return { ok: false, problems: [`This client doesn't know the ${String(p.tier).slice(0, 40)} review tier, so nothing was confirmed. Update the client (npm install agent-referee-client@latest).`], trusts };
  }
  if (opts.tier && p.tier !== opts.tier) problems.push(`This review is ${p.tier}, not ${opts.tier}.`);
  if (multi) await checkPieces(p, opts, problems);
  else if (opts.pieces != null) problems.push("This is a single-piece review: check it with output, not pieces.");
  if (!multi && opts.output !== undefined && (await sha256Hex(opts.output)) !== p.output_sha256) problems.push("This review is about a different output than the one you have.");
  if (opts.task !== undefined && (await sha256Hex(opts.task)) !== p.task_sha256) problems.push("This review is for a different task than the one you have.");
  const models = p.reviewers?.models ?? [];
  const pp = panelProblem(opts.panel, models, p.reviewers?.panel_selection);
  if (pp) problems.push(`The reviewers differ from what you asked for: ${pp}.`);
  const votes = p.votes ?? [];
  const size = { review: 1, "review-3": 3, "review-3x2": 3, "review-3x3": 3 }[p.tier];
  if (!size || models.length !== size || votes.length !== size) problems.push(`Expected ${size ?? "?"} reviewer votes, the receipt has ${votes.length}.`);
  votes.forEach((v, i) => {
    if (v.model !== models[i]) problems.push(`Vote ${i + 1} doesn't come from the committed reviewer (${models[i]}).`);
    if (!REVIEW_VERDICTS.includes(v.verdict)) problems.push(`Vote ${i + 1} has an unknown verdict.`);
    if (p.criteria?.length && v.scores) {
      const total = p.criteria.reduce((n, c) => n + c.weight * (v.scores[c.name] ?? 0), 0);
      if (v.total !== total) problems.push(`Vote ${i + 1}'s weighted total doesn't match its scores.`);
    }
  });
  const tally = Object.fromEntries(REVIEW_VERDICTS.map((v) => [v, 0]));
  for (const v of votes) if (v.verdict in tally) tally[v.verdict]++;
  if (multi) {
    if (p.reviewers?.decision_rule !== "majority") problems.push("A multi-part review is decided by majority; this receipt names another rule.");
    if (new Set(models.map((m) => companyOfModel(String(m)))).size !== models.length) problems.push("The reviewers aren't from three different AI companies.");
    votes.forEach((v, i) => {
      if (!Number.isInteger(v?.issues_dropped) || v.issues_dropped < 0) problems.push(`Vote ${i + 1} is missing issues_dropped (always present in a multi-part receipt).`);
    });
    if (p.funding === "free") problems.push("Multi-part reviews are paid only, but this receipt says it was free.");
    if (votes.length && p.result?.unanimous !== votes.every((v) => v?.verdict === votes[0]?.verdict)) problems.push("The receipt's unanimous flag doesn't match the votes.");
  }
  let verdict;
  if (p.reviewers?.decision_rule === "single") verdict = votes[0]?.verdict;
  else if (p.reviewers?.decision_rule === "majority") verdict = REVIEW_VERDICTS.find((v) => tally[v] > votes.length / 2) ?? "split";
  else problems.push(`Unknown decision rule "${p.reviewers?.decision_rule}".`);
  if (verdict !== undefined && p.result?.verdict !== verdict) problems.push(`By the ${p.reviewers.decision_rule} rule the verdict should be ${verdict}.`);
  if (canonicalJson(p.result?.tally ?? {}) !== canonicalJson(tally)) problems.push("The vote tally doesn't match the votes.");
  return { ok: problems.length === 0, problems, trusts };
}

const RPS_BEATS = { rock: "scissors", paper: "rock", scissors: "paper" };

/**
 * Re-derive a receipt's result yourself, without trusting the service's arithmetic. No network calls.
 * Checks every reveal against its commitment, then recomputes the winner (or picked option) using the
 * same public method the service uses. Call verifyReceipt() too, to check who signed it.
 *
 * Pass { seat } (the Seat you played with) so it also confirms the receipt holds exactly what YOU committed
 * and revealed. Without that, a dishonest service could swap in a different seed for one side and still
 * produce a self-consistent receipt; with it, any swap of your seed is caught by you.
 *
 * With { seat } (or { acks }), it also compares the service's signed step acknowledgments against the receipt.
 * Any contradiction is listed in `evidence`: the acknowledgment and the receipt are both signed by the service,
 * so together they prove the contradiction to anyone (see findContradictions).
 *
 * Returns { ok, recomputed, problems, trusts, evidence }:
 *   ok          no problem found
 *   recomputed  the result itself was re-derived from the agents' own commitments and reveals
 *   problems    anything that doesn't add up (a non-empty list means ok is false)
 *   trusts      what you're taking on the service's word for this receipt (forfeits, judge verdicts)
 */
export async function verifyOutcome(receipt, opts = {}) {
  const p = receipt?.payload ?? receipt;
  const problems = [];
  const trusts = [];
  if (!p?.tier || !p?.outcome) return { ok: false, recomputed: false, problems: ["Not a receipt payload."], trusts };
  const fp = formatProblem(p, "match");
  if (fp) return { ok: false, recomputed: false, problems: [fp], trusts, evidence: [] };
  const multiJudge = p.receipt_format === JUDGE_FORMAT;
  if (multiJudge && !isMultiJudgeTier(p.tier))
    return { ok: false, recomputed: false, problems: [`A ${JUDGE_FORMAT} receipt must be for a multi-part judge tier (judge-3x2 or judge-3x3), not ${String(p.tier).slice(0, 40)}.`], trusts, evidence: [] };
  if (!multiJudge && isMultiJudgeTier(p.tier))
    return { ok: false, recomputed: false, problems: [`A ${p.tier} receipt must say receipt_format ${JUDGE_FORMAT}; this one doesn't, so it can't be checked.`], trusts, evidence: [] };
  const out = p.outcome;
  const proof = p.proof ?? {};

  // Signed step acknowledgments that the receipt contradicts: provable to anyone.
  const me = opts.seat;
  const evidence = findContradictions(p, opts.acks ?? me?.acks ?? []);
  if (!me) for (const e of evidence) problems.push(e.reason);
  const adv = judgeAdvisory(p);
  if (adv.advisory) trusts.push(adv.advisory); // the receipt's own words, signed (judge spec §9): not a copy kept here
  if (adv.humanReviewRequired)
    trusts.push("The service marks this verdict for a person's review (human_review: required). Don't act on it in a step that can't be undone until someone has reviewed it.");
  const done = (recomputed) => ({ ok: problems.length === 0, recomputed, problems, trusts, evidence, advisory: adv.advisory, humanReview: adv.humanReview });

  // The receipt must describe the match this agent agreed to (tier, seats, odds, options, rules, demo or not).
  if (me?.requested) await checkSettings(p, me.requested, problems);

  // Your own inputs must appear in the receipt exactly as you sent them.
  if (me) {
    if (me.matchId !== p.match_id) problems.push("This receipt is for a different match than your seat.");
    const roundsOf = proof.rounds ?? [{ round: 1, commits: proof.commits, reveals: proof.reveals }];
    for (const m of me.mine ?? []) {
      const r = roundsOf.find((x) => x.round === (m.round ?? 1)) ?? (roundsOf.length === 1 ? roundsOf[0] : undefined);
      if (!r) { problems.push(`Round ${m.round}: missing from the receipt.`); continue; }
      const c = r.commits?.[me.seat];
      const v = r.reveals?.[me.seat];
      if (c !== undefined && c !== m.commitment) problems.push(`Round ${m.round}: your commitment was replaced.`);
      if (v && (v.value !== m.value || v.nonce !== m.nonce)) problems.push(`Round ${m.round}: your reveal was replaced.`);
      if (c === undefined && !out.by_forfeit) problems.push(`Round ${m.round}: your commitment is missing.`);
    }
    for (const e of evidence) problems.push(e.reason);
    if (problems.length)
      problems.push("Don't accept this result. Keep this signed receipt and seat.mine (your seed and nonce): the receipt is the service's signed claim, and your inputs show it differs from what you sent.");
  }

  const checkReveals = async (commits = {}, reveals = {}, label = "") => {
    for (const [seat, r] of Object.entries(reveals)) {
      if (!commits[seat]) problems.push(`${label}${seat} revealed without a commitment.`);
      else if ((await sha256Hex(`${r.value}:${r.nonce}`)) !== commits[seat]) problems.push(`${label}${seat}'s reveal doesn't match its commitment.`);
    }
  };
  const combined = async (seeds) => {
    const parts = Object.keys(seeds).sort().map((s) => `${s}=${seeds[s]}`);
    const hex = await sha256Hex(`${p.match_id}|1|${parts.join("|")}`);
    if (proof.combined_sha256 && proof.combined_sha256 !== hex) problems.push("Combined random value doesn't match the reveals.");
    return BigInt("0x" + hex.slice(0, 16));
  };
  if (out.by_forfeit || out.forfeited?.length)
    trusts.push(`That ${(Array.isArray(out.forfeited) ? out.forfeited : []).join(", ")} missed a deadline is the service's record; it can't be recomputed from the receipt.`);

  if (JUDGE_TIERS.includes(p.tier)) {
    if (multiJudge) {
      const given = [];
      if (opts.pieces != null) {
        if (typeof opts.pieces !== "object" || Array.isArray(opts.pieces)) problems.push('pieces must be by seat: { "seat": ["text 1", "text 2"] }.');
        else given.push(...Object.entries(opts.pieces));
      }
      if (me?.pieces) given.push([me.seat, me.pieces]);
      await checkJudgePieces(p, given, problems);
    }
    if (!out.by_forfeit) checkJudgeDecision(p, problems, trusts);
    return done(false);
  }

  if (p.tier === "rps" || p.tier === "rps-bo3") {
    const [a, b] = p.parties;
    const wins = { [a]: 0, [b]: 0 };
    for (const r of proof.rounds ?? []) {
      await checkReveals(r.commits, r.reveals, `Round ${r.round}: `);
      if (r.reveals?.[a] && r.reveals?.[b]) {
        const va = r.reveals[a].value, vb = r.reveals[b].value;
        const expected = va === vb ? null : RPS_BEATS[va] === vb ? a : b;
        if ((r.winner ?? null) !== expected) problems.push(`Round ${r.round}: winner should be ${expected ?? "a tie"}.`);
        if (expected) wins[expected]++;
      }
    }
    if (!out.by_forfeit) {
      const target = p.tier === "rps" ? 1 : 2;
      const champ = [a, b].find((s) => wins[s] >= target) ?? null;
      if ((out.winner ?? null) !== champ) problems.push(`Winner should be ${champ ?? "nobody"}.`);
    }
    return done(!out.by_forfeit);
  }

  await checkReveals(proof.commits, proof.reveals);
  const seeds = Object.fromEntries(Object.entries(proof.reveals ?? {}).map(([s, r]) => [s, r.value]));

  if (p.tier === "weighted") {
    if (out.by_forfeit) return done(false);
    const weights = out.weights ?? {};
    const seats = Object.keys(weights).sort();
    for (const s of seats) if (!seeds[s]) problems.push(`${s} has no reveal.`);
    const total = seats.reduce((n, s) => n + weights[s], 0);
    let ticket = Number((await combined(seeds)) % BigInt(total));
    let winner = seats[seats.length - 1];
    for (const s of seats) {
      if (ticket < weights[s]) { winner = s; break; }
      ticket -= weights[s];
    }
    if (out.winner !== winner) problems.push(`Winner should be ${winner}.`);
    return done(true);
  }

  if (p.tier === "draw") {
    const options = out.options ?? [];
    const idx = Number((await combined(seeds)) % BigInt(options.length || 1));
    if (out.picked_index !== idx || out.picked_option !== options[idx]) problems.push(`Picked option should be #${idx} (${options[idx]}).`);
    return done(true);
  }

  problems.push(`Unknown tier "${p.tier}".`);
  return done(false);
}

/**
 * Check a rematch series from its receipts alone (any order; game 1 included or not). Confirms each game links to
 * the previous receipt by hash, game numbers run in order, and every running tally adds up from the winners.
 * Verify each receipt's signature too (verifyReceipt) and, for your own games, verifyOutcome.
 * Returns { ok, problems, tally } where tally is the series total after the last game given.
 */
export async function verifySeries(receipts) {
  const ps = (receipts ?? []).map((r) => r?.payload ?? r).filter(Boolean);
  const problems = [];
  if (!ps.length) return { ok: false, problems: ["No receipts given."], tally: null };
  const fp = ps.map((x) => formatProblem(x, "match")).find(Boolean);
  if (fp) return { ok: false, problems: [fp], tally: null };
  const gameOf = (p) => p.series?.game ?? 1;
  ps.sort((a, b) => gameOf(a) - gameOf(b));
  const seriesId = ps[0].series?.series_id ?? ps[0].match_id;
  let tally = null;
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    const s = p.series;
    const game = gameOf(p);
    if (game === 1) {
      if (p.match_id !== seriesId) problems.push(`Game 1 (${p.match_id}) isn't the start of series ${seriesId}.`);
    } else if (s?.series_id !== seriesId) problems.push(`Game ${game} belongs to a different series.`);
    const prev = ps[i - 1];
    if (prev) {
      if (gameOf(prev) !== game - 1) problems.push(`Game ${game - 1} is missing.`);
      else {
        if (s?.previous_match_id !== prev.match_id) problems.push(`Game ${game} doesn't follow game ${game - 1}'s match.`);
        if (s?.previous_receipt_sha256 !== (await sha256Hex(canonicalJson(prev)))) problems.push(`Game ${game} doesn't link to game ${game - 1}'s receipt (it was changed or swapped).`);
      }
    }
    // Running tally: start from the given previous tally (or zero for game 1), add this game's result.
    const before = game === 1 ? { games: 0, wins: Object.fromEntries((p.parties ?? []).map((x) => [x, 0])), no_result: 0 } : tally ?? (prev ? null : undefined);
    if (before) {
      const t = structuredClone(before);
      t.games++;
      const w = p.outcome?.winner;
      if (w && (p.parties ?? []).includes(w)) t.wins[w] = (t.wins[w] ?? 0) + 1;
      else t.no_result++;
      if (s?.tally && canonicalJson(s.tally) !== canonicalJson(t)) problems.push(`Game ${game}'s tally doesn't add up.`);
      tally = t;
    } else tally = s?.tally ?? null; // series given from the middle: take its signed tally as the starting point
  }
  return { ok: problems.length === 0, problems, tally };
}

/**
 * Compare the service's signed step acknowledgments with a receipt. Returns [{ reason, ack }] for every
 * acknowledgment the receipt contradicts (a commitment or reveal that changed or vanished, or a forfeit for a
 * step the service had accepted). Both documents are signed by the service, so anyone can check this:
 * verify both signatures (verifyReceipt), then run this. No seed or secret needed.
 */
export function findContradictions(receipt, acks = []) {
  const p = receipt?.payload ?? receipt;
  const out = [];
  if (!p?.match_id) return out;
  const proof = p.proof ?? {};
  const forfeited = Array.isArray(p.outcome?.forfeited) ? [...p.outcome.forfeited] : [];
  const roundsOf = proof.rounds ?? [{ round: 1, commits: proof.commits, reveals: proof.reveals }];
  const roundFor = (n) => roundsOf.find((r) => r.round === n) ?? (roundsOf.length === 1 && !proof.rounds ? roundsOf[0] : undefined);
  for (const ack of acks) {
    const a = ack?.payload;
    if (a?.type !== "step-ack" || a.match_id !== p.match_id) continue;
    const seat = a.seat;
    const flag = (reason) => out.push({ reason: `Signed ${a.step} acknowledgment contradicts the receipt: ${reason}`, ack });
    if (a.step === "commit" || a.step === "reveal") {
      const r = roundFor(a.round);
      const c = r?.commits?.[seat];
      if (c !== a.commitment) flag(`${seat}'s round ${a.round} commitment ${c ? "was changed" : "is missing"}.`);
      if (a.step === "reveal") {
        const v = r?.reveals?.[seat];
        if (!v || v.value !== a.value || v.nonce !== a.nonce) flag(`${seat}'s round ${a.round} reveal ${v ? "was changed" : "is missing"}.`);
        if (forfeited.includes(seat)) flag(`${seat} is listed as forfeiting after the service accepted its reveal.`);
      }
    } else if (a.step === "submit") {
      if (forfeited.includes(seat)) flag(`${seat} is listed as forfeiting after the service accepted its submission.`);
      if (a.receipt_format === JUDGE_FORMAT || p.receipt_format === JUDGE_FORMAT) {
        // Multi-part judge tiers: the ack names the side's pieces; the receipt must show exactly those.
        const recs = proof.pieces?.[seat];
        if (recs == null) flag(`${seat}'s accepted pieces are missing from the receipt.`);
        else if (canonicalJson(recs) !== canonicalJson(a.pieces ?? null) || proof.pieces_sha256?.[seat] !== a.pieces_sha256) flag(`${seat}'s submission was changed.`);
      } else {
        const h = proof.submission_sha256?.[seat];
        if (h && h !== a.position_sha256) flag(`${seat}'s submission was changed.`);
      }
    } else if (a.step === "join") {
      const paid = p.paid_by?.[seat];
      if (paid && a.paid_by && paid !== a.paid_by) flag(`${seat}'s paying wallet was changed.`);
    }
  }
  return out;
}

export function canonicalJson(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(v)
    .filter((k) => v[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`)
    .join(",")}}`;
}
