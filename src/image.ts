import fs from "node:fs/promises";
import path from "node:path";

export interface ImageSize {
  width: number;
  height: number;
}

/** PNG/JPEG/GIF/WebP 헤더에서 크기를 읽는다. 알 수 없으면 undefined. */
export function parseImageSize(buf: Buffer): ImageSize | undefined {
  try {
    // PNG
    if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.toString("ascii", 12, 16) === "IHDR") {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    // GIF
    if (buf.length >= 10 && buf.toString("ascii", 0, 3) === "GIF") {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    // JPEG
    if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let o = 2;
      while (o + 9 < buf.length) {
        if (buf[o] !== 0xff) {
          o++;
          continue;
        }
        const marker = buf[o + 1]!;
        if (marker === 0xff) {
          o++;
          continue;
        }
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          o += 2;
          continue;
        }
        const len = buf.readUInt16BE(o + 2);
        const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isSof) return { height: buf.readUInt16BE(o + 5), width: buf.readUInt16BE(o + 7) };
        o += 2 + len;
      }
      return undefined;
    }
    // WebP
    if (buf.length >= 30 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
      const kind = buf.toString("ascii", 12, 16);
      if (kind === "VP8 ") return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      if (kind === "VP8L") {
        const b = buf.readUInt32LE(21);
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
      }
      if (kind === "VP8X") {
        return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** 티스토리 에디터 이미지 치환자 (ENDPOINTS.md 형식) */
export function buildPlaceholder(url: string, filename: string, size?: ImageSize): string {
  const key = url.replace(/^https?:\/\/[^/]+\/dna\//, "").replace(/&/g, "&amp;");
  const meta: Record<string, unknown> = {};
  if (size) {
    meta.originWidth = size.width;
    meta.originHeight = size.height;
  }
  meta.style = "alignCenter";
  meta.filename = filename;
  return `[##_Image|kage@${key}|CDM|1.3|${JSON.stringify(meta)}_##]`;
}

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

function hasHiddenSegment(p: string): boolean {
  return p.split(path.sep).some((seg) => seg.startsWith(".") && seg !== "." && seg !== "..");
}

/**
 * 업로드용 이미지 파일 읽기. 임의 파일 유출을 막기 위해
 * 숨김 경로(.secrets 등 '.' 로 시작하는 경로 구간), 10MB 초과, 이미지가 아닌 파일을 거부한다.
 */
export async function readImageForUpload(file: string): Promise<{ buffer: Buffer; filename: string }> {
  const abs = path.resolve(file);
  let real: string;
  try {
    real = await fs.realpath(abs);
  } catch {
    throw new Error(`이미지 파일을 찾을 수 없습니다: ${file}`);
  }
  for (const p of [abs, real]) {
    if (hasHiddenSegment(p) || p.includes("/.secrets/")) throw new Error(`숨김 경로의 파일은 업로드할 수 없습니다: ${file}`);
  }
  const st = await fs.stat(real);
  if (!st.isFile()) throw new Error(`파일이 아닙니다: ${file}`);
  if (st.size > MAX_UPLOAD_BYTES) throw new Error(`이미지가 너무 큽니다 (최대 10MB): ${file}`);
  const buffer = await fs.readFile(real);
  if (!parseImageSize(buffer)) throw new Error(`이미지(PNG/JPEG/GIF/WebP)로 인식되지 않습니다: ${file}`);
  return { buffer, filename: path.basename(abs) };
}
