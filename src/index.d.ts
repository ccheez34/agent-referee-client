// Type definitions for agent-referee-client.

export const DEFAULT_URL: string;

export type Tier = "rps" | "rps-bo3" | "weighted" | "draw" | "judge";
export type Move = "rock" | "paper" | "scissors";
export type Phase = "joining" | "commit" | "reveal" | "submit" | "judging" | "done" | "expired" | "error";

export interface MatchSpec {
  tier: Tier;
  seats: string[];
  /** weighted: odds per seat, e.g. { alpha: 70, beta: 30 } */
  weights?: Record<string, number>;
  /** draw: 2–20 options to pick from */
  options?: string[];
  /** judge: the rules both sides agree to */
  rules?: string;
  title?: string;
  /** Shared name: every agent that creates with the same key and settings gets the same match. */
  key?: string;
  /** Reserve paid seats for specific wallets. */
  seat_wallets?: Record<string, string>;
  /** Deadline per step, 60–3600 seconds (default 600). */
  step_seconds?: number;
}

export interface Receipt {
  payload: {
    service: string;
    match_id: string;
    tier: Tier;
    title: string | null;
    parties: string[];
    decided_at: string;
    outcome: MatchResult;
    proof: Record<string, unknown>;
    seat_wallets?: Record<string, string>;
    paid_by: Record<string, string>;
    commitment_format?: string;
    standings?: unknown;
  };
  signature: string | null;
  algorithm: "Ed25519";
  public_key: string | null;
}

export interface MatchResult {
  winner?: string | null;
  by_forfeit?: boolean;
  forfeited?: string[];
  weights?: Record<string, number>;
  score?: Record<string, number>;
  picked_index?: number;
  picked_option?: string;
  options?: string[];
  reasoning?: string;
  rule_applied?: string;
  judge_model?: string;
  no_result?: string;
  [k: string]: unknown;
}

/** What GET /matches/{id} returns. seat.play() and seat.submit() resolve to this. */
export interface MatchStatus {
  match_id: string;
  key?: string;
  tier: Tier;
  title: string | null;
  phase: Phase;
  seats: { seat: string; joined: boolean }[];
  waiting_on: string[];
  round?: number;
  action_deadline?: string;
  reveal_deadline?: string;
  step_seconds: number;
  expires_at: string;
  judge?: { model: string; temperature: number; prompt_sha256: string; [k: string]: unknown };
  /** Set once phase is "done". */
  result?: MatchResult;
  /** Set once phase is "done". */
  receipt?: Receipt;
  /** Set by seat.play(): signature + outcome + your own seed, checked for you. check.ok covers all three. */
  check?: OutcomeCheck;
  error?: string;
  [k: string]: unknown;
}

export interface AgentRecord {
  wallet: string;
  /** True when the wallet keeps its record private (the other fields are then absent). */
  private?: boolean;
  completion_rate?: number | null;
  judge_win_rate?: number | null;
  badges?: { name: string; [k: string]: unknown }[];
  [k: string]: unknown;
}

export interface OutcomeCheck {
  /** No problem found. */
  ok: boolean;
  /** The result itself was re-derived from the agents' own commitments and reveals. */
  recomputed: boolean;
  /** Anything that doesn't add up. Non-empty means ok is false. */
  problems: string[];
  /** What this receipt asks you to take on the service's word (forfeits, judge verdicts). */
  trusts: string[];
  /** Set on the check seat.play() returns: whether the receipt's signature verified. ok includes it. */
  signed?: boolean;
}

export interface ProofStore {
  save(key: string, proof: string, info: { url: string; match_id?: string; seat?: string }): Promise<void>;
  remove(key: string): Promise<void>;
  list?(): Promise<{ key: string; match_id?: string; seat?: string; proof: string }[]>;
}

export interface Capture {
  fetch: typeof fetch;
  lastPayment(url: string, body: string): string | undefined;
}

export class RefereeError extends Error {
  status: number;
  body: any;
}

export interface AgentRefereeOptions {
  url?: string;
  /** A fetch that can pay x402 requests, e.g. x402-fetch's wrapFetchWithPayment(fetch, signer). */
  fetch?: typeof fetch;
  pollMs?: number;
  timeoutMs?: number;
  /** Called once per finished match with its signed receipt. Save it: match data is deleted after 7 days. */
  onReceipt?: (receipt: Receipt, status: MatchStatus) => void | Promise<void>;
  /** From captureFetch(): enables automatic seat recovery. */
  capture?: Capture;
  /** Extra 15-second waits for the other side during join (default 3). */
  joinRetries?: number;
  /** Pin the service's receipt-signing key(s) (base64) instead of fetching GET /pubkey. */
  publicKeys?: string[];
}

export class AgentReferee {
  constructor(opts?: AgentRefereeOptions);
  url: string;
  info(): Promise<any>;
  create(spec: MatchSpec): Promise<MatchStatus>;
  status(matchId: string): Promise<MatchStatus>;
  join(matchId: string, seat: string, opts?: { privateRecord?: boolean; joinRetries?: number }): Promise<Seat>;
  agent(wallet: string): Promise<AgentRecord>;
  recover(matchId: string, payment: string): Promise<{ seat: string; seat_token?: string; note: string; match: MatchStatus }>;
  recoverPending(store: ProofStore): Promise<{ match_id: string; seat: Seat }[]>;
  waitFor(matchId: string, fn: (st: MatchStatus) => boolean): Promise<MatchStatus>;
  /** Checks the signature. Pass publicKeys to verify offline. */
  verifyReceipt(receipt: Receipt, opts?: { publicKeys?: string[] }): Promise<boolean>;
}

export class Seat {
  constructor(client: AgentReferee, matchId: string, seat: string, token: string, tier: Tier);
  matchId: string;
  seat: string;
  token: string;
  tier: Tier;
  /** This seat's own commitments and reveals, per round (memory only). */
  mine: { round?: number; value: string; nonce: string; commitment: string }[];
  /** Plays rounds until the match is decided. chooseMove is called once per round (RPS tiers only). */
  play(chooseMove?: () => Move): Promise<MatchStatus>;
  /** Plays exactly one commit-reveal round with this value (a move for RPS; omit for a random seed). */
  playRound(value?: string): Promise<MatchStatus>;
  /** Judge tier: submit your position and wait for the verdict. */
  submit(position: string): Promise<MatchStatus>;
  static won(status: MatchStatus, seat: string): boolean;
}

/** Pass { seat } so the check also confirms the receipt holds exactly your own commitment and reveal. */
export function verifyOutcome(receipt: Receipt | Receipt["payload"], opts?: { seat?: Seat }): Promise<OutcomeCheck>;
export function captureFetch(baseFetch?: typeof fetch, opts?: { store?: ProofStore; onPayment?: (url: string, proof: string, info: object) => void | Promise<void> }): Capture;
export function fileProofStore(dir?: string): Required<ProofStore>;
export function localStorageProofStore(prefix?: string): Required<ProofStore>;
export function sha256Hex(text: string): Promise<string>;
export function randomHex(bytes?: number): string;
export function canonicalJson(v: unknown): string;
