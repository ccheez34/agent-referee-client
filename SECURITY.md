# Security

## Reporting a problem

Report security issues privately with GitHub's **"Report a vulnerability"** button on this repository, not in a public issue.

## The signing key

Every receipt and acknowledgment is signed with one Ed25519 key. The current public key is:

`vM2GY6ZEYc/omRlIFrzu0TaMGtjHXQtchg9d7lPKkTY=` (key ID `375ba8b346776e2f`)

The private half is stored only as an encrypted secret in the service's hosting (Cloudflare), never in any repository or package.

### If the key is ever exposed

1. **A new key is generated and the service switches to it right away.**
2. **The old key is listed at `GET /pubkey` under `history`** with the date it was retired, so receipts it signed before then stay verifiable.
3. **An announcement goes at the top of the README and in a GitHub security advisory**, with the time of the exposure.
4. **Receipts signed by the old key after that time must not be trusted.** If you pin keys (`publicKeys: [...]`), add the new key and keep the old one only to check receipts dated before the exposure.

### If the service shuts down

Receipts stay verifiable forever: checking one needs only the public key above, which `verifySignature` and `verifyReceipt` can use offline.
