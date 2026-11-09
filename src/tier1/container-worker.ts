#!/usr/bin/env node
import { runWorker } from "./worker.ts";

const io = process as any;
try { io.exitCode = await runWorker(io.stdin, io.stdout); }
catch { io.stderr.write("container worker failed\n"); io.exitCode = 1; }
