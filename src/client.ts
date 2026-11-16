import vm from "node:vm";
import path from "node:path";
import type { z } from "zod";
import { type Config } from "./config.js";
import { Session } from "./session.js";
import { BlockedError, CaptchaRequiredError, ContractError, HttpError, SessionExpiredError } from "./errors.js";
import { buildPlaceholder, parseImageSize } from "./image.js";
import {
  AttachSchema,
  CategoriesSchema,
  ConfigSchema,
  DeletePostSchema,
  DraftCreateSchema,
  DraftDeleteSchema,
  DraftListSchema,
  EntryUrlSchema,
  MyBlogsSchema,
  PostListSchema,
  type CategoryNode,
  type DraftItem,
  type PostDetail,
} from "./schemas.js";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36";
const MYBLOGS_URL = "https://www.tistory.com/legacy/member/blog/api/myBlogs";

export type Visibility = "private" | "protected" | "public";
export const VISIBILITY_CODE: Record<Visibility, number> = { private: 0, protected: 15, public: 20 };

export interface FlatCategory {
  id: number;
  name: string;
  path: string;
  entries?: number | undefined;
}

export interface PostInput {
  title: string;
  content: string;
  visibility: Visibility;
  category?: number | undefined;
  tags?: string[] | undefined;
}

export interface UploadResult {
  url: string;
  key: string;
  filename: string;
  placeholder: string;
}

export type FetchFn = typeof fetch;

interface RawResponse {
  status: number;
  contentType: string;
  location: string;
  text: string;
}

/** 비정상 상태 코드 → 예외. 403/429 는 계약 변경이 아닌 차단/요청 제한으로 분류한다. */
export function httpFailure(endpoint: string, status: number): HttpError {
  return status === 403 || status === 429 ? new BlockedError(endpoint, status) : new HttpError(endpoint, status);
}

const CAPTCHA_RE = /captcha|kaptcha|recaptcha|캡차|보안\s*문자/i;

