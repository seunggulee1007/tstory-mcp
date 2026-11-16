import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { disallowed, isAllowedPath, symlinks } from "../batch/repair-gate.js";
import { foreignHostCount, riskyHits, scanDiff } from "../batch/secret-scan.js";

describe("변경 경로 allowlist", () => {
  it("허용 경로", () => {
    for (const p of ["src/schemas.ts", "src/client.ts", "recordings/ENDPOINTS.md", "test/client.test.ts", "test/fixtures/responses.ts", ".repair-input/drift.md"]) {
      expect(isAllowedPath(p)).toBe(true);
    }
  });
  it("그 외는 거부", () => {
    const bad = ["src/session.ts", "batch/run.sh", "package.json", ".secrets/state.json", ".env", "test/x.sh", "../etc/passwd", "/abs/path.ts", "src/../batch/run.sh", ".github/workflows/x.yml", "recordings/x.har"];
    expect(disallowed(["src/client.ts", ...bad])).toEqual(bad);
  });
  it("심볼릭 링크 거부", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-"));
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "real.ts"), "x");
    fs.symlinkSync(path.join(dir, "real.ts"), path.join(dir, "src/client.ts"));
    fs.writeFileSync(path.join(dir, "src/schemas.ts"), "ok");
    expect(symlinks(dir, ["src/client.ts", "src/schemas.ts", "gone.ts"])).toEqual(["src/client.ts"]);
  });
});

describe("새 파일 규칙", () => {
  it("새 파일은 test/fixtures/** 에서만 허용", () => {
    expect(disallowed([{ path: "test/fixtures/new.json", isNew: true }, { path: "test/fixtures/more.ts", isNew: true }])).toEqual([]);
    expect(disallowed([{ path: "test/new.test.ts", isNew: true }])).toEqual(["test/new.test.ts"]);
    expect(disallowed([{ path: "test/helpers2.ts", isNew: true }, { path: "src/extra.ts", isNew: true }])).toEqual(["test/helpers2.ts", "src/extra.ts"]);
  });
  it("기존 test 파일 수정은 허용", () => {
    expect(disallowed([{ path: "test/client.test.ts", isNew: false }])).toEqual([]);
  });
  it("고정 파일을 '새 파일' 로 만드는 것은 거부 (이미 있어야 함)", () => {
    expect(disallowed([{ path: "src/client.ts", isNew: true }])).toEqual(["src/client.ts"]);
  });
});

describe("위험 패턴 건수", () => {
  const add = (l: string) => `+${l}\n`;
  it("위험 패턴이 있는 추가 줄을 센다", () => {
    const diff = ["import fs from 'node:fs';", "const k = process.env.X;", "await fetch(url);", "eval('1')", "const ok = 1;"].map(add).join("");
    expect(riskyHits(diff)).toBe(4);
  });
  it("삭제/문맥 줄은 세지 않는다", () => {
    expect(riskyHits("-import fs from 'node:fs';\n process.env.X\n")).toBe(0);
  });
  it("호스트 허용 목록", () => {
    expect(foreignHostCount("https://blog.tistory.com/manage https://x.kakaocdn.net/a https://img.daumcdn.net/b")).toBe(0);
    expect(foreignHostCount("https://evil.example.com/x https://tistory.com.evil.io/y")).toBe(2);
    expect(riskyHits(add("see https://evil.example.com/x"))).toBe(1);
  });
  it("위험 줄에 낯선 호스트가 같이 있으면 둘 다 센다", () => {
    expect(riskyHits(add("fetch('https://evil.example.com')"))).toBe(2);
  });
});

describe("secret-scan", () => {
  const secrets = ["COOKIEVALUE-0123456789"];
  it("상태 파일의 쿠키 값을 추가 줄에서 찾는다 (값은 보고하지 않음)", () => {
    const f = scanDiff("+++ b/x\n+const a = 'COOKIEVALUE-0123456789';\n", secrets);
    expect(f).toHaveLength(1);
    expect(JSON.stringify(f)).not.toContain("COOKIEVALUE");
  });
  it("쿠키/서명 패턴", () => {
    expect(scanDiff("+Cookie: TSSESSION=abcdefghijk\n", [])).toHaveLength(1);
    expect(scanDiff("+Cookie: TSSESSION_KEEP=abcdefghijk\n", [])).toHaveLength(1);
    expect(scanDiff("+u?credential=ABCDEFGH12345&x=1\n", [])).toHaveLength(1);
    expect(scanDiff("+u?signature=ABCDEFGH12345\n", [])).toHaveLength(1);
  });
  it("삭제/문맥 줄과 placeholder 는 무시", () => {
    expect(scanDiff("-TSSESSION=abcdefghijk\n TSSESSION=abcdefghijk\n+credential=FAKE&signature=<redacted>\n+TSSESSION=<redacted>\n+`TSSESSION` 쿠키\n", [])).toEqual([]);
  });
  it("짧은 쿠키 값(8자 미만)은 무시", () => {
    expect(scanDiff("+abc12\n", ["abc12"])).toEqual([]);
  });
});
