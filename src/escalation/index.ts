// Escalation (plan C5, design §4 steps 4–6, §5.8 Talk): the supervisor decides from tier 1's draft
// whether the thread goes to the expert tier, and sends the package over xmsg. A draft with
// `escalate_forced`, or with a confidence below the threshold, sends at once; any other waits for
// 🔍. The package passes the escalation guard (S5) before it leaves, and is stamped with the
// supervisor's thread id after it, never with one the model or the guard wrote. The destination is
// the router's (C6), from the thread state.
//
// Delivery is at most once (X10): a package's key is its thread and the sequence number of the draft
// it carries, so a 🔍 repeated on the same draft, or a retry after a lost response, resends the same
// body under the same key and xmsg delivers nothing new.
import type { ThreadState, ThreadStateStore } from "../state/index.ts";
import type { Draft } from "../tier1/draft.ts";
import { errors, load } from "../tier1/schema.ts";

// Conservative (design §4: "initially conservative"): only a draft tier 1 scored in the escalation
// skill's high band, its central claim checked by eval, source or recall, reaches the asker
// unreviewed. Configuration; defaulted, reversible.
export const THRESHOLD = 0.8;

// What C5 needs of xmsg: one send to an address under an idempotency key. A send repeated with the
// same key and body returns the first send's message id and delivers nothing (X10).
export interface XmsgSend {
  send(to: string, text: string, key: string): Promise<string>;
}

// The package as tier 1's turn leaves it, before the guard and the stamp.
export type Package = { cleaned_question: string; draft: Draft; eval_transcript: unknown[]; gaps: string[] };

export interface EscalationOptions {
  store: ThreadStateStore;
  xmsg: XmsgSend;
  // S5: the package as it may leave the pod, or a throw that refuses it.
  guard: (pkg: Package) => Promise<Package>;
  // C6: the expert instance's xmsg address for the thread.
  route: (state: ThreadState) => string;
  // The supervisor's record of the thread: its cleaned question and its evals, in order.
  context: (thread: string) => { cleaned_question: string; eval_transcript: unknown[] };
  threshold?: number;
}

const schema = load("escalation");

export class Escalation {
  private o: EscalationOptions;
  private chains = new Map<string, Promise<unknown>>();

  constructor(o: EscalationOptions) {
    this.o = o;
  }

  // Tier 1's `reply`: the thread's latest draft. Resolves to the message id when it sent.
  reply(thread: string, draft: Draft): Promise<string | null> {
    return this.draft(thread, { ...this.o.context(thread), draft, gaps: draft.gaps });
  }

  // Tier 1's `escalate`: its package, decided by its draft like a reply.
  escalate(thread: string, pkg: Package): Promise<string | null> {
    return this.draft(thread, pkg);
  }

  // 🔍 on the thread: send its latest draft whatever it says.
  deeper(thread: string): Promise<string> {
    return this.serial(thread, () => this.send(thread));
  }

  private draft(thread: string, pkg: Package): Promise<string | null> {
    return this.serial(thread, () => {
      const seq = (this.o.store.escalation(thread)?.seq ?? 0) + 1;
      this.o.store.setEscalation(thread, { seq, pkg });
      const { escalate_forced, confidence } = pkg.draft;
      return escalate_forced || confidence < (this.o.threshold ?? THRESHOLD) ? this.send(thread) : null;
    });
  }

  private async send(thread: string): Promise<string> {
    const { store, xmsg, guard, route } = this.o;
    const rec = store.escalation(thread);
    const st = store.read(thread);
    if (!rec || !st) throw new Error(`thread ${thread}: no draft to escalate`);
    let body = rec.body;
    if (body === undefined) {
      const stamped = { ...(await guard(rec.pkg as Package)), thread_id: thread };
      const bad = errors(schema, stamped);
      if (bad.length) throw new Error(`thread ${thread}: escalation refused: ${bad.join("; ")}`);
      body = JSON.stringify(stamped);
      store.setEscalation(thread, { ...rec, body });
    }
    const id = await xmsg.send(route(st), body, `${thread}#${rec.seq}`);
    store.write({ ...st, status: "escalated" });
    return id;
  }

  // One step at a time per thread, so two 🔍 never guard one draft twice.
  private serial<T>(thread: string, f: () => T | Promise<T>): Promise<T> {
    const run = (this.chains.get(thread) ?? Promise.resolve()).then(f, f);
    this.chains.set(thread, run.catch(() => {}));
    return run;
  }
}
