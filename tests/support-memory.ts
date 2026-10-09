// The support memory's refusal check (design oracle 20): it can refuse an entry, never admit one.
// A merged PR is the admission. Refuses any file under the directory that holds a credential shape
// the redactor names, names a private repository, carries an absolute home path, or (README
// excepted) lacks frontmatter with a name and a description.
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
  if (rel !== "README.md") {
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
    if (!fm || !/^name: \S/m.test(fm[1]) || !/^description: \S/m.test(fm[1]))
      errors.push(`${rel}: no frontmatter with name and description`);
  }
}
// An empty directory is a broken fileset, not a clean memory.
if (files.length < 2) errors.push(`only ${files.length} file(s) under ${dir}`);

for (const e of errors) console.error(e);
console.log(`support-memory: ${files.length} files checked, ${errors.length} refused`);
process.exit(errors.length ? 1 : 0);
