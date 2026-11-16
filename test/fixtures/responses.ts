// ENDPOINTS.md 의 응답 형태로 손으로 쓴 sanitized fixture (쿠키/비밀번호 없음)
export const myBlogs = {
  status: 200,
  desc: "OK",
  data: [
    { id: 1, name: "testblog", title: "테스트 블로그", defaultUrl: "https://testblog.tistory.com", adminUrl: "https://testblog.tistory.com/manage", role: "소유자", defaultBlog: true },
  ],
};

export const posts = {
  count: 2,
  totalCount: 2,
  items: [
    { id: "12", title: "두번째", slogan: "second", visibility: "PUBLIC", category: "개발", categoryId: "5", published: "2026-01-02", created: "2026-01-02", modified: "2026-01-02", permalink: "https://testblog.tistory.com/12", countOfComments: "0" },
    { id: "11", title: "첫번째", slogan: "first", visibility: "PRIVATE", category: "", categoryId: "0", published: "2026-01-01", created: "2026-01-01", modified: "2026-01-01", permalink: "https://testblog.tistory.com/11", countOfComments: "0" },
  ],
};

export const categories = {
  categories: [
    { id: -3, name: "전체", label: "전체", priority: 0, entries: 2, visibility: 2, children: [], leaf: true },
    {
      id: 5, name: "개발", label: "개발", priority: 1, entries: 1, visibility: 2, leaf: false,
      children: [{ id: 6, name: "자바스크립트", label: "개발/자바스크립트", priority: 1, entries: 1, visibility: 2, children: [], leaf: true }],
    },
  ],
};

export const postDetail = {
  id: "12",
  title: "두번째",
  slogan: "second",
  content: "<p>본문</p>",
  published: 1767312000,
  category: "5",
  type: "post",
  visibility: 20,
  acceptComment: "1",
  tags: ["a", "b"],
  thumbnail: null,
};

export const newpostHtml = `<!doctype html><html><head><script>
window.Config = {
  "post": ${JSON.stringify(postDetail)},
  version: 'x', // JS 리터럴 (엄격한 JSON 아님)
  extra: { a: 1 }
};
</script></head><body></body></html>
`;

export const drafts = {
  success: true,
  data: [{ sequence: 3, title: "초안", summary: "요약", tags: "", categoryId: 0, createdAt: "2026-01-01 10:00:00", updatedAt: "2026-01-01 10:00:00" }],
};

export const draftCreate = { success: true, total: 1, draft: { sequence: 9 } };
export const draftDelete = { success: true, total: 0 };
export const attach = {
  name: "a.png",
  url: "https://blog.kakaocdn.net/dna/abc/def/GHI/img.png?credential=FAKE&expires=1&allow_ip=&signature=FAKE",
  key: "abc/def/GHI",
  filename: "img.png",
  size: 10,
};
