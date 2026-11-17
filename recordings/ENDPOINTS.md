# Tistory 내부 API 명세 (역추출)

- 기준일: 2026-11-16 (agent-browser 0.43.0 HAR 녹화 + 직접 HTTP 재현으로 검증)
- 원본 녹화: `recordings/*.har` (쿠키 포함 → git 제외, 로컬 전용)
- `{B}` = `https://{blog}.tistory.com/manage`

## 인증

- 필요한 것: **쿠키만**. 도메인에 `tistory`가 들어간 쿠키 전체를 `Cookie` 헤더로 보낸다.
  - 핵심: `TSSESSION`(.tistory.com, 세션 쿠키), `_T_ANO`(.tistory.com)
- Referer / X-Requested-With / User-Agent: 없어도 200 (생략 테스트 완료). 단, 브라우저와 비슷하게 보이도록 UA·Referer는 붙인다.
- 세션 만료/미인증 신호: `302` 리다이렉트 (로그인 페이지로). JSON 대신 HTML이 오면 같은 의미로 본다.
- 로그인: **카카오 QR 로그인만 사용** (아이디/비밀번호 입력 금지). 흐름: `https://www.tistory.com/auth/login` → 링크 "카카오계정으로 로그인" → accounts.kakao.com 로그인 화면의 버튼 "QR코드 로그인" → `accounts.kakao.com/qr_login/...`. 여기서 체크박스 "로그인 상태 유지"(LabelText, 기본 해제)를 체크하고, `<canvas title="로그인 QR코드">`(150x150)의 QR 을 카카오톡 앱으로 스캔(유효 약 5분, "QR코드 새로고침" 버튼 `button.btn_reset`) → 브라우저가 `https://www.tistory.com/` 로 리다이렉트. 헤드리스로 완전 동작.
- 세션 수명: "로그인 상태 유지" 체크 시 `TSSESSION`, `TSSESSION_KEEP`(.tistory.com)이 30일 만료 (미체크 시 TSSESSION 은 세션 쿠키).
  - **슬라이딩 만료**: `GET https://www.tistory.com/legacy/member/blog/api/myBlogs` 응답이 `Set-Cookie: TSSESSION_KEEP=...; Max-Age=2592000` 와 `TSSESSION=...; Max-Age=2592000` 을 내려 만료를 30일 뒤로 밀어준다. 다른 엔드포인트는 Set-Cookie 가 없다. → 주기적으로 myBlogs 를 호출하면 세션 유지.
  - **조용한 재로그인 불가**: `TSSESSION_KEEP` 만으로는 `/manage` 가 로그인으로 302. 카카오 쿠키가 남아 있어도 "카카오계정으로 로그인"은 `prompt=select_account` 라 ID/PW 폼이 다시 뜬다. → 만료되면 QR 로그인을 다시 해야 한다.

## 엔드포인트