/** `window.Config = {...}` 의 중괄호 범위를 문자열/주석을 고려해 균형 맞춰 잘라낸다 */
function extractConfigLiteral(html: string): string | undefined {
  const m = /window\.Config\s*=\s*\{/.exec(html);
  if (!m) return undefined;
  const start = m.index + m[0].length - 1;
  let depth = 0;
  for (let i = start; i < html.length; i++) {
    const ch = html[i]!;
    if (ch === '"' || ch === "'" || ch === "`") {
      for (i++; i < html.length && html[i] !== ch; i++) if (html[i] === "\\") i++;
    } else if (ch === "/" && html[i + 1] === "/") {
      while (i < html.length && html[i] !== "\n") i++;
    } else if (ch === "/" && html[i + 1] === "*") {
      i = html.indexOf("*/", i + 2);
      if (i < 0) return undefined;
      i++;
    } else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return html.slice(start, i + 1);
  }
  return undefined;
}

/** window.Config 리터럴을 파싱해 post 를 돌려준다 */
export function parseWindowConfig(html: string): z.infer<typeof ConfigSchema> {
  const literal = extractConfigLiteral(html);
  if (!literal) {
    // 로그인 페이지 등 다른 HTML 이면 세션 만료로 본다
    throw new SessionExpiredError("newpost", "window.Config 를 찾을 수 없음");
  }
  let value: unknown;
  try {
    value = vm.runInNewContext(`(${literal})`, Object.create(null), { timeout: 1000 });
  } catch {
    throw new ContractError("newpost", [{ code: "custom", path: ["window.Config"], message: "파싱 실패" }]);
  }
  const r = ConfigSchema.safeParse(value);
  if (!r.success) throw new ContractError("newpost", r.error.issues);
  return r.data;
}

export function entryUrlToId(entryUrl: string): string {
  const m = entryUrl.replace(/[?#].*$/, "").match(/\/(\d+)\/?$/);
  if (!m || !m[1]) throw new ContractError("entryUrl", [{ code: "custom", path: ["entryUrl"], message: "id 추출 실패" }]);
  return m[1];
}

export class TistoryClient {
  private blogName: string | undefined;

  constructor(
    private readonly session: Session,
    private readonly config: Pick<Config, "blog">,
    private readonly fetchFn: FetchFn = fetch,
  ) {
    this.blogName = config.blog;
  }

  private async raw(method: string, url: string, init: { body?: BodyInit; json?: unknown; referer?: string } = {}): Promise<RawResponse> {
    const headers: Record<string, string> = {
      cookie: this.session.cookieHeader(),
      "user-agent": UA,
      accept: "application/json, text/html;q=0.8, */*;q=0.5",
    };
    if (init.referer) headers.referer = init.referer;
    let body = init.body;
    if (init.json !== undefined) {
      body = JSON.stringify(init.json);
      headers["content-type"] = "application/json;charset=UTF-8";
    }
    const res = await this.fetchFn(url, { method, headers, body, redirect: "manual" });
    const u = new URL(url);
    const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    if (setCookies.length) this.session.mergeSetCookie(setCookies, u.hostname);
    const text = await res.text();
    return { status: res.status, contentType: res.headers.get("content-type") ?? "", location: res.headers.get("location") ?? "", text };
  }

  private endpointName(method: string, url: string): string {
    const u = new URL(url);
    return `${method} ${u.pathname.replace(/\/\d+(\.json)?$/, "/{id}$1")}`;
  }

  /** 3xx: 로그인으로 보내는 리다이렉트만 세션 만료. 그 외 리다이렉트는 API 변경(HttpError) */
  private assertNotExpired(endpoint: string, r: RawResponse): void {
    if (r.status >= 300 && r.status < 400) {
      if (!r.location || /login|auth|kakao/i.test(r.location)) throw new SessionExpiredError(endpoint, `HTTP ${r.status}`, true);
      throw new HttpError(endpoint, r.status);
    }
  }

  private parseJson<S extends z.ZodType>(endpoint: string, r: RawResponse, schema: S): z.infer<S> {
    this.assertNotExpired(endpoint, r);
    // 상태 코드가 먼저: 404 HTML 페이지 등은 세션 만료가 아니다
    if (r.status < 200 || r.status >= 300) throw httpFailure(endpoint, r.status);
    const looksHtml = /text\/html/i.test(r.contentType) || /^\s*</.test(r.text);
    if (looksHtml) throw new SessionExpiredError(endpoint, "JSON 대신 HTML 응답");
    let data: unknown;
    try {
      data = JSON.parse(r.text);
    } catch {
      throw new ContractError(endpoint, [{ code: "custom", path: [], message: "JSON 파싱 실패" }]);
    }
    const p = schema.safeParse(data);
    if (!p.success) throw new ContractError(endpoint, p.error.issues);
    return p.data;
  }

  private async json<S extends z.ZodType>(
    method: string,
    url: string,
    schema: S,
    init: { body?: BodyInit; json?: unknown } = {},
  ): Promise<z.infer<S>> {
    const r = await this.raw(method, url, { ...init, referer: `https://${this.blogName ?? "www"}.tistory.com/manage/newpost` });
    return this.parseJson(this.endpointName(method, url), r, schema);
  }

  /** TSSESSION 만료 시각(epoch 초). 세션 쿠키면 undefined */
  sessionExpiresAt(): number | undefined {
    return this.session.expiryOf("TSSESSION");
  }

  async myBlogs() {
    const r = await this.raw("GET", MYBLOGS_URL, { referer: "https://www.tistory.com/" });
    return this.parseJson("GET /legacy/member/blog/api/myBlogs", r, MyBlogsSchema).data;
  }

  async blog(): Promise<string> {
    if (this.blogName) return this.blogName;
    const blogs = await this.myBlogs();
    const def = blogs.find((b) => b.defaultBlog) ?? blogs[0];
    if (!def) throw new Error("블로그가 없습니다");
    this.blogName = def.name;
    return def.name;
  }

  private async base(): Promise<string> {
    return `https://${await this.blog()}.tistory.com/manage`;
  }

  async listPosts(opts: { page?: number; keyword?: string; categoryId?: number; visibility?: "all" | Visibility } = {}) {
    const B = await this.base();
    const vis = opts.visibility === "private" ? "private" : opts.visibility === "protected" ? "protected" : opts.visibility === "public" ? "public" : "all";
    const q = new URLSearchParams({
      category: String(opts.categoryId ?? -3),
      page: String(opts.page ?? 1),
      searchKeyword: opts.keyword ?? "",
      searchType: "title",
      visibility: vis,
    });
    return this.json("GET", `${B}/posts.json?${q}`, PostListSchema);
  }

  async getPost(id: string | number): Promise<PostDetail> {
    const B = await this.base();
    const url = `${B}/newpost/${id}`;
    const r = await this.raw("GET", url, { referer: `${B}/posts` });
    const ep = this.endpointName("GET", url);
    this.assertNotExpired(ep, r);
    if (r.status < 200 || r.status >= 300) throw httpFailure(ep, r.status);
    return parseWindowConfig(r.text).post;
  }

  async listCategories(): Promise<FlatCategory[]> {
    const B = await this.base();
    const data = await this.json("GET", `${B}/category/simple.json`, CategoriesSchema);
    return flattenCategories(data.categories);
  }

  /** 카테고리 id 숫자 또는 이름/경로("부모/자식")를 id 로 변환 */
  async resolveCategory(cat: string | number | undefined): Promise<number | undefined> {
    if (cat === undefined || cat === "") return undefined;
    if (typeof cat === "number") return cat;
    if (/^-?\d+$/.test(cat)) return Number(cat);
    const flat = await this.listCategories();
    const hit = flat.find((c) => c.path === cat) ?? flat.find((c) => c.name === cat);
    if (!hit) throw new Error(`카테고리를 찾을 수 없습니다: ${cat}`);
    return hit.id;
  }

  private postBody(id: string, published: 0 | 1, p: PostInput) {
    return {
      id,
      title: p.title,
      content: p.content,
      slogan: "",
      visibility: VISIBILITY_CODE[p.visibility],
      category: p.category ?? 0,
      tag: (p.tags ?? []).join(","),
      published,
      uselessMarginForEntry: 1,
      cclCommercial: 0,
      cclDerive: 0,
      type: "post",
      attachments: [],
      recaptchaValue: "",
      draftSequence: null,
      ...(published === 0 ? { acceptComment: 1, thumbnail: null, daumLike: null } : {}),
    };
  }

  private async submitPost(method: "POST" | "PUT", url: string, body: unknown): Promise<{ id: string; entryUrl: string }> {
    const ep = this.endpointName(method, url);
    const B = await this.base();
    const r = await this.raw(method, url, { json: body, referer: `${B}/newpost` });
    this.assertNotExpired(ep, r);
    const htmlBody = /text\/html/i.test(r.contentType) || /^\s*</.test(r.text);
    if (r.status < 200 || r.status >= 300) {
      if (r.status === 403 || r.status === 429 || CAPTCHA_RE.test(r.text)) throw new CaptchaRequiredError(ep, r.status);
      throw httpFailure(ep, r.status);
    }
    if (htmlBody) throw new SessionExpiredError(ep, "JSON 대신 HTML 응답");
    let data: unknown;
    try {
      data = JSON.parse(r.text);
    } catch {
      data = undefined;
    }
    const p = EntryUrlSchema.safeParse(data);
    if (!p.success) {
      if (CAPTCHA_RE.test(r.text)) throw new CaptchaRequiredError(ep, r.status);
      throw new ContractError(ep, p.error.issues);
    }
    return { id: entryUrlToId(p.data.entryUrl), entryUrl: p.data.entryUrl };
  }

  async publishPost(p: PostInput) {
    const B = await this.base();
    return this.submitPost("POST", `${B}/post.json`, this.postBody("0", 1, p));
  }

  async updatePost(id: string | number, patch: Partial<PostInput>) {
    const cur = await this.getPost(id);
    const curVis: Visibility = cur.visibility === 20 ? "public" : cur.visibility === 15 ? "protected" : "private";
    const catNum = cur.category == null ? 0 : Number(cur.category);
    const merged: PostInput = {
      title: patch.title ?? cur.title,
      content: patch.content ?? cur.content,
      visibility: patch.visibility ?? curVis,
      category: patch.category ?? (Number.isFinite(catNum) ? catNum : 0),
      tags: patch.tags ?? cur.tags,
    };
    const B = await this.base();
    return this.submitPost("PUT", `${B}/post/${id}.json`, this.postBody(String(id), 0, merged));
  }

  async deletePost(id: string | number) {
    const B = await this.base();
    const d = await this.json("DELETE", `${B}/post/${id}.json`, DeletePostSchema);
    return { id: String(typeof d.data === "object" ? d.data.id : d.data) };
  }

  async listDrafts(): Promise<DraftItem[]> {
    const B = await this.base();
    return (await this.json("GET", `${B}/drafts`, DraftListSchema)).data;
  }

  async saveDraft(d: { title: string; content: string; tags?: string[]; categoryId?: number }): Promise<{ sequence: number }> {
    const B = await this.base();
    const res = await this.json("POST", `${B}/drafts`, DraftCreateSchema, {
      json: {
        title: d.title,
        content: d.content,
        tags: (d.tags ?? []).join(","),
        categoryId: d.categoryId ?? 0,
        totalWritingTimeMs: 0,
      },
    });
    return { sequence: res.draft.sequence };
  }

  async deleteDraft(sequence: number): Promise<void> {
    const B = await this.base();
    await this.json("DELETE", `${B}/drafts/${sequence}`, DraftDeleteSchema);
  }

  async uploadImage(buffer: Buffer, filename: string): Promise<UploadResult> {
    const B = await this.base();
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(buffer)]), path.basename(filename));
    const a = await this.json("POST", `${B}/post/attach.json`, AttachSchema, { body: form });
    return {
      url: a.url,
      key: a.key,
      filename: a.filename,
      placeholder: buildPlaceholder(a.url, path.basename(filename), parseImageSize(buffer)),
    };
  }
}

export function flattenCategories(nodes: CategoryNode[], parent = ""): FlatCategory[] {
  const out: FlatCategory[] = [];
  for (const n of nodes) {
    const p = parent ? `${parent}/${n.name}` : n.name;
    out.push({ id: n.id, name: n.name, path: p, entries: n.entries });
    if (n.children?.length) out.push(...flattenCategories(n.children, p));
  }
  return out;
}

import { loadConfig } from "./config.js";

export function createClient(env: NodeJS.ProcessEnv = process.env): TistoryClient {
  const cfg = loadConfig(env);
  return new TistoryClient(new Session(cfg.stateFile), cfg);
}
