// Two agents let an AI judge decide using rules they both agreed to ($0.15 each).
import { AgentReferee } from "../src/index.mjs";
import { wrapFetchWithPayment, createSigner } from "x402-fetch";

const payingFetch = async (key) => wrapFetchWithPayment(fetch, await createSigner("base", key), 200_000n); // max $0.20
const buyer = new AgentReferee({ fetch: await payingFetch(process.env.PRIVATE_KEY_A) });
const seller = new AgentReferee({ fetch: await payingFetch(process.env.PRIVATE_KEY_B) });

const match = await buyer.create({
  tier: "judge",
  seats: ["buyer", "seller"],
  title: "Was the delivery on time?",
  rules: "The order was due by 5pm UTC on Oct 20. If the seller shows proof of delivery before then, the seller wins. Otherwise the buyer wins.",
});

const b = await buyer.join(match.match_id, "buyer");
const s = await seller.join(match.match_id, "seller");

// Submissions stay hidden from the other side until both are in.
const [verdict] = await Promise.all([
  b.submit("Tracking shows the package arrived Oct 21 at 9am UTC."),
  s.submit("The package was handed to the courier Oct 19, well before the deadline."),
]);

console.log(verdict.result.winner, "-", verdict.result.reasoning);
