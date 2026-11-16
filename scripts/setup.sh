#!/usr/bin/env bash
# tstory-mcp 한 번에 설치
#
#   npm run setup                            # 의존성 + 브라우저 + 빌드 + 기본 파일
#   npm run setup -- --login                 # + 카카오 QR 로그인
#   npm run setup -- --mcp=~/work/my-blog    # + 그 프로젝트에서만 쓰도록 MCP 등록 (local 범위)
#   npm run setup -- --mcp-global            # + 모든 프로젝트에서 쓰도록 MCP 등록 (user 범위)
#   npm run setup -- --cron                  # + 6시간마다 배치 실행 크론 등록 (서버용)
#
# 여러 번 실행해도 안전합니다(이미 된 단계는 건너뜀).
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DO_LOGIN=0; DO_CRON=0; MCP_SCOPE=""; MCP_DIR=""
for a in "$@"; do
  case "$a" in
    --login) DO_LOGIN=1 ;;
    --mcp=*) MCP_SCOPE=local; MCP_DIR="${a#--mcp=}"; MCP_DIR="${MCP_DIR/#\~/$HOME}" ;;
    --mcp) echo "--mcp 에는 쓸 프로젝트 경로를 붙이세요: --mcp=<경로>  (모든 프로젝트에 등록하려면 --mcp-global)" >&2; exit 2 ;;
    --mcp-global) MCP_SCOPE=user ;;
    --cron) DO_CRON=1 ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "알 수 없는 옵션: $a (--help 참고)" >&2; exit 2 ;;
  esac
done
if [[ "$MCP_SCOPE" == local ]]; then
  [[ -d "$MCP_DIR" ]] || { echo "프로젝트 경로가 없습니다: $MCP_DIR" >&2; exit 2; }
  MCP_DIR="$(cd "$MCP_DIR" && pwd)"
fi

if [[ -t 1 ]]; then B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; D=$'\033[2m'; N=$'\033[0m'; else B=; G=; Y=; R=; D=; N=; fi
step() { printf '\n%s▸ %s%s\n' "$B" "$1" "$N"; }
ok()   { printf '  %s✔%s %s\n' "$G" "$N" "$1"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$1"; }
die()  { printf '  %s✘ %s%s\n' "$R" "$1" "$N" >&2; exit 1; }

OS="$(uname -s)"

# ── 1. 사전 요구사항 ────────────────────────────────────────────────
step "사전 요구사항 확인"
case "$OS" in
  Darwin|Linux) ok "운영체제: $OS $(uname -m)" ;;
  *) die "macOS 또는 Linux 에서만 지원합니다 (Windows 는 WSL 사용)" ;;
esac

if ! command -v node >/dev/null 2>&1; then
  warn "Node.js 가 없습니다. 아래 중 하나로 설치한 뒤 다시 실행하세요."
  if [[ "$OS" == Darwin ]]; then echo "      brew bundle            # 이 저장소의 Brewfile: node + git + claude-code"; fi
  echo "      curl https://mise.run | sh && mise use -g node@24"
  die "Node.js 22.12 이상 필요"
fi
NODE_V="$(node -p 'process.versions.node')"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=12)?0:1)' \
  || die "Node.js $NODE_V 는 너무 오래됐습니다. 22.12 이상이 필요합니다 (권장: 24)."
ok "Node.js $NODE_V"
command -v npm >/dev/null 2>&1 || die "npm 이 없습니다"
ok "npm $(npm -v)"
command -v git >/dev/null 2>&1 && ok "git $(git --version | awk '{print $3}')" || warn "git 이 없습니다. 자가복구 배치(수정안 브랜치)에 필요합니다."

if command -v claude >/dev/null 2>&1; then
  ok "Claude Code $(claude --version 2>/dev/null | awk '{print $1}')"
else
  warn "Claude Code 가 없습니다. MCP 로 쓰려면 설치하세요:  curl -fsSL https://claude.ai/install.sh | bash"
fi

# ── 2. 의존성 ───────────────────────────────────────────────────────
step "npm 의존성 설치"
if [[ -f package-lock.json ]]; then npm ci --no-audit --no-fund --loglevel=error; else npm install --no-audit --no-fund --loglevel=error; fi
ok "node_modules 준비 완료"

