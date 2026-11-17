import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isTistoryCookieDomain, keepTistoryCookies, Session } from "../src/session.js";

const ck = (domain: string, name = "n") => ({ name, value: "v", domain, path: "/", expires: -1 });

function tmpState(cookies: ReturnType<typeof ck>[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tstory-prune-"));
  const file = path.join(dir, "state.json");
  fs.writeFileSync(file, JSON.stringify({ cookies, origins: [{ origin: "https://www.tistory.com" }] }), { mode: 0o600 });
  return file;
}

describe("티스토리 쿠키 도메인 필터", () => {
  it.each(["tistory.com", ".tistory.com", "www.tistory.com", ".tiara.tistory.com"])("유지: %s", (d) => {
    expect(isTistoryCookieDomain(d)).toBe(true);
  });
  it.each([".kakao.com", "accounts.kakao.com", "tistory.evil.com", "nottistory.com"])("제거: %s", (d) => {
    expect(isTistoryCookieDomain(d)).toBe(false);
  });
  it("origins 등 다른 키는 그대로 둔다", () => {
    const st = { cookies: [ck(".kakao.com"), ck(".tistory.com")], origins: [{ origin: "x" }], extra: 1 };
    const out = keepTistoryCookies(st);
    expect(out.cookies).toHaveLength(1);
    expect(out.origins).toEqual([{ origin: "x" }]);
    expect(out.extra).toBe(1);
  });
});

describe("state 파일 정리", () => {
  it("Session 저장 시 티스토리 외 쿠키가 제거된다", () => {
    const file = tmpState([ck(".kakao.com", "_kawlt"), ck(".tistory.com", "TSSESSION")]);
    new Session(file).mergeSetCookie(["a=b; Domain=tistory.com; Path=/"], "www.tistory.com");
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(saved.cookies.map((c: { name: string }) => c.name).sort()).toEqual(["TSSESSION", "a"]);
    expect(saved.origins).toHaveLength(1);
  });
});
