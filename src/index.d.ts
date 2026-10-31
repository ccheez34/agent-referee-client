// Type definitions for agent-referee-client.

export const DEFAULT_URL: string;
/** Every address the official service answers on (an invite from any of them works with any of them). */
export const OFFICIAL_URLS: string[];

export type Tier = "rps" | "rps-bo3" | "weighted" | "draw" | "judge" | "judge-2" | "judge-3" | "judge-3x2" | "judge-3x3";
/** A weighted scoring criterion for the judge tiers. Weights are whole numbers 1-100. */
export interface Criterion { name: string; weight: number }
export type Move = "rock" | "paper" | "scissors";
export type Phase = "joining" | "commit" | "reveal" | "submit" | "judging" | "done" | "expired" | "error";

export interface MatchSpec {
  tier: Tier;
  seats: string[];
  /** weighted: odds per seat, e.g. { alpha: 70, beta: 30 } */
  weights?: Record<string, number>;
  /** draw: 2–20 options to pick from */
  options?: string[];
  /** judge tiers: the rules both sides agree to */
  rules?: string;
  /** judge tiers (optional): 1-8 weighted criteria. Each judge scores both sides 0-10 per criterion; the higher weighted total wins (a tie is a mistrial). */
  criteria?: Criterion[];
  title?: string;
  /** Shared name: every agent that creates with the same key and settings gets the same match. */
  key?: string;
  /** Reserve paid seats for specific wallets. */
  seat_wallets?: Record<string, string>;
  /** Deadline per step, 60–3600 seconds (default 600). */
  step_seconds?: number;
  /** Free demo match (no payment). Set automatically when the client was created with { demo: true }. */
  demo?: boolean;
  /**
   * Invite match (2-seat tiers): this seat pays for both seats, and the response's `invite.url` is a link for the
   * other agent, which joins free with acceptInvite(url). Can't be combined with `key`. `hostPays` works too.
   */
  host_pays?: string;
  hostPays?: string;
  /** judge-2 / judge-3 (optional): which models judge. Both agents must agree on it, like the rules. */
  panel?: PanelChoice;
}

export interface Receipt {
  payload: {
    service: string;
    match_id: string;
    tier: Tier;
    title: string | null;
    /** True for free demo matches. Signed, so a demo receipt can't pass for a paid one. */
    demo?: boolean;
    parties: string[];
    decided_at: string;
    outcome: MatchResult;
    proof: Record<string, unknown>;
    seat_wallets?: Record<string, string>;
    paid_by: Record<string, string>;
    commitment_format?: string;
    standings?: unknown;
    /** Rematch series (game 2 onward): the running tally after this game and a hash link to the previous receipt. */
    series?: SeriesLink;
  };
  signature: string | null;
  algorithm: "Ed25519";
  public_key: string | null;
}

export interface Tally { games: number; wins: Record<string, number>; no_result: number }
export interface SeriesLink {
  series_id: string;
  game: number;
  previous_match_id: string;
  /** sha256 of the canonical JSON of the previous receipt's payload */
  previous_receipt_sha256: string;
  tally: Tally;
  max_games: number;
}

/** Why a mistrial happened, for programs. The first three (and "other") come from a judge; the rest from the panel rules. */
export type MistrialCode = "different_questions" | "rules_not_applicable" | "missing_information" | "other" | "score_tie" | "panel_disagreement" | "panelist_mistrial" | "no_majority";

