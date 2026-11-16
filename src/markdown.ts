import path from "node:path";
import { Marked } from "marked";
import { readImageForUpload } from "./image.js";

export type Uploader = (buf: Buffer, filename: string) => Promise<{ placeholder: string }>;

const REMOTE_RE = /^([a-z][a-z0-9+.-]*:|\/\/)/i;

/** 마크다운 → HTML. 로컬 이미지는 업로드 후 티스토리 치환자(<p> 로 감쌈)로 바꾼다. */
export async function markdownToHtml(md: string, upload: Uploader, baseDir = process.cwd()): Promise<string> {
  const localImages = new Map<string, string>();
  const marked = new Marked({ gfm: true, breaks: false });
  marked.use({
    walkTokens(token) {
      if (token.type === "image" && !REMOTE_RE.test(token.href)) {
        localImages.set(token.href, "");
      }
    },
  });
  // 1차: 로컬 이미지 수집 후 업로드
  marked.parse(md);
  for (const href of localImages.keys()) {
    let file = decodeURI(href);
    if (!path.isAbsolute(file)) file = path.resolve(baseDir, file);
    const { buffer, filename } = await readImageForUpload(file);
    const { placeholder } = await upload(buffer, filename);
    localImages.set(href, placeholder);
  }
  // 2차: 이미지를 치환자로 렌더 (단독 이미지 단락은 marked 가 <p> 로 감쌈)
  const renderer = new Marked({ gfm: true });
  renderer.use({
    renderer: {
      image({ href, title, text }) {
        const ph = localImages.get(href);
        if (ph !== undefined) return ph;
        const t = title ? ` title="${title}"` : "";
        return `<img src="${href}" alt="${text}"${t}>`;
      },
    },
  });
  return renderer.parse(md) as string;
}
