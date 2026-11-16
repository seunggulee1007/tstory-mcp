// 빌드된 MCP 서버를 stdio 로 띄워 tools/list 와 읽기 도구를 호출하는 스모크 테스트
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({ command: "node", args: ["dist/src/server.js"], env: { ...process.env } as Record<string, string> });
const client = new Client({ name: "smoke", version: "1.0.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log("tools:", tools.tools.map((t) => t.name).join(", "));

for (const [name, args] of [
  ["tistory_list_posts", { page: 1 }],
  ["tistory_list_categories", {}],
] as const) {
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content as { text: string }[])[0]!.text;
  console.log(`\n== ${name} (isError=${r.isError ?? false}) ==\n${text.slice(0, 400)}${text.length > 400 ? "\n..." : ""}`);
}
const d = await client.callTool({ name: "tistory_delete_post", arguments: { id: 1, confirm: false } });
console.log("\n== tistory_delete_post confirm=false ==", (d.content as { text: string }[])[0]!.text, "isError=", d.isError);
await client.close();
