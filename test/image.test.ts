import { describe, expect, it } from "vitest";
import { buildPlaceholder, parseImageSize } from "../src/image.js";
import { png } from "./png.js";

describe("이미지 크기 파싱", () => {
  it("PNG", () => expect(parseImageSize(png(16, 8))).toEqual({ width: 16, height: 8 }));
  it("GIF", () => {
    const b = Buffer.alloc(10);
    b.write("GIF89a", 0, "ascii");
    b.writeUInt16LE(30, 6);
    b.writeUInt16LE(20, 8);
    expect(parseImageSize(b)).toEqual({ width: 30, height: 20 });
  });
  it("JPEG (SOF0)", () => {
    const b = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x20, 0x00, 0x40, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(parseImageSize(b)).toEqual({ width: 0x40, height: 0x20 });
  });
  it("WebP (VP8X)", () => {
    const b = Buffer.alloc(30);
    b.write("RIFF", 0, "ascii");
    b.write("WEBP", 8, "ascii");
    b.write("VP8X", 12, "ascii");
    b.writeUIntLE(99, 24, 3);
    b.writeUIntLE(49, 27, 3);
    expect(parseImageSize(b)).toEqual({ width: 100, height: 50 });
  });
  it("알 수 없는 형식은 undefined", () => expect(parseImageSize(Buffer.from("hello"))).toBeUndefined());
});

describe("치환자 형식", () => {
  const url = "https://blog.kakaocdn.net/dna/abc/def/img.png?credential=X&expires=1&signature=Y";
  it("ENDPOINTS.md 형식과 정확히 일치", () => {
    expect(buildPlaceholder(url, "a.png", { width: 16, height: 8 })).toBe(
      '[##_Image|kage@abc/def/img.png?credential=X&amp;expires=1&amp;signature=Y|CDM|1.3|{"originWidth":16,"originHeight":8,"style":"alignCenter","filename":"a.png"}_##]',
    );
  });
  it("크기를 모르면 originWidth/Height 생략", () => {
    const p = buildPlaceholder(url, "a.png");
    expect(p).not.toContain("originWidth");
    expect(p).toContain('{"style":"alignCenter","filename":"a.png"}');
  });
});
