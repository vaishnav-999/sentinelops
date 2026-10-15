// Starts `next dev` against the local FastAPI backend (docker-compose.live.yml).
// Env vars are set here so no .env file has to change.
import { spawn } from "node:child_process";

const env = {
  ...process.env,
  NEXT_PUBLIC_DATA_SOURCE: "http",
  NEXT_PUBLIC_API_BASE_URL: process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://127.0.0.1:8000",
};

const child = spawn("npx", ["next", "dev", ...process.argv.slice(2)], {
  env,
  stdio: "inherit",
  shell: process.platform === "win32",
});

child.on("exit", (code) => process.exit(code ?? 0));
