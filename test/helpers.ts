import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Session } from "../src/session.js";
import { TistoryClient } from "../src/client.js";

export function tmpState(cookies: Record<string, unknown>[] = [{ name: "TSSESSION", value: "FAKE-SESSION", domain: ".tistory.com", path: "/", expires: -1 }]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tstory-test-"));
  const file = path.join(dir, "state.json");
  fs.writeFileSync(file, JSON.stringify({ cookies, origins: [] }), { mode: 0o600 });
  return file;
}

export type Route = (url: string, init: RequestInit) => Response | Promise<Response>;

export function mockClient(route: Route, blog: string | null = "testblog") {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return route(String(url), init);
  }) as typeof fetch;
  const stateFile = tmpState();
  const session = new Session(stateFile);
  return { client: new TistoryClient(session, { blog: blog ?? undefined }, fetchFn), calls, stateFile, session };
}

export const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
