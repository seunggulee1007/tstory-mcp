import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";

interface HarEntry {
  request: { method: string; url: string; postData?: { mimeType?: string; text?: string } };
  response: { status: number; content?: { mimeType?: string; text?: string; encoding?: string } };
}

const SENSITIVE_KEY = /pass(word)?|cookie|token|credential|signature|secret|session|mail|phone|tel$|mobile/i;
const MAX_SAMPLE = 600;

/** 출력 전체에 마지막으로 적용하는 방어적 마스킹 (secrets: 상태 파일의 쿠키 값들) */
export function scrub(text: string, secrets: string[] = []): string {
  let out = text;
  for (const v of secrets) if (v.length >= 8) out = out.split(v).join("<redacted>");
  return out
    .replace(/(credential|signature)=[^&\s"'|)\]]*/gi, "$1=<redacted>")
    .replace(/\b(TSSESSION(?:_KEEP)?|_T_ANO|TSID|PD)=[^;\s"']+/g, "$1=<redacted>")
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "<email>")
    .replace(/\b0\d{1,2}-?\d{3,4}-?\d{4}\b/g, "<phone>");
}

/**
 * 값이 아니라 "모양"만 남긴다. 문자열은 <string N>(길이), 단 enum 같은 대문자 식별자는 유지.
 * 제3자가 쓴 글 제목/본문 등이 요약(=LLM 입력)에 섞여 들어가는 것을 막기 위함.
 */
const SAFE_KEY = /^[A-Za-z0-9_$-]{1,40}$/;
/** 키도 제3자가 정할 수 있으므로 안전한 식별자 모양이 아니면 길이만 남긴다 */
export function safeKey(k: string): string {
  return SAFE_KEY.test(k) ? k : `<key ${k.length}>`;
}

export function shapeOf(v: unknown, depth = 0): unknown {
  if (Array.isArray(v)) return depth > 3 ? `[배열 ${v.length}]` : v.slice(0, 2).map((x) => shapeOf(x, depth + 1));
  if (v && typeof v === "object") {
    if (depth > 3) return "{...}";
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [safeKey(k), SENSITIVE_KEY.test(k) ? "<redacted>" : shapeOf(x, depth + 1)]),
    );
  }
  if (typeof v === "string") return /^[A-Z_]{1,20}$/.test(v) ? v : `<string ${v.length}>`;
  return v;
}

function queryValue(v: string): string {
  return /^-?\d+$/.test(v) || /^[A-Za-z_-]{1,20}$/.test(v) ? v : `<string ${v.length}>`;
}

function cleanUrl(raw: string): { host: string; pathname: string; query: string } {
  const u = new URL(raw);
  const q = [...u.searchParams.entries()]
    .map(([k, v]) => `${k}=${SENSITIVE_KEY.test(k) ? "<redacted>" : queryValue(v)}`)
    .join("&");
  return { host: u.hostname, pathname: u.pathname, query: q };
}

/** 대상: {블로그}.tistory.com/manage/** 와 www.tistory.com/legacy/member/blog/api/myBlogs 만 */
export function isTarget(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.hostname === "www.tistory.com") return u.pathname === "/legacy/member/blog/api/myBlogs";
    return u.hostname.endsWith(".tistory.com") && /^\/manage(\/|$)/.test(u.pathname);
  } catch {
    return false;
  }
}

function tryJson(text: string | undefined): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function describeBody(text: string | undefined, mime: string | undefined, encoding?: string): string {
  if (!text) return "(없음)";
  if (encoding === "base64") return "(바이너리)";
  const json = tryJson(text);
  if (json === undefined) return `(JSON 아님${mime ? `: ${mime.split(";")[0]}` : ""})`;
  const red = shapeOf(json);
  const keys = json && typeof json === "object" && !Array.isArray(json) ? `키: ${Object.keys(json).map(safeKey).join(", ")}\n` : "";
  const sample = JSON.stringify(red);
  return `${keys}샘플: \`${sample.length > MAX_SAMPLE ? `${sample.slice(0, MAX_SAMPLE)}…` : sample}\``;
}

export function summarizeHar(har: { log?: { entries?: HarEntry[] } }, title = "API 변경 녹화 요약", secrets: string[] = []): string {
  // 글 관리(/manage) 호출을 먼저 보여준다 (정렬은 안정적)
  const isManage = (e: HarEntry) => /^\/manage(\/|$)/.test(new URL(e.request.url).pathname);
  const entries = (har.log?.entries ?? [])
    .filter((e) => isTarget(e.request.url))
    .sort((a, b) => Number(isManage(b)) - Number(isManage(a)));
  const seen = new Set<string>();
  const out: string[] = [`# ${title}`, "", "값은 제외하고 키와 모양만 정리한 요약입니다 (쿠키/헤더/서명/문자열 값 없음).", ""];
  for (const e of entries) {
    const { pathname, query } = cleanUrl(e.request.url);
    const key = `${e.request.method} ${pathname}?${query} ${e.response.status}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const resMime = e.response.content?.mimeType ?? "";
    const reqIsJson = /json/i.test(e.request.postData?.mimeType ?? "");
    if (!/json/i.test(resMime) && !reqIsJson) continue;
    out.push(`## ${e.request.method} ${pathname}${query ? `?${query}` : ""}`);
    out.push(`- 상태: ${e.response.status}`);
    out.push(`- content-type: ${resMime.split(";")[0] || "(없음)"}`);
    if (e.request.postData) {
      out.push(`- 요청 본문: ${describeBody(e.request.postData.text, e.request.postData.mimeType)}`);
    }
    out.push(`- 응답: ${describeBody(e.response.content?.text, resMime, e.response.content?.encoding)}`);
    out.push("");
  }
  if (out.length === 4) out.push("(대상 호출 없음)");
  return scrub(out.join("\n"), secrets) + "\n";
}

/** 상태 파일의 쿠키 값들 (최종 마스킹용). 읽을 수 없으면 빈 배열 */
export function cookieValues(stateFile: string): string[] {
  try {
    const st = JSON.parse(fs.readFileSync(stateFile, "utf8")) as { cookies?: { value?: string }[] };
    return (st.cookies ?? []).map((c) => c.value ?? "").filter((v) => v.length >= 8);
  } catch {
    return [];
  }
}

function latestHar(dir: string): string | undefined {
  if (!fs.existsSync(dir)) return undefined;
  return fs
    .readdirSync(dir)
    .filter((f) => /^drift-.*\.har$/.test(f))
    .sort()
    .map((f) => path.join(dir, f))
    .at(-1);
}

function main(): void {
  const dir = path.resolve("recordings");
  const input = process.argv[2] ?? latestHar(dir);
  if (!input) {
    console.error("요약할 drift-*.har 가 없습니다. 먼저 npm run record 를 실행하세요.");
    process.exit(1);
  }
  const har = JSON.parse(fs.readFileSync(input, "utf8"));
  const secrets = cookieValues(loadConfig().stateFile);
  const outFile = input.replace(/\.har$/, ".md");
  fs.writeFileSync(outFile, summarizeHar(har, `API 변경 녹화 요약 (${path.basename(input)})`, secrets));
  console.log(`요약: ${outFile}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
