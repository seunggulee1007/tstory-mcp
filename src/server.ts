#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createClient, type TistoryClient, type Visibility } from "./client.js";
import { CaptchaRequiredError, ContractError, HttpError, SessionExpiredError } from "./errors.js";
import { readImageForUpload } from "./image.js";
import { markdownToHtml } from "./markdown.js";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
});
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

export function describeError(e: unknown): string {
  if (e instanceof SessionExpiredError) {
    return "티스토리 세션이 만료되었습니다. 터미널에서 `npm run login` 을 실행하고 카카오톡으로 QR 코드를 스캔해 다시 로그인한 뒤 다시 시도하세요.";
  }
  if (e instanceof ContractError) {
    return `티스토리 내부 API 응답 형식이 바뀐 것 같습니다 (${e.message}). 헬스체크/복구 배치를 확인하세요.`;
  }
  if (e instanceof CaptchaRequiredError) return `캡차 인증이 필요합니다: ${e.message}`;
  if (e instanceof HttpError) return `티스토리 요청 실패: ${e.message}`;
  return `오류: ${e instanceof Error ? e.message : String(e)}`;
}

async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (e) {
    return fail(describeError(e));
  }
}

const visibilityEnum = z.enum(["private", "protected", "public"]);
const formatEnum = z.enum(["markdown", "html"]);

async function toHtml(client: TistoryClient, content: string, format: "markdown" | "html"): Promise<string> {
  if (format === "html") return content;
  return markdownToHtml(content, (buf, name) => client.uploadImage(buf, name));
}

