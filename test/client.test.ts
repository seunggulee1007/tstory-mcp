import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { entryUrlToId, flattenCategories, parseWindowConfig } from "../src/client.js";
import { CaptchaRequiredError, ContractError, SessionExpiredError } from "../src/errors.js";
import * as F from "./fixtures/responses.js";
import { json, mockClient } from "./helpers.js";
import { png } from "./png.js";

describe("window.Config 파싱", () => {
  it("JS 리터럴에서 post 추출", () => {
    const c = parseWindowConfig(F.newpostHtml);
    expect(c.post.title).toBe("두번째");
    expect(c.post.tags).toEqual(["a", "b"]);
  });
  it("Config 가 없으면 SessionExpiredError", () => {
    expect(() => parseWindowConfig("<html>login</html>")).toThrow(SessionExpiredError);
  });
  it("post 형태가 다르면 ContractError", () => {
    expect(() => parseWindowConfig("window.Config = { post: { id: 1 } };\n")).toThrow(ContractError);
  });
});

describe("entryUrl → id", () => {
  it("URL 끝에서 추출", () => {
    expect(entryUrlToId("https://x.tistory.com/193")).toBe("193");
    expect(entryUrlToId("https://x.tistory.com/193?a=1")).toBe("193");
  });
  it("숫자가 없으면 ContractError", () => expect(() => entryUrlToId("https://x.tistory.com/")).toThrow(ContractError));
});

describe("카테고리 평탄화", () => {
  it("경로 생성", () => {
    const flat = flattenCategories(F.categories.categories);
    expect(flat.find((c) => c.id === 6)?.path).toBe("개발/자바스크립트");
  });
});

