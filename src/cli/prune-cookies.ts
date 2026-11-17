import { loadConfig } from "../config.js";
import { pruneStateFile } from "../session.js";

// 기존 state 파일에서 티스토리 외(카카오 계정 등) 쿠키를 제거한다. 이름·값은 출력하지 않는다.
const { stateFile } = loadConfig();
try {
  const { total, removed } = pruneStateFile(stateFile);
  console.log(`쿠키 ${total}개 중 ${removed}개 제거`);
} catch (e) {
  console.error("정리 실패:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
}
