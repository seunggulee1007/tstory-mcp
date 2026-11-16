import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 복구 제안에서 변경을 허용하는 경로 (신뢰된 메인 체크아웃 코드로 검사).
 * isNew: HEAD 에 없던 새 파일. 새 파일은 test/fixtures/** 아래에서만 허용하고,
 * 그 외 test 파일은 이미 HEAD 에 있던 것만 수정할 수 있다.
 */
export function isAllowedPath(p: string, isNew = false): boolean {
  if (p.includes("..") || p.startsWith("/") || p.includes("\0")) return false;
  if (p === "src/schemas.ts" || p === "src/client.ts" || p === "recordings/ENDPOINTS.md") return !isNew;
  if (isNew) return /^test\/fixtures\/[^]+\.(ts|json)$/.test(p);
  if (/^test\/[^]+\.ts$/.test(p) || /^test\/fixtures\/[^]+\.json$/.test(p)) return true;
  // 입력 폴더는 커밋 전에 지워야 하지만 존재 자체는 허용
  return p.startsWith(".repair-input/");
}

export interface Change {
  path: string;
  isNew: boolean;
}

/** 허용되지 않은 경로 목록 */
export function disallowed(changes: (string | Change)[]): string[] {
  return changes
    .map((c) => (typeof c === "string" ? { path: c, isNew: false } : c))
    .filter((c) => c.path && !isAllowedPath(c.path, c.isNew))
    .map((c) => c.path);
}

/** 허용 경로여도 심볼릭 링크면 거부 (밖의 파일을 가리키는 우회 방지) */
export function symlinks(root: string, paths: string[]): string[] {
  return paths.filter((p) => {
    try {
      return fs.lstatSync(path.join(root, p)).isSymbolicLink();
    } catch {
      return false; // 삭제된 파일
    }
  });
}

/** CLI: tsx batch/repair-gate.ts <worktree> < 줄 단위 "M<TAB>경로" (수정/삭제) 또는 "A<TAB>경로" (새 파일) */
function main(): void {
  const root = process.argv[2] ?? ".";
  const changes: Change[] = fs
    .readFileSync(0, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      const [kind, ...rest] = l.split("\t");
      return { path: rest.join("\t").trim(), isNew: kind === "A" };
    });
  const bad = [...disallowed(changes), ...symlinks(root, changes.map((c) => c.path)).map((p) => `${p} (심볼릭 링크)`)];
  for (const b of bad) console.error(`허용되지 않은 변경: ${b}`);
  process.exit(bad.length ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
