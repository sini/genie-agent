// The PR action (plan A3, design §5.6): genie-bot forks the repository, commits the proposal's
// files on a new branch of its fork, and opens a PR against the upstream default branch, whose body
// links the thread. Only public repositories: a private one is refused before the fork.
//
// The calls, in order, each throwing on any non-2xx or network error:
//   1. GET  /repos/{repo}                        public, and its default branch
//   2. POST /repos/{repo}/forks                  the fork (or genie-bot's existing one)
//   3. GET  /repos/{fork}/git/ref/heads/{base}   polled until the fork exists: forks are async,
//                                                and this is the only wait, bounded by forkWaitMs
//   4. GET  /repos/{repo}/branches/{base}        the base commit and its tree, upstream's
//   5. POST /repos/{fork}/git/trees              every file inline, over the base tree
//   6. POST /repos/{fork}/git/commits            one commit, the title as its message
//   7. POST /repos/{fork}/git/refs               the branch; an existing one is refused, not moved
//   8. POST /repos/{repo}/pulls                  the PR
// The git data API, not the contents API: one commit for any number of files, and the branch
// appears only once that commit exists. The contents API makes a commit per file on a branch that
// must already exist, so a failure part-way would leave a half-applied branch.
//
// No retry. If the PR call fails, the branch is deleted (best effort, once) so the same proposal
// can be opened again. The fork stays: it is genie-bot's public fork and the next PR reuses it.
// An unreferenced tree or commit is GitHub's to collect. The act throws and the broker records
// it as not acted, with the token scrubbed from the reason.
import type { Act } from "./index.ts";

export function pr(link: (thread: string) => string, base = "https://api.github.com", { forkWaitMs = 60_000, pollMs = 2_000, timeoutMs = 30_000 } = {}): Act {
  return async (p, token, thread) => {
    if (p.kind !== "pr" || !p.repo || !p.branch) throw new Error(`pr: cannot act on a ${p.kind} proposal without a repo and branch`);
    const body = `${p.body}\n\nThread: ${link(thread)}`;
    const call = async (method: string, route: string, payload?: unknown) => {
      const res = await fetch(`${base}${route}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "content-type": "application/json",
        },
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      if (!res.ok) {
        const limit = ["retry-after", "x-ratelimit-remaining", "x-ratelimit-reset"]
          .filter((h) => res.headers.has(h))
          .map((h) => `${h}=${res.headers.get(h)}`);
        const err = new Error(`pr: ${method} ${route}: HTTP ${res.status}${limit.length ? ` (${limit.join(", ")})` : ""}: ${text.slice(0, 200)}`);
        throw Object.assign(err, { status: res.status });
      }
      return text ? JSON.parse(text) : {};
    };

    const upstream = await call("GET", `/repos/${p.repo}`);
    if (upstream.private !== false) throw new Error(`pr: ${p.repo} is not public`);
    const into: string = upstream.default_branch;
    const fork = await call("POST", `/repos/${p.repo}/forks`);
    const deadline = Date.now() + forkWaitMs;
    for (;;) {
      try {
        await call("GET", `/repos/${fork.full_name}/git/ref/heads/${into}`);
        break;
      } catch (e) {
        if ((e as { status?: number }).status !== 404 || Date.now() + pollMs > deadline) throw e;
        await new Promise((r) => setTimeout(r, pollMs));
      }
    }
    const head = await call("GET", `/repos/${p.repo}/branches/${into}`);
    const tree = await call("POST", `/repos/${fork.full_name}/git/trees`, {
      base_tree: head.commit.commit.tree.sha,
      tree: Object.entries(p.files).map(([name, content]) => ({ path: name, mode: "100644", type: "blob", content })),
    });
    const commit = await call("POST", `/repos/${fork.full_name}/git/commits`, { message: p.title, tree: tree.sha, parents: [head.commit.sha] });
    await call("POST", `/repos/${fork.full_name}/git/refs`, { ref: `refs/heads/${p.branch}`, sha: commit.sha });
    const pull = await call("POST", `/repos/${p.repo}/pulls`, { title: p.title, head: `${fork.owner.login}:${p.branch}`, base: into, body }).catch(async (e) => {
      const cleanup = await call("DELETE", `/repos/${fork.full_name}/git/refs/heads/${p.branch}`).then(
        () => "branch deleted",
        (d) => `branch left behind: ${d instanceof Error ? d.message : d}`,
      );
      throw new Error(`${e instanceof Error ? e.message : e} (${cleanup})`);
    });
    if (typeof pull.html_url !== "string" || !pull.html_url) throw new Error("pr: the PR has no html_url");
    return { url: pull.html_url };
  };
}
