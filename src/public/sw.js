// 什麼都不快取，只是讓瀏覽器認得這是可以安裝的 App。
// Caches nothing; it only lets browsers treat the site as an installable app.
self.addEventListener('fetch', () => {});
