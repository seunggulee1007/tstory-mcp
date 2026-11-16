#!/usr/bin/env bash
# 크론 진입점: 헬스체크 -> (계약 변경 시) 녹화 -> 요약 -> 격리된 worktree 에서 수정안 "제안"
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# 크론은 PATH 가 빈약하므로 뒤에 보강 (앞에 붙이면 다른 node 가 잡힐 수 있음)
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin"

# .env 로드 (있으면)
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

mkdir -p reports
notify() { npx --no-install tsx batch/notify.ts "$*" || echo "[tstory-mcp] $*"; }

# 프로세스 그룹 전체에 타임아웃 적용 (npm 뿐 아니라 tsx/agent-browser 자손까지 정리)
run_timeout() { perl "$ROOT/batch/pg-timeout.pl" "$@"; }

file_mtime() { stat -f %m "$1" 2>/dev/null || stat -c %Y "$1"; }

# --- 중복 실행 방지: pid 파일 락 (죽은 pid 면 회수, 2시간 넘게 살아 있으면 알림) ---
LOCK="$ROOT/reports/.batch.lock"
if [[ -f "$LOCK" ]]; then
  old_pid="$(cat "$LOCK" 2>/dev/null || true)"
  if [[ -n "$old_pid" ]] && kill -0 "$old_pid" 2>/dev/null; then
    age=$(( $(date +%s) - $(file_mtime "$LOCK") ))
    if (( age > 7200 )); then
      notify "이전 배치(pid $old_pid)가 2시간 넘게 실행 중입니다. 확인이 필요합니다."
    fi
    exit 0
  fi
  rm -f "$LOCK"
fi
if ! ( set -o noclobber; echo "$$" >"$LOCK" ) 2>/dev/null; then
  exit 0 # 동시에 다른 실행이 락을 잡음
fi

# record 가 쓰는 브라우저 세션 이름 (EXIT trap 에서 정리하기 위해 고정). record 를 시작한 경우에만 정리한다.
export RECORD_SESSION="tstory-record-cron-$$"
RECORD_STARTED=0
cleanup() {
  if [[ "$RECORD_STARTED" == 1 ]]; then
    npx --no-install tsx batch/cleanup-browsers.ts --session "$RECORD_SESSION" >/dev/null 2>&1 || true
  fi
  rm -f "$LOCK"
}
trap cleanup EXIT

# 이전 실행이 남긴 고아 브라우저(30분 이상, ppid=1) 정리
npx --no-install tsx batch/cleanup-browsers.ts >/dev/null 2>&1 || true

set +e
npm run --silent healthcheck >reports/last-run.log 2>&1
code=$?
set -e
if [[ "$code" -ne 0 ]]; then cat reports/last-run.log >&2; fi
REPORT="$(ls -1 reports/healthcheck-*.json 2>/dev/null | sort | tail -1 || true)"

case "$code" in
  0)
    exit 0
    ;;
  2)
    notify "세션 만료 — 서버에서 \`npm run login\` 실행 후 카카오톡으로 QR 스캔"
    exit 2
    ;;
  4)
    DAYS_LEFT="$(REPORT="$REPORT" node -e '
      const r=JSON.parse(require("fs").readFileSync(process.env.REPORT,"utf8"));
      console.log(Math.max(0,Math.ceil((Date.parse(r.sessionExpiresAt)-Date.now())/86400000)));
    ' 2>/dev/null || echo "?")"
    notify "세션 만료 임박(${DAYS_LEFT}일 남음) — 서버에서 \`npm run login\` 후 QR 스캔"
    exit 4
    ;;
  3)
    ;;
  *)
    notify "헬스체크 실패 (종료 코드 $code, 차단/요청 제한 또는 일시 장애 가능). reports/ 의 최신 리포트를 확인하세요. 자동 복구는 하지 않습니다."
    exit "$code"
    ;;
esac

# ---- 여기부터 계약/API 변경(3) 처리 ----
# 같은 문제를 24시간 안에 이미 시도했으면 알림만(24시간에 한 번) 하고 건너뛴다
OUT="$(npx --no-install tsx batch/drift-state.ts "$REPORT" reports/drift-state.json)" || { notify "drift 상태 판단 실패"; exit 1; }
read -r DECISION SIG7 <<<"$OUT"
case "$DECISION" in
  skip) exit 3 ;;
  notify)
    notify "동일한 티스토리 API 변경이 계속 감지되고 있습니다 (이미 수정안 시도함, 서명 $SIG7). 수정안 브랜치/리포트를 확인하세요."
    exit 3
    ;;
esac

if ! git rev-parse --verify -q HEAD >/dev/null; then
  notify "API 변경이 감지됐지만 커밋이 없어 수정안 브랜치를 만들 수 없음"
  exit 3
fi

# 녹화: 이번 실행에서 새로 만든 HAR 만 인정한다 (오래된 HAR 로 대체하지 않음)
START_TS="$(date +%s)"
RECORD_STARTED=1
set +e
run_timeout 600 npm run --silent record >reports/last-record.log 2>&1
rec_code=$?
set -e
HAR="$(sed -n 's/^HAR: //p' reports/last-record.log | tail -1)"
if [[ -z "$HAR" || ! -f "$HAR" ]] || (( $(file_mtime "$HAR") < START_TS )); then
  notify "API 변경이 감지됐지만 이번 실행의 녹화 HAR 가 없어 수정안 생성을 중단합니다 (record 종료 코드 $rec_code)."
  exit 3
fi
run_timeout 120 npm run --silent summarize -- "$HAR" >/dev/null
MD="${HAR%.har}.md"
if [[ ! -f "$MD" ]] || (( $(file_mtime "$MD") < START_TS )); then
  notify "녹화 요약 생성에 실패해 수정안 생성을 중단합니다."
  exit 3
fi

exec_code=0
"$ROOT/batch/repair.sh" "$REPORT" "$MD" "$SIG7" || exec_code=$?
exit "$exec_code"
