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
   * @param {number} [opts.timeoutMs] Max wait for the other side (default 15 minutes).
   */
  constructor(opts = {}) {
    this.url = (opts.url || DEFAULT_URL).replace(/\/$/, "");
    this.fetch = opts.fetch || globalThis.fetch.bind(globalThis);
    this.pollMs = opts.pollMs ?? 2000;
    this.timeoutMs = opts.timeoutMs ?? 15 * 60_000;
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
   * @param {{tier: "rps"|"rps-bo3"|"weighted"|"draw"|"judge", seats: string[], title?: string, key?: string,
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
   * @returns {Promise<Seat>}
   */
  async join(matchId, seat) {
    const st = await this.status(matchId);
    let path = JOIN_PATH[st.tier];
    if (st.tier === "draw") path = seat === "mediator" ? "/join/draw/mediator" : "/join/draw/party";
    const r = await this._call("POST", path, { match_id: matchId, seat });
    return new Seat(this, matchId, seat, r.seat_token, st.tier);
  }

  /** Wait until fn(status) returns true. */
  async waitFor(matchId, fn) {
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      const st = await this.status(matchId);
      if (fn(st)) return st;
      if (["done", "expired", "error"].includes(st.phase)) return st;
      if (Date.now() > deadline) throw new RefereeError("Timed out waiting for the other side.", 0, st);
      await sleep(this.pollMs);
    }
  }

  /** Verify a receipt's Ed25519 signature against the service's public key. */
  async verifyReceipt(receipt) {
    if (!receipt?.signature) return false;
    const { public_key } = await this._call("GET", "/pubkey");
    if (!public_key) return false;
    const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey("raw", b64(public_key), { name: "Ed25519" }, false, ["verify"]);
    return crypto.subtle.verify({ name: "Ed25519" }, key, b64(receipt.signature), new TextEncoder().encode(canonicalJson(receipt.payload)));
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
    await this.client._call("POST", `/matches/${this.matchId}/commit`, {
      seat: this.seat,
      seat_token: this.token,
      commitment: await sha256Hex(`${v}:${nonce}`),
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
      if (st.phase !== "commit") return st;
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

export function canonicalJson(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(v)
    .filter((k) => v[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`)
    .join(",")}}`;
}

