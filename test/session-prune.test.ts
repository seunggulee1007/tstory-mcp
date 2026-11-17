import { describe, expect, it } from "vitest";
import { isTistoryCookieDomain, keepTistoryCookies } from "../src/session.js";

const ck = (domain: string, name = "n") => ({ name, value: "v", domain, path: "/", expires: -1 });

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
