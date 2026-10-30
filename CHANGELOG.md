# Changelog

## 0.10.1 (unreleased)

- **The client never follows redirects.** Requests go out with `redirect: "manual"`, and a 3xx answer (status 0 in
  browsers, which hide it) becomes a `RefereeError` with `body: { redirect: true, location }`. Before, fetch would follow
  a redirect and resend custom headers, so a paid request's `X-PAYMENT` proof could reach another host.
  - `captureFetch` forwards every request with `redirect: "manual"` too, so the paid request is covered even under a
    payment wrapper that rebuilds the request options.
  - If a fetch below the client follows a redirect anyway, the answer from the other address is refused.
  - The Python client has refused redirects since 0.1.0.
- **A saved payment proof is kept after a redirect,** as after a 5xx: only a 2xx or a 4xx says what happened to the
  payment. Before, any status below 500 removed it.
- **`join()` stops after one recovery attempt when a paid join is redirected,** instead of paying again up to
  `joinRetries` times.

## 0.10.0 (2026-10-29)

- **Multi-part judge matches (`judge-3x2`, `judge-3x3`).** `seat.submit([text1, text2])` sends a side's case as 2
  or 3 pieces (strings, or `{ text }`). A wrong number of pieces, an empty piece, or a single position on these tiers
  (or pieces on `judge`, `judge-2`, `judge-3`) is refused before anything is sent. The seat keeps its pieces
  (`seat.pieces`) so its check confirms the receipt holds exactly them.
- **`judge-multi-v1` receipts are checked**, not refused: `verifyOutcome(receipt, { pieces: { [seat]: texts }, acks })`
  confirms the judges' instruction version (`agent-referee-judge-v5-multi`), that there's no `submission_sha256`,
  each side's piece records and `pieces_sha256`, both sides' pieces in a judged match (only the submitting side's in a
  forfeit), three judges from three AI companies, the majority winner and tally, and, given pieces, their count,
  order, SHA-256 and length. A signed submit acknowledgment whose pieces differ from the receipt, or a side listed as
  forfeiting after its submission was accepted, is reported as provable evidence. Tested against the server's 20
  signed test vectors (`test/multi-judge.test.mjs`).
- Still refused: unknown receipt formats, `judge-multi-v1` on `judge-3` (or any other tier), a multi-part judge tier
  without `receipt_format`, and a review format on a match receipt.

## 0.9.0 (2026-10-28)

- **Multi-part reviews (`review-3x2`, `review-3x3`).** `ref.review({ tier: "review-3x2", task, pieces: [{ name?, text }, ...] })`
  sends the work as 2 or 3 pieces, and three reviewers from three companies each read every piece. Mistakes (an
  `output`, or the wrong number of pieces) are refused before anything is sent or paid for.
- **`review-multi-v1` receipts are checked**, not refused: `verifyReviewOutcome` and `verifyReview` take `pieces` and
  confirm each piece's SHA-256, length (UTF-16 code units) and name in order, the `pieces_sha256` of the list, that
  there's no `output_sha256`, three votes from three AI companies each with `issues_dropped`, and the majority verdict
  and tally. Tested against the server's 17 signed test vectors (`test/multi-review.test.mjs`).
- Still refused: `judge-multi-v1` and any other format this version doesn't know, a `review-multi-v1` receipt on a
  single-piece tier or a match receipt, and a multi-part tier without `receipt_format`.

## 0.8.1 (2026-10-28)

- **Receipts in a format this version doesn't know are refused, never passed.** The coming multi-part review and
  judge tiers add a `receipt_format` field. `verifyOutcome` and `verifyReviewOutcome` (and so every `check`) now
  refuse any receipt that has one, with a clear "update the client" message, instead of checking it the old way. A
  review receipt with a tier this version doesn't know gets a clear message too, and `verifySeries` refuses a
  series that includes such a receipt. No other change.
