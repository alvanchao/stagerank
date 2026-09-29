// 裁判畫面的四件事：螢幕常亮、勾選名額提示、跳出作廢、評分中不掉已填的內容。
// Four things on the judge screen: keep the screen awake, show the quota, report a walk-away,
// and never lose what has been filled in.
(function () {
  var panel = document.getElementById('scoring');
  if (!panel) return;

  var heatId = panel.getAttribute('data-heat');
  var competitionId = panel.getAttribute('data-competition');
  var form = panel.querySelector('form');

  // 評審中不讓手機自動鎖屏，避免被誤判成跳出。
  // Keep the screen on while judging so an auto-lock is never mistaken for walking away.
  if ('wakeLock' in navigator) {
    navigator.wakeLock.request('screen').catch(function () {});
  }

  // ---- 勾選名額：畫面顯示「已勾 5／15」，超過就擋住 ----
  // The quota counter, shown as "5 / 15", enforced on screen as well as on the server.
  var quota = document.getElementById('quota');
  var limit = quota ? parseInt(quota.getAttribute('data-limit'), 10) : null;

  function markBoxes() {
    return Array.prototype.slice.call(document.querySelectorAll('.markbox'));
  }

  function refreshQuota() {
    if (!quota || !limit) return;
    var boxes = markBoxes();
    var used = boxes.filter(function (b) { return b.checked; }).length;
    quota.textContent = quota.textContent.replace(/\d+\s*[／\/]\s*\d+|\d+ of \d+/, used + ' / ' + limit);
    boxes.forEach(function (b) { b.disabled = !b.checked && used >= limit; });
  }

  // ---- 評分中的暫存 ----
  // 主持人補點一位選手時，畫面要更新，但裁判已經勾好的不能被洗掉。
  // 暫存只留在這支手機、這一場，送出或換場就清掉。
  // When the host adds a latecomer the screen must update, but whatever the judge already
  // ticked must survive. The draft stays on this phone, for this heat only, and is cleared
  // on submit or change-over.
  var DRAFT_KEY = 'stagerank.draft.' + competitionId + '.' + heatId;

  function readDraft() {
    try {
      var raw = window.sessionStorage.getItem(DRAFT_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      return null; // 無痕模式等情況讀不到，當作沒有暫存就好 / private mode: just carry on
    }
  }

  function saveDraft() {
    var draft = { marks: [], values: {} };
    markBoxes().forEach(function (b) { if (b.checked) draft.marks.push(b.value); });
    Array.prototype.slice.call(form ? form.querySelectorAll('input[type=text]') : []).forEach(function (input) {
      if (input.value !== '') draft.values[input.name] = input.value;
    });
    try {
      window.sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    } catch (err) { /* 存不進去不影響評分 / storage failures never block judging */ }
  }

  function clearDraft() {
    try { window.sessionStorage.removeItem(DRAFT_KEY); } catch (err) { /* ignore */ }
  }

  function restoreDraft() {
    var draft = readDraft();
    if (!draft) return;
    markBoxes().forEach(function (b) {
      if (draft.marks.indexOf(b.value) !== -1) b.checked = true;
    });
    Object.keys(draft.values || {}).forEach(function (name) {
      var input = form && form.querySelector('[name="' + name + '"]');
      if (input && input.value === '') input.value = draft.values[name];
    });
  }

  restoreDraft();
  refreshQuota();

  panel.addEventListener('change', function () {
    refreshQuota();
    saveDraft();
  });
  panel.addEventListener('input', saveDraft);

  // ---- 跳出作廢 ----
  // 只有「裁判真的離開畫面」才算。系統自己的重整、按送出、按連結都不算。
  // Only a genuine walk-away counts. Our own refreshes, the submit button and our own links do not.
  var reported = false;

  function isInternalNavigation() {
    return window.__stagerankInternalNav === true;
  }

  function reportLeft() {
    if (reported || isInternalNavigation()) return;
    reported = true;
    var body = JSON.stringify({ heatId: heatId });
    var url = '/judge/' + competitionId + '/left';
    if (navigator.sendBeacon) {
      navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
    } else {
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true });
    }
  }

  // 按下送出、或點了站內的連結，都是在這個 app 裡面走動，不是跳出去。
  // Submitting, or following one of our own links, is moving inside the app, not leaving it.
  document.addEventListener('submit', function () {
    window.__stagerankInternalNav = true;
    clearDraft();
  }, true);

  document.addEventListener('click', function (event) {
    var link = event.target && event.target.closest ? event.target.closest('a[href]') : null;
    if (link && link.origin === window.location.origin) window.__stagerankInternalNav = true;
  }, true);

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') reportLeft();
  });
  window.addEventListener('pagehide', reportLeft);

  // ---- 補點：主持人加人時就地更新名單，不重整，裁判勾好的都還在 ----
  // A late add patches the list in place instead of refreshing, so nothing ticked is lost.
  if (window.StageRankLive) {
    window.StageRankLive.takeOver('checkin', function () {
      saveDraft();
      window.StageRankLive.reloadNow();
    });
  }
})();