export function buildServer(client: TistoryClient): McpServer {
  const server = new McpServer({ name: "tstory-mcp", version: "1.0.0" });

  server.registerTool(
    "tistory_whoami",
    {
      annotations: { readOnlyHint: true, openWorldHint: true }, description: "로그인된 티스토리 계정의 블로그 목록과 현재 사용 중인 블로그를 확인합니다." },
    () =>
      run(async () => {
        const blogs = await client.myBlogs();
        return { currentBlog: await client.blog(), blogs: blogs.map((b) => ({ name: b.name, title: b.title, defaultBlog: b.defaultBlog })) };
      }),
  );

  server.registerTool(
    "tistory_list_posts",
    {
      annotations: { readOnlyHint: true, openWorldHint: true },
      description: "블로그 글 목록을 조회합니다 (페이지당 15개). 키워드/카테고리/공개범위로 필터링할 수 있습니다.",
      inputSchema: {
        page: z.number().int().min(1).optional().describe("페이지 번호 (기본 1)"),
        keyword: z.string().optional().describe("제목 검색어"),
        categoryId: z.number().int().optional().describe("카테고리 id (기본: 전체)"),
        visibility: z.enum(["all", "private", "protected", "public"]).optional().describe("공개 범위 필터"),
      },
    },
    (args) =>
      run(async () => {
        const r = await client.listPosts(args);
        return {
          count: r.count,
          totalCount: r.totalCount,
          items: r.items.map((p) => ({
            id: String(p.id),
            title: p.title,
            visibility: p.visibility,
            category: p.category,
            categoryId: p.categoryId,
            created: p.created,
            permalink: p.permalink,
          })),
        };
      }),
  );

  server.registerTool(
    "tistory_get_post",
    {
      annotations: { readOnlyHint: true, openWorldHint: true },
      description: "글 한 건의 제목, 본문(HTML), 공개범위, 카테고리, 태그를 조회합니다.",
      inputSchema: { id: z.union([z.string(), z.number()]).describe("글 번호") },
    },
    ({ id }) =>
      run(async () => {
        // 보호글 비밀번호(password)는 응답에 싣지 않는다
        const { password: _pw, ...post } = (await client.getPost(id)) as Record<string, unknown>;
        return post;
      }),
  );

  server.registerTool(
    "tistory_list_categories",
    {
      annotations: { readOnlyHint: true, openWorldHint: true }, description: "카테고리 목록을 계층 경로(예: 부모/자식)와 함께 평탄화해 조회합니다." },
    () => run(() => client.listCategories()),
  );

  server.registerTool(
    "tistory_publish_post",
    {
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      description:
        "새 글을 발행합니다. 기본 공개범위는 비공개(private)입니다. 마크다운의 로컬 이미지는 자동 업로드됩니다. 캡차로 막히면 임시저장으로 대체합니다. 글 번호는 발행 시 영구 소모되니 주의하세요.",
      inputSchema: {
        title: z.string().min(1).describe("제목"),
        content: z.string().describe("본문 (format 에 따라 마크다운 또는 HTML)"),
        format: formatEnum.default("markdown").describe("본문 형식"),
        visibility: visibilityEnum.default("private").describe("공개 범위 (기본 private)"),
        category: z.union([z.string(), z.number()]).optional().describe("카테고리 id 또는 이름/경로"),
        tags: z.array(z.string()).optional().describe("태그 목록"),
      },
    },
    ({ title, content, format, visibility, category, tags }) =>
      run(async () => {
        const html = await toHtml(client, content, format);
        const categoryId = await client.resolveCategory(category);
        try {
          const r = await client.publishPost({ title, content: html, visibility: visibility as Visibility, category: categoryId, tags });
          return { published: true, ...r, visibility };
        } catch (e) {
          if (!(e instanceof CaptchaRequiredError)) throw e;
          const d = await client.saveDraft({ title, content: html, tags, categoryId });
          return {
            published: false,
            savedAsDraft: true,
            draftSequence: d.sequence,
            message: "캡차 인증이 필요해 발행하지 못하고 임시저장으로 대체했습니다. 티스토리에서 직접 발행해 주세요.",
          };
        }
      }),
  );

  server.registerTool(
    "tistory_update_post",
    {
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      description: "기존 글을 수정합니다. 지정한 필드만 바꾸고 나머지는 기존 값을 유지합니다.",
      inputSchema: {
        id: z.union([z.string(), z.number()]).describe("글 번호"),
        title: z.string().optional(),
        content: z.string().optional(),
        format: formatEnum.default("markdown").describe("content 형식"),
        visibility: visibilityEnum.optional().describe("public/protected 로 바꾸려면 confirm: true 필요"),
        category: z.union([z.string(), z.number()]).optional().describe("카테고리 id 또는 이름/경로"),
        tags: z.array(z.string()).optional(),
        confirm: z.boolean().optional().describe("공개 범위를 public/protected 로 바꿀 때 true"),
      },
    },
    ({ id, title, content, format, visibility, category, tags, confirm }) => {
      if ((visibility === "public" || visibility === "protected") && confirm !== true) {
        return Promise.resolve(fail("공개 범위를 public/protected 로 바꾸려면 confirm: true 를 지정해야 합니다."));
      }
      return run(async () => {
        const html = content === undefined ? undefined : await toHtml(client, content, format);
        const categoryId = await client.resolveCategory(category);
        return client.updatePost(id, {
          ...(title !== undefined && { title }),
          ...(html !== undefined && { content: html }),
          ...(visibility !== undefined && { visibility }),
          ...(categoryId !== undefined && { category: categoryId }),
          ...(tags !== undefined && { tags }),
        });
      });
    },
  );

  server.registerTool(
    "tistory_delete_post",
    {
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      description: "글을 삭제합니다. 되돌릴 수 없으므로 confirm: true 가 반드시 필요합니다.",
      inputSchema: {
        id: z.union([z.string(), z.number()]).describe("글 번호"),
        confirm: z.boolean().describe("true 여야만 삭제합니다"),
      },
    },
    ({ id, confirm }) =>
      confirm !== true ? Promise.resolve(fail("삭제하려면 confirm: true 를 지정해야 합니다.")) : run(() => client.deletePost(id)),
  );

  server.registerTool(
    "tistory_list_drafts",
    {
      annotations: { readOnlyHint: true, openWorldHint: true }, description: "임시저장 글 목록을 조회합니다." },
    () => run(() => client.listDrafts()),
  );

  server.registerTool(
    "tistory_save_draft",
    {
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      description: "임시저장 글을 만듭니다.",
      inputSchema: {
        title: z.string().min(1),
        content: z.string(),
        format: formatEnum.default("markdown"),
        category: z.union([z.string(), z.number()]).optional().describe("카테고리 id 또는 이름/경로"),
        tags: z.array(z.string()).optional(),
      },
    },
    ({ title, content, format, category, tags }) =>
      run(async () => {
        const html = await toHtml(client, content, format);
        const categoryId = await client.resolveCategory(category);
        return client.saveDraft({ title, content: html, tags, categoryId });
      }),
  );

  server.registerTool(
    "tistory_delete_draft",
    {
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      description: "임시저장 글을 삭제합니다.",
      inputSchema: { sequence: z.number().int().describe("임시저장 sequence 번호") },
    },
    ({ sequence }) =>
      run(async () => {
        await client.deleteDraft(sequence);
        return { deleted: sequence };
      }),
  );

  server.registerTool(
    "tistory_upload_image",
    {
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      description: "로컬 이미지 파일을 티스토리에 업로드하고 본문에 넣을 치환자(placeholder)를 반환합니다.",
      inputSchema: { path: z.string().describe("이미지 파일의 로컬 경로") },
    },
    ({ path: p }) =>
      run(async () => {
        const { buffer, filename } = await readImageForUpload(p);
        return client.uploadImage(buffer, filename);
      }),
  );

  return server;
}

const KEEPALIVE_MS = 6 * 60 * 60 * 1000;

/** myBlogs 호출은 응답 Set-Cookie 로 세션 만료를 30일 뒤로 밀어준다(슬라이딩). 실패해도 무시. */
async function keepAlive(client: TistoryClient): Promise<void> {
  try {
    await client.myBlogs();
  } catch (e) {
    console.error(`세션 갱신 실패: ${e instanceof Error ? e.message : e}`);
  }
}

async function main(): Promise<void> {
  const client = createClient();
  const server = buildServer(client);
  await server.connect(new StdioServerTransport());
  void keepAlive(client);
  setInterval(() => void keepAlive(client), KEEPALIVE_MS).unref();
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("server.js") || process.argv[1]?.endsWith("tstory-mcp")) {
  main().catch((e) => {
    console.error("서버 시작 실패:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
