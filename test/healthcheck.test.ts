import { describe, expect, it } from "vitest";
import { exitCodeFor, makePng, runChecks, type CheckResult } from "../batch/healthcheck.js";
import { parseImageSize } from "../src/image.js";
import * as F from "./fixtures/responses.js";
import { json, mockClient } from "./helpers.js";

const c = (name: string, ok: boolean, errorType: string | null = null): CheckResult => ({ name, ok, ms: 1, errorType, detail: "" });
const rep = (checks: CheckResult[], sessionExpiresAt: string | null = null) => ({ ok: checks.every((x) => x.ok), checks, sessionExpiresAt });

describe("healthcheck 종료 코드", () => {
  it("모두 성공 → 0", () => expect(exitCodeFor(rep([c("a", true)]))).toBe(0));
  it("myBlogs 세션 만료 → 2 (계약 오류보다 우선)", () =>
    expect(exitCodeFor(rep([c("listPosts", false, "ContractError"), c("myBlogs", false, "SessionExpiredError")]))).toBe(2));
  it("myBlogs 가 아닌 곳이 200 인데 HTML 이면 API 변경 → 3", () =>
    expect(exitCodeFor(rep([c("myBlogs", true), c("listPosts", false, "SessionExpiredHtml")]))).toBe(3));
  it("어느 check 든 로그인 리다이렉트면 세션 만료 → 2", () =>
    expect(exitCodeFor(rep([c("myBlogs", true), c("listPosts", false, "SessionExpiredError")]))).toBe(2));
  it("myBlogs 가 HTML 을 받아도 → 2", () => expect(exitCodeFor(rep([c("myBlogs", false, "SessionExpiredHtml")]))).toBe(2));
  it("403/429(BlockedError)는 복구 대상이 아니므로 → 1 (계약 오류가 섞여도)", () =>
    expect(exitCodeFor(rep([c("a", false, "BlockedError"), c("b", false, "ContractError")]))).toBe(1));
  it("계약 불일치 → 3", () => expect(exitCodeFor(rep([c("a", false, "ContractError")]))).toBe(3));
  it("4xx 변경(ApiDriftError) → 3", () => expect(exitCodeFor(rep([c("a", false, "ApiDriftError")]))).toBe(3));
  it("기타 → 1", () => expect(exitCodeFor(rep([c("a", false, "HttpError")]))).toBe(1));
  it("정상이지만 세션 만료가 7일 미만이면 → 4", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(exitCodeFor(rep([c("a", true)], "2026-01-05T00:00:00Z"), now)).toBe(4);
    expect(exitCodeFor(rep([c("a", true)], "2026-01-20T00:00:00Z"), now)).toBe(0);
  });
  it("실패가 있으면 만료 임박보다 실패 코드가 우선", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(exitCodeFor(rep([c("a", false, "ContractError")], "2026-01-02T00:00:00Z"), now)).toBe(3);
  });
  it("Skipped 만 있으면 → 1", () => expect(exitCodeFor(rep([c("a", false, "Skipped")]))).toBe(1));
});

describe("makePng", () => {
  it("16x16 PNG 헤더", () => expect(parseImageSize(makePng(16, 16))).toEqual({ width: 16, height: 16 }));
});

describe("runChecks (mock)", () => {
  it("전부 통과하고 임시저장을 지운다", async () => {
    let drafts: typeof F.drafts.data = [];
    const { client, calls } = mockClient((u, init) => {
      if (u.includes("/drafts/")) {
        drafts = [];
        return json(F.draftDelete);
      }
      if (u.endsWith("/drafts") && init.method === "POST") {
        drafts = [{ ...F.drafts.data[0]!, sequence: 9 }];
        return json(F.draftCreate);
      }
      if (u.endsWith("/drafts")) return json({ success: true, data: drafts });
      if (u.includes("posts.json")) return json(F.posts);
      if (u.includes("category/simple")) return json(F.categories);
      if (u.includes("newpost/")) return new Response(F.newpostHtml, { status: 200, headers: { "content-type": "text/html" } });
      if (u.includes("attach.json")) return json(F.attach);
      if (u.includes("myBlogs")) return json(F.myBlogs);
      return new Response("?", { status: 404 });
    });
    const r = await runChecks(client, { HEALTHCHECK_UPLOAD: "1" });
    expect(r.checks.filter((x) => !x.ok)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(calls.some((x) => x.init.method === "PUT" || (x.init.method === "POST" && x.url.endsWith("post.json")))).toBe(false);
  });

  it("HEALTHCHECK_UPLOAD 기본값은 꺼짐", async () => {
    const { client } = mockClient(() => json({}));
    const r = await runChecks(client, {});
    expect(r.checks.find((x) => x.name === "uploadImage")).toBeUndefined();
  });

  it("302(로그인) 는 errorType SessionExpiredError, 200+HTML 은 SessionExpiredHtml 로 기록", async () => {
    const a = await runChecks(mockClient(() => new Response(null, { status: 302 })).client, {});
    expect(a.checks.find((x) => x.name === "listPosts")!.errorType).toBe("SessionExpiredError");
    const b = await runChecks(
      mockClient((u) => (u.includes("myBlogs") ? json(F.myBlogs) : new Response("<html/>", { status: 200, headers: { "content-type": "text/html" } }))).client,
      {},
    );
    expect(b.checks.find((x) => x.name === "listPosts")!.errorType).toBe("SessionExpiredHtml");
    expect(exitCodeFor(b)).toBe(3);
  });

  it("세션 만료는 각 check 가 독립적으로 실패 → 종료 코드 2", async () => {
    const { client } = mockClient(() => new Response(null, { status: 302 }));
    const r = await runChecks(client, {});
    expect(r.ok).toBe(false);
    expect(r.checks.length).toBeGreaterThan(5);
    expect(exitCodeFor(r)).toBe(2);
  });
});
