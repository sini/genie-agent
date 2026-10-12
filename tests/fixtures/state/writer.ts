// The first life of a thread, as its own OS process: `node writer.ts <stateRoot> <storeRoot> <thread>
// <fact> <state json> <cache value json>`. It plants the fact in the thread's pi session through
// the supervisor, records the tier and one cache entry, tears pi down and exits.
import { Supervisor } from "../../../src/supervisor/index.ts";
import { ThreadStateStore } from "../../../src/state/index.ts";

const [stateRoot, storeRoot, thread, fact, state, value] = process.argv.slice(2);
const fake = new URL("../supervisor/fake-pi.ts", import.meta.url).pathname;
const store = new ThreadStateStore(stateRoot, storeRoot);
const s = new Supervisor((t) => ({ command: process.execPath, args: [fake, ...store.sessionArgs(t)] }));
const r = await s.command(thread, { type: "prompt", message: fact });
if (r.success !== true) throw new Error(`prompt failed: ${JSON.stringify(r)}`);
store.write(JSON.parse(state));
store.cachePut(thread, { repo: "https://github.com/sini/x", rev: "abc", attr: "a", flags: [] }, JSON.parse(value));
await s.shutdown();
