// The support memory's refusal check (design oracle 20): it can refuse an entry, never admit one.
// A merged PR is the admission. Refuses any file under the directory that holds a credential shape
// the redactor names, names a private repository, carries an absolute home path, or (README
// and the MEMORY.md index excepted) lacks frontmatter with a name and a description. Where a MEMORY.md
// index exists it also refuses an unindexed file, a type outside the README enum, a dangling [[slug]], a
// malformed values:/verified:/scope: field and a trap without verified:, and prints the provisional values
// and the unverified files.
// Usage: node tests/support-memory.ts <support-memory dir>
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { redact } from "../src/redactor/index.ts";

const privateRepos = ["den-ag-design", "gen-progress-report-v1"];
const dir = process.argv[2];

function walk(d: string): string[] {
  return readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)],
  );
}

const errors: string[] = [];
const files = walk(dir);
for (const f of files) {
  const rel = relative(dir, f);
  const text = readFileSync(f, "utf8");
  for (const { kind } of redact(text).hits) errors.push(`${rel}: credential shape ${kind}`);
  for (const r of privateRepos)
    if (text.toLowerCase().includes(r)) errors.push(`${rel}: names private repository ${r}`);
  if (/\/home\//.test(text)) errors.push(`${rel}: absolute /home/ path`);
  // README and the MEMORY.md index are the only files without frontmatter.
  if (rel !== "README.md" && rel !== "MEMORY.md") {
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
    if (!fm || !/^name: \S/m.test(fm[1]) || !/^description: \S/m.test(fm[1]))
      errors.push(`${rel}: no frontmatter with name and description`);
  }
}
// An empty directory is a broken fileset, not a clean memory.
if (files.length < 2) errors.push(`only ${files.length} file(s) under ${dir}`);

// Where a MEMORY.md index exists, the README's own invariants hold too.
const indexFile = join(dir, "MEMORY.md");
if (files.includes(indexFile)) {
  const index = readFileSync(indexFile, "utf8");
  const types = ["practice", "trap", "workflow", "reference"];
  const names = new Set<string>();
  const links: [string, string][] = [];
  const provisional: string[] = [];
  const unverified: string[] = [];
  for (const f of files) {
    const rel = relative(dir, f);
    if (rel === "README.md" || rel === "MEMORY.md") continue;
    const text = readFileSync(f, "utf8");
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "";
    const name = /^name: (\S+)$/m.exec(fm)?.[1];
    if (name) names.add(name);
    const type = /^type: (\S+)$/m.exec(fm)?.[1];
    if (!type || !types.includes(type)) errors.push(`${rel}: type must be one of ${types.join(" | ")}`);
    if (!index.includes(`(${rel})`)) errors.push(`${rel}: no line in MEMORY.md`);
    // values: one indented `key: owner-set <date> | measured (<how>) | provisional` line per policy number.
    const values = /^values:\n((?:  .*\n?)*)/m.exec(fm)?.[1] ?? "";
    for (const line of values.split("\n").filter(Boolean)) {
      const m = /^  ([a-z0-9-]+): (owner-set \d{4}-\d{2}-\d{2}|measured \(.+\)|provisional)$/.exec(line);
      if (!m) errors.push(`${rel}: malformed values line: ${line.trim()}`);
      else if (m[2] === "provisional") provisional.push(`${rel}: ${m[1]}`);
    }
    // verified: `<date>; <tool> <version>[, <tool> <version>]` or the literal `unverified`; required on a trap.
    const verified = /^verified: (.*)$/m.exec(fm)?.[1];
    if (verified === undefined) {
      if (type === "trap") errors.push(`${rel}: type trap needs verified:`);
    } else if (verified === "unverified") unverified.push(rel);
    // The formatter may strip YAML quotes, so the quoted and plain forms are both accepted.
    else if (!/^("?)\d{4}-\d{2}-\d{2}; [^,"]+ [^\s,"]+(, [^,"]+ [^\s,"]+)*\1$/.test(verified))
      errors.push(`${rel}: malformed verified: ${verified}`);
    const scope = /^scope: (.*)$/m.exec(fm)?.[1];
    if (scope !== undefined && scope !== "local") errors.push(`${rel}: scope must be local`);
    // On disk a link is escaped as `\[[slug]\]`; stopping at the first `]` matches both forms. Slugs are kebab-case,
    // so a regex character class such as `[[:space:]]` is not read as a link.
    for (const m of text.matchAll(/\[\[([a-z0-9-]+)\]/g)) links.push([rel, m[1]]);
  }
  for (const [rel, slug] of links)
    if (!names.has(slug)) errors.push(`${rel}: [[${slug}]] resolves to no name`);
  // A regex that matches nothing would pass every tree.
  if (links.length === 0) errors.push("link check matched 0 [[slug]] links");
  // Printed, never refused: these are the owner's review queue.
  console.log(`provisional values (${provisional.length}):`);
  for (const p of provisional) console.log(`  ${p}`);
  console.log(`unverified traps and references (${unverified.length}):`);
  for (const u of unverified) console.log(`  ${u}`);
}

for (const e of errors) console.error(e);
console.log(`support-memory: ${files.length} files checked, ${errors.length} refused`);
process.exit(errors.length ? 1 : 0);
