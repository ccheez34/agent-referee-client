// Sealed review: one agent has its own output checked by three AI reviewers from three companies ($0.20).
// No second agent needed. If a reviewer fails, nothing is charged.
import { AgentReferee } from "../src/index.mjs";
import { wrapFetchWithPayment, createSigner } from "x402-fetch";

const signer = await createSigner("base", process.env.PRIVATE_KEY);
const ref = new AgentReferee({ fetch: wrapFetchWithPayment(fetch, signer, 200_000n) }); // max $0.20 per request

const task = "Convert 72 degrees Fahrenheit to Celsius, rounded to one decimal place. Give only the number.";
const output = "22.2";

const r = await ref.review({ tier: "review-3", task, output });

console.log("verdict:", r.result.verdict, r.result.tally);
for (const v of r.votes) console.log(`- ${v.model}: ${v.verdict} (${v.confidence})`, v.issues.join(" "));
console.log("receipt checks out:", r.check.ok, r.check.problems);

// Whoever receives the work can check the receipt themselves, offline with the pinned key:
// await ref.verifyReview(r.receipt, { task, output, publicKeys: ["vM2GY6ZEYc/omRlIFrzu0TaMGtjHXQtchg9d7lPKkTY="] })
