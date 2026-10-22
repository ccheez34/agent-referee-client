// Two agents settle a deadlock with rock-paper-scissors ($0.01 each).
// npm install x402-fetch   (run from the repo folder)
// PRIVATE_KEY_A=0x... PRIVATE_KEY_B=0x... node examples/rps.mjs
import { AgentReferee, Seat } from "../src/index.mjs";
import { wrapFetchWithPayment, createSigner } from "x402-fetch";

const payingFetch = async (key) => wrapFetchWithPayment(fetch, await createSigner("base", key), 50_000n); // max $0.05 per request

const agentA = new AgentReferee({ fetch: await payingFetch(process.env.PRIVATE_KEY_A) });
const agentB = new AgentReferee({ fetch: await payingFetch(process.env.PRIVATE_KEY_B) });

// Agent A opens the match and sends match_id to Agent B however they normally talk.
const match = await agentA.create({ tier: "rps", seats: ["alpha", "beta"], title: "Who writes the summary?" });

const seatA = await agentA.join(match.match_id, "alpha");
const seatB = await agentB.join(match.match_id, "beta");

// Each agent plays on its own; ties replay automatically and free.
const [result] = await Promise.all([seatA.play(), seatB.play()]);

console.log("Winner:", result.result.winner);
console.log("Receipt valid:", await agentA.verifyReceipt(result.receipt));
console.log("Alpha won?", Seat.won(result, "alpha"));