# ── 3. 브라우저 (QR 로그인·API 변경 재녹화용) ───────────────────────
step "헤드리스 브라우저(Chrome for Testing) 설치"
if [[ "$OS" == Linux ]]; then
  warn "Linux: 브라우저 실행에 필요한 시스템 라이브러리도 설치합니다 (sudo 암호를 물을 수 있음)"
  npx --no-install agent-browser install --with-deps
else
  npx --no-install agent-browser install
fi
ok "브라우저 준비 완료"

# ── 4. 빌드 ─────────────────────────────────────────────────────────
step "빌드"
npm run --silent build
ok "dist/src/server.js 생성"

# ── 5. 기본 파일 ────────────────────────────────────────────────────
step "기본 파일 준비"
mkdir -p .secrets reports && chmod 700 .secrets reports
ok ".secrets/ (권한 700)"
if [[ ! -f .env ]]; then cp .env.example .env && chmod 600 .env && ok ".env 생성 (.env.example 복사)"; else ok ".env 이미 있음"; fi

STATE="$ROOT/.secrets/state.json"

# ── 6. 로그인 (선택) ────────────────────────────────────────────────
if [[ "$DO_LOGIN" == 1 ]]; then
  step "카카오 QR 로그인"
  echo "  카카오톡 앱 > 더보기 > 우측 상단 스캔 버튼으로 아래 QR 을 찍으세요."
  npm run --silent login
fi

# ── 7. Claude Code 에 MCP 등록 (선택) ───────────────────────────────
if [[ -n "$MCP_SCOPE" ]]; then
  step "Claude Code 에 MCP 서버 등록 ($MCP_SCOPE 범위)"
  command -v claude >/dev/null 2>&1 || die "claude 가 없어 등록할 수 없습니다 (위 설치 안내 참고)"
  # local 범위는 그 프로젝트 디렉터리에서 실행해야 그 프로젝트에만 등록된다 (~/.claude.json 에 저장, 저장소엔 안 남음)
  TARGET_DIR="${MCP_DIR:-$HOME}"
  if (cd "$TARGET_DIR" && claude mcp get tistory >/dev/null 2>&1); then
    ok "이미 등록돼 있음 (다시 등록하려면: cd $TARGET_DIR && claude mcp remove tistory -s $MCP_SCOPE)"
  else
    (cd "$TARGET_DIR" && claude mcp add tistory -s "$MCP_SCOPE" -e TISTORY_STATE_FILE="$STATE" -- node "$ROOT/dist/src/server.js" >/dev/null)
    if [[ "$MCP_SCOPE" == local ]]; then ok "등록 완료: $MCP_DIR 에서만 사용 (새 Claude Code 세션부터 보임)"
    else ok "등록 완료: 모든 프로젝트에서 사용 (새 Claude Code 세션부터 보임)"; fi
  fi
fi

# ── 8. 크론 (선택, 서버용) ──────────────────────────────────────────
CRON_LINE="0 */6 * * * $ROOT/batch/run.sh >> $ROOT/reports/cron.log 2>&1"
if [[ "$DO_CRON" == 1 ]]; then
  step "크론 등록 (6시간마다 헬스체크·세션 연장)"
  ( crontab -l 2>/dev/null | grep -vF "$ROOT/batch/run.sh" || true; echo "$CRON_LINE" ) | crontab -
  ok "등록 완료:  $CRON_LINE"
fi

# ── 마무리 ──────────────────────────────────────────────────────────
step "완료"
if [[ -f "$STATE" ]]; then
  ok "로그인 세션 있음"
else
  warn "아직 로그인하지 않았습니다 →  npm run login"
fi
[[ -n "$MCP_SCOPE" ]] || echo "  ${D}Claude Code 에 등록 →  npm run setup -- --mcp=<쓸 프로젝트 경로>${N}"
[[ "$DO_CRON" == 1 ]] || echo "  ${D}서버에서 주기 실행 →  npm run setup -- --cron${N}"
echo "  ${D}동작 확인 →  npm run healthcheck${N}"
