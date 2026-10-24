# Changelog

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
