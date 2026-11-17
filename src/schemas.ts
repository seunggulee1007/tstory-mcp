import { z } from "zod";

/** 서버가 문자열/숫자를 섞어 내려주는 id 계열 */
const idLike = z.union([z.string(), z.number()]);

export const MyBlogsSchema = z
  .object({
    status: z.number(),
    data: z.array(
      z.object({ id: idLike, name: z.string(), title: z.string(), defaultBlog: z.boolean() }).passthrough(),
    ),
  })
  .passthrough();

export const PostListItemSchema = z
  .object({
    id: idLike,
    title: z.string(),
    visibility: z.string(),
    category: z.string().nullish(),
    categoryId: idLike.nullish(),
    created: z.string().nullish(),
    permalink: z.string().nullish(),
  })
  .passthrough();

export const PostListSchema = z
  .object({ count: z.number(), totalCount: z.number(), items: z.array(PostListItemSchema) })
  .passthrough();

export interface CategoryNode {
  id: number;
  name: string;
  label?: string | undefined;
  entries?: number | undefined;
  children?: CategoryNode[] | undefined;
}

export const CategoryNodeSchema: z.ZodType<CategoryNode> = z.lazy(() =>
  z
    .object({
      id: z.number(),
      name: z.string(),
      label: z.string().optional(),
      entries: z.number().optional(),
      children: z.array(CategoryNodeSchema).optional(),
    })
    .passthrough(),
);

export const CategoriesSchema = z.object({ categories: z.array(CategoryNodeSchema) }).passthrough();

/** GET {B}/category.json: 카테고리 관리 화면의 전체 트리 (rootLabel 은 저장 시 그대로 되돌려 보낸다) */
export const CategoryTreeSchema = z
  .object({ categories: z.array(CategoryNodeSchema), rootLabel: z.string() })
  .passthrough();

/** PUT {B}/category.json 응답: 실측 형태는 {categoryTree, inputs, rootLabel}. 필드에 의존하지 않으므로 어떤 JSON 객체든 통과시킨다 */
export const CategorySaveSchema = z.object({}).passthrough();

/** window.Config.post */
export const PostDetailSchema = z
  .object({
    id: idLike,
    title: z.string(),
    content: z.string(),
    visibility: z.number(),
    category: idLike.nullish(),
    tags: z.array(z.string()),
    slogan: z.string().nullish(),
  })
  .passthrough();

export const ConfigSchema = z.object({ post: PostDetailSchema }).passthrough();

export const EntryUrlSchema = z.object({ entryUrl: z.string() }).passthrough();

// 실측 응답은 {"data":193} (숫자). 객체 형태도 허용해 둔다.
export const DeletePostSchema = z
  .object({ data: z.union([idLike, z.object({ id: idLike }).passthrough()]) })
  .passthrough();

export const DraftItemSchema = z
  .object({
    sequence: z.number(),
    title: z.string(),
    categoryId: idLike.nullish(),
    createdAt: z.union([z.string(), z.number()]).nullish(),
    updatedAt: z.union([z.string(), z.number()]).nullish(),
  })
  .passthrough();

export const DraftListSchema = z.object({ success: z.boolean(), data: z.array(DraftItemSchema) }).passthrough();

export const DraftCreateSchema = z
  .object({ success: z.boolean(), total: z.number().optional(), draft: z.object({ sequence: z.number() }).passthrough() })
  .passthrough();

export const DraftDeleteSchema = z.object({ success: z.boolean() }).passthrough();

export const AttachSchema = z
  .object({ url: z.string(), key: z.string(), filename: z.string() })
  .passthrough();

export type PostListItem = z.infer<typeof PostListItemSchema>;
export type PostDetail = z.infer<typeof PostDetailSchema>;
export type DraftItem = z.infer<typeof DraftItemSchema>;
