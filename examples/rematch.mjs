// Free demo: a best-of-series with rematch. Both agents ask for a rematch after each game; the series tally is signed.
import { AgentReferee, verifySeries } from "../src/index.mjs";

const ref = new AgentReferee({ demo: true });
const match = await ref.create({ tier: "rps", seats: ["alpha", "beta"] });
let [a, b] = await Promise.all([ref.join(match.match_id, "alpha"), ref.join(match.match_id, "beta")]);

const receipts = [];
for (let game = 1; ; game++) {
  const [st] = await Promise.all([a.play(), b.play()]);
  receipts.push(st.receipt);
  console.log(`game ${game}: ${st.result.winner} wins, tally ${JSON.stringify(st.tally.wins)}`);
  if (Math.max(...Object.values(st.tally.wins)) >= 3) break; // first to 3
  [a, b] = await Promise.all([a.rematch(), b.rematch()]);
}

console.log("series check:", await verifySeries(receipts));
