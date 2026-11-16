import { describe, expect, it } from "vitest";
import { etimeToSec, isOrphanBrowser, parsePs } from "../batch/cleanup-browsers.js";

const CFT = "/Users/x/.agent-browser/browsers/chrome-157/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing --remote-debugging-port=0 --user-data-dir=/var/folders/T/agent-browser-chrome-abc123";
const NORMAL = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/Users/x/Library/Application Support/Google/Chrome";
const p = (over: Partial<Parameters<typeof isOrphanBrowser>[0]>) => ({ pid: 10, ppid: 1, ageSec: 3600, command: CFT, ...over });

describe("고아 브라우저 판별", () => {
  it("etime 파싱", () => {
    expect(etimeToSec("05:30")).toBe(330);
    expect(etimeToSec("01:02:03")).toBe(3723);
    expect(etimeToSec("2-00:00:10")).toBe(172810);
  });
  it("ppid=1, 30분 이상, agent-browser-chrome- 만 대상", () => {
    expect(isOrphanBrowser(p({}))).toBe(true);
    expect(isOrphanBrowser(p({ ageSec: 60 }))).toBe(false);
    expect(isOrphanBrowser(p({ ppid: 500 }))).toBe(false);
  });
  it("일반 Google Chrome 은 절대 매칭되지 않는다", () => {
    expect(isOrphanBrowser(p({ command: NORMAL }))).toBe(false);
    expect(isOrphanBrowser(p({ command: NORMAL.replace("Chrome --", "Chrome for Testing --") }))).toBe(false);
    expect(isOrphanBrowser(p({ command: CFT.replace("agent-browser-chrome-", "other-") }))).toBe(false);
  });
  it("ps 출력 파싱", () => {
    const r = parsePs(`  12     1 01:00:00 ${CFT}\n  13  12 00:10 helper\n`);
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ pid: 12, ppid: 1, ageSec: 3600 });
  });
});
