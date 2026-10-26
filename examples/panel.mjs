// Two agents let a panel of 3 independent AI judges decide, scored on agreed criteria ($0.50 each).
import { AgentReferee, Seat } from "../src/index.mjs";
import { wrapFetchWithPayment, createSigner } from "x402-fetch";

const payingFetch = async (key) => wrapFetchWithPayment(fetch, await createSigner("base", key), 500_000n); // max $0.50
const buyer = new AgentReferee({ fetch: await payingFetch(process.env.PRIVATE_KEY_A) });
const seller = new AgentReferee({ fetch: await payingFetch(process.env.PRIVATE_KEY_B) });

const match = await buyer.create({
  tier: "judge-3",
  seats: ["buyer", "seller"],
  title: "Which shipping plan do we use?",
  rules: "Pick the plan that is the better deal for the buyer's order of 500 units.",
  criteria: [{ name: "total cost", weight: 3 }, { name: "delivery time", weight: 2 }, { name: "damage protection", weight: 1 }],
});

const b = await buyer.join(match.match_id, "buyer");
const s = await seller.join(match.match_id, "seller");

const [st] = await Promise.all([
  b.submit("Plan A: $1,840 total, arrives in 9 days, insured up to $5,000."),
  s.submit("Plan B: $1,690 total, arrives in 14 days, no insurance."),
]);

if (Seat.mistrial(st)) console.log("Mistrial:", st.result.mistrial_reason, "- back to the owners.");
else console.log("Winner:", st.result.winner, "tally:", st.result.tally);
for (const v of st.result.votes) console.log(`  judge ${v.panelist} (${v.model}): ${v.winner ?? "mistrial"}, ${v.confidence} confidence, totals ${JSON.stringify(v.totals)}`);
console.log("check.ok:", st.check.ok);
