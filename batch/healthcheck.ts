import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { createClient, type TistoryClient } from "../src/client.js";
import { BlockedError, ContractError, HttpError, SessionExpiredError } from "../src/errors.js";

export interface CheckResult {
  name: string;
  ok: boolean;
  ms: number;
  errorType: string | null;
  detail: string;
}

export interface Report {
  ok: boolean;
  checkedAt: string;
  /** myBlogs 로 슬라이딩 갱신한 뒤의 TSSESSION 만료 시각 (세션 쿠키면 null) */
  sessionExpiresAt: string | null;
  checks: CheckResult[];
}

/** 이 일수보다 적게 남으면 슬라이딩 갱신이 멈춘 것으로 보고 경고한다 */
export const SESSION_WARN_DAYS = 7;

export function sessionDaysLeft(report: Pick<Report, "sessionExpiresAt">, now = Date.now()): number | null {
  return report.sessionExpiresAt ? (Date.parse(report.sessionExpiresAt) - now) / 86_400_000 : null;
}

/** 0 정상, 2 세션 만료, 3 계약/API 변경, 4 세션 만료 임박, 1 기타 */
export function exitCodeFor(report: Pick<Report, "ok" | "checks" | "sessionExpiresAt">, now = Date.now()): number {
  if (report.ok) {
    const left = sessionDaysLeft(report, now);
    return left !== null && left < SESSION_WARN_DAYS ? 4 : 0;
  }
  const failed = report.checks.filter((c) => !c.ok);
  // 세션 만료(2): myBlogs 가 만료로 실패했거나, 어느 check 든 로그인 리다이렉트를 받은 경우. 200 인데 HTML 인 다른 엔드포인트는 API 변경(3).
  if (failed.some((c) => c.name === "myBlogs" && (c.errorType === "SessionExpiredError" || c.errorType === "SessionExpiredHtml"))) return 2;
  // 어느 check 든 로그인으로 리다이렉트되면 세션 만료
  if (failed.some((c) => c.errorType === "SessionExpiredError")) return 2;
  // 403/429 는 차단/요청 제한 가능성이라 복구 대상이 아니다
  if (failed.some((c) => c.errorType === "BlockedError")) return 1;
  if (failed.some((c) => c.errorType === "ContractError" || c.errorType === "ApiDriftError" || c.errorType === "SessionExpiredHtml")) return 3;
  return 1;
}

function classify(e: unknown): string {
  // 로그인으로의 리다이렉트(진짜 만료)와 200 인데 HTML 인 경우(API 변경 가능성)를 구분한다
  if (e instanceof SessionExpiredError) return e.viaRedirect ? "SessionExpiredError" : "SessionExpiredHtml";
  if (e instanceof ContractError || e instanceof BlockedError) return e.name;
  // 4xx 는 엔드포인트 변경(drift)으로, 5xx/네트워크는 일시 장애(기타)로 본다
  if (e instanceof HttpError) return e.status >= 400 && e.status < 500 ? "ApiDriftError" : "HttpError";
  return e instanceof Error ? e.constructor.name : "Error";
}

async function check(name: string, fn: () => Promise<string | void>): Promise<CheckResult> {
  const t0 = Date.now();
  try {
    const detail = (await fn()) ?? "";
    return { name, ok: true, ms: Date.now() - t0, errorType: null, detail };
  } catch (e) {
    return { name, ok: false, ms: Date.now() - t0, errorType: classify(e), detail: e instanceof Error ? e.message : String(e) };
  }
}

