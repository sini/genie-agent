// The per-thread eval lock (design oracle 15): one eval in flight per thread, the next request on that
// thread waiting for it, other threads free. It wraps whatever runs a launch, the local bwrap runner or
// the k8s Job (E3), so both backends inherit it.
import type { EvalResult, Launch } from "./run.ts";

export type Runner = (launch: Launch) => Promise<EvalResult>;

// The thread is the caller's, the supervisor's that holds the thread, as sender_tier is: never a field
// of the request the model writes. Requests on one thread run in arrival order. A run that fails or
// times out releases the thread.
export function perThread(run: Runner): (thread: string, launch: Launch) => Promise<EvalResult> {
  const tails = new Map<string, Promise<void>>();
  return (thread, launch) => {
    const result = (tails.get(thread) ?? Promise.resolve()).then(() => run(launch));
    const tail = result.then(
      () => {},
      () => {},
    );
    tails.set(thread, tail);
    // An idle thread holds no entry.
    tail.then(() => tails.get(thread) === tail && tails.delete(thread));
    return result;
  };
}