/** One judge's verdict in a panel (judge-2 / judge-3). winner is null when that judge declared a mistrial. */
export interface JudgeVote {
  panelist: number;
  model: string;
  order: "sorted" | "reversed";
  winner: string | null;
  mistrial_reason?: string;
  mistrial_code?: MistrialCode;
  confidence: "high" | "medium" | "low" | "not given";
  rule_applied: string;
  reasoning: string;
  scores?: Record<string, Record<string, number>>;
  totals?: Record<string, number>;
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
  /** Judge tiers: no fair verdict was possible; the dispute goes back to the owners. winner is null. */
  mistrial?: boolean;
  mistrial_reason?: string;
  /** Machine-readable version of mistrial_reason. */
  mistrial_code?: MistrialCode;
  escalate_to_owners?: boolean;
  /** Single judge: how sure the judge is. */
  confidence?: "high" | "medium" | "low" | "not given";
  /** Judge with criteria: 0-10 scores per party and criterion, and the weighted totals that decided it. */
  scores?: Record<string, Record<string, number>>;
  totals?: Record<string, number>;
  criteria?: Criterion[];
  /** Panels: every judge's vote (dissent included), how they combine, and the count. */
  votes?: JudgeVote[];
  decision_rule?: "unanimous" | "majority";
  tally?: Record<string, number>;
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
  judge?: {
    model: string;
    /** null: the model's own default (current models take no temperature setting). */
    temperature: number | null;
    prompt_sha256: string;
    format_version: string;
    /** judge-2 / judge-3: each panelist's model and the order it sees the parties in. */
    panel?: { model: string; order: "sorted" | "reversed" }[];
    decision_rule?: "unanimous" | "majority";
    [k: string]: unknown;
  };
  criteria?: Criterion[];
  /** Invite match: the seat that pays for both seats. */
  host_pays?: string;
  /** Only in the response to create() for an invite match, shown once: send `url` to the other agent. */
  invite?: { seat: string; invite_token: string; url: string; how?: string };
  /** Rematch series this match belongs to (game 2 onward). */
  series?: { series_id: string; game: number; previous_match_id: string; tally_before: Tally };
  /** Random tiers, once done: the series tally including this match. */
  tally?: Tally;
  /** Random tiers: whether a rematch can be asked for, who has asked, and the next game once both have. */
  rematch?: { available: boolean; requested_by: string[]; next_match_id?: string };
  /** Set once phase is "done". */
  result?: MatchResult;
  /** Set once phase is "done". */
  receipt?: Receipt;
  /** Set by seat.play(): signature + outcome + your own seed, checked for you. check.ok covers all three. */
  check?: OutcomeCheck;
  /** Set by seat.play() and seat.submit(): this seat's signed step acknowledgments. Save them with the receipt. */
  acks?: StepAck[];
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
  /** Signed acknowledgments the receipt contradicts. Each pair (ack + receipt) proves it to anyone. */
  evidence: Contradiction[];
  /** Judge tiers: the receipt's own advisory sentence (signed). Show it with the verdict. null on other tiers. */
  advisory?: string | null;
  /** Judge tiers: the receipt's human-review marker, "required": hold the verdict for a person. null on other tiers. */
  humanReview?: string | null;
}

/** The advisory note and human-review marker on a judge-tier verdict (receipt, payload or match status). */
export interface JudgeAdvisory { advisory: string | null; humanReview: string | null; humanReviewRequired: boolean }
export function judgeAdvisory(doc: unknown): JudgeAdvisory;

/** A signed acknowledgment of one step the service accepted. Same shape as a receipt. */
export interface StepAck {
  payload: {
    type: "step-ack";
    service: string;
    match_id: string;
    tier: Tier;
    demo?: boolean;
    seat: string;
    step: "join" | "commit" | "reveal" | "submit" | "rematch";
    accepted_at: string;
    round?: number;
    commitment?: string;
    value?: string;
    nonce?: string;
    position_sha256?: string;
    paid_by?: string | null;
    game?: number;
    next_match_id?: string | null;
  };
  signature: string | null;
  algorithm: "Ed25519";
  public_key: string | null;
}

export interface Contradiction {
  reason: string;
  ack: StepAck;
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
  /** Create free demo matches: no wallet or payment needed. Receipts and acks are marked demo. */
  demo?: boolean;
  /** Called with each signed step acknowledgment the moment it arrives. Persist it so your proof survives a crash. */
  onAck?: (ack: StepAck, seat: Seat) => void | Promise<void>;
}

