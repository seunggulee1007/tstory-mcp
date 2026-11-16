import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { markdownToHtml } from "../src/markdown.js";
import { png } from "./png.js";

describe("markdownToHtml", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-"));
  fs.writeFileSync(path.join(dir, "x.png"), png(2, 2));
  const abs = path.join(dir, "y.png");
  fs.writeFileSync(abs, png(2, 2));

  it("GFM 렌더", async () => {
    const html = await markdownToHtml("# 제목\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n~~취소~~", async () => ({ placeholder: "" }));
    expect(html).toContain("<h1");
    expect(html).toContain("<table>");
    expect(html).toContain("<del>");
  });

  it("로컬 이미지(상대/절대)는 업로드 후 <p> 치환자로 교체, 원격은 유지", async () => {
    const uploaded: string[] = [];
    const html = await markdownToHtml(
      `![a](./x.png)\n\n![b](${abs})\n\n![c](https://example.com/r.png)`,
      async (_buf, name) => {
        uploaded.push(name);
        return { placeholder: `[##_Image|kage@${name}|CDM|1.3|{}_##]` };
      },
      dir,
    );
    expect(uploaded).toEqual(["x.png", "y.png"]);
    expect(html).toContain("<p>[##_Image|kage@x.png|CDM|1.3|{}_##]</p>");
    expect(html).toContain("<p>[##_Image|kage@y.png|CDM|1.3|{}_##]</p>");
    expect(html).toContain('<img src="https://example.com/r.png"');
    expect(html).not.toContain("./x.png");
  });
});
