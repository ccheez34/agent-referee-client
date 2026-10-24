// agent-referee-client: settle disagreements between AI agents with Agent Referee.
// Works in Node 18+, Deno, Bun, browsers and Cloudflare Workers (uses fetch + Web Crypto only).

export const DEFAULT_URL = "https://agent-referee.fairplayclub.workers.dev";

const JOIN_PATH = {
  rps: "/join/rps",
  "rps-bo3": "/join/rps-bo3",
  weighted: "/join/weighted",
  judge: "/join/judge",
};

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
      const res = await baseFetch(input, init); // if this throws (no reply), the proof stays saved for recovery
      // A definite answer from the service (2xx: seat issued; 4xx: payment never settled) means the proof
      // is no longer needed. 5xx can come from a gateway after the seat was already claimed, so keep it.
      if (p && res.status < 500 && opts.store?.remove) await opts.store.remove(key).catch(() => {});
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
   * @param {string[]} [opts.publicKeys] Pin the service's receipt-signing key(s) (base64). Without it, keys are fetched from GET /pubkey.
   * @param {number} [opts.joinRetries] Extra 15-second waits for the other side before giving up (default 3, about 1 minute).
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
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
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
   * @param {{tier: "rps"|"rps-bo3"|"weighted"|"draw"|"judge", seats: string[], title?: string, key?: string,
   *          seat_wallets?: Record<string, string>,
   *          weights?: Record<string, number>, options?: string[], rules?: string}} spec
   */
  create(spec) {
    return this._call("POST", "/matches", spec);
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
    let path = JOIN_PATH[st.tier];
    if (st.tier === "draw") path = seat === "mediator" ? "/join/draw/mediator" : "/join/draw/party";
    const body = { match_id: matchId, seat };
    if (typeof opts.privateRecord === "boolean") body.private_record = opts.privateRecord;
    let r;
    let retries = opts.joinRetries ?? this.joinRetries;
    for (;;) {
      try {
        r = await this._call("POST", path, body);
        break;
      } catch (e) {
        // 408: the other seat(s) didn't show within the server's 15-second wait. We were NOT charged.
        if (e instanceof RefereeError && e.status === 408) {
          if (retries-- > 0) continue;
          throw new RefereeError("The other side didn't show up. You were not charged.", 408, e.body);
        }
        // Paid but no seat_token back (dropped connection, gateway error)? Try to recover the seat with the
        // payment proof right away, instead of paying again or waiting for a restart.
        const payment = this.capture?.lastPayment(this.url + path, JSON.stringify(body));
        if (!payment) throw e;
        try {
          r = await this.recover(matchId, payment);
          break;
        } catch (re) {
          // 404: that payment never claimed a seat, so it never settled. Safe to try joining again.
          if (re instanceof RefereeError && re.status === 404 && retries-- > 0) continue;
          throw re;
        }
      }
    }
    return new Seat(this, matchId, seat, r.seat_token, st.tier);
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
    trusted = trusted.filter(Boolean);
    const candidates = receipt.public_key ? trusted.filter((k) => k === receipt.public_key) : trusted;
    const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    const data = new TextEncoder().encode(canonicalJson(receipt.payload));
    for (const k of candidates) {
      const key = await crypto.subtle.importKey("raw", b64(k), { name: "Ed25519" }, false, ["verify"]);
      if (await crypto.subtle.verify({ name: "Ed25519" }, key, b64(receipt.signature), data)) return true;
    }
    return false;
  }
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
    await this.client._call("POST", `/matches/${this.matchId}/commit`, {
      seat: this.seat,
      seat_token: this.token,
      commitment,
    });
    await this.client.waitFor(this.matchId, (st) => st.phase !== "commit" || st.round !== round);
    await this.client._call("POST", `/matches/${this.matchId}/reveal`, { seat: this.seat, seat_token: this.token, value: v, nonce });
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
        if (st.receipt) {
          const check = await verifyOutcome(st.receipt, { seat: this });
          let signed = false;
          try { signed = await this.client.verifyReceipt(st.receipt); } catch {}
          check.signed = signed;
          if (!signed) {
            check.ok = false;
            check.problems.push("The receipt's signature doesn't match the service's key, so it may not come from the service. Don't accept this result.");
          }
          st.check = check;
        }
        return st;
      }
    }
  }

  /** Judge tier: submit your position, then wait for the verdict. */
  async submit(position) {
    await this.client._call("POST", `/matches/${this.matchId}/submit`, { seat: this.seat, seat_token: this.token, position });
    return this.client.waitFor(this.matchId, (st) => st.phase === "done");
  }

  /** True if this seat won (for tiers with a winner). */
  static won(status, seat) {
    return status?.result?.winner === seat;
  }
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
 * Returns { ok, recomputed, problems, trusts }:
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
  const out = p.outcome;
  const proof = p.proof ?? {};

  // Your own inputs must appear in the receipt exactly as you sent them.
  const me = opts.seat;
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
    trusts.push(`That ${(out.forfeited ?? []).join(", ")} missed a deadline is the service's record; it can't be recomputed from the receipt.`);

  if (p.tier === "judge") {
    trusts.push("The verdict is the AI judge's decision; it can be audited (rules, model, prompt fingerprint) but not recomputed.");
    return { ok: true, recomputed: false, problems, trusts };
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
    return { ok: problems.length === 0, recomputed: !out.by_forfeit, problems, trusts };
  }

  await checkReveals(proof.commits, proof.reveals);
  const seeds = Object.fromEntries(Object.entries(proof.reveals ?? {}).map(([s, r]) => [s, r.value]));

  if (p.tier === "weighted") {
    if (out.by_forfeit) return { ok: problems.length === 0, recomputed: false, problems, trusts };
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
    return { ok: problems.length === 0, recomputed: true, problems, trusts };
  }

  if (p.tier === "draw") {
    const options = out.options ?? [];
    const idx = Number((await combined(seeds)) % BigInt(options.length || 1));
    if (out.picked_index !== idx || out.picked_option !== options[idx]) problems.push(`Picked option should be #${idx} (${options[idx]}).`);
    return { ok: problems.length === 0, recomputed: true, problems, trusts };
  }

  return { ok: false, recomputed: false, problems: [`Unknown tier "${p.tier}".`], trusts };
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
