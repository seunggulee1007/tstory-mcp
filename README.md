# tstory-mcp

티스토리 블로그를 Claude 등 MCP 클라이언트에서 다루기 위한 MCP 서버입니다. 글 조회/발행/수정/삭제, 카테고리, 임시저장, 이미지 업로드를 지원하고, 티스토리 내부 API가 바뀌면 스스로 감지해 수정안을 만드는 자가복구 배치가 함께 들어 있습니다.

## 주의: 비공식 내부 API입니다

- 티스토리는 글쓰기 오픈 API를 종료했습니다. 이 프로젝트는 **관리자 웹 화면이 쓰는 내부 API**(`{블로그}.tistory.com/manage/...`)를 쿠키 인증으로 호출합니다.
- 예고 없이 바뀌거나 막힐 수 있고, 약관상 허용 범위가 불분명합니다. 개인 블로그 용도로, 본인 책임으로 사용하세요.
- 글 번호는 발행할 때마다 영구 소모되며 삭제해도 재사용되지 않습니다. 그래서 헬스체크는 발행 대신 임시저장 생성/삭제로 검증합니다.
- 발행 직전 카카오 캡차가 도입되면 발행이 막힐 수 있습니다. 이때 `tistory_publish_post` 는 임시저장으로 대체하고 알려 줍니다.
- 세션 쿠키(`.secrets/state.json`)는 계정 접근 권한과 같습니다. 절대 커밋/공유하지 마세요 (`.gitignore` 로 제외, 권한 0600).

API 명세는 [`recordings/ENDPOINTS.md`](recordings/ENDPOINTS.md) 에 있습니다.

## 설치

```bash
npm install
npm run build
cp .env.example .env   # 필요하면 수정
```

Node 24 이상, npm 기준입니다.

## 로그인: 카카오 QR (`npm run login`)

이 프로젝트는 **카카오 아이디/비밀번호를 어디에도 입력하지 않습니다.** 인증은 카카오톡 앱으로 QR 코드를 스캔하는 방식만 지원합니다.

```bash
npm run login            # 기본: 헤드리스. QR 코드를 터미널에 그림
npm run login -- --open  # (macOS) QR 이미지를 기본 뷰어로도 열기
npm run login -- --headed  # 눈에 보이는 브라우저 창을 함께 사용
```

1. 헤드리스 브라우저가 티스토리 로그인 화면에서 "카카오계정으로 로그인", "QR코드 로그인"으로 이동하고 **"로그인 상태 유지"를 체크**합니다.
2. QR 코드를 읽어 터미널에 다시 그립니다. SSH 로 접속한 헤드리스 서버에서도 그대로 동작합니다. 이미지는 `.secrets/login-qr.png`(0600)에도 저장됩니다.
3. 카카오톡 앱으로 스캔합니다. QR 은 약 5분간 유효하며, 만료되면 자동으로 새로고침해 다시 그립니다(최대 3회).
4. 스캔이 끝나 `www.tistory.com` 으로 이동하면 세션을 `.secrets/state.json`(0600)에 저장하고, `myBlogs` 로 확인한 뒤 블로그 이름과 `TSSESSION` 만료 시각을 출력합니다. 브라우저는 항상 닫습니다.

### 세션 수명

- "로그인 상태 유지"를 체크하면 `TSSESSION`, `TSSESSION_KEEP` 쿠키가 **30일** 만료가 됩니다 (체크하지 않으면 `TSSESSION` 이 세션 쿠키).
- `myBlogs` API 응답이 `Set-Cookie ... Max-Age=2592000` 으로 만료를 30일 뒤로 다시 밀어줍니다(슬라이딩). MCP 서버는 시작할 때와 6시간마다, 헬스체크는 실행할 때마다 `myBlogs` 를 호출하고 갱신된 쿠키를 `state.json` 에 저장합니다. 즉 배치를 주기적으로 돌리면 세션이 계속 이어집니다.
- 조용한 재로그인은 불가능합니다(`TSSESSION_KEEP` 만으로는 `/manage` 가 로그인으로 리다이렉트되고, 카카오 쿠키가 있어도 티스토리가 계정 선택 화면을 요구함). 그래서 세션이 끊기면 QR 로그인을 다시 해야 합니다.
- 다시 로그인해야 할 때는 알림이 옵니다 (아래 종료 코드 2, 4). 서버에서 `npm run login` 을 실행하고 카카오톡으로 QR 을 스캔하세요.

## Claude Code에 등록

```bash
claude mcp add tistory -- node /절대경로/tstory-mcp/dist/src/server.js
```

