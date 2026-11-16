import type { ZodIssue } from "zod";

/** 세션 만료: 302 리다이렉트 또는 JSON 자리에 HTML이 온 경우 */
export class SessionExpiredError extends Error {
  readonly name = "SessionExpiredError";
  /** 로그인으로의 리다이렉트로 확인된 경우 true (200 인데 HTML 이 온 경우는 false) */
  constructor(public readonly endpoint: string, detail = "", public readonly viaRedirect = false) {
    super(`세션이 만료되었습니다 (${endpoint})${detail ? ` - ${detail}` : ""}`);
  }
}

/** 응답이 zod 스키마와 맞지 않음 = API 계약 변경(drift). body/쿠키는 포함하지 않는다. */
export class ContractError extends Error {
  readonly name = "ContractError";
  constructor(public readonly endpoint: string, public readonly issues: ZodIssue[]) {
    super(
      `API 계약 불일치 (${endpoint}): ` +
        issues
          .slice(0, 10)
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; "),
    );
  }
}

/** 발행/수정이 캡차 등으로 막힌 것으로 추정되는 경우 */
export class CaptchaRequiredError extends Error {
  readonly name = "CaptchaRequiredError";
  constructor(public readonly endpoint: string, public readonly status: number) {
    super(`캡차 인증이 필요한 것으로 보입니다 (${endpoint}, HTTP ${status})`);
  }
}

export class HttpError extends Error {
  name = "HttpError";
  constructor(public readonly endpoint: string, public readonly status: number) {
    super(`HTTP ${status} (${endpoint})${status === 403 || status === 429 ? " - 차단/요청 제한 가능성" : ""}`);
  }
}

/** 403/429: 계약 변경이 아니라 차단 또는 요청 제한일 가능성이 높다 (복구 대상 아님) */
export class BlockedError extends HttpError {
  name = "BlockedError";
}
