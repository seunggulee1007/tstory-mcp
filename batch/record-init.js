// newpost 는 작성 중이던 글(autosave)이 있으면 confirm("이어서 작성하시겠습니까?")을 띄우는데,
// HAR 녹화 중에는 이 대화상자가 브라우저 데몬을 멈추게 한다. 해당 confirm 만 "아니오"로 자동 응답한다.
(() => {
  const orig = window.confirm.bind(window);
  window.confirm = (msg) => (/저장된 글이 있습니다/.test(String(msg)) ? false : orig(msg));
})();
