import { fileURLToPath } from "node:url";

/** NOTIFY_WEBHOOK_URL 이 있으면 Dooray 인커밍 웹훅 형식으로 전송, 없으면 stdout 출력 */
export async function notify(text: string, env: NodeJS.ProcessEnv = process.env, fetchFn: typeof fetch = fetch): Promise<void> {
  const url = env.NOTIFY_WEBHOOK_URL;
  if (!url) {
    console.log(`[tstory-mcp] ${text}`);
    return;
  }
  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ botName: "tstory-mcp", text }),
    });
    if (!res.ok) console.error(`알림 전송 실패: HTTP ${res.status}`);
  } catch (e) {
    console.error(`알림 전송 실패: ${e instanceof Error ? e.message : String(e)}`);
    console.log(`[tstory-mcp] ${text}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const text = process.argv.slice(2).join(" ");
  if (!text) {
    console.error("사용법: tsx batch/notify.ts <메시지>");
    process.exit(1);
  }
  await notify(text);
}
