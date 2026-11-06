// Read-only GitHub inspection tool `gh_read` (GC1 §2.4, GAP-10, OQ-2, OQ-4, F8, P2).
// Runs inside genie-root on the host side of the C1 JSON-line bridge; its optional fine-grained
// zero-permission read token (`githubReadTokenFile`) is read at request time in genie-root and
// never enters `pi`'s bubblewrap jail.
import { readFileSync } from "node:fs";
import { isValidRepoCoord } from "../mirror/index.ts";

export const GH_NUMERIC_ID_RE = /^[1-9][0-9]{0,9}$/;
export const GH_GIST_ID_RE = /^[0-9a-f]{20,40}$/;

export type GhReadKind =
  | "issue"
  | "issue_list"
  | "pr"
  | "pr_list"
  | "pr_diff"
  | "pr_checks"
  | "gist"
  | "run";

export interface GhReadRequest {
  kind: GhReadKind;
  repo?: string;
  id?: string;
  state?: "open" | "closed" | "all";
  limit?: number;
}

export interface GhReadMutants {
  // M-gh-read-bypass-id-validation: skips GH_NUMERIC_ID_RE / GH_GIST_ID_RE and encodeURIComponent.
  bypassIdValidation?: boolean;
  // M-gh-read-follow-redirect: changes redirect: "manual" to redirect: "follow" and skips 3xx refusal.
  followRedirect?: boolean;
}

export interface GhReadOptions {
  githubApi?: string;
  tokenFile?: string | null;
  timeoutMs?: number;
  maxBytes?: number;
  mutants?: GhReadMutants;
}

