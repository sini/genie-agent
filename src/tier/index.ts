// The thread's tier (plan C7, design §5.1 and rows 22-24). It is the lowest tier among the senders
// whose text the thread carries, read from each line's authenticated `tier` tag in matrix-xmsg's
// raw envelope (M5d, M11) before guard-in, never from any line's text or guard-in's cleaned_text.
// It falls when a public sender's text enters and rises only on a trusted sender's `!trust`
// (row 23), which sanctions the participants present at that point: their later lines keep it
// trusted, a new public participant lowers it again. Room background a bootstrap carries does not
// count when the thread's initiator is trusted (row 22).
import type { ThreadStateStore, Tier, TrustState } from "../state/index.ts";

// One relayed line: matrix-xmsg's RelayedLine less its text, which no tier is read from. sender is
// matrix-xmsg's mapped sender name for presentation; sender_id is the injective mxid, the
// participant's identity for trust.
export interface Line {
  sender: string;
  sender_id: string;
  tier: Tier;
}

export interface Envelope {
  bootstrap: boolean;
  request: Line;
  thread: Line[];
  background: Line[];
}

// The `!trust` control (row 23). M12 owes it: matrix-xmsg forwards an in-thread `!trust` as this
// record, separate from any envelope, with the sender's authenticated tier, mxid and the `!trust` event.
export interface TrustControl {
  control: "trust";
  sender: string;
  sender_id: string;
  tier: Tier;
  event_id: string;
}

export type TierState = TrustState & { tier: Tier };

const TIERS: readonly string[] = ["trusted", "public"];

export function isId(s: string): boolean {
  return s.startsWith("@") && s.includes(":");
}

function line(raw: string): Line {
  const o = JSON.parse(raw) as { sender?: unknown; sender_id?: unknown; tier?: unknown };
  if (
    typeof o.sender !== "string" ||
    typeof o.sender_id !== "string" ||
    !o.sender_id ||
    typeof o.tier !== "string" ||
    !TIERS.includes(o.tier)
  )
    throw new Error(`thread tier: envelope line without a sender, sender_id and tier: ${raw}`);
  return { sender: o.sender, sender_id: o.sender_id, tier: o.tier as Tier };
}

// matrix-xmsg's envelope (src/context.rs, build_envelope_with_rewrite): a `[matrix]` header, the
// trigger's line in `<request>`, then `<context role="background|thread" context="bootstrap|delta">`
// blocks of one JSON line each. Every line is JSON-escaped and its `<request`/`<context` tags
// escaped, so message text cannot open or close a block. The header's `(tier)` is not read.
export function parseEnvelope(raw: string): Envelope {
  const req: Line[] = [];
  const env = { bootstrap: false, thread: [] as Line[], background: [] as Line[] };
  let into: Line[] | undefined;
  for (const l of raw.split("\n")) {
    if (l === "<request>") into = req;
    else if (l.startsWith("<context ")) {
      const role = / role="([a-z]+)"/.exec(l)?.[1];
      if (role !== "thread" && role !== "background") throw new Error(`thread tier: unknown context role in ${l}`);
      env.bootstrap ||= / context="bootstrap"/.test(l);
      into = env[role];
    } else if (l === "</request>" || l === "</context>") into = undefined;
    else if (into && l) into.push(line(l));
    else if (l && !l.startsWith("[matrix] ")) throw new Error(`thread tier: unexpected envelope line: ${l}`);
  }
  if (req.length !== 1) throw new Error(`thread tier: envelope with ${req.length} request lines`);
  return { ...env, request: req[0] };
}

// The tier after one envelope or control. prev is undefined for a thread's first envelope.
export function step(prev: TierState | undefined, input: Envelope | TrustControl): TierState {
  if ("control" in input) {
    if (!prev) throw new Error("thread tier: !trust on a thread with no envelope");
    if (typeof input.sender_id !== "string" || !input.sender_id)
      throw new Error(`thread tier: !trust control without a sender_id: ${JSON.stringify(input)}`);
    if (input.tier !== "trusted") return prev;
    const present = [...new Set([...prev.participants, input.sender_id])];
    return { ...prev, tier: "trusted", participants: present, sanctioned: present };
  }
  const s: TierState = prev ? { ...prev } : { tier: input.request.tier, initiator: input.request.tier, participants: [], sanctioned: [] };
  const counted = [...(input.bootstrap && s.initiator === "trusted" ? [] : input.background), ...input.thread, input.request];
  for (const l of counted) {
    if (l.tier === "public" && !s.sanctioned.includes(l.sender_id)) s.tier = "public";
    if (!s.participants.includes(l.sender_id)) s.participants = [...s.participants, l.sender_id];
  }
  return s;
}

// Apply one input to the thread's stored tier: sender_tier in its P2 state, the rest beside it. A
// thread whose state predates C7 starts from its stored tier with nobody sanctioned. A thread
// whose stored state predates C7.1 (keyed by display names with no injective IDs) drops to its
// untrusted tier (public) until a trusted sender !trusts it again (fail closed).
export function observe(store: ThreadStateStore, thread: string, input: Envelope | TrustControl, now = new Date().toISOString()): Tier {
  const st = store.read(thread);
  const raw = st && (store.trust(thread) ?? { initiator: st.sender_tier, participants: [], sanctioned: [] });
  let prev: TierState | undefined;
  if (st && raw) {
    const hasLegacy = raw.sanctioned.some((s) => !isId(s)) || (raw.participants.length > 0 && !raw.participants.some(isId));
    if (hasLegacy) {
      prev = { tier: "public", initiator: raw.initiator, participants: raw.participants.filter(isId), sanctioned: [] };
    } else {
      prev = { tier: st.sender_tier, ...raw };
    }
  }
  const { tier, ...trust } = step(prev, input);
  store.write({ thread_id: thread, status: "active", created: now, last_active: now, ...st, sender_tier: tier });
  store.setTrust(thread, trust);
  return tier;
}
