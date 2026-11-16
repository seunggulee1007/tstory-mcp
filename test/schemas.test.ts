import { describe, expect, it } from "vitest";
import * as S from "../src/schemas.js";
import * as F from "./fixtures/responses.js";

describe("스키마 (sanitized fixture)", () => {
  it.each([
    ["myBlogs", S.MyBlogsSchema, F.myBlogs],
    ["posts", S.PostListSchema, F.posts],
    ["categories", S.CategoriesSchema, F.categories],
    ["config", S.ConfigSchema, { post: F.postDetail }],
    ["drafts", S.DraftListSchema, F.drafts],
    ["draftCreate", S.DraftCreateSchema, F.draftCreate],
    ["draftDelete", S.DraftDeleteSchema, F.draftDelete],
    ["attach", S.AttachSchema, F.attach],
    ["entryUrl", S.EntryUrlSchema, { entryUrl: "https://testblog.tistory.com/13" }],
    ["deletePost (실측: 숫자)", S.DeletePostSchema, { data: 193 }],
    ["deletePost (객체)", S.DeletePostSchema, { data: { id: "13" } }],
  ])("%s 통과", (_n, schema, data) => {
    expect(schema.safeParse(data).success).toBe(true);
  });

  it("passthrough: 모르는 필드를 보존", () => {
    const r = S.MyBlogsSchema.parse({ ...F.myBlogs, extra: 1 }) as Record<string, unknown>;
    expect(r.extra).toBe(1);
  });

  it("필수 필드가 사라지면 실패", () => {
    expect(S.PostListSchema.safeParse({ count: 1, totalCount: 1 }).success).toBe(false);
    expect(S.DraftCreateSchema.safeParse({ success: true }).success).toBe(false);
  });
});
