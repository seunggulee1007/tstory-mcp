import { PNG } from "pngjs";
import { createRequire } from "node:module";
import QRCode from "qrcode";

// jsqr 은 CJS 이고 타입 선언이 ESM default 형태라 require 로 불러온다
const jsQR = createRequire(import.meta.url)("jsqr") as typeof import("jsqr").default;

/** data:image/png;base64,... → PNG 버퍼 */
export function dataUrlToPng(dataUrl: string): Buffer {
  const m = dataUrl.match(/^data:image\/png;base64,(.+)$/);
  if (!m) throw new Error("PNG data URL 이 아닙니다");
  return Buffer.from(m[1]!, "base64");
}

/** QR 이미지(PNG)에서 텍스트를 읽는다. 못 읽으면 에러. */
export function decodeQrPng(png: Buffer): string {
  const img = PNG.sync.read(png);
  const r = jsQR(new Uint8ClampedArray(img.data), img.width, img.height);
  if (!r) throw new Error("QR 코드를 해독하지 못했습니다");
  return r.data;
}

/** 터미널용 QR 문자열 (작은 블록 문자) */
export function renderQrTerminal(text: string): Promise<string> {
  return QRCode.toString(text, { type: "terminal", small: true });
}

/** 최근접 이웃 확대 (저해상도 캔버스 QR 을 파일로 볼 때 흐려지지 않게) */
export function scalePng(png: Buffer, factor: number): Buffer {
  const src = PNG.sync.read(png);
  const dst = new PNG({ width: src.width * factor, height: src.height * factor });
  for (let y = 0; y < dst.height; y++) {
    for (let x = 0; x < dst.width; x++) {
      const s = ((Math.floor(y / factor) * src.width + Math.floor(x / factor)) << 2) as number;
      const d = (y * dst.width + x) << 2;
      for (let k = 0; k < 4; k++) dst.data[d + k] = src.data[s + k]!;
    }
  }
  return PNG.sync.write(dst);
}
