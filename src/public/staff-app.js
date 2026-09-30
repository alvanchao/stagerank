// 工作人員 App 登入頁：檢查是不是已安裝成 App、掃描 QR、註冊什麼都不快取的 service worker。
// Staff app sign-in: check that it runs as an installed app, scan a QR, register the no-op worker.
(function () {
  var standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
    || window.navigator.standalone === true;
  document.getElementById('standalone').value = standalone ? '1' : '0';
  document.getElementById('install').hidden = standalone;

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(function () {});

  var scanBtn = document.getElementById('scan');
  var code = document.getElementById('code');
  var video = document.getElementById('preview');
  var note = document.getElementById('scanNote');
  if (!('BarcodeDetector' in window) || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return;
  }
  scanBtn.hidden = false;
  note.hidden = false;

  var stream = null;
  var running = false;
  function stop() {
    running = false;
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    stream = null;
    video.hidden = true;
  }
  function fromScan(text) {
    try { var u = new URL(text); var c = u.searchParams.get('code'); if (c) return c; } catch (e) { /* not a URL */ }
    return text;
  }
  scanBtn.addEventListener('click', function () {
    var detector = new window.BarcodeDetector({ formats: ['qr_code'] });
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }).then(function (s) {
      stream = s;
      video.srcObject = s;
      video.hidden = false;
      video.play();
      running = true;
      (function tick() {
        if (!running) return;
        detector.detect(video).then(function (found) {
          if (found && found.length) {
            code.value = fromScan(found[0].rawValue);
            stop();
            return;
          }
          setTimeout(tick, 250);
        }).catch(function () { setTimeout(tick, 400); });
      })();
    }).catch(function () { note.hidden = false; });
  });
})();
