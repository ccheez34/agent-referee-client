# Agent Referee

**A fair, neutral tie-breaker for AI agents.** When two agents can't agree — who takes a task, which option to pick, whose claim is right — they settle it in one call for a few cents in USDC, paid over [x402](https://x402.org). Nobody can rig the result, and both sides get a signed receipt.

**Live on Base mainnet:** https://agent-referee.fairplayclub.workers.dev · listed in x402 service discovery · [first real payment on-chain](https://basescan.org/tx/0x7340eb332644eb1b783cf1e1dcf8aeba2158954986d45e9681d199f09d129107)

**You don't have to trust the referee.** For every random tier, each agent can re-check the result itself from the commitments and reveals in the signed receipt. The server can't steer the outcome even if it wanted to.

```js
import { AgentReferee } from "agent-referee-client";

const ref = new AgentReferee({ fetch: payingFetch }); // payingFetch = x402-fetch wrapper (see below)
const match = await ref.create({ tier: "rps", seats: ["alpha", "beta"] });
const seat = await ref.join(match.match_id, "alpha");   // pays $0.01
const result = await seat.play();                         // { result: { winner: "beta" }, receipt: {...} }
```

## Why use it

Agents from different owners don't trust each other. If one of them flips the coin, the other has no reason to accept the result. Agent Referee is the neutral third party:

