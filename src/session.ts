import fs from "node:fs";
import path from "node:path";

export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  [key: string]: unknown;
}

interface StateFile {
  cookies: StoredCookie[];
  origins?: unknown[];
  [key: string]: unknown;
}

const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 3_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readState(file: string): StateFile {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    throw new Error(`state 파일을 읽을 수 없습니다: ${file} (npm run login 으로 생성하세요)`);
  }
  const st = JSON.parse(raw) as StateFile;
  if (!Array.isArray(st.cookies)) st.cookies = [];
  return st;
}

/** 임시 파일 + fsync + rename 으로 원자적으로 쓴다 (0600). */
function writeStateAtomic(file: string, state: StateFile): StateFile {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(state, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  return state;
}

/** state 파일 쓰기용 락 (npm run login 과 MCP/배치가 같은 락을 쓴다). 오래된 락은 회수한다. */
export function withStateLock<T>(stateFile: string, fn: () => T): T {
  const lock = `${stateFile}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lock, "wx", 0o600));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lock, { force: true }); // 죽은 프로세스가 남긴 락
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > deadline) throw new Error(`state 파일 락을 얻지 못했습니다: ${lock}`);
      sleepSync(25);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

/** Playwright storageState 파일에서 쿠키를 읽고, 응답의 Set-Cookie 를 다시 파일에 병합한다. */
export class Session {
  private state: StateFile;
  private mtimeMs: number;

  constructor(public readonly stateFile: string) {
    this.state = readState(stateFile);
    this.mtimeMs = fs.statSync(stateFile).mtimeMs;
  }

  /** 다른 프로세스(예: npm run login)가 파일을 바꿨으면 다시 읽는다 */
  private reloadIfChanged(): void {
    try {
      const m = fs.statSync(this.stateFile).mtimeMs;
      if (m !== this.mtimeMs) {
        this.state = readState(this.stateFile);
        this.mtimeMs = m;
      }
    } catch {
      /* 일시적으로 없으면 메모리 상태 유지 */
    }
  }

  private tistoryCookies(): StoredCookie[] {
    const now = Date.now() / 1000;
    return this.state.cookies.filter(
      (c) => c.domain.includes("tistory") && (c.expires === -1 || c.expires === undefined || c.expires > now),
    );
  }

  /** 쿠키 만료 시각(epoch 초). 세션 쿠키이거나 없으면 undefined */
  expiryOf(name: string): number | undefined {
    this.reloadIfChanged();
    const c = this.tistoryCookies().find((x) => x.name === name);
    return c && c.expires > 0 ? c.expires : undefined;
  }

  cookieHeader(): string {
    this.reloadIfChanged();
    return this.tistoryCookies()
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
  }

  /**
   * Set-Cookie 헤더들을 병합한다. 락을 잡고 디스크의 최신 상태를 다시 읽어 병합한 뒤
   * 원자적으로(임시 파일 + fsync + rename, 0600) 저장한다. 변경이 있었는지 반환.
   */
  mergeSetCookie(setCookies: string[], requestHost: string): boolean {
    if (!setCookies.length) return false;
    return withStateLock(this.stateFile, () => {
      const latest = readState(this.stateFile);
      const changed = applySetCookies(latest, setCookies, requestHost);
      if (changed) this.write(latest);
      else {
        this.state = latest;
        this.mtimeMs = fs.statSync(this.stateFile).mtimeMs;
      }
      return changed;
    });
  }

  private write(state: StateFile): void {
    this.state = writeStateAtomic(this.stateFile, state);
    this.mtimeMs = fs.statSync(this.stateFile).mtimeMs;
  }
}

/** state 객체에 Set-Cookie 들을 적용한다 (Max-Age 가 Expires 보다 우선). */
export function applySetCookies(state: StateFile, setCookies: string[], requestHost: string): boolean {
  let changed = false;
  for (const line of setCookies) {
    const parts = line.split(";").map((s) => s.trim());
    const first = parts.shift() ?? "";
    const eq = first.indexOf("=");
    if (eq <= 0) continue;
    const name = first.slice(0, eq);
    const value = first.slice(eq + 1);
    let domain = requestHost;
    let cpath = "/";
    let maxAge: number | undefined;
    let expiresAttr: number | undefined;
    for (const attr of parts) {
      const i = attr.indexOf("=");
      const k = (i < 0 ? attr : attr.slice(0, i)).toLowerCase();
      const v = i < 0 ? "" : attr.slice(i + 1);
      if (k === "domain") domain = v.startsWith(".") ? v : `.${v}`;
      else if (k === "path") cpath = v || "/";
      else if (k === "max-age" && Number.isFinite(Number(v))) maxAge = Number(v);
      else if (k === "expires" && !Number.isNaN(Date.parse(v))) expiresAttr = Date.parse(v) / 1000;
    }
    let expires = -1;
    let remove = false;
    if (maxAge !== undefined) {
      if (maxAge <= 0) remove = true;
      else expires = Date.now() / 1000 + maxAge;
    } else if (expiresAttr !== undefined) {
      if (expiresAttr <= Date.now() / 1000) remove = true;
      else expires = expiresAttr;
    }
    if (!domain.includes("tistory")) continue;
    const idx = state.cookies.findIndex((c) => c.name === name && c.domain === domain && c.path === cpath);
    if (remove) {
      if (idx >= 0) {
        state.cookies.splice(idx, 1);
        changed = true;
      }
      continue;
    }
    const existing = idx >= 0 ? state.cookies[idx] : undefined;
    if (existing) {
      if (existing.value !== value || Math.abs(existing.expires - expires) > 1) {
        existing.value = value;
        existing.expires = expires;
        changed = true;
      }
    } else {
      state.cookies.push({ name, value, domain, path: cpath, expires, httpOnly: false, secure: true, sameSite: "Lax" });
      changed = true;
    }
  }
  return changed;
}
