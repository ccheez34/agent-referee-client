# Changelog

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
