#!/usr/bin/env bash
# 수정안 제안 단계 (run.sh 가 호출). 사용법: repair.sh <healthcheck-report.json> <drift-summary.md> <signature7>
#
# 정책: "수정안을 브랜치에 제안만 한다. 사람이 리뷰하고 머지한다."
#  - 모델이 쓴 코드는 자동으로 실행하지 않는다 (typecheck/test/healthcheck 도 돌리지 않음).
#  - 모델은 쿠키가 없는 임시 worktree 에서, Bash 없이, 허용된 파일만 읽고/고친다.
#  - claude 종료 직후, 어떤 node/npx/tsx 도 실행하기 전에 저장소 전체의 변경(탈출)을 검사한다.
#  - 변경 경로 allowlist 와 비밀 스캔은 "메인 체크아웃의 신뢰된 코드"로 검사한다.
#  - 메인 체크아웃의 브랜치는 절대 바꾸지 않는다. worktree 에 대한 git 은 gitfile 을 신뢰하지 않고
#    미리 구한 GITDIR 로만 호출한다 (hooksPath/fsmonitor 비활성).
#  - 알림에는 개수만 담고, 모델이 정한 파일 이름 등 상세는 reports/repair-<브랜치>.log 에만 남긴다.
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
REPORT="$1"; DRIFT_MD="$2"; SIG7="$3"
STATE_FILE="${TISTORY_STATE_FILE:-$ROOT/.secrets/state.json}"
mkdir -p "$ROOT/reports"

notify() { npx --no-install tsx batch/notify.ts "$*" || echo "[tstory-mcp] $*"; }

if ! git rev-parse --verify -q HEAD >/dev/null; then
  notify "API 변경이 감지됐지만 커밋이 없어 수정안 브랜치를 만들 수 없음"
  exit 3
fi
if ! command -v claude >/dev/null 2>&1; then
  notify "API 변경 감지. claude CLI 가 없어 자동 수정안은 건너뜁니다. recordings/ 의 drift 요약을 확인하세요."
  exit 3
fi

BRANCH="fix/api-drift-$(date +%Y%m%d)-${SIG7}"
LOG="$ROOT/reports/repair-${BRANCH//\//-}.log"
if git show-ref --verify -q "refs/heads/$BRANCH"; then
  notify "이미 같은 수정안 브랜치가 있습니다: $BRANCH (리뷰 대기 중)"
  exit 3
fi

TMP_PARENT="$(mktemp -d "${TMPDIR:-/tmp}/tstory-repair.XXXXXX")"
WT="$TMP_PARENT/wt"
WT_ADDED=0
KEEP_BRANCH=0
ALERT=0   # 1 이면 저장소가 변조됐을 수 있으므로 git/node 를 더 실행하지 않는다 (포렌식을 위해 그대로 둠)
cleanup() {
  if [[ "$ALERT" == 1 ]]; then return; fi
  # worktree 는 gitfile 이 변조됐을 수 있으므로 git worktree remove 대신 디렉터리를 지우고 prune 한다
  if [[ "$WT_ADDED" == 1 ]]; then rm -rf "$WT"; fi
  git worktree prune >/dev/null 2>&1 || true
  if [[ "$KEEP_BRANCH" != 1 ]]; then git branch -D "$BRANCH" >/dev/null 2>&1 || true; fi
  rm -rf "$TMP_PARENT"
}
trap cleanup EXIT

: >"$LOG"; chmod 600 "$LOG"
discard() { # $1: 알림에 쓸 사유(개수만, 모델이 정한 이름 금지)
  notify "자동 수정안을 폐기했습니다: $1 (상세: reports/$(basename "$LOG"))"
  exit 3
}

git worktree add -q -b "$BRANCH" "$WT" HEAD
WT_ADDED=1

# worktree 의 gitfile 을 고정한다. 이후 worktree 에 대한 git 은 이 GITDIR 로만 호출한다.
GITFILE="$(cat "$WT/.git")"
GITDIR="$(git -C "$WT" rev-parse --absolute-git-dir)"
wtgit() { git --git-dir="$GITDIR" --work-tree="$WT" -c core.fsmonitor=false -c core.hooksPath=/dev/null "$@"; }

