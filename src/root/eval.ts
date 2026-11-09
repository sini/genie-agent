import { readFileSync } from "node:fs";
import { K8sClient, k8sRunner, type BuilderConfig } from "../eval/k8s.ts";
import type { Runner } from "../eval/lock.ts";
import { runEval, type RunOptions } from "../eval/run.ts";

export interface KubernetesConfig {
  baseUrl: string;
  namespace: string;
  image: string;
  tokenFile?: string;
  runtimeClassName?: string;
  cpu?: string;
  source?: { claimName: string; subPath?: string };
  store: { claimName: string; subPath?: string };
  scratchLimit?: string;
  builderKeySecretName?: string;
  builderKeyMountPath?: string;
  builderKeyFileName?: string;
  builder?: BuilderConfig;
}

export interface EvalConfig extends Pick<RunOptions, "timeoutMs" | "builders" | "memoryMax" | "bwrap"> {
  backend?: "local" | "kubernetes";
  kubernetes?: KubernetesConfig;
}

export function validateEvalConfig(config: EvalConfig = {}): void {
  if (config.backend !== undefined && config.backend !== "local" && config.backend !== "kubernetes") throw new Error("unknown eval backend");
  if (config.backend !== "kubernetes") {
    if (config.kubernetes !== undefined) throw new Error("eval.kubernetes requires the kubernetes backend");
    return;
  }
  const k = config.kubernetes;
  if (!k || !k.baseUrl || !k.namespace || !k.image || !k.store?.claimName) throw new Error("kubernetes eval requires baseUrl, namespace, image and store.claimName");
  const url = new URL(k.baseUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("invalid Kubernetes API URL");
  if (config.bwrap) throw new Error("eval.bwrap belongs to the local backend");
}

export function configuredEval(config: EvalConfig = {}, worktreeRoot: string): Runner {
  validateEvalConfig(config);
  if (config.backend !== "kubernetes") return (launch) => runEval(launch, { ...config, worktreeRoot });
  const k = config.kubernetes!;
  const client = new K8sClient({ baseUrl: k.baseUrl, namespace: k.namespace, timeoutMs: config.timeoutMs, token: k.tokenFile ? readFileSync(k.tokenFile, "utf8").trim() : undefined });
  return k8sRunner({
    client, namespace: k.namespace, image: k.image, runtimeClassName: k.runtimeClassName,
    storeClaimName: k.store.claimName, storeSubPath: k.store.subPath,
    repoClaimName: k.source?.claimName, repoSubPath: k.source?.subPath, worktreeRoot,
    timeoutMs: config.timeoutMs, memoryMax: config.memoryMax, cpu: k.cpu, scratchLimit: k.scratchLimit,
    builders: config.builders, builder: k.builder, builderKeySecretName: k.builderKeySecretName,
    builderKeyMountPath: k.builderKeyMountPath, builderKeyFileName: k.builderKeyFileName,
  });
}
