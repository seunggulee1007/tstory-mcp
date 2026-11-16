import crypto from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export interface DriftState {
  signature: string;
  lastAttemptAt: number;
  lastNotifiedAt: number;
}

const DAY = 24 * 3600 * 1000;

interface ReportLike {
  checks: { name: string; ok: boolean; errorType: string | null; detail: string }[];
}

/** 실패한 check 이름 + errorType + detail 해시 */
export function signatureOf(report: ReportLike): string {
  const parts = report.checks
    .filter((c) => !c.ok)
    .map((c) => `${c.name}|${c.errorType}|${c.detail}`)
    .sort();
  return crypto.createHash("sha256").update(parts.join("\n")).digest("hex");
}

/**
 * new: 처음이거나 24시간이 지나 새로 시도 / notify: 같은 문제로 24시간 내 재시도 없이 알림만 / skip: 아무것도 안 함
 */
export function decide(state: DriftState | undefined, sig: string, now: number): { action: "new" | "notify" | "skip"; next: DriftState } {
  if (state && state.signature === sig && now - state.lastAttemptAt < DAY) {
    if (now - state.lastNotifiedAt >= DAY) return { action: "notify", next: { ...state, lastNotifiedAt: now } };
    return { action: "skip", next: state };
  }
  return { action: "new", next: { signature: sig, lastAttemptAt: now, lastNotifiedAt: now } };
}

function main(): void {
  const [report, file = "reports/drift-state.json"] = process.argv.slice(2);
  if (!report) {
    console.error("사용법: tsx batch/drift-state.ts <healthcheck-report.json> [drift-state.json]");
    process.exit(1);
  }
  const sig = signatureOf(JSON.parse(fs.readFileSync(report, "utf8")));
  let state: DriftState | undefined;
  try {
    state = JSON.parse(fs.readFileSync(file, "utf8")) as DriftState;
  } catch {
    state = undefined;
  }
  const { action, next } = decide(state, sig, Date.now());
  if (action !== "skip") fs.writeFileSync(file, JSON.stringify(next, null, 2), { mode: 0o600 });
  console.log(`${action} ${sig.slice(0, 7)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
