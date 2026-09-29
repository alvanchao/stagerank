// 即時同步：主持人一按，這一頁就自己跟上。
// Live sync: when the host presses something, this page follows along.
(function () {
  var script = document.currentScript;
  var competitionId = script && script.getAttribute('data-competition');
  if (!competitionId || typeof EventSource === 'undefined') return;

  var EVENTS = [
    'heat-standby', 'heat-start', 'heat-closed', 'checkin', 'judge-ready',
    'judge-submitted', 'judge-voided', 'absent', 'reported', 'heat-ready', 'no-more-heats',
  ];

  var source = new EventSource('/events/' + competitionId);
  var reloadTimer = null;

  // 由程式自己觸發的重整，要先舉旗。裁判畫面靠這面旗子分辨
  // 「系統自己重整」和「裁判切到別的 app」，不然每次同步都會被誤判成作弊。
  // A refresh we trigger ourselves raises a flag first. The judge screen uses it to tell
  // "the system refreshed" apart from "the judge switched apps"; without it, every sync
  // would be mistaken for cheating.
  function reloadNow() {
    window.__stagerankInternalNav = true;
    window.location.reload();
  }

  function scheduleReload() {
    if (reloadTimer) return;
    // 稍微延遲再重整，避免同一秒內好幾個事件讓畫面連閃好幾次。
    // A short delay so a burst of events causes one refresh, not several flickers.
    reloadTimer = setTimeout(reloadNow, 400);
  }

  // 頁面可以自己接管某些事件（裁判評分中就不重整，改成就地更新名單）。
  // A page can take over some events (while scoring, the judge screen patches the list in place).
  var handlers = {};
  window.StageRankLive = {
    takeOver: function (type, fn) { handlers[type] = fn; },
    reloadNow: reloadNow,
  };

  EVENTS.forEach(function (type) {
    source.addEventListener(type, function (event) {
      if (handlers[type]) {
        handlers[type](event);
        return;
      }
      scheduleReload();
    });
  });

  // 斷線瀏覽器會自己重連，會場網路不穩時不必做什麼。
  // The browser reconnects on its own, which is what flaky venue wifi needs.
  source.onerror = function () {};
})();
