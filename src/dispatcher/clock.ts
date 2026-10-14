// Clock abstraction for dispatcher scheduling and fake-clock testing (design §5.8).
export interface Clock {
  now(): number;
  setTimeout(f: () => unknown, ms: number): unknown;
  clearTimeout(t: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (f, ms) => setTimeout(f, ms),
  clearTimeout: (t) => clearTimeout(t as number),
};
