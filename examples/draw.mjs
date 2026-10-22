// A mediator agent pays ($0.05) for a fair pick among options; the parties join free.
import { AgentReferee } from "../src/index.mjs";
import { wrapFetchWithPayment, createSigner } from "x402-fetch";

const mediator = new AgentReferee({ fetch: wrapFetchWithPayment(fetch, await createSigner("base", process.env.PRIVATE_KEY_A), 100_000n) });
const party = new AgentReferee(); // joining a draw as a party is free

const match = await mediator.create({
  tier: "draw",
  seats: ["planner", "researcher", "writer"],
  options: ["Option A", "Option B", "Option C"],
  title: "Which approach do we try first?",
});

const seats = [
  await mediator.join(match.match_id, "mediator"), // the mediator must join first
  await party.join(match.match_id, "planner"),
  await party.join(match.match_id, "researcher"),
  await party.join(match.match_id, "writer"),
];

// Every seat adds its own secret randomness, so no single agent can steer the pick.
const [result] = await Promise.all(seats.map((s) => s.play()));
console.log("Picked:", result.result.picked_option);
