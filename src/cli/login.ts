import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadConfig } from "../config.js";
import { createClient } from "../client.js";
import { Session, withStateLock } from "../session.js";
import { abExec, closeBrowser, uniqueSession } from "../browser.js";
import { dataUrlToPng, decodeQrPng, renderQrTerminal, scalePng } from "../qr.js";

const LOGIN_URL = "https://www.tistory.com/auth/login";
const QR_LIFETIME_MS = 290_000; // 화면 카운트다운 약 5분
const MAX_REFRESH = 3;

process.umask(0o077);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const headed = process.argv.includes("--headed");
const openImage = process.argv.includes("--open");
const session = uniqueSession("tistory-login");
const ab = (args: string[]) => abExec(session, args);

let cleaned = false;
function cleanup(): void {
  if (cleaned) return;
  cleaned = true;
  closeBrowser(session);
}
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => {
    cleanup();
    process.exit(130);
  });
}

function currentUrl(): string {
  return ab(["get", "url"]).trim();
}

function isLoggedInUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname.endsWith("tistory.com") && !u.pathname.startsWith("/auth");
  } catch {
    return false;
  }
}

/** "로그인 상태 유지" 가 체크되어 있어야 30일 세션이 된다 */
function ensureStaySignedIn(): void {
  const checked = () => ab(["eval", "document.querySelector('input[type=checkbox]')?.checked === true"]).trim() === "true";
  if (checked()) return;
  ab([
    "eval",
    "(() => { const l = [...document.querySelectorAll('label')].find((x) => x.innerText.includes('로그인 상태 유지')); (l ?? document.querySelector('input[type=checkbox]')).click(); })()",
  ]);
  if (!checked()) throw new Error('"로그인 상태 유지" 체크에 실패했습니다');
}

async function showQr(stateDir: string): Promise<void> {
  ensureStaySignedIn();
  const raw = ab(["eval", "document.querySelector('canvas').toDataURL('image/png')"]).trim();
  const png = dataUrlToPng(JSON.parse(raw) as string);
  const text = decodeQrPng(png);
  const file = path.join(stateDir, "login-qr.png");
  fs.writeFileSync(file, scalePng(png, 4), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  console.log("\n카카오톡 앱으로 아래 QR 코드를 스캔하세요 (약 5분간 유효).\n");
  console.log(await renderQrTerminal(text));
  console.log(`QR 이미지: ${file}`);
  if (openImage && process.platform === "darwin") execFileSync("open", [file]);
}

async function main(): Promise<void> {
  const { stateFile } = loadConfig();
  const stateDir = path.dirname(stateFile);
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });

  console.log("카카오 QR 로그인을 시작합니다. (아이디/비밀번호는 입력하지 않습니다)");
  ab([...(headed ? ["--headed"] : []), "open", LOGIN_URL]);
  ab(["find", "role", "link", "click", "--name", "카카오계정으로 로그인"]);
  ab(["wait", "--load", "load"]);
  ab(["find", "role", "button", "click", "--name", "QR코드 로그인"]);
  ab(["wait", "--load", "load"]);
  ab(["wait", "canvas"]);

  await showQr(stateDir);
  let issuedAt = Date.now();
  let refreshes = 0;

  for (;;) {
    await sleep(2000);
    if (isLoggedInUrl(currentUrl())) break;
    if (Date.now() - issuedAt > QR_LIFETIME_MS) {
      if (++refreshes > MAX_REFRESH) throw new Error("QR 코드가 만료되어 로그인하지 못했습니다 (새로고침 3회 초과)");
      console.log(`\nQR 코드가 만료되어 새로 고칩니다 (${refreshes}/${MAX_REFRESH}).`);
      ab(["click", "button.btn_reset"]);
      await sleep(1500);
      await showQr(stateDir);
      issuedAt = Date.now();
    }
  }

  // 같은 디렉터리의 임시 파일로 저장한 뒤, session.ts 와 같은 락을 잡고 교체한다
  const tmp = `${stateFile}.login-${process.pid}.tmp`;
  try {
    ab(["state", "save", tmp]);
    fs.chmodSync(tmp, 0o600);
    withStateLock(stateFile, () => fs.renameSync(tmp, stateFile));
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  console.log(`\n세션을 저장했습니다: ${stateFile}`);

  const client = createClient();
  const blogs = await client.myBlogs();
  const exp = new Session(stateFile).expiryOf("TSSESSION");
  console.log(`로그인 확인 완료. 블로그: ${blogs.map((b) => b.name).join(", ")}`);
  console.log(exp ? `TSSESSION 만료: ${new Date(exp * 1000).toISOString()}` : "TSSESSION 이 세션 쿠키입니다 (로그인 상태 유지가 적용되지 않았을 수 있음)");
}

main()
  .catch((e) => {
    console.error("로그인 실패:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(cleanup);
