import QRCode from "qrcode";
import { describe, expect, it } from "vitest";
import { dataUrlToPng, decodeQrPng, renderQrTerminal, scalePng } from "../src/qr.js";

const URL_TEXT = "https://auth.kakao.com/qr_login/FAKE-TOKEN-0123456789";

describe("QR 해독 → 터미널 렌더", () => {
  it("생성한 QR PNG(data URL)를 해독하고 터미널 문자열로 다시 그린다", async () => {
    const dataUrl = await QRCode.toDataURL(URL_TEXT, { width: 150, margin: 2 });
    const png = dataUrlToPng(dataUrl);
    expect(decodeQrPng(png)).toBe(URL_TEXT);

    const term = await renderQrTerminal(decodeQrPng(png));
    expect(term.split("\n").length).toBeGreaterThan(10);
    expect(term).not.toMatch(/[▀▄]/);
    expect(term).toMatch(/\x1b\[4[07]m/);
  });

  it("4배 확대한 이미지도 해독된다", async () => {
    const png = dataUrlToPng(await QRCode.toDataURL(URL_TEXT, { width: 120, margin: 2 }));
    expect(decodeQrPng(scalePng(png, 4))).toBe(URL_TEXT);
  });

  it("QR 이 없는 이미지는 에러", () => {
    const blank = dataUrlToPng(
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    );
    expect(() => decodeQrPng(blank)).toThrow();
  });
});
