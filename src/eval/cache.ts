// The eval-result cache (plan E6, design §6): keyed (repo, rev, attr, flags).
// Wraps a runner with thread-state caching so a second identical request runs 0 evals.
import type { CacheKey } from "../state/index.ts";
import { effectiveTier, type EvalResult, type Launch } from "./run.ts";

export type { CacheKey };

export interface EvalCacheStore {
  cacheGet(thread: string, key: CacheKey): unknown;
  cachePut(thread: string, key: CacheKey, value: unknown): void;
}

export function cacheKeyFor(launch: Launch): CacheKey {
  const flags =
    (launch as unknown as { flags?: string[] }).flags ??
    (launch.request as unknown as { flags?: string[] }).flags ??
    (effectiveTier(launch) === "trusted" ? ["trusted"] : []);
  return {
    repo: launch.request.repo,
    rev: launch.request.rev,
    attr: launch.request.attr,
    flags,
  };
}

export type ThreadRunner = (thread: string, launch: Launch) => Promise<EvalResult>;
export type Runner = (launch: Launch) => Promise<EvalResult>;

// Cache only results the eval itself determined: exit 0 with limit_hit "none", plus a
// deterministic evaluation error (non-zero exit with limit_hit "none", e.g. a Nix eval error).
// Transient limit hits (timeout, oom, egress, unknown) must never be cached.
export const isCacheable = (result: EvalResult): boolean => result.limit_hit === "none";

// Wraps a thread-aware runner (such as perThread) with thread-state eval result caching.
export function withCache(
  store: EvalCacheStore,
  run: ThreadRunner,
): ThreadRunner {
  return async (thread: string, launch: Launch) => {
    const key = cacheKeyFor(launch);
    const cached = store.cacheGet(thread, key) as EvalResult | undefined;
    if (cached !== undefined) {
      return cached;
    }
    const result = await run(thread, launch);
    if (isCacheable(result)) {
      store.cachePut(thread, key, result);
    }
    return result;
  };
}

// Wraps a standalone runner for a specific thread with thread-state eval result caching.
export function cachedRunner(
  store: EvalCacheStore,
  thread: string,
  run: Runner,
): Runner {
  const wrapped = withCache(store, (_, launch) => run(launch));
  return (launch: Launch) => wrapped(thread, launch);
}