export async function ghRead(req: GhReadRequest, opts: GhReadOptions = {}): Promise<unknown> {
  if (!req || typeof req !== "object") {
    throw new Error("gh_read: request must be an object");
  }
  const { kind } = req;
  const validKinds: GhReadKind[] = ["issue", "issue_list", "pr", "pr_list", "pr_diff", "pr_checks", "gist", "run"];
  if (!validKinds.includes(kind)) {
    throw new Error(`gh_read: unsupported kind: ${String(kind)}`);
  }

  const bypassId = opts.mutants?.bypassIdValidation === true;

  // Validate repo
  if (kind === "gist") {
    if (req.repo !== undefined) {
      throw new Error("gh_read: repo is not permitted for kind 'gist'");
    }
  } else {
    if (typeof req.repo !== "string" || !isValidRepoCoord(req.repo)) {
      throw new Error(`gh_read: invalid repo coordinate: ${String(req.repo)}`);
    }
  }

  // Validate id
  if (kind === "issue_list" || kind === "pr_list") {
    if (req.id !== undefined) {
      throw new Error(`gh_read: id is not permitted for kind '${kind}'`);
    }
  } else if (kind === "gist") {
    if (typeof req.id !== "string" || (!bypassId && !GH_GIST_ID_RE.test(req.id))) {
      throw new Error(`gh_read: invalid gist id: ${String(req.id)}`);
    }
  } else {
    if (typeof req.id !== "string" || (!bypassId && !GH_NUMERIC_ID_RE.test(req.id))) {
      throw new Error(`gh_read: invalid numeric id: ${String(req.id)}`);
    }
  }

  // Validate state and limit
  if (req.state !== undefined) {
    if (kind !== "issue_list" && kind !== "pr_list") {
      throw new Error(`gh_read: state is only permitted for issue_list and pr_list`);
    }
    if (req.state !== "open" && req.state !== "closed" && req.state !== "all") {
      throw new Error(`gh_read: invalid state: ${String(req.state)}`);
    }
  }
  const state = req.state ?? "open";

  if (req.limit !== undefined) {
    if (kind !== "issue_list" && kind !== "pr_list") {
      throw new Error(`gh_read: limit is only permitted for issue_list and pr_list`);
    }
    if (typeof req.limit !== "number" || !Number.isInteger(req.limit) || req.limit < 1 || req.limit > 30) {
      throw new Error(`gh_read: invalid limit: ${String(req.limit)}`);
    }
  }
  const limit = req.limit ?? 10;

  const baseRaw = (opts.githubApi ?? "https://api.github.com").replace(/\/+$/, "");
  const baseUrl = new URL(baseRaw);
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxBytes = opts.maxBytes ?? 16_384;

  const token = opts.tokenFile ? readFileSync(opts.tokenFile, "utf8").trim() : undefined;
  const enc = (s: string) => (bypassId ? s : encodeURIComponent(s));

  const fetchEndpoint = async (pathAndQuery: string, accept = "application/vnd.github+json"): Promise<string> => {
    const targetUrl = new URL(`${baseRaw}${pathAndQuery}`);
    if (!bypassId && targetUrl.origin !== baseUrl.origin) {
      throw new Error(`gh_read: origin mismatch: ${targetUrl.origin}`);
    }
    const headers: Record<string, string> = {
      Accept: accept,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "genie-agent",
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    const res = await fetch(targetUrl.toString(), {
      method: "GET",
      headers,
      redirect: opts.mutants?.followRedirect ? "follow" : "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!opts.mutants?.followRedirect && res.status >= 300 && res.status < 400) {
      throw new Error("gh_read: HTTP redirect refused");
    }
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`gh_read ${pathAndQuery}: HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return text.length > maxBytes ? text.slice(0, maxBytes) : text;
  };

  const fetchJson = async (pathAndQuery: string): Promise<unknown> => {
    const raw = await fetchEndpoint(pathAndQuery);
    return JSON.parse(raw);
  };

  if (kind === "gist") {
    const idSeg = enc(req.id!);
    return fetchJson(`/gists/${idSeg}`);
  }

  const [owner, name] = req.repo!.split("/");
  const repoPath = `/repos/${enc(owner!)}/${enc(name!)}`;

  switch (kind) {
    case "issue": {
      const idSeg = enc(req.id!);
      const issue = await fetchJson(`${repoPath}/issues/${idSeg}`);
      const comments = await fetchJson(`${repoPath}/issues/${idSeg}/comments?per_page=10`);
      return { issue, comments };
    }
    case "issue_list": {
      const items = await fetchJson(`${repoPath}/issues?state=${encodeURIComponent(state)}&per_page=${limit}`);
      return { issues: items };
    }
    case "pr": {
      const idSeg = enc(req.id!);
      const pull = await fetchJson(`${repoPath}/pulls/${idSeg}`);
      const comments = await fetchJson(`${repoPath}/issues/${idSeg}/comments?per_page=10`);
      return { pull, comments };
    }
    case "pr_list": {
      const items = await fetchJson(`${repoPath}/pulls?state=${encodeURIComponent(state)}&per_page=${limit}`);
      return { pulls: items };
    }
    case "pr_diff": {
      const idSeg = enc(req.id!);
      const diff = await fetchEndpoint(`${repoPath}/pulls/${idSeg}`, "application/vnd.github.v3.diff");
      return { diff, truncated: diff.length >= maxBytes };
    }
    case "pr_checks": {
      const idSeg = enc(req.id!);
      const pull = (await fetchJson(`${repoPath}/pulls/${idSeg}`)) as { head?: { sha?: string } };
      const sha = pull?.head?.sha;
      if (typeof sha !== "string" || !/^[0-9a-f]{40}$/i.test(sha)) {
        throw new Error("gh_read pr_checks: pull response missing valid head.sha");
      }
      const checks = await fetchJson(`${repoPath}/commits/${encodeURIComponent(sha)}/check-runs?per_page=30`);
      return { head_sha: sha, check_runs: checks };
    }
    case "run": {
      const idSeg = enc(req.id!);
      const run = await fetchJson(`${repoPath}/actions/runs/${idSeg}`);
      const jobs = await fetchJson(`${repoPath}/actions/runs/${idSeg}/jobs?per_page=30`);
      return { run, jobs };
    }
  }
}
