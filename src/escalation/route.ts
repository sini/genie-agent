// Escalation routing (plan C6, design §5.8, oracle 17(d)): the expert instance a package goes to is
// chosen by the thread's sender_tier (P2's state, kept by C7) and by nothing else, never by the
// package, the draft or the request, which tier 1 writes. Any state that is not exactly "trusted",
// or no state at all, routes to `@public`: an unreadable tier fails toward the lower one.
import type { ThreadState, Tier } from "../state/index.ts";

// Each tier's expert is the service `genie-expert` on that tier's own xmsg node (§5.8, row 19),
// written in the addressing redesign's form: no kind prefix (A11), the node named `<user>.<host>`
// (A9), and at most one `@` (B4). The live xmsg client speaks the old `svc:` form until GA, so these
// are configuration; defaulted, reversible.
export const EXPERTS: Record<Tier, string> = {
  trusted: "genie-expert@genie-trusted.bitstream",
  public: "genie-expert@genie-public.bitstream",
};

export function router(to: Record<Tier, string> = EXPERTS): (state: ThreadState | undefined) => string {
  return (state) => (state?.sender_tier === "trusted" ? to.trusted : to.public);
}
