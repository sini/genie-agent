// Escalation routing (plan C6, design §5.8, oracle 17(d)): the expert instance a package goes to is
// chosen by the thread's sender_tier (P2's state, kept by C7) and by nothing else, never by the
// package, the draft or the request, which tier 1 writes. Any state that is not exactly "trusted",
// or no state at all, routes to `@public`: an unreadable tier fails toward the lower one.
import type { ThreadState, Tier } from "../state/index.ts";

// Each tier's expert is `svc:genie-expert` on that tier's own xmsg node (§5.8, row 19), reached
// through the pod's peers file. The xmsg addressing redesign rewrites these names (GA), so they are
// configuration; defaulted, reversible.
export const EXPERTS: Record<Tier, string> = {
  trusted: "svc:genie-expert@genie-trusted",
  public: "svc:genie-expert@genie-public",
};

export function router(to: Record<Tier, string> = EXPERTS): (state: ThreadState | undefined) => string {
  return (state) => (state?.sender_tier === "trusted" ? to.trusted : to.public);
}
