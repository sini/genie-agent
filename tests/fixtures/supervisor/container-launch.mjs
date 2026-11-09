import { spawn } from "node:child_process";

let buffered = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", function bootstrap(chunk) {
  buffered += chunk;
  const end = buffered.indexOf("\n");
  if (end < 0) return;
  process.stdin.removeListener("data", bootstrap);
  const message = JSON.parse(buffered.slice(0, end));
  message.custody.socket = `${process.argv[2]}/root.sock`;
  const child = spawn(process.execPath, [process.argv[3]], { stdio: ["pipe", "inherit", "inherit"] });
  child.stdin.write(`${JSON.stringify(message)}\n${buffered.slice(end + 1)}`);
  process.stdin.pipe(child.stdin);
  child.on("exit", (code) => process.exit(code ?? 1));
});