describe("TistoryClient (mock fetch)", () => {
  it("302 는 SessionExpiredError", async () => {
    const { client } = mockClient(() => new Response(null, { status: 302, headers: { location: "https://www.tistory.com/auth/login" } }));
    await expect(client.listPosts()).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it("JSON 자리에 HTML 이 오면 SessionExpiredError", async () => {
    const { client } = mockClient(() => new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }));
    await expect(client.listCategories()).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it("스키마 불일치는 ContractError 이며 본문/쿠키를 담지 않음", async () => {
    const { client } = mockClient(() => json({ items: "SECRET-BODY" }));
    const err = await client.listPosts().catch((e) => e);
    expect(err).toBeInstanceOf(ContractError);
    expect(String(err.message)).not.toContain("SECRET-BODY");
    expect(String(err.message)).not.toContain("FAKE-SESSION");
  });

  it("Cookie/UA/Referer 헤더를 붙인다", async () => {
    const { client, calls } = mockClient(() => json(F.posts));
    await client.listPosts({ page: 2, keyword: "k" });
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h.cookie).toBe("TSSESSION=FAKE-SESSION");
    expect(h["user-agent"]).toMatch(/Mozilla/);
    expect(h.referer).toBe("https://testblog.tistory.com/manage/newpost");
    expect(calls[0]!.url).toContain("page=2");
    expect(calls[0]!.url).toContain("searchKeyword=k");
  });

  it("블로그 미지정이면 defaultBlog 사용", async () => {
    const { client, calls } = mockClient((u) => (u.includes("myBlogs") ? json(F.myBlogs) : json(F.posts)), null);
    await client.listPosts();
    expect(calls[1]!.url.startsWith("https://testblog.tistory.com/manage/posts.json")).toBe(true);
  });

  it("응답 Set-Cookie 를 state 파일에 병합 (0600, 원자적 쓰기)", async () => {
    const { client, stateFile } = mockClient(
      () => new Response(JSON.stringify(F.posts), { status: 200, headers: [["content-type", "application/json"], ["set-cookie", "TSSESSION=ROTATED; Domain=.tistory.com; Path=/; Max-Age=3600"], ["set-cookie", "NEW=1; Path=/"]] }),
    );
    await client.listPosts();
    const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const sess = saved.cookies.find((c: { name: string }) => c.name === "TSSESSION");
    expect(sess.value).toBe("ROTATED");
    expect(saved.cookies.find((c: { name: string }) => c.name === "NEW")?.domain).toBe("testblog.tistory.com");
    expect(fs.statSync(stateFile).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(stateFile.replace(/[^/]+$/, "")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("getPost: newpost HTML 의 window.Config 사용", async () => {
    const { client } = mockClient(() => new Response(F.newpostHtml, { status: 200, headers: { "content-type": "text/html" } }));
    expect((await client.getPost(12)).content).toBe("<p>본문</p>");
  });

  it("publishPost: 본문 형식과 id 추출 (기본 비공개 = 0)", async () => {
    const { client, calls } = mockClient(() => json({ entryUrl: "https://testblog.tistory.com/77" }));
    const r = await client.publishPost({ title: "t", content: "<p>c</p>", visibility: "private", category: 5, tags: ["a", "b"] });
    expect(r.id).toBe("77");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(calls[0]!.init.method).toBe("POST");
    expect(body).toMatchObject({ id: "0", published: 1, visibility: 0, category: 5, tag: "a,b", type: "post", recaptchaValue: "", draftSequence: null });
  });

  it("publishPost: 403 은 CaptchaRequiredError", async () => {
    const { client } = mockClient(() => new Response("blocked", { status: 403 }));
    await expect(client.publishPost({ title: "t", content: "c", visibility: "private" })).rejects.toBeInstanceOf(CaptchaRequiredError);
  });

  it("publishPost: entryUrl 없이 captcha 문구면 CaptchaRequiredError", async () => {
    const { client } = mockClient(() => json({ error: "captcha required" }));
    await expect(client.publishPost({ title: "t", content: "c", visibility: "public" })).rejects.toBeInstanceOf(CaptchaRequiredError);
  });

  it("updatePost: 기존 글을 가져와 병합 후 PUT", async () => {
    const { client, calls } = mockClient((u, init) =>
      init.method === "PUT" ? json({ entryUrl: "https://testblog.tistory.com/12" }) : new Response(F.newpostHtml, { status: 200, headers: { "content-type": "text/html" } }),
    );
    const r = await client.updatePost(12, { title: "새 제목" });
    expect(r.id).toBe("12");
    const put = calls.find((c) => c.init.method === "PUT")!;
    expect(put.url).toBe("https://testblog.tistory.com/manage/post/12.json");
    expect(JSON.parse(String(put.init.body))).toMatchObject({ id: "12", title: "새 제목", content: "<p>본문</p>", visibility: 20, category: 5, tag: "a,b", published: 0, acceptComment: 1, thumbnail: null, daumLike: null });
  });

  it("deletePost / 드래프트 API", async () => {
    const { client, calls } = mockClient((u, init) => {
      if (u.endsWith("/drafts") && init.method === "POST") return json(F.draftCreate);
      if (u.includes("/drafts/")) return json(F.draftDelete);
      if (u.endsWith("/drafts")) return json(F.drafts);
      return json({ data: 5 });
    });
    expect(await client.deletePost(5)).toEqual({ id: "5" });
    expect((await client.listDrafts())[0]!.sequence).toBe(3);
    expect(await client.saveDraft({ title: "t", content: "c" })).toEqual({ sequence: 9 });
    await client.deleteDraft(9);
    expect(calls.at(-1)!.init.method).toBe("DELETE");
  });

  it("uploadImage: multipart 업로드 + 치환자", async () => {
    const { client, calls } = mockClient(() => json(F.attach));
    const r = await client.uploadImage(png(16, 16), "my.png");
    expect(calls[0]!.init.body).toBeInstanceOf(FormData);
    expect((calls[0]!.init.body as FormData).get("file")).toBeInstanceOf(Blob);
    expect(r.placeholder).toContain('"originWidth":16');
    expect(r.placeholder).toContain('"filename":"my.png"');
    expect(r.placeholder.startsWith("[##_Image|kage@abc/def/GHI/img.png?credential=FAKE&amp;expires=1")).toBe(true);
  });
});

describe("createCategory (mock fetch)", () => {
  /** 저장 후 simple.json 에 새 카테고리가 나타나는 가짜 서버 */
  const server = (opts: { created?: { id: number; name: string; label?: string }; parentId?: number } = {}) => {
    const route = (u: string, init: RequestInit) => {
      if (u.endsWith("/manage/category.json")) return init.method === "PUT" ? json({ categoryTree: {} }) : json(F.categoryTree);
      const cats = structuredClone(F.categoryTree);
      if (opts.created) {
        const node = { ...opts.created, priority: 9, entries: 0, children: [] };
        if (opts.parentId === undefined) cats.categories.push(node as never);
        else cats.categories.find((c) => c.id === opts.parentId)!.children!.push(node as never);
      }
      return json(cats);
    };
    return mockClient(route);
  };
  const putOf = (calls: { url: string; init: RequestInit }[]) => calls.find((c) => c.init.method === "PUT");

  it("최상위 생성: diff 본문(priority=형제 수, parent 0, depth 1)과 referer", async () => {
    const { client, calls } = server({ created: { id: 50, name: "새분류" } });
    const r = await client.createCategory({ name: "  새분류 " });
    expect(r).toMatchObject({ id: 50, name: "새분류", path: "새분류" });
    const put = putOf(calls)!;
    expect(put.url).toBe("https://testblog.tistory.com/manage/category.json");
    expect((put.init.headers as Record<string, string>).referer).toBe("https://testblog.tistory.com/manage/category");
    const node = {
      id: -1, name: "새분류", children: [], depth: 1, opened: true, priority: 2, visibility: 20, parent: 0,
      viewChannel: null, entries: 0, categoryInfo: {}, isNew: true, updatedData: true,
    };
    expect(JSON.parse(String(put.init.body))).toEqual({ rootLabel: "분류 전체보기", delete: [], append: [node], update: [node] });
  });

  it("하위 생성: 부모를 이름으로 해석, depth 2, label, priority=자식 수", async () => {
    const { client, calls } = server({ created: { id: 51, name: "타입스크립트" }, parentId: 5 });
    const r = await client.createCategory({ name: "타입스크립트", parent: "개발" });
    expect(r).toMatchObject({ id: 51, path: "개발/타입스크립트" });
    const body = JSON.parse(String(putOf(calls)!.init.body));
    expect(body.append[0]).toMatchObject({ id: -1, name: "타입스크립트", depth: 2, priority: 1, parent: 5, label: "개발/", isNew: true });
    expect(body.update).toEqual(body.append);
  });

  it("부모를 id 로도 지정할 수 있다", async () => {
    const { client, calls } = server({ created: { id: 52, name: "메모" }, parentId: 7 });
    await client.createCategory({ name: "메모", parent: 7 });
    expect(JSON.parse(String(putOf(calls)!.init.body)).append[0]).toMatchObject({ parent: 7, priority: 0, label: "일상/" });
  });

  it.each([
    ["빈 이름", { name: "   " }, "비어"],
    ['"/" 포함', { name: "a/b" }, "/"],
    ["같은 부모 아래 중복", { name: "일상" }, "이미"],
    ["하위 중복", { name: "자바스크립트", parent: "개발" }, "이미"],
    ["부모 없음", { name: "x", parent: "없는분류" }, "부모 카테고리를 찾을 수 없습니다"],
    ["부모가 하위 카테고리", { name: "x", parent: "개발/자바스크립트" }, "최상위"],
    ["부모가 하위 카테고리(id)", { name: "x", parent: 6 }, "최상위"],
  ])("검증 실패(%s)는 PUT 전에 거부", async (_n, input, msg) => {
    const { client, calls } = server();
    await expect(client.createCategory(input)).rejects.toThrow(msg);
    expect(putOf(calls)).toBeUndefined();
  });

  it("저장 후 새 카테고리를 찾지 못하면 ContractError", async () => {
    const { client } = server();
    await expect(client.createCategory({ name: "사라짐" })).rejects.toBeInstanceOf(ContractError);
  });
});