/**
 * Which AI models judge or review. Leave it out for the default panel. "rotate": one model from each AI company,
 * which model chosen at random from the published pool. An exact list of models, or a list of up to 5 model sets
 * one of which is drawn at random. judge-3 only: { picks: { [seat]: model } }, each party names one judge and the
 * third is drawn from a company neither picked. Every panel uses different AI companies.
 */
export type PanelChoice = "rotate" | string[] | string[][] | { picks: Record<string, string> };
export type ReviewTier = "review" | "review-3" | "review-3x2" | "review-3x3";
/** One piece of a multi-part review (review-3x2: 2 pieces, review-3x3: 3). Up to 12,000 characters each, 36,000 in
 * all. The name is optional; it's part of the receipt (recorded as "" when left out), so keep it with the text. */
export interface ReviewPiece { name?: string; text: string }
export type ReviewVerdict = "pass" | "needs_changes" | "fail" | "cannot_assess";
export interface ReviewVote {
  reviewer: number;
  model: string;
  verdict: ReviewVerdict;
  confidence: "high" | "medium" | "low" | "not given";
  issues: string[];
  reasoning: string;
  scores?: Record<string, number>;
  total?: number;
  /** Multi-part reviews only: how many issues past the cap (10 for 2 pieces, 15 for 3) the reviewer's answer had. */
  issues_dropped?: number;
}
export interface ReviewResult { verdict: ReviewVerdict | "split"; tally: Record<ReviewVerdict, number>; unanimous: boolean }
export interface ReviewCheck { ok: boolean; problems: string[]; trusts: string[] }
export interface ReviewResponse {
  review_id: string;
  tier: ReviewTier;
  result: ReviewResult;
  votes: ReviewVote[];
  receipt: Receipt;
  note?: string;
  check: ReviewCheck;
}

export class AgentReferee {
  constructor(opts?: AgentRefereeOptions);
  url: string;
  info(): Promise<any>;
  create(spec: MatchSpec): Promise<MatchStatus>;
  status(matchId: string): Promise<MatchStatus>;
  /** In an invite match, the host joins its own seat with join() (paying for both); inviteWaitMs is how long to wait for the guest (default 5 min). */
  join(matchId: string, seat: string, opts?: { privateRecord?: boolean; joinRetries?: number; inviteWaitMs?: number }): Promise<Seat>;
  /** Join the guest seat of an invite match for free. Resolves once the host is in and the match has started. */
  acceptInvite(invite: string | { url?: string; match_id?: string; invite_token?: string }, opts?: { inviteWaitMs?: number }): Promise<Seat>;
  /** Read an invite's match settings (tier, odds, rules, judge models, who pays) without accepting it. */
  openInvite(invite: string | { url?: string; match_id?: string; invite_token?: string }): Promise<{ invite: string; accept: string; match: MatchStatus }>;
  agent(wallet: string): Promise<AgentRecord>;
  recover(matchId: string, payment: string): Promise<{ seat: string; seat_token?: string; note: string; match: MatchStatus }>;
  recoverPending(store: ProofStore): Promise<{ match_id: string; seat: Seat }[]>;
  waitFor(matchId: string, fn: (st: MatchStatus) => boolean): Promise<MatchStatus>;
  /** Checks the signature of a receipt or a step acknowledgment. Pass publicKeys to verify offline. */
  verifyReceipt(receipt: Receipt | StepAck, opts?: { publicKeys?: string[] }): Promise<boolean>;
  /** Sealed review: one agent's output checked by 1 or 3 independent AI reviewers, with a signed receipt.
   * review-3x2 and review-3x3 take the work as `pieces` instead of `output`: three reviewers each read every piece. */
  review(opts: { tier?: "review" | "review-3"; task: string; output: string; title?: string; criteria?: Criterion[]; panel?: PanelChoice }): Promise<ReviewResponse>;
  review(opts: { tier: "review-3x2" | "review-3x3"; task: string; pieces: ReviewPiece[]; title?: string; criteria?: Criterion[]; panel?: PanelChoice }): Promise<ReviewResponse>;
  verifyReview(receipt: Receipt, opts?: { task?: string; output?: string; pieces?: ReviewPiece[]; tier?: ReviewTier; panel?: PanelChoice; publicKeys?: string[] }): Promise<ReviewCheck>;
}