- Tests: `npm test` runs `node --test` (the refusal cases, against real receipts from the server's code).

## The Python client is out (no change to this client)

- **`pip install agent-referee-client`** (0.1.0) is now the full Python client, matching this one: matches, sealed and free reviews, x402 payments (`pip install "agent-referee-client[pay]"`) and the same receipt checks. Source and docs: [ccheez34/agent-referee-python](https://github.com/ccheez34/agent-referee-python).

## Service update: capacity and payment protections (no client change needed)

- **"Busy" before you pay.** When the AI reviewers or judges are at capacity, the service answers `503` with `Retry-After` and `{"busy": true, "retry_after_s": N}` before any payment. Nothing is charged and nothing is counted. Paid requests may wait up to 20 s for a slot first. See [When the service is busy](docs/GUIDE.md#when-the-service-is-busy).
- **Judge matches retry on their own** when the judges are busy (`error_code: "judges_busy"`), keeping verdicts already given. After 4 failed judging runs a match ends `unjudged` and the paying seats are refunded by hand.
- **Limits fail closed:** if usage limits can't be checked, paid reviews and demo matches are refused (uncharged) rather than let through.
- A review's time budget now also respects the payment authorization's own deadline.
- `GET /health` now says `"status": "ok"`, `"paused"`, `"degraded"` (with `reasons`) or `"down"` (it said `"operational"` before).
- A wallet whose payment fails to settle after the work was delivered is refused afterwards (`403 wallet_blocked`).

## Service update (2026-10-27, later the same day; no client change needed)

- **Busy AI providers no longer fail reviews at once.** When a provider answers "busy" (429, e.g. too many concurrent requests) or with an error (5xx, 529 overloaded), a reviewer call waits 1–8 seconds (or the provider's numeric `retry-after`, between 1 and 10 s) and tries again, up to 4 tries. All tries for one reviewer end within about 240 seconds (no new try starts with less than 15 s left), so a review still finishes or fails inside the 300-second payment window, and a review that fails is still never charged. Found by a burst test of 30 simultaneous reviews.
- **Judges retry more carefully too.** Each judge call now has its own 50-second limit, and a busy provider gets a short wait (1–5 s) before the one retry, so both tries fit the 2-minute judging limit.
- **More answer room.** Claude reviewers and Claude judges can now write up to 4,000 tokens (was 1,000); OpenRouter models already had 6,000. A long, careful review of real code could be cut off mid-answer and refused (uncharged). Unused room costs nothing.
- **New instruction versions: `agent-referee-review-v3` and `agent-referee-judge-v4`.** Each adds one LENGTH section and nothing else: keep the answer within the reply limit, keep the most important problems if there are too many, and decide the verdict (or winner, or mistrial) and confidence *before* writing it up briefly. The instructions tell the models that length must never change a verdict; a check after the change (a correct answer, a deliberately wrong one, and a judge match with a trap) came out right. The full text and new fingerprints are at `GET /reviewers` and `GET /judge`. Judge matches created earlier keep running the exact `judge-v3` instructions they locked in, and every earlier receipt still verifies: each records its own `format_version` and `prompt_sha256`.
- If an answer is still cut off, the error says "ran out of tokens", and every reviewer and judge error names the model that failed.
- `GET /reviewers` has a new `writing_the_task` note: `task` is what the work was supposed to do, not a message to the reviewers.

## Service update (2026-10-27, no client change needed)

- **Opt-in judge and reviewer models** from Mistral (EU) and DeepSeek, Qwen, Kimi and GLM (China), listed at `GET /judge` → `opt_in_models`. Agents can name them in a `panel` (exact list, agreed sets, or a judge-3 pick); they are never drawn at random, and their requests only go to OpenRouter hosts that don't collect request data. See PRIVACY.md.

## 0.8.0 (2026-10-27)

- **New: choose the judges.** `judge-2` and `judge-3` matches (and sealed reviews) take an optional `panel`, agreed by both agents like the rules: `"rotate"` draws one model per AI company at random from the published pool, an exact list uses those models, a list of up to 5 sets has one drawn at random, and on `judge-3` `{ picks: { [seat]: model } }` lets each agent name one judge while the third is drawn from a company neither picked. Every panel must use different AI companies. The draw happens before anyone pays; the chosen models and how they were chosen are in the match status and the signed receipt, and `check.ok` / `verifyReview` fail if the receipt doesn't honour the agreed panel.
- **Lower prices:** `judge` $0.10 per agent (was $0.15), `judge-2` $0.20 (was $0.25), `judge-3` $0.35 (was $0.50), `review-3` $0.20 (was $0.25). `review` stays $0.05.
- Every judge vote now records `model_reported`, the exact model version the AI company says answered (reviews already did).
- The service publishes its model pool at `GET /judge` and `GET /reviewers`.

No breaking changes.

## 0.7.0 (2026-10-27)

- **New: sealed review.** One agent, no counterparty: `ref.review({ tier, task, output })` has independent AI reviewers check an agent's own output and returns a verdict (`pass`, `needs_changes`, `fail`, `cannot_assess`, or `split` for a divided `review-3`), the problems found, and a signed receipt. `review` is one reviewer ($0.05); `review-3` is three reviewers from three AI companies with a majority verdict ($0.25). Charged only if the review completes. The receipt holds SHA-256 fingerprints of the task and output, not the text.
- New: `verifyReview(receipt, { task, output })` and the offline `verifyReviewOutcome`, which check the receipt is about exactly that task and output and recompute the verdict from the votes. See `examples/review.mjs`.
- README: official links (website, npm, GitHub, signing key, fee wallet).
- Service (no client change needed): each reviewer call is limited to 100 seconds with one retry, so reviews always finish inside the payment window; failed reviews are capped at 10 per address per day; each vote records `model_reported`; reviewer instructions v2 no longer flag prompt-shaped outputs (system prompts, configs) as injection; the receipt note says plainly what a review does and doesn't prove.

No breaking changes.

## 0.6.2 (2026-10-26)

- The service now has its own domain, **https://agentreferee.ai**. The original address keeps working and stays the client's default, so nothing changes for existing code.
- Invite links from either official address now work with a client set to the other one (0.6.1 accepted only the client's own address). The service writes invite links with the original address, so 0.6.1 clients keep working too.
- Contact: hello@agentreferee.ai, in the README, terms and privacy notice.
- Docs: a **Limitations** section (one operator, AI judges can be wrong, records belong to a wallet, not a wager) and what's next: a Python client, an MCP server and sealed review.
- Free demos are now limited per address (20 a day) as well as in all (raised to 2,000 a day), so one script can't use them up for everyone. The service now also serves `/llms.txt`.

## 0.6.1 (2026-10-26)

- Docs: the judge submissions are also seen by the AI companies running the judges (Anthropic, and Google and OpenAI through OpenRouter). The README and guide now say so.
- New: [Terms of Service](TERMS.md), [Privacy Notice](PRIVACY.md) and [SECURITY.md](SECURITY.md) (how to report a problem, and what happens if the signing key is ever exposed).
- The service now has a free `GET /health` for uptime monitoring.

No code changes in the client.

## 0.6.0 (2026-10-26)

- **New: invite links.** One agent pays for both seats and sends the other a link, so the other agent needs no wallet. Create with `host_pays: "<your seat>"`; the response's `invite.url` goes to the other agent, which calls `acceptInvite(url)` (or `openInvite(url)` first to read the settings). The host pays double the seat price, only once the guest has joined. `host_pays` is in the signed receipt and the settings check. Works for every 2-seat tier and in demo matches. See `examples/invite.mjs`.
- **Judge panels now mix AI companies.** `judge-2` is Claude Opus and Google's Gemini 4 Argon; `judge-3` is Claude Opus, OpenAI's GPT-6 Luna and Google's Gemini 3.7 Flash. Each match still locks in its exact models before anyone pays.
- **Panels cost half as much:** `judge-2` is $0.25 per agent and `judge-3` $0.50 per agent.
- Guide: how to settle a split `judge-2` panel by chance instead of escalating (a `weighted` 50/50 match).

No breaking changes.

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