| 기능 | 메서드 | 경로 | 요청 | 응답 |
|---|---|---|---|---|
| 내 블로그 목록 | GET | `https://www.tistory.com/legacy/member/blog/api/myBlogs` | - | `{status:200, data:[{id,name,title,defaultUrl,adminUrl,role,defaultBlog}]}` |
| 글 목록 | GET | `{B}/posts.json?category=-3&page=1&searchKeyword=&searchType=title&visibility=all` | 쿼리 | `{count, totalCount, items:[{id,title,slogan,visibility:"PUBLIC"\|"PRIVATE"\|"PROTECTED",category,categoryId,published,created,modified,permalink,countOfComments,...}]}` (페이지당 15) |
| 카테고리 | GET | `{B}/category/simple.json` | - | `{categories:[{id,name,label,priority,entries,visibility,children:[...],leaf}]}` (id -3=전체, 0=없음) |
| 카테고리 전체 트리 | GET | `{B}/category.json` | - | `{categories:[simple.json 과 같은 노드...], rootLabel:"분류 전체보기", viewChannels, settingSelected, settingOptionList}` (카테고리 관리 화면용, referer `{B}/category`) |
| 카테고리 저장 | PUT | `{B}/category.json` | `Content-Type: application/json`. 전체 트리가 아닌 변경분 `{rootLabel, delete:[id...], append:[노드...], update:[노드...]}`. 새 노드는 append 와 update 양쪽에 넣는다: `{id:-1,name,children:[],depth:1,opened:true,priority:<형제 수>,visibility:20,parent:0,viewChannel:null,entries:0,categoryInfo:{},isNew:true,updatedData:true}`. 하위는 `depth:2,priority:<부모의 자식 수>,parent:<부모 id>,label:"부모이름/"`. 2단계까지만 지원 | `{categoryTree:[노드...], inputs, rootLabel}` (2026-11-17 실측). 새 노드 id 는 응답에 표시되지 않으므로 저장 후 simple.json 을 다시 읽어 확인. 삭제는 `delete:[id]` 로 실측 확인 |
| 글 단건(수정용) | GET | `{B}/newpost/{id}` | - | HTML. `window.Config = {...}` 의 `post` = `{id,title,slogan,content(HTML),visibility(0/15/20),category,tags:[],acceptComment,password,thumbnail,...}` |
| 발행 | POST | `{B}/post.json` | JSON (아래) `id:"0"`, `published:1` | `{entryUrl:"https://{blog}.tistory.com/{id}"}` ← id는 URL 끝에서 추출 |
| 수정 | PUT | `{B}/post/{id}.json` | JSON (아래) `id:"{id}"`, `published:0`, `acceptComment:1`, `thumbnail:null`, `daumLike:null` | `{entryUrl}` |
| 삭제 | DELETE | `{B}/post/{id}.json` | - | `{data: 193}` (삭제된 글 id, 숫자) |
| 임시저장 목록 | GET | `{B}/drafts` | - | `{success, data:[{sequence,title,summary,tags,categoryId,createdAt,updatedAt}]}` |
| 임시저장 생성 | POST | `{B}/drafts` | `{title,content,tags,categoryId,totalWritingTimeMs}` | `{success,total,draft:{sequence}}` |
| 임시저장 삭제 | DELETE | `{B}/drafts/{sequence}` | - | `{success,total}` |
| 이미지 업로드 | POST | `{B}/post/attach.json` | multipart, 필드명 `file` | `{name,url,key,filename,size}` |
| 자동저장 조회 | GET | `{B}/autosave` | - | `{autosavedEntry:null\|{...}}` |

### 발행/수정 본문

```json
{
  "id": "0",
  "title": "제목",
  "content": "<p>HTML</p>",
  "slogan": "",
  "visibility": 0,
  "category": 0,
  "tag": "태그1,태그2",
  "published": 1,
  "uselessMarginForEntry": 1,
  "cclCommercial": 0,
  "cclDerive": 0,
  "type": "post",
  "attachments": [],
  "recaptchaValue": "",
  "draftSequence": null
}
```

- `visibility`: 0 비공개 / 15 보호 / 20 공개
- `slogan`: 빈 문자열이면 서버가 제목으로 생성
- 본문 이미지: 에디터는 치환자 `[##_Image|kage@{url에서 https://blog.kakaocdn.net/dna/ 를 뺀 나머지, &는 &amp;로}|CDM|1.3|{"originWidth":W,"originHeight":H,"style":"alignCenter","filename":"{원본파일명}"}_##]` 를 `<p>` 안에 넣는다 (autosave 녹화에서 확인). 즉 `kage@{key}/{filename}?{쿼리}` 형태.

## 주의 신호

- 에디터가 발행/수정 직전 `POST {B}/dkaptcha/widgetId` 호출 → 카카오 캡차 위젯. 현재 `recaptchaValue:""`로 통과하지만, 정책 강화 시 발행이 막힐 수 있음. 이 경우 **임시저장으로 대체**하고 사람에게 알린다.
- 글 번호는 발행 시 소모되며, 삭제해도 재사용되지 않는다(191·192 소모됨). → 헬스체크는 발행 대신 임시저장 생성·삭제로 검증한다.
