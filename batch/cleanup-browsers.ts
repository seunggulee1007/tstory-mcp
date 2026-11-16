import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { closeBrowser } from "../src/browser.js";

export interface Proc {
  pid: number;
  ppid: number;
  ageSec: number;
  command: string;
}

/** ps 의 etime ([[dd-]hh:]mm:ss) → 초 */
export function etimeToSec(etime: string): number {
  const [d, rest] = etime.includes("-") ? etime.split("-") : ["0", etime];
  const parts = (rest as string).split(":").map(Number);
  while (parts.length < 3) parts.unshift(0);
  return Number(d) * 86400 + parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
}

/**
 * 고아 브라우저 판별. agent-browser 가 띄운 "Google Chrome for Testing" 이면서
 * user-data-dir 이 agent-browser-chrome- 인 메인 프로세스(ppid=1)만 대상으로 한다.
 * 사용자의 일반 Google Chrome 은 이름/경로가 달라 절대 매칭되지 않는다.
 */
export function isOrphanBrowser(p: Proc, minAgeSec = 30 * 60): boolean {
  return (
    p.ppid === 1 &&
    p.ageSec >= minAgeSec &&
    p.command.includes("Google Chrome for Testing") &&
    /--user-data-dir=\S*agent-browser-chrome-/.test(p.command)
  );
}

export function parsePs(out: string): Proc[] {
  const procs: Proc[] = [];
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (m) procs.push({ pid: Number(m[1]), ppid: Number(m[2]), ageSec: etimeToSec(m[3]!), command: m[4]! });
  }
  return procs;
}

export function cleanupOrphans(minAgeSec = 30 * 60): number[] {
  const out = execFileSync("ps", ["-axo", "pid=,ppid=,etime=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const killed: number[] = [];
  for (const p of parsePs(out).filter((x) => isOrphanBrowser(x, minAgeSec))) {
    try {
      process.kill(p.pid, "SIGKILL");
      killed.push(p.pid);
    } catch {
      /* 이미 종료 */
    }
  }
  return killed;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--session");
  if (i > 0 && process.argv[i + 1]) {
    // 특정 세션 정리: close 후 안 닫히면 데몬/Chrome 강제 종료
    closeBrowser(process.argv[i + 1]!);
    console.log(`세션 정리: ${process.argv[i + 1]}`);
    process.exit(0);
  }
  const killed = cleanupOrphans();
  console.log(killed.length ? `고아 브라우저 ${killed.length}개 정리: ${killed.join(", ")}` : "정리할 고아 브라우저 없음");
}
