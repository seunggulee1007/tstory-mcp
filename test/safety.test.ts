import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { BlockedError, HttpError, SessionExpiredError } from "../src/errors.js";
import { readImageForUpload } from "../src/image.js";
import { buildServer } from "../src/server.js";
import { Session, applySetCookies } from "../src/session.js";
import { json, mockClient, tmpState } from "./helpers.js";
import { png } from "./png.js";

describe("오류 분류", () => {
  const html404 = () => new Response("<html>not found</html>", { status: 404, headers: { "content-type": "text/html" } });
  it("404 HTML 은 세션 만료가 아니라 HttpError", async () => {
    const { client } = mockClient(html404);
    const e = await client.listCategories().catch((x) => x);
    expect(e).toBeInstanceOf(HttpError);
    expect(e).not.toBeInstanceOf(SessionExpiredError);
    const e2 = await client.getPost(1).catch((x) => x);
    expect(e2).toBeInstanceOf(HttpError);
  });
  it("403/429 는 BlockedError (차단/요청 제한 문구)", async () => {
    for (const status of [403, 429]) {
      const { client } = mockClient(() => new Response("x", { status }));
      const e = await client.listPosts().catch((x) => x);
      expect(e).toBeInstanceOf(BlockedError);
      expect(e.message).toContain("차단/요청 제한");
    }
  });
  it("200 HTML 은 세션 만료, 로그인이 아닌 곳으로의 302 는 HttpError", async () => {
    const a = mockClient(() => new Response("<html/>", { status: 200, headers: { "content-type": "text/html" } }));
    expect(await a.client.listCategories().catch((x) => x)).toBeInstanceOf(SessionExpiredError);
    const b = mockClient(() => new Response(null, { status: 302, headers: { location: "https://x.tistory.com/manage/elsewhere" } }));
    expect(await b.client.listCategories().catch((x) => x)).toBeInstanceOf(HttpError);
    const c = mockClient(() => new Response(null, { status: 302, headers: { location: "https://www.tistory.com/auth/login" } }));
    expect(await c.client.listCategories().catch((x) => x)).toBeInstanceOf(SessionExpiredError);
  });
});

describe("세션 파일", () => {
  it("병합 시 디스크의 최신 상태를 다시 읽어 다른 프로세스의 변경을 덮어쓰지 않는다", () => {
    const file = tmpState();
    const s = new Session(file);
    // 다른 프로세스(예: npm run login)가 파일에 쿠키를 추가
    const disk = JSON.parse(fs.readFileSync(file, "utf8"));
    disk.cookies.push({ name: "FRESH", value: "from-login-123", domain: ".tistory.com", path: "/", expires: -1 });
    fs.writeFileSync(file, JSON.stringify(disk), { mode: 0o600 });
    s.mergeSetCookie(["TSSESSION=ROTATED; Domain=.tistory.com; Path=/; Max-Age=3600"], "www.tistory.com");
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(saved.cookies.find((c: { name: string }) => c.name === "FRESH")?.value).toBe("from-login-123");
    expect(saved.cookies.find((c: { name: string }) => c.name === "TSSESSION")?.value).toBe("ROTATED");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
  });

  it("파일이 바뀌면 cookieHeader 가 다시 읽는다", () => {
    const file = tmpState();
    const s = new Session(file);
    expect(s.cookieHeader()).toBe("TSSESSION=FAKE-SESSION");
    const disk = JSON.parse(fs.readFileSync(file, "utf8"));
    disk.cookies[0].value = "NEW-LOGIN";
    fs.writeFileSync(file, JSON.stringify(disk), { mode: 0o600 });
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
    expect(s.cookieHeader()).toBe("TSSESSION=NEW-LOGIN");
  });

  it("죽은 프로세스가 남긴 오래된 락은 회수한다", () => {
    const file = tmpState();
    const lock = `${file}.lock`;
    fs.writeFileSync(lock, "");
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    const s = new Session(file);
    expect(s.mergeSetCookie(["A=1234567890; Domain=.tistory.com; Path=/; Max-Age=60"], "www.tistory.com")).toBe(true);
  });

  it("Max-Age 가 Expires 보다 우선", () => {
    const st = { cookies: [] as Record<string, unknown>[] } as never;
    const past = "Thu, 01 Jan 1970 00:00:01 GMT";
    applySetCookies(st, [`K=value-12345; Domain=.tistory.com; Path=/; Expires=${past}; Max-Age=3600`], "www.tistory.com");
    const c = (st as { cookies: { name: string; expires: number }[] }).cookies.find((x) => x.name === "K")!;
    expect(c).toBeDefined();
    expect(c.expires).toBeGreaterThan(Date.now() / 1000 + 3000);
    // Max-Age=0 이면 Expires 가 미래여도 삭제
    applySetCookies(st, ["K=x; Domain=.tistory.com; Path=/; Max-Age=0; Expires=Fri, 01 Jan 2100 00:00:00 GMT"], "www.tistory.com");
    expect((st as { cookies: unknown[] }).cookies).toHaveLength(0);
  });
});