/** 16x16 단색 PNG 생성 */
export function makePng(w = 16, h = 16): Buffer {
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const byte of b) {
      c ^= byte;
      for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
    const out = Buffer.alloc(4);
    out.writeUInt32BE((c ^ 0xffffffff) >>> 0);
    return out;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    return Buffer.concat([len, td, crc(td)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0x80)]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export async function runChecks(client: TistoryClient, env: NodeJS.ProcessEnv = process.env): Promise<Report> {
  const checks: CheckResult[] = [];
  let latestId: string | undefined;
  let listOk = false;

  checks.push(await check("myBlogs", async () => `블로그 ${(await client.myBlogs()).length}개`));
  checks.push(
    await check("listPosts", async () => {
      const r = await client.listPosts({ page: 1 });
      listOk = true;
      latestId = r.items[0] ? String(r.items[0].id) : undefined;
      return `총 ${r.totalCount}건`;
    }),
  );
  checks.push(await check("listCategories", async () => `카테고리 ${(await client.listCategories()).length}개`));
  checks.push(await check("listDrafts", async () => `임시저장 ${(await client.listDrafts()).length}건`));
  checks.push(
    await check("getPost", async () => {
      if (!listOk) throw new Error("listPosts 실패로 건너뜀");
      if (!latestId) return "글이 없어 건너뜀";
      const p = await client.getPost(latestId);
      return `id=${p.id}`;
    }).then((r) => (r.detail.includes("건너뜀") && !r.ok ? { ...r, errorType: "Skipped" } : r)),
  );
  checks.push(
    await check("draftCycle", async () => {
      const title = `[tstory-mcp] healthcheck ${new Date().toISOString()}`;
      let seq: number | undefined;
      try {
        seq = (await client.saveDraft({ title, content: "<p>healthcheck</p>" })).sequence;
        const found = (await client.listDrafts()).some((d) => d.sequence === seq);
        if (!found) throw new ContractError("draftCycle", [{ code: "custom", path: ["drafts"], message: "생성한 임시저장이 목록에 없음" }]);
      } finally {
        if (seq !== undefined) {
          await client.deleteDraft(seq);
          if ((await client.listDrafts()).some((d) => d.sequence === seq)) {
            throw new ContractError("draftCycle", [{ code: "custom", path: ["drafts"], message: "삭제한 임시저장이 목록에 남아 있음" }]);
          }
        }
      }
      return `sequence=${seq} 생성/삭제 확인`;
    }),
  );
  // 업로드는 블로그에 파일이 남으므로 기본 꺼짐 (HEALTHCHECK_UPLOAD=1 로 켬, 주 1회 권장)
  if (env.HEALTHCHECK_UPLOAD === "1") {
    checks.push(
      await check("uploadImage", async () => {
        const r = await client.uploadImage(makePng(16, 16), "healthcheck.png");
        if (!r.placeholder.includes('"originWidth":16')) throw new Error("치환자에 이미지 크기가 없음");
        return "16x16 PNG 업로드 확인";
      }),
    );
  }
  const exp = client.sessionExpiresAt();
  return {
    ok: checks.every((c) => c.ok),
    checkedAt: new Date().toISOString(),
    sessionExpiresAt: exp ? new Date(exp * 1000).toISOString() : null,
    checks,
  };
}

export function writeReport(report: Report, dir = "reports"): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `healthcheck-${report.checkedAt.replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  return file;
}

async function main(): Promise<void> {
  let report: Report;
  try {
    report = await runChecks(createClient());
  } catch (e) {
    // state 파일 없음 등 초기화 실패
    report = {
      ok: false,
      checkedAt: new Date().toISOString(),
      sessionExpiresAt: null,
      checks: [{ name: "init", ok: false, ms: 0, errorType: "InitError", detail: e instanceof Error ? e.message : String(e) }],
    };
  }
  const file = writeReport(report);
  for (const c of report.checks) console.log(`${c.ok ? "OK  " : "FAIL"} ${c.name} (${c.ms}ms) ${c.errorType ?? ""} ${c.detail}`);
  const left = sessionDaysLeft(report);
  console.log(
    report.sessionExpiresAt
      ? `sessionExpiresAt: ${report.sessionExpiresAt} (${left!.toFixed(1)}일 남음)`
      : "sessionExpiresAt: 없음 (세션 쿠키)",
  );
  console.log(`리포트: ${file}`);
  process.exit(exitCodeFor(report));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
