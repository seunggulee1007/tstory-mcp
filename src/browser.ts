import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const AGENT_BROWSER_BIN = path.join(root, "node_modules", ".bin", "agent-browser");
const SOCKET_DIR = path.join(os.homedir(), ".agent-browser");

/** 실행마다 고유한 세션 이름 (다른 실행/에이전트와 브라우저를 공유하지 않기 위함) */
export function uniqueSession(prefix: string): string {
  return `${prefix}-${process.pid}-${Date.now().toString(36)}`;
}

export function abExec(session: string, args: string[], opts: { state?: string; timeoutMs?: number } = {}): string {
  const full = ["--session", session, ...(opts.state ? ["--state", opts.state] : []), ...args];
  return execFileSync(AGENT_BROWSER_BIN, full, {
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 60_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function childrenOf(pid: number): number[] {
  try {
    const out = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" });
    return out
      .split("\n")
      .map((l) => l.trim().split(/\s+/).map(Number))
      .filter(([, ppid]) => ppid === pid)
      .map(([p]) => p as number);
  } catch {
    return [];
  }
}

/** pid 가 agent-browser/Chrome for Testing 인지 확인 (pid 재사용으로 엉뚱한 프로세스를 죽이지 않기 위함) */
function isBrowserProcess(pid: number): boolean {
  try {
    const cmd = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
    return /agent-browser|Google Chrome for Testing/.test(cmd);
  } catch {
    return false;
  }
}

function killTree(pid: number): void {
  if (!isBrowserProcess(pid)) return;
  for (const c of childrenOf(pid)) killTree(c);
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* 이미 종료 */
  }
}

/** 세션의 데몬 pid (소켓 디렉터리의 <session>.pid) */
function daemonPid(session: string): number | undefined {
  try {
    const n = Number(fs.readFileSync(path.join(SOCKET_DIR, `${session}.pid`), "utf8").trim());
    return Number.isInteger(n) && n > 1 ? n : undefined;
  } catch {
    return undefined;
  }
}

/** 브라우저를 닫는다. close 가 실패/지연(10초)하면 데몬과 Chrome 프로세스를 직접 죽인다. */
export function closeBrowser(session: string): void {
  const pid = daemonPid(session);
  try {
    abExec(session, ["close"], { timeoutMs: 10_000 });
  } catch {
    /* 강제 종료로 진행 */
    if (pid) killTree(pid);
  }
  // 소켓/pid/target 같은 세션 잔여 파일 제거
  for (const f of fs.existsSync(SOCKET_DIR) ? fs.readdirSync(SOCKET_DIR) : []) {
    if (f.startsWith(`${session}.`)) fs.rmSync(path.join(SOCKET_DIR, f), { force: true });
  }
}
