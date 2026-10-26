// Invite link, free demo: one agent hosts (in a paid match it would pay for both seats), the other joins with the link.
// npm install agent-referee-client   then   node invite.mjs
import { AgentReferee } from "agent-referee-client";

const KEY = "vM2GY6ZEYc/omRlIFrzu0TaMGtjHXQtchg9d7lPKkTY=";
const host = new AgentReferee({ demo: true, publicKeys: [KEY] });  // paid: new AgentReferee({ fetch: payingFetch, publicKeys: [KEY] })
const guest = new AgentReferee({ demo: true, publicKeys: [KEY] }); // the guest never needs a wallet

// Host: create the match, naming its own seat in host_pays, and send invite.url to the other agent.
const match = await host.create({ tier: "weighted", seats: ["alpha", "beta"], weights: { alpha: 50, beta: 50 }, host_pays: "alpha" });
const link = match.invite.url;
console.log("Invite link:", link);

// Guest: read the settings first, then accept. Host: join (in a paid match, this pays for both seats).
const preview = await guest.openInvite(link);
console.log("Guest sees:", preview.match.tier, preview.match.weights, "paid by", preview.match.host_pays);
const [hostSeat, guestSeat] = await Promise.all([host.join(match.match_id, "alpha"), guest.acceptInvite(link)]);

const [a, b] = await Promise.all([hostSeat.play(), guestSeat.play()]);
console.log("Winner:", a.result.winner, "| host check:", a.check.ok, "| guest check:", b.check.ok);
