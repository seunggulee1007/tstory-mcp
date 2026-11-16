import { describe, expect, it } from "vitest";
import { decide, signatureOf } from "../batch/drift-state.js";

const rep = (detail: string) => ({ checks: [{ name: "listPosts", ok: false, errorType: "ContractError", detail }, { name: "myBlogs", ok: true, errorType: null, detail: "" }] });
const H = 3600 * 1000;

describe("drift 중복 방지", () => {
  it("서명은 실패 check 의 이름/유형/detail 에 의존", () => {
    expect(signatureOf(rep("a"))).toBe(signatureOf(rep("a")));
    expect(signatureOf(rep("a"))).not.toBe(signatureOf(rep("b")));
  });
  it("처음이면 new", () => expect(decide(undefined, "s", 0).action).toBe("new"));
  it("같은 서명으로 24시간 내면 skip, 이후 알림 1회", () => {
    const first = decide(undefined, "s", 0).next;
    expect(decide(first, "s", 5 * H).action).toBe("skip");
    expect(decide(first, "s", 25 * H).action).toBe("new"); // 24시간이 지나면 다시 시도
  });
  it("다른 서명이면 new", () => {
    expect(decide({ signature: "s", lastAttemptAt: 0, lastNotifiedAt: 0 }, "t", H).action).toBe("new");
  });
  it("시도 후 24시간 안에서 알림 간격이 지나면 notify (알림 시각 갱신)", () => {
    const st = { signature: "s", lastAttemptAt: 10 * H, lastNotifiedAt: 0 };
    const r = decide(st, "s", 12 * H);
    expect(r.action).toBe("skip"); // 알림은 24시간에 한 번
    const r2 = decide({ ...st, lastNotifiedAt: -20 * H }, "s", 12 * H);
    expect(r2.action).toBe("notify");
    expect(r2.next.lastNotifiedAt).toBe(12 * H);
  });
});
