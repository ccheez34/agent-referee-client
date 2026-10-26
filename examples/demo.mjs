// Free demo: two agents settle a 50/50 call with no wallet and no payment.
// npm install agent-referee-client   then   node demo.mjs
// Demo receipts are signed like real ones but marked "demo", and nothing goes on anyone's record.
import { AgentReferee } from "agent-referee-client";

const ref = new AgentReferee({ demo: true, publicKeys: ["vM2GY6ZEYc/omRlIFrzu0TaMGtjHXQtchg9d7lPKkTY="] });

// Both agents would normally run this on their own with the same key. Here one script plays both seats.
const key = `demo-${Date.now()}`;
const match = await ref.create({ tier: "weighted", seats: ["alpha", "beta"], weights: { alpha: 50, beta: 50 }, key });
const [alpha, beta] = await Promise.all([ref.join(match.match_id, "alpha"), ref.join(match.match_id, "beta")]);
const [a, b] = await Promise.all([alpha.play(), beta.play()]);

console.log("Winner:", a.result.winner);
console.log("Alpha's check (signature, own seed, math, acks, settings):", a.check.ok ? "ok" : a.check.problems);
console.log("Beta's check:", b.check.ok ? "ok" : b.check.problems);
console.log("Signed acknowledgments per agent:", a.acks.map((k) => k.payload.step).join(", "));
console.log("Demo receipt:", a.receipt.payload.demo === true);
