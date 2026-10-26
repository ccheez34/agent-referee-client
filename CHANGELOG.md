# Changelog

## 0.5.0 (2026-10-26)

- **New: judge panels.** `judge-2` (two independent judges, different models; both must agree or it's a mistrial) and `judge-3` (three judges; majority wins, dissent kept). Judges run in parallel and never see each other's verdicts, and judge 2 sees the sides in reverse order. Every vote is in the signed receipt, and `verifyOutcome` recomputes the panel's decision from the votes.
- **New: mistrial.** When no fair verdict is possible, the judge(s) return `winner: null`, `mistrial: true`, a reason and `escalate_to_owners: true` instead of forcing a winner. `Seat.mistrial(status)` checks for it. A mistrial counts as completed on records, never as a win or loss.
- **New: mistrial codes.** Every mistrial also carries `mistrial_code`, so a program can act on it without parsing prose: `different_questions`, `rules_not_applicable`, `missing_information` or `other` from a judge, and `score_tie`, `panel_disagreement`, `panelist_mistrial` or `no_majority` from the panel rules. It's in the signed receipt. Table in the guide.
- **New: confidence.** Every verdict says how sure the judge is: `high`, `medium` or `low`.
- **New: scoring criteria.** Judge tiers accept `criteria: [{ name, weight }]`. Judges score each side 0-10 per criterion, and the winner is computed from the scores and the agreed weights, which `verifyOutcome` recomputes. Criteria are part of the agreed settings and the settings check.
- **New: rematch.** `seat.rematch()` for `weighted`, `rps` and `rps-bo3`: both sides ask, then the next game of a series is created with the same settings, its seats locked to the wallets that paid. Each receipt carries the running tally and a hash of the previous receipt; `verifySeries(receipts)` checks the whole series. Up to 10 games.
- **New: judging retries itself.** If the judges fail (for example the AI provider is overloaded), `seat.submit()` retries the judging for you, free, and `seat.retryJudge()` does it by hand. The match error now includes the provider's reason.
- Judges now run at the model's own default temperature, since current models no longer accept a temperature setting. The match and receipt show `temperature: null`.
- The judge's instructions are now version `agent-referee-judge-v3` (see `GET /judge`). Matches created earlier keep the exact instructions they locked in.

No breaking changes. Older clients keep working with every existing tier.

## 0.4.0 (2026-10-24)

- **New: free demo mode.** `new AgentReferee({ demo: true })` runs the full protocol with no wallet or payment. Receipts and acknowledgments are marked `demo` in the signed part, nothing is recorded, the judge tier is excluded, and there's a shared daily limit. See `examples/demo.mjs`.
- **New: settings check.** The client remembers the settings it agreed to, and `check.ok` fails if a receipt's tier, seats, odds, options, rules or demo setting differ, so a service can't hand the two agents receipts for different matches.
- When a paid join fails after retrying, the error now says why (for example a payment-processor message) instead of a confusing seat-recovery message.
- Docs: the trust section now says plainly that a dishonest operator could decide a match by ignoring a reveal, and that step order is enforced only by the service; roadmap items to close both.

No breaking changes.

## 0.3.0 (2026-10-24)

- **New: signed step acknowledgments.** Each step the service accepts (join, commit, reveal, judge submission) returns an `ack` signed with the receipt key. Seats keep them in `seat.acks`.
- **New: `findContradictions(receipt, acks)`** lists every acknowledgment a receipt contradicts. A changed seed or a forfeit for an accepted step is now provable to anyone, not just detectable by the agent affected.
- `check.ok` (from `seat.play()` and now `seat.submit()`) also verifies acknowledgments; `check.evidence` lists contradictions.
- `seat.play()` and `seat.submit()` return `acks` alongside `receipt`, so both can be saved together.
- **New: `verifySignature(doc, publicKeys)`**, a standalone offline signature check for receipts and acknowledgments, so third parties don't need a client.
- **New:** `onAck` client option is called with each acknowledgment the moment it arrives, so your proof survives a crash.

No breaking changes. Older service versions simply return no acknowledgments.

## 0.2.0 (2026-10-23)

- **New: `verifyOutcome(receipt, { seat })`** confirms your own seed is in the receipt exactly as you sent it, re-derives the result from the agents' commitments and reveals, offline, and lists anything taken on the service's word (forfeits, judge verdicts).
- **New:** `verifyReceipt(receipt, { publicKeys })` verifies a signature offline, without contacting the service.
- **New:** `seat.play()` checks the result for you (signature, your own seed, and the math) and returns it as `check`.
- **New:** `publicKeys` client option pins the service's signing key.
- **New:** TypeScript types.
- `fileProofStore` now writes proof files readable only by your user.
- Docs: shorter README with a trust breakdown, comparisons and a match diagram; full details moved to `docs/GUIDE.md`.

No breaking changes.

## 0.1.0 (2026-10-21)

First release.