describe("이미지 업로드 경로 검사", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "up-"));
  const ok = path.join(dir, "a.png");
  fs.writeFileSync(ok, png(4, 4));
  it("정상 이미지는 허용", async () => expect((await readImageForUpload(ok)).filename).toBe("a.png"));
  it("이미지가 아닌 파일 거부", async () => {
    const f = path.join(dir, "note.png");
    fs.writeFileSync(f, "plain text, not an image");
    await expect(readImageForUpload(f)).rejects.toThrow(/이미지/);
  });
  it(".secrets 및 숨김 경로 거부", async () => {
    fs.mkdirSync(path.join(dir, ".secrets"));
    const s = path.join(dir, ".secrets", "login-qr.png");
    fs.writeFileSync(s, png(4, 4));
    await expect(readImageForUpload(s)).rejects.toThrow(/숨김/);
    fs.mkdirSync(path.join(dir, ".hidden"));
    const h = path.join(dir, ".hidden", "x.png");
    fs.writeFileSync(h, png(4, 4));
    await expect(readImageForUpload(h)).rejects.toThrow(/숨김/);
  });
  it("숨김 경로를 가리키는 심볼릭 링크 거부", async () => {
    const link = path.join(dir, "link.png");
    fs.symlinkSync(path.join(dir, ".secrets", "login-qr.png"), link);
    await expect(readImageForUpload(link)).rejects.toThrow(/숨김/);
  });
  it("10MB 초과 거부", async () => {
    const big = path.join(dir, "big.png");
    fs.writeFileSync(big, Buffer.concat([png(4, 4), Buffer.alloc(10 * 1024 * 1024)]));
    await expect(readImageForUpload(big)).rejects.toThrow(/너무 큽니다/);
  });
});

describe("MCP 서버 안전장치", () => {
  async function connect(fake: Record<string, unknown>) {
    const server = buildServer(fake as never);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    const client = new Client({ name: "t", version: "1" });
    await client.connect(a);
    return client;
  }
  const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0]!.text);

  it("공개 범위를 public/protected 로 바꾸는 수정은 confirm 필요", async () => {
    const updatePost = vi.fn(async () => ({ id: "1", entryUrl: "u" }));
    const c = await connect({ updatePost, resolveCategory: async () => undefined });
    const denied = await c.callTool({ name: "tistory_update_post", arguments: { id: 1, visibility: "public" } });
    expect(denied.isError).toBe(true);
    expect(updatePost).not.toHaveBeenCalled();
    const ok = await c.callTool({ name: "tistory_update_post", arguments: { id: 1, visibility: "public", confirm: true } });
    expect(ok.isError).toBeFalsy();
    const priv = await c.callTool({ name: "tistory_update_post", arguments: { id: 1, visibility: "private" } });
    expect(priv.isError).toBeFalsy();
    expect(updatePost).toHaveBeenCalledTimes(2);
  });

  it("get_post 는 보호글 password 를 반환하지 않음", async () => {
    const c = await connect({ getPost: async () => ({ id: "1", title: "t", content: "c", visibility: 15, tags: [], password: "SECRET-PW" }) });
    const r = await c.callTool({ name: "tistory_get_post", arguments: { id: 1 } });
    expect(text(r)).not.toContain("SECRET-PW");
    expect(text(r)).toContain('"title"');
  });

  it("업로드 도구는 숨김 경로/비이미지를 거부", async () => {
    const uploadImage = vi.fn();
    const c = await connect({ uploadImage });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "srv-"));
    fs.mkdirSync(path.join(dir, ".secrets"));
    const f = path.join(dir, ".secrets", "state.json");
    fs.writeFileSync(f, "{}");
    const r = await c.callTool({ name: "tistory_upload_image", arguments: { path: f } });
    expect(r.isError).toBe(true);
    expect(uploadImage).not.toHaveBeenCalled();
  });

  it("도구 annotations", async () => {
    const c = await connect({});
    const tools = (await c.listTools()).tools;
    const by = Object.fromEntries(tools.map((t) => [t.name, t.annotations ?? {}]));
    expect(by.tistory_list_posts).toMatchObject({ readOnlyHint: true });
    expect(by.tistory_delete_post).toMatchObject({ destructiveHint: true });
    expect(by.tistory_publish_post).toMatchObject({ destructiveHint: true });
    expect(by.tistory_update_post).toMatchObject({ destructiveHint: true });
  });
});