# 입력은 요약 md 와 헬스체크 리포트만 (HAR/.env/.secrets 는 복사하지 않는다)
mkdir -p "$WT/.repair-input"
cp "$DRIFT_MD" "$WT/.repair-input/drift-summary.md"
cp "$REPORT" "$WT/.repair-input/healthcheck-report.json"

# --- 모델 실행 (격리) -------------------------------------------------------------------
# env -i                       : 환경 변수 전부 제거 (HOME, PATH, 선택적으로 ANTHROPIC_API_KEY 만 전달)
# --safe-mode                  : CLAUDE.md/스킬/플러그인/훅/MCP 서버/커스텀 명령 비활성화
# --restricted                 : Bash 등 코드 실행 도구와 WebFetch 제거, 사용자/프로젝트/로컬 settings 무시,
#                                파일 도구를 작업 디렉터리(worktree)로 제한
# --strict-mcp-config          : --mcp-config 에 준 것만 사용 (아무것도 안 줌 = MCP 없음)
# --disable-slash-commands     : 스킬/명령 비활성화
# --tools "Read,Grep,Glob,Edit,Write" : 사용 가능한 내장 도구를 명시 (Bash 없음)
# --settings batch/repair-settings.json : 읽기/수정 경로 allow, 비밀/Bash/Web deny (신뢰된 메인 체크아웃의 파일)
# --permission-mode acceptEdits, --no-session-persistence
# --max-budget-usd             : 비용 상한 (이 CLI 에는 --max-turns 가 없어 예산+타임아웃으로 대신 제한)
# pg-timeout.pl 1800           : 전체 실행 시간 상한 (프로세스 그룹 전체 종료)
CLAUDE_ENV=(HOME="$HOME" PATH="$PATH")
if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then CLAUDE_ENV+=(ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY"); fi

touch "$TMP_PARENT/stamp"
set +e
(
  cd "$WT"
  env -i "${CLAUDE_ENV[@]}" \
    perl "$ROOT/batch/pg-timeout.pl" 1800 \
    claude -p "$(cat "$ROOT/batch/repair-prompt.md")" \
      --safe-mode --restricted --strict-mcp-config --disable-slash-commands \
      --tools "Read,Grep,Glob,Edit,Write" \
      --settings "$ROOT/batch/repair-settings.json" \
      --permission-mode acceptEdits \
      --no-session-persistence \
      --max-budget-usd "${REPAIR_MAX_BUDGET_USD:-3}"
) >"$TMP_PARENT/claude.log" 2>&1
claude_code=$?
set -e

# --- 탈출 검사 (node/npx/tsx 를 실행하기 전에!) ------------------------------------------------
# claude 실행 중에 저장소(ROOT, .git/hooks, node_modules 포함)가 바뀌었으면 경로 제한이 뚫린 것이다.
# 정상적으로 바뀌는 곳만 제외: reports/, .secrets/(MCP 가 쿠키 갱신), git 이 만지는 worktree 관리 정보와 index.
ESCAPED="$(/usr/bin/find "$ROOT" -newer "$TMP_PARENT/stamp" \
  -not -path "$ROOT/reports" -not -path "$ROOT/reports/*" \
  -not -path "$ROOT/.secrets" -not -path "$ROOT/.secrets/*" \
  -not -path "$ROOT/.git/worktrees" -not -path "$ROOT/.git/worktrees/*" \
  -not -path "$ROOT/.git/index" -not -path "$ROOT/.git/index.lock" \
  -print -quit 2>/dev/null || true)"
if [[ -n "$ESCAPED" ]]; then
  ALERT=1
  # 변조됐을 수 있는 notify.ts(tsx) 는 쓰지 않고 printf 로만 알린다
  printf '%s [ALERT] 수정안 생성 중 허용되지 않은 위치가 변경됨: %s (worktree 와 임시 디렉터리 %s 는 포렌식을 위해 남김)\n' \
    "$(date '+%F %T')" "$ESCAPED" "$TMP_PARENT" | tee -a "$ROOT/reports/repair-ALERT.log" >&2
  exit 1
fi

cp "$TMP_PARENT/claude.log" "$LOG"; chmod 600 "$LOG"   # claude 최종 출력 보존 (알림에는 넣지 않음)
if [[ "$claude_code" -ne 0 ]]; then discard "claude 비정상 종료(코드 $claude_code)"; fi

# --- 게이트 (전부 메인 체크아웃의 신뢰된 코드로 실행) ----------------------------------------
# (c) worktree gitfile 이 그대로인지
if [[ ! -f "$WT/.git" || -L "$WT/.git" || "$(cat "$WT/.git")" != "$GITFILE" ]]; then discard "gitfile 변조"; fi

rm -rf "$WT/.repair-input"
# 수정/삭제는 M, HEAD 에 없던 새 파일은 A
CHANGES="$( { wtgit -c core.quotepath=off diff --name-only HEAD | sed 's/^/M\t/'; wtgit -c core.quotepath=off ls-files -o --exclude-standard | sed 's/^/A\t/'; } | sort -u )"
if [[ -z "$CHANGES" ]]; then discard "수정안이 비어 있음"; fi
if [[ "$(wtgit rev-parse --abbrev-ref HEAD)" != "$BRANCH" ]]; then discard "worktree HEAD 가 수정안 브랜치가 아님"; fi

# (a) 변경 경로 allowlist (새 파일은 test/fixtures/** 만, 심볼릭 링크 거부). git add 전에 검사해 .gitattributes 같은 우회를 막는다.
if ! printf '%s\n' "$CHANGES" | npx --no-install tsx batch/repair-gate.ts "$WT" 2>>"$LOG"; then
  discard "허용되지 않은 경로 변경 $(grep -c '^허용되지 않은 변경' "$LOG" || true)건"
fi

wtgit add -A

# (b) 비밀 스캔: 상태 파일의 쿠키 값과 쿠키/서명 패턴 (발견 시 폐기)
if ! wtgit diff --cached | npx --no-install tsx batch/secret-scan.ts "$STATE_FILE" 2>>"$LOG"; then
  discard "diff 에서 비밀 후보 $(grep -c '^비밀 후보 발견' "$LOG" || true)건"
fi

# 위험 패턴(파일/프로세스/네트워크/환경 접근, 낯선 호스트)은 폐기하지 않고 경고만 남긴다
RISKY="$(wtgit diff --cached | npx --no-install tsx batch/secret-scan.ts --risky || echo 0)"
WARN=""
if [[ "$RISKY" =~ ^[0-9]+$ && "$RISKY" -gt 0 ]]; then WARN="⚠ 위험 패턴 ${RISKY}건 — diff 정독 필요"; fi

REVIEW="먼저 git diff main..${BRANCH} 로 리뷰하세요. 그다음 직접 npm run typecheck && npm test && npm run healthcheck 를 실행해 확인한 뒤 머지하세요."
wtgit -c user.name="tstory-mcp batch" -c user.email="tstory-mcp@localhost" -c commit.gpgsign=false \
  commit --no-verify -q -m "fix: 티스토리 API 변경 수정안 제안 (자동 생성, 리뷰 필요)

${WARN:+$WARN

}1) git diff main..${BRANCH} 리뷰
2) npm run typecheck && npm test && npm run healthcheck 직접 실행
실행/검증되지 않은 모델 제안입니다."

KEEP_BRANCH=1
rm -rf "$WT"
git worktree prune >/dev/null 2>&1 || true
WT_ADDED=0

NFILES="$(printf '%s\n' "$CHANGES" | grep -c .)"
MSG="API 변경 수정안 브랜치 생성(${BRANCH}, 변경 파일 ${NFILES}개). ${WARN:+$WARN. }${REVIEW} 상세 로그: reports/$(basename "$LOG")"
if [[ "${REPAIR_PUSH:-0}" == "1" ]]; then
  if ! GIT_TERMINAL_PROMPT=0 git push -u origin "$BRANCH" >>"$LOG" 2>&1; then
    MSG="$MSG (push 실패: 로컬 브랜치만 남아 있음)"
  fi
fi
notify "$MSG"
exit 3
