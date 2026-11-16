import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { cookieValues } from "./summarize-har.js";

export interface Finding {
  kind: string;
  line: number;
}

const PATTERNS: [string, RegExp][] = [
  ["세션 쿠키 패턴", /\b(TSSESSION(?:_KEEP)?|_T_ANO|TSID)=(?!<|FAKE)[^\s;"'<]{3,}/],
  ["credential= 값", /credential=(?!<|FAKE)[A-Za-z0-9%_-]{8,}/i],
  ["signature= 값", /signature=(?!<|FAKE)[A-Za-z0-9%_-]{8,}/i],
];

/**
 * diff 텍스트에서 추가된 줄(+)만 검사한다. 상태 파일의 쿠키 값(8자 이상)과 쿠키/서명 패턴이 있으면 찾는다.
 * 값 자체는 결과에 담지 않는다 (종류와 줄 번호만).
 */
export function scanDiff(diff: string, secrets: string[]): Finding[] {
  const found: Finding[] = [];
  diff.split("\n").forEach((line, i) => {
    if (!line.startsWith("+") || line.startsWith("+++")) return;
    if (secrets.some((v) => v.length >= 8 && line.includes(v))) found.push({ kind: "상태 파일의 쿠키 값", line: i + 1 });
    for (const [kind, re] of PATTERNS) if (re.test(line)) found.push({ kind, line: i + 1 });
  });
  return found;
}

const RISKY = /child_process|node:fs|from ["']fs|readFile|writeFile|process\.env|import\(|require\(|eval\(|new Function|\.secrets|state\.json|fetch\(/;
const ALLOWED_HOSTS = ["tistory.com", "daumcdn.net", "kakaocdn.net"];

/** URL 호스트가 허용 목록(.tistory.com, daumcdn.net, kakaocdn.net)이 아닌 개수 */
export function foreignHostCount(line: string): number {
  let n = 0;
  for (const m of line.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)) {
    const host = m[1]!.toLowerCase();
    if (!ALLOWED_HOSTS.some((d) => host === d || host.endsWith(`.${d}`))) n++;
  }
  return n;
}

/** 추가된 줄에서 위험 패턴(파일/프로세스/네트워크/환경 접근, 낯선 호스트)의 건수. 폐기 사유는 아니고 리뷰 경고용. */
export function riskyHits(diff: string): number {
  let hits = 0;
  for (const line of diff.split("\n")) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    if (RISKY.test(line)) hits++;
    hits += foreignHostCount(line);
  }
  return hits;
}

/** CLI: git diff 를 stdin 으로 받는다. 사용법: tsx batch/secret-scan.ts <state.json> < diff  /  tsx batch/secret-scan.ts --risky < diff (위험 패턴 건수 출력) */
function main(): void {
  if (process.argv[2] === "--risky") {
    console.log(riskyHits(fs.readFileSync(0, "utf8")));
    return;
  }
  const stateFile = process.argv[2] ?? ".secrets/state.json";
  const diff = fs.readFileSync(0, "utf8");
  const findings = scanDiff(diff, cookieValues(stateFile));
  for (const f of findings) console.error(`비밀 후보 발견: ${f.kind} (diff ${f.line}번째 줄)`);
  process.exit(findings.length ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
