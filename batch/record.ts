import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { createClient, type TistoryClient } from "../src/client.js";
import { abExec, closeBrowser, uniqueSession } from "../src/browser.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// run.sh 가 EXIT trap 에서 같은 세션을 정리할 수 있도록 이름을 외부에서 받을 수 있다
const SESSION = process.env.RECORD_SESSION || uniqueSession("tstory-record");
export const RECORD_TITLE = "[tstory-mcp] 헬스체크 녹화";

function ab(args: string[], opts: { state?: string } = {}): string {
  return abExec(SESSION, args, opts);
}

let closed = false;
function closeOnce(): void {
  if (closed) return;
  closed = true;
  closeBrowser(SESSION);
}
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => {
    closeOnce();
    process.exit(130);
  });
}

async function step(name: string, fn: () => unknown): Promise<void> {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message.split("\n")[0] : String(e);
    console.warn(`  실패 ${name}: ${msg} (계속 진행)`);
  }
}

function refOf(pattern: RegExp): string {
  const snap = ab(["snapshot", "-i"]);
  const line = snap.split("\n").find((l) => pattern.test(l));
  const m = line?.match(/ref=(e\d+)/);
  if (!m) throw new Error(`요소를 찾지 못함: ${pattern}`);
  return `@${m[1]}`;
}

/** 녹화 중 만든 임시저장이 남아 있으면 API 로 지운다. 지운 개수 반환 */
export async function cleanupDrafts(client: TistoryClient, title = RECORD_TITLE): Promise<number> {
  let n = 0;
  for (const d of await client.listDrafts()) {
    if (d.title.startsWith(title)) {
      await client.deleteDraft(d.sequence);
      n++;
    }
  }
  return n;
}

async function main(): Promise<void> {
  const { stateFile } = loadConfig();
  const client = createClient();
  const B = `https://${await client.blog()}.tistory.com/manage`;
  const iso = new Date().toISOString().replace(/[:.]/g, "-");
  const harFile = path.join(root, "recordings", `drift-${iso}.har`);
  fs.mkdirSync(path.dirname(harFile), { recursive: true });

  console.log("녹화 시작");
  let started = false;
  await step("HAR 시작", () => {
    ab(["--init-script", path.join(root, "batch", "record-init.js"), "network", "har", "start"], { state: stateFile });
    started = true;
  });
  if (!started) {
    closeOnce();
    throw new Error("HAR 를 시작하지 못했습니다");
  }

  try {
    await step("글 목록 열기", () => {
      ab(["open", `${B}/posts`]);
      ab(["wait", "--load", "load"]);
    });
    await step("카테고리 페이지 열기", () => {
      ab(["open", `${B}/category`]);
      ab(["wait", "--load", "load"]);
    });
    await step("글쓰기 열기", () => {
      ab(["open", `${B}/newpost`]);
      ab(["wait", "--load", "load"]);
    });
    await step("제목 입력", () => ab(["find", "placeholder", "제목을 입력하세요", "fill", RECORD_TITLE]));
    await step("본문 입력(iframe)", () => ab(["fill", refOf(/textbox "글 내용 입력"/), "tstory-mcp 헬스체크 본문"]));
    await step("임시저장 클릭", () => {
      ab(["find", "role", "button", "click", "--name", "임시저장"]);
      ab(["wait", "1500"]);
    });
    await step("임시저장 목록 열기", () => {
      ab(["click", refOf(/button "임시저장 개수/)]);
      ab(["wait", "1000"]);
    });
    await step("임시저장 글 hover", () => ab(["hover", "a.link_info"]));
    await step("임시저장 글 삭제 클릭", () => ab(["click", "button.ico_trash"]));
    await step("삭제 확인창 수락", () => {
      ab(["dialog", "accept"]);
      ab(["wait", "1000"]);
    });
  } finally {
    await step("HAR 저장", () => ab(["network", "har", "stop", harFile]));
    await step("브라우저 종료", closeOnce);
    if (fs.existsSync(harFile)) {
      fs.chmodSync(harFile, 0o600);
      console.log(`HAR: ${harFile}`);
    } else {
      console.warn("HAR 파일이 만들어지지 않았습니다");
    }
  }

  const left = await cleanupDrafts(client);
  console.log(left ? `남은 임시저장 ${left}건을 API 로 삭제했습니다` : "남은 임시저장 없음");
  const remain = (await client.listDrafts()).filter((d) => d.title.startsWith(RECORD_TITLE));
  if (remain.length) throw new Error("녹화용 임시저장이 남아 있습니다");
  if (!fs.existsSync(harFile)) process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
    .catch((e) => {
      console.error("녹화 실패:", e instanceof Error ? e.message : e);
      process.exitCode = 1;
    })
    .finally(closeOnce);
}
