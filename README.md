# 顯影 — PWA 版

可以裝到手機主畫面的版本。所有紀錄和照片都存在手機本機（IndexedDB），沒有伺服器、沒有帳號、沒有上傳。

## 檔案

```
index.html              App 本體
fx.js                   視覺與動態層（GSAP、Lenis、WebGL）
vendor/                 gsap.min.js、lenis.min.js、lenis.css（已內附，不需網路）
sw.js                   Service Worker（離線快取、通知）
manifest.webmanifest    PWA 設定檔
icon-192.png            圖示
icon-512.png            圖示
icon-maskable-512.png   Android 自適應圖示
apple-touch-icon.png    iOS 主畫面圖示
```

## 動態與視覺（GSAP + Lenis + WebGL）

- **GSAP**：所有動畫共用同一個 ticker，負責頁面進場、導覽小圓點滑動、浮層展開（從你點的位置圓形展開）、文字顯影。
- **Lenis**：平滑捲動。只作用在桌面滑鼠滾輪，手機觸控維持瀏覽器原生捲動（比較跟手）。浮層開著時會暫停，浮層自己照常捲。
- **WebGL（視覺核心）**：三個效果
  1. 照片顯影：先從亮處出現、先是黑白再慢慢上色，結束時顏色就是原圖。用在單則、播放本週。
  2. 暗房紅燈：拍攝畫面的背景，剩餘時間越少越暗，文字對比度有守住。
  3. 底紋顆粒：全站背景的細微底片顆粒，跟著捲動速度起漣漪，換分頁時掃過一次。
- **降級**：沒有 WebGL → 改用普通圖片加 CSS 濾鏡動畫；系統設「減少動態效果」→ 不用 Lenis、動畫直接到位、背景靜態；`fx.js` 載入失敗 → App 照常用，只是沒有動畫。想手動測沒有 WebGL 的版本，網址後面加 `?nogl=1`。
- 授權：GSAP 3.15.0（GreenSock Standard License，免費可商用）、Lenis 1.3.27（MIT）。
- 改過程式後，請把 `sw.js` 第一行的 `CACHE` 版本號加一，手機才會抓到新檔案。

## 部署（GitHub Pages，免費、五分鐘）

PWA **一定要 HTTPS** 才能運作，直接用瀏覽器開本機檔案是不行的（Service Worker 不會註冊）。最省事的做法是 GitHub Pages：

1. 在 GitHub 開一個新的 repository（Public）。
2. 把這個資料夾裡的所有檔案上傳到 repo 根目錄。
3. 到 repo 的 **Settings → Pages**，Source 選 `Deploy from a branch`，Branch 選 `main` / `(root)`，按 Save。
4. 等一兩分鐘，網址會長這樣：`https://<你的帳號>.github.io/<repo名>/`
5. 用手機瀏覽器打開那個網址。

要在電腦上先測的話，在這個資料夾跑 `python3 -m http.server 8000`，然後開 `http://localhost:8000`（localhost 被當成安全來源，SW 可以註冊）。

## 裝到主畫面

**iPhone（Safari，iOS 16.4 以上）**：用 Safari 打開網址 → 按下方分享鍵 → 加入主畫面 → 從主畫面圖示打開它 → App 裡會問你要不要開通知。
iOS 的限制：通知只有在「從主畫面圖示打開」的情況下才能用，在 Safari 分頁裡開是收不到的。

**Android（Chrome）**：打開網址後會跳出「加到主畫面」的提示，或從 App 裡的按鈕安裝。

## 通知能做到什麼、做不到什麼

**現在能做到**：App 開著、或剛切到背景還沒被系統回收時，今天的時刻一到就會跳通知。點通知會打開 App。

**現在做不到**：App 完全關掉後準時跳通知。這不是程式沒寫好，是瀏覽器的限制——排程本機通知的 Notification Triggers API 至今沒有在任何瀏覽器正式上線。iOS 和 Android 都一樣。

**要做到完全背景推播，需要一台伺服器**，流程是：

1. 產生一組 VAPID 金鑰（`npx web-push generate-vapid-keys`）。
2. App 裡呼叫 `registration.pushManager.subscribe()`，把 subscription 傳給伺服器存起來。
3. 伺服器每天為每個使用者隨機挑一個時間，用 `web-push` 套件在那個時間點送出推播。
4. `sw.js` 裡的 `push` 事件已經寫好了，收到就會跳通知，不用再改。

最省成本的做法是一支跑在免費層的小服務（Cloudflare Workers + Cron Triggers、或 Vercel Cron）。這一步要等到你確定要讓別人也用的時候再做，自己測試階段用現在這版就夠。

## 顯影（觀察者）要填金鑰

觀察者需要一組 Anthropic API 金鑰。到 https://console.anthropic.com 申請，然後在 App 的「顯影 → 設定」填進去。

金鑰只存在這支手機的 IndexedDB 裡，不會傳到任何地方。但要知道：**把金鑰放在前端，任何拿到這支手機的人都能看到它**，所以這個做法只適合自己測試。如果要給種子使用者用，金鑰必須改由伺服器保管，App 只跟自己的伺服器講話。

## 資料

- 照片壓到 560px、JPEG 品質 0.7 才存，一則大約 40–80KB。
- 全部存在瀏覽器的 IndexedDB。**移除 App、清掉瀏覽器資料、或 iOS 長時間沒用自動清理，資料都會消失。**
- 設定裡有「匯出成一個檔案」，測試期間建議偶爾匯出備份。