환경 변수가 필요하면 `-e TISTORY_STATE_FILE=/절대경로/.secrets/state.json -e TISTORY_BLOG=블로그이름` 을 붙입니다. 기본 state 경로(`.secrets/state.json`)는 **서버 프로세스의 현재 디렉터리 기준**이므로, 다른 곳에서 실행한다면 절대경로를 지정하세요.

### 제공 도구

| 도구 | 설명 |
|---|---|
| `tistory_whoami` | 블로그 목록과 현재 블로그 |
| `tistory_list_posts` | 글 목록 (page, keyword, categoryId, visibility) |
| `tistory_get_post` | 글 한 건 (본문 HTML 포함) |
| `tistory_list_categories` | 카테고리 (경로 포함, 평탄화) |
| `tistory_publish_post` | 발행. 기본 공개범위 **비공개**, 마크다운 기본, 로컬 이미지 자동 업로드, 캡차 시 임시저장 대체 |
| `tistory_update_post` | 수정 (지정한 필드만 변경) |
| `tistory_delete_post` | 삭제 (`confirm: true` 필수) |
| `tistory_list_drafts` / `tistory_save_draft` / `tistory_delete_draft` | 임시저장 |
| `tistory_upload_image` | 로컬 이미지 업로드 후 치환자 반환 |

세션이 만료되면 도구가 `npm run login` 을 안내하는 메시지를 돌려줍니다.

안전장치: 공개 범위를 public/protected 로 바꾸는 `tistory_update_post` 는 `confirm: true` 가 필요하고, 이미지 업로드는 숨김 경로(`.secrets` 등)/10MB 초과/이미지가 아닌 파일을 거부하며, `tistory_get_post` 는 보호글 비밀번호를 돌려주지 않습니다.

## 개발

```bash
npm run typecheck   # 타입 검사
npm test            # vitest (fetch 는 모두 mock)
npm run build       # dist/ 생성
npm start           # stdio MCP 서버 실행
```

## 자가복구 배치 (서버 설치)

티스토리 내부 API가 바뀌면 `healthcheck` 가 감지하고, 브라우저 UI를 다시 녹화해 변경 내용을 요약한 뒤 헤드리스 Claude Code 로 수정안 브랜치를 만듭니다.

### 구성

| 명령 | 역할 |
|---|---|
| `npm run healthcheck` | `myBlogs` 로 세션 갱신 후 `sessionExpiresAt` 을 리포트에 기록하고, 읽기 API, 임시저장 생성/삭제, 이미지 업로드를 독립적으로 검사하고 `reports/healthcheck-<시각>.json` 작성. 글 발행/수정/삭제는 하지 않음. 이미지 업로드 검사는 블로그에 파일이 남아 기본 꺼짐(`HEALTHCHECK_UPLOAD=1` 로 켬, 주 1회 정도 권장) |
| `npm run record` | 헤드리스 브라우저로 목록/카테고리/글쓰기/임시저장/삭제 화면을 HAR 로 녹화(`recordings/drift-<시각>.har`). 만든 임시저장은 API로 확인해 남기지 않음. 실행마다 고유 브라우저 세션을 쓰고 끝나면 반드시 닫음(안 닫히면 프로세스 강제 종료) |
| `npm run cleanup` | 30분 넘게 남아 있는 고아 `Google Chrome for Testing`(ppid=1, `agent-browser-chrome-` 프로필) 정리. 일반 Chrome 은 대상이 아님. `run.sh` 시작 시 자동 실행 |
| `npm run summarize` | 최신 HAR 를 쿠키/서명 제외 마크다운(`recordings/drift-<시각>.md`)으로 요약 |
| `batch/run.sh` | 위 과정을 묶은 크론 진입점 (pid 락, 타임아웃, 중복 알림 방지) |
| `batch/repair.sh` | 격리된 worktree 에서 수정안을 제안하고 게이트 통과 시 브랜치에 커밋 |

### 서버에 설치

1. 저장소를 서버에 받고 `npm install` (브라우저 녹화를 쓰려면 `npx agent-browser install` 로 Chrome 설치).
2. 서버에서 직접 `npm run login` 을 실행해 터미널에 뜬 QR 을 스캔합니다(SSH 가능). 다른 곳에서 로그인했다면 `.secrets/state.json` 을 서버의 같은 경로로 복사하고 `chmod 600` 합니다.
3. `.env.example` 을 `.env` 로 복사해 `NOTIFY_WEBHOOK_URL`(Dooray 웹훅) 등을 채웁니다. `batch/run.sh` 가 `.env` 를 읽습니다.
4. 수정안 제안을 쓰려면 서버에 `claude` CLI 가 설치/로그인되어 있고 저장소에 커밋이 있어야 합니다. 없으면 알림만 보냅니다.
5. 크론 등록 (6시간마다 예시):

