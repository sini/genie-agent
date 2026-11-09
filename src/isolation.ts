import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export const BASELINE_ISOLATION = "baseline: credential custody, no OS isolation";
export const BWRAP_ISOLATION = "bwrap: credential custody, Linux namespaces";

export function executable(name: string): string | undefined {
  const candidates = name.includes("/") ? [name] : (process.env.PATH ?? "").split(":").filter(Boolean).map((dir) => `${dir}/${name}`);
  for (const candidate of candidates) {
    try { if (existsSync(candidate)) return resolve(candidate); } catch {}
  }
  return undefined;
}

const probes = new Map<string, boolean>();
// A present bwrap may be unusable under the host's namespace policy.
export function usableBwrap(candidate = "bwrap", namespaces: string[] = []): string | undefined {
  if (process.platform !== "linux") return undefined;
  const bin = executable(candidate);
  if (!bin) return undefined;
  const key = `${bin}\0${namespaces.join("\0")}`;
  let usable = probes.get(key);
  if (usable === undefined) {
    const marker = "genie-namespace-probe";
    const printf = executable("printf");
    if (!printf) return undefined;
    // The trivial probe must not orphan a bwrap init when Root itself is PID 1.
    const result = spawnSync(bin, [
      "--die-with-parent", "--new-session", "--unshare-user", "--unshare-pid", "--as-pid-1", ...namespaces,
      "--ro-bind", "/", "/", "--bind", "/proc", "/proc", "--", printf, "%s", marker,
    ], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, encoding: "utf8", timeout: 5000 });
    usable = result.status === 0 && result.stdout === marker;
    probes.set(key, usable);
  }
  return usable ? bin : undefined;
}