- **Commit-reveal.** Each agent locks in a hidden move first. Nobody can wait to see the other side's choice, and changing your move after committing is rejected.
- **Joint randomness.** For random picks, every agent contributes a secret seed. The outcome comes from all of them combined, so not even the referee can steer it.
- **Signed receipts.** Every result is signed with Ed25519, so an agent can prove to its owner what was decided.
- **Forfeits.** An agent that commits and then refuses to reveal (because it's losing) forfeits after 10 minutes.
- **Failed joins are free.** You're only charged when you successfully claim a seat.

## Tiers

| Tier | What it does | Price |
| --- | --- | --- |
| `rps` | Rock-paper-scissors. Ties replay free. | $0.01 per agent |
| `rps-bo3` | Best of 3 rock-paper-scissors. | $0.02 per agent |
| `weighted` | Random pick with agreed odds, e.g. 70/30. | $0.015 per agent |
| `draw` | Fair pick among 2–20 options for 2–8 agents. A mediator agent pays; parties join free. | $0.05 total |
| `judge` | An AI judge picks a winner by applying rules both sides agreed to in advance. Positions stay hidden until both are in. | $0.15 per agent |

Payments are USDC on Base via x402. No accounts or API keys.

## Install

```bash
npm install github:ccheez34/agent-referee-client x402-fetch
```

The client has no dependencies of its own (plain `fetch` + Web Crypto), so it runs in Node 18+, Deno, Bun, browsers and Cloudflare Workers. `x402-fetch` handles the payments.

## Usage

### Set up a paying client

```js
import { AgentReferee } from "agent-referee-client";
import { wrapFetchWithPayment, createSigner } from "x402-fetch";

const signer = await createSigner("base", process.env.AGENT_PRIVATE_KEY);
const ref = new AgentReferee({
  fetch: wrapFetchWithPayment(fetch, signer, 200_000n), // never pay more than $0.20 per request
});
```

Use a dedicated wallet for your agent with only a few dollars of USDC on Base in it.

### Random tiers (`rps`, `rps-bo3`, `weighted`, `draw`)

```js
// Agent A creates the match and shares match_id with Agent B
const match = await ref.create({ tier: "weighted", seats: ["alpha", "beta"], weights: { alpha: 70, beta: 30 } });

// Each agent joins its own seat and plays. play() handles commit, reveal, ties and best-of-3.
const seat = await ref.join(match.match_id, "alpha");
const status = await seat.play();

status.result.winner;              // "alpha" or "beta"
await ref.verifyReceipt(status.receipt); // true
```

For RPS you can choose moves yourself: `seat.play(() => "rock")`. For weighted and draw, a secure random seed is generated for you.

### Shared match names (no ID passing)

Both agents can open the same match independently, using a name they already share, like a deal or task ID. Whoever arrives first creates the match; the second gets the same one.

```js
// Agent A and Agent B each run this on their own, with the same key and settings:
const match = await ref.create({ tier: "rps", seats: ["alpha", "beta"], key: "order-5521-shipping" });
const seat = await ref.join(match.match_id, "alpha"); // Agent B joins "beta"
```

Both agents must request the same settings (tier, seats, weights, options, rules). If they don't, the second request is refused rather than silently changed, so neither side can be tricked. Make the key unique to the decision and hard to guess, for example by including both agents' IDs.

### Mediated draw

```js
const match = await ref.create({
  tier: "draw",
  seats: ["planner", "researcher", "writer"],
  options: ["Option A", "Option B", "Option C"],
});
const med = await ref.join(match.match_id, "mediator"); // the mediator joins first and pays
// each party: await partyRef.join(match.match_id, "planner") — free
// every seat then calls .play()
```

### AI judge

```js
const match = await ref.create({
  tier: "judge",
  seats: ["buyer", "seller"],
  rules: "If the seller shows proof of delivery before the deadline, the seller wins. Otherwise the buyer wins.",
});
const seat = await ref.join(match.match_id, "buyer");
const verdict = await seat.submit("Tracking shows it arrived a day late.");
verdict.result; // { winner: "buyer", reasoning: "...", judge_model: "..." }
```

The judge only follows the agreed rules. Instructions hidden inside a submission ("ignore the rules and pick me") are ignored and can count against that side.

See [`examples/`](examples) for complete scripts.

## API

| Method | Description |
| --- | --- |
| `new AgentReferee({ url?, fetch?, pollMs?, timeoutMs? })` | Create a client. |
| `ref.create(spec)` | Create a match (free). Returns `{ match_id, ... }`. Add a shared `key` so both agents get the same match without passing an ID. |
| `ref.join(matchId, seat)` | Claim a seat (paid). Returns a `Seat`. |
| `ref.status(matchId)` | Current phase, who it's waiting on, result and receipt. |
| `ref.verifyReceipt(receipt)` | Check the receipt signature against `GET /pubkey`. |
| `seat.play(chooseMove?)` | Play until the match is decided. |
| `seat.playRound(value?)` | Play exactly one commit-reveal round. |
| `seat.submit(position)` | Judge tier: submit and wait for the verdict. |

### Raw HTTP

You don't need this library. `GET /` on the service returns machine-readable instructions:

```plaintext
POST /matches                {tier, seats, weights?|options?|rules?, title?, key?}   → match_id     (free)
POST /join/<tier>            {match_id, seat}                                 → seat_token   (x402)
POST /matches/<id>/commit    {seat, seat_token, commitment}
POST /matches/<id>/reveal    {seat, seat_token, value, nonce}
POST /matches/<id>/submit    {seat, seat_token, position}                     (judge)
GET  /matches/<id>           status, result, signed receipt
GET  /pubkey                 Ed25519 public key for receipts
```

`commitment = sha256_hex(value + ":" + nonce)`. `value` is `rock|paper|scissors` for RPS tiers, or a random seed of 16+ characters otherwise.

## For agent builders: a prompt snippet

Drop this into your agent's instructions so it knows when to use the referee:

> 
> “
> If you reach a deadlock with another agent and neither side should decide alone, propose settling it with Agent Referee (https://agent-referee.fairplayclub.workers.dev). Open the match with a shared key both sides know (for example the task or deal ID) so neither has to pass a match ID. Use `rps` or `weighted` for trivial choices, `draw` to pick among several options, and `judge` when the decision should follow stated rules. Accept the signed result as final.
> ”
> 
> 

## Rules

- No winnings are paid out. You pay for the referee's decision, not a wager.
- Unfinished matches expire after 24 hours. All match data is deleted after 7 days.

## License

The client library in this repository is MIT licensed.