```cron
0 */6 * * * /절대경로/tstory-mcp/batch/run.sh >> /절대경로/tstory-mcp/reports/cron.log 2>&1
```

### 종료 코드

`npm run healthcheck` / `batch/run.sh` 공통입니다.

| 코드 | 의미 | run.sh 동작 |
|---|---|---|
| 0 | 모든 검사 통과 | 조용히 종료 |
| 2 | 세션 만료 (302 또는 HTML 응답) | "세션 만료 — 서버에서 `npm run login` 실행 후 카카오톡으로 QR 스캔" 알림 |
| 4 | 모든 검사 통과했지만 `myBlogs` 갱신 후에도 TSSESSION 만료가 7일 미만 (슬라이딩 갱신이 멈춤) | "세션 만료 임박(N일 남음) — 서버에서 `npm run login` 후 QR 스캔" 알림 |
| 3 | 계약/API 변경 (스키마 불일치, 403/429 이외의 4xx) | 녹화, 요약, 수정안 브랜치 제안 |
| 1 | 그 외 (403/429 차단·요청 제한, 네트워크/5xx 등 일시 장애) | 알림만 (복구 시도 안 함) |

### 수정안 브랜치 (제안만 만들고 사람이 리뷰/머지)

코드 3 이 나오면 `run.sh` 는 같은 문제를 24시간 안에 이미 시도했는지(`reports/drift-state.json` 서명) 확인하고, 새 문제일 때만 이번 실행에서 녹화(`record`, 10분 제한)와 요약을 하고 `batch/repair.sh` 로 수정안을 **제안**합니다.

1. 메인 체크아웃은 건드리지 않고, 임시 디렉터리에 `git worktree` 로 `fix/api-drift-<날짜>-<서명>` 브랜치를 만듭니다. 커밋이 하나도 없으면 건너뛰고 알립니다.
2. 요약 md 와 헬스체크 리포트만 `.repair-input/` 으로 복사합니다 (HAR, `.env`, `.secrets` 는 복사하지 않음).
3. `claude -p` 를 환경 변수를 비운 채(`env -i`, HOME/PATH 만) Bash 도구 없이 실행합니다. 읽기는 `src/`, `test/`, `ENDPOINTS.md`, `.repair-input/` 만, 쓰기는 `src/schemas.ts`, `src/client.ts`, `recordings/ENDPOINTS.md`, `test/` 만 허용합니다 (`batch/repair-settings.json`). 사용한 격리 플래그는 `batch/repair.sh` 주석에 있습니다. 이 CLI 에는 `--max-turns` 가 없어 `--max-budget-usd` 와 30분 타임아웃으로 제한합니다.
4. 끝나면 신뢰된 메인 체크아웃 코드로 게이트를 통과해야 합니다: 변경 경로 allowlist(그 외 경로나 심볼릭 링크가 있으면 폐기), `secret-scan`(상태 파일의 쿠키 값, `TSSESSION=`/`credential=`/`signature=` 패턴이 diff 에 있으면 폐기). 통과하면 worktree 안에서 커밋하고 worktree 를 지웁니다.
5. **모델이 쓴 코드를 자동으로 실행하지 않습니다.** 타입체크/테스트/헬스체크도 돌리지 않습니다. `REPAIR_PUSH=1` 이면 브랜치를 push 합니다.

리뷰하고 머지하는 방법:

```bash
git log --stat main..fix/api-drift-<날짜>-<서명>
git diff main...fix/api-drift-<날짜>-<서명>
git switch fix/api-drift-<날짜>-<서명>
npm run typecheck && npm test && npm run healthcheck   # 직접 실행해 확인
```

스키마가 지나치게 느슨해지지 않았는지, 글 발행/수정/삭제 같은 위험한 호출이 추가되지 않았는지 확인한 뒤 머지하세요.

**왜 이렇게 하나요.** 자동 수정 단계가 세션 쿠키를 읽거나, 모델이 고친 코드가 쿠키가 있는 환경에서 곧바로 실행되면 녹화 화면의 제3자 텍스트(프롬프트 주입)로 세션이 유출될 수 있습니다. 그래서 모델은 비밀이 없는 격리된 사본에서 파일만 고치고, 실행과 검증은 사람이 합니다. 요약 md 도 문자열 값 없이 키와 모양만 남기고 `manage` API 와 `myBlogs` 호출만 담습니다.

## 보안 메모

- `recordings/*.har` 에는 라이브 쿠키가 들어 있어 git 에서 제외되고 0600 으로 저장됩니다. 요약 md 는 쿠키/`credential=`/`signature=` 값을 제거합니다.
- 로그와 리포트에는 응답 본문이나 쿠키를 남기지 않습니다 (오류에는 엔드포인트와 스키마 이슈만 포함).