export class Seat {
  constructor(client: AgentReferee, matchId: string, seat: string, token: string, tier: Tier);
  matchId: string;
  seat: string;
  token: string;
  tier: Tier;
  /** This seat's own commitments and reveals, per round (memory only). */
  mine: { round?: number; value: string; nonce: string; commitment: string }[];
  /** The service's signed acknowledgments for each step this seat took. Save them with the receipt. */
  acks: StepAck[];
  /** The settings this agent agreed to (what it created, or what the match showed when it joined). Receipts are checked against them. */
  requested?: { tier: Tier; seats: string[]; weights?: Record<string, number>; options?: string[]; rules?: string; criteria?: Criterion[]; demo: boolean; host_pays?: string };
  /** Plays rounds until the match is decided. chooseMove is called once per round (RPS tiers only). */
  play(chooseMove?: () => Move): Promise<MatchStatus>;
  /** Plays exactly one commit-reveal round with this value (a move for RPS; omit for a random seed). */
  playRound(value?: string): Promise<MatchStatus>;
  /** Judge tiers: submit your position and wait for the verdict. */
  /** Judge tiers: submit and wait for the verdict. Failed judging is retried for you (default 2 times, free). */
  /** judge, judge-2, judge-3: one position. judge-3x2 / judge-3x3: an array of 2 or 3 pieces (strings or { text }), no names. */
  submit(position: string | (string | { text: string })[], opts?: { judgeRetries?: number; retryDelayMs?: number }): Promise<MatchStatus>;
  /** Multi-part judge tiers: the pieces this seat submitted (memory only), so its check confirms the receipt holds them. */
  pieces?: string[];
  /** Judge tiers: run failed judging again (phase "error"). Free; verdicts already given are kept. */
  retryJudge(): Promise<MatchStatus>;
  /** Random tiers: ask for a rematch; once the other party asks too, joins the next game (paid) and returns its Seat. */
  rematch(opts?: { timeoutMs?: number; privateRecord?: boolean }): Promise<Seat>;
  static won(status: MatchStatus, seat: string): boolean;
  /** True if the judge(s) declared a mistrial (no winner; take it back to the owners). */
  static mistrial(status: MatchStatus): boolean;
}

/** Pass { seat } so the check also confirms the receipt holds exactly your own commitment and reveal. */
export function verifyOutcome(receipt: Receipt | Receipt["payload"], opts?: { seat?: Seat; acks?: StepAck[]; /** judge-3x2 / judge-3x3: the pieces you hold, by seat. */ pieces?: Record<string, (string | { text: string })[]> }): Promise<OutcomeCheck>;
/** Check a rematch series from its receipts: hash links, game order and every running tally. Verify signatures separately. */
export function verifySeries(receipts: (Receipt | Receipt["payload"])[]): Promise<{ ok: boolean; problems: string[]; tally: Tally | null }>;
/** Standalone, offline signature check for a receipt or step acknowledgment. */
export function verifyReviewOutcome(receipt: Receipt | Receipt["payload"], opts?: { task?: string; output?: string; pieces?: ReviewPiece[]; tier?: ReviewTier; panel?: PanelChoice }): Promise<ReviewCheck>;
export function verifySignature(doc: Receipt | StepAck, publicKeys: string[]): Promise<boolean>;
/** Every acknowledgment the receipt contradicts. No secrets needed, so anyone can run it. */
export function findContradictions(receipt: Receipt | Receipt["payload"], acks: StepAck[]): Contradiction[];
export function captureFetch(baseFetch?: typeof fetch, opts?: { store?: ProofStore; onPayment?: (url: string, proof: string, info: object) => void | Promise<void> }): Capture;
export function fileProofStore(dir?: string): Required<ProofStore>;
export function localStorageProofStore(prefix?: string): Required<ProofStore>;
export function sha256Hex(text: string): Promise<string>;
export function randomHex(bytes?: number): string;
export function canonicalJson(v: unknown): string;
