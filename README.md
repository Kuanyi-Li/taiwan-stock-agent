# 股票 Agent — 台美股智能分析平台

> 完全靜態的台美股組合追蹤、AI 訊號分析與回測驗證工具，可直接部署到 GitHub Pages

![screenshot](https://img.shields.io/badge/platform-GitHub%20Pages-blue)
![license](https://img.shields.io/badge/license-MIT-green)

---

## 功能一覽

### 核心追蹤
| 功能 | 說明 |
|------|------|
| **投資組合管理** | 台美股持股清單、均價、成本、市值、未實現損益、今日損益 |
| **即時報價** | 每 8-12 秒自動更新，台股上市+上櫃合併查詢 |
| **K 線圖** | 蠟燭圖 + 折線圖，5分/15分/1時/1日/1週/3月/6月/1年，今日K線即時同步 |
| **技術指標** | RSI、MACD、KD、ADX、布林帶、MA5/10/20/60/120/240 |
| **買賣訊號** | 7級訊號（緊急出場～強力買進），全站統一同一套判斷標準 |
| **資金分配** | 依預算自動計算分批建議，跟訊號徽章門檻對齊、跟預測準確度掛鉤 |

### 分析與決策輔助（「腦袋」功能）
| 功能 | 說明 |
|------|------|
| **回測沙盒** | 台美股、長短線並排、投資組合模式、7天冷卻期機制、隔天開盤價成交避免偷看未來 |
| **歷史相似情境比對** | 找出技術面組合最相似的歷史時間點，秀出當時實際發生了什麼（取代單一預測線）|
| **重大事件提醒** | FOMC、CPI、PCE、非農（美）+ 央行理監事會議（台），日曆+側邊欄雙重顯示 |
| **全市場選股篩選器** | 掃描全部上市股票，法人買超+估值+殖利率+動能+分散度五因子評分 |
| **長期核心觀察清單** | 精選長期體質標的，跟即時篩選器交叉比對 |
| **產業集中度分析** | 持股產業佔比視覺化，過度集中會警示 |

### 其他
| 功能 | 說明 |
|------|------|
| **交易與除權息日曆** | 買賣紀錄、除權息日期、重大事件整合在同一份月曆 |
| **Email 通知** | 整合 EmailJS，到價/訊號觸發時自動發信 |
| **雲端同步** | 選用 JSONBin，跨裝置同步持股資料 |
| **自選清單** | 追蹤未持有的股票 |
| **資料持久化** | localStorage 本機儲存，重新整理不會遺失資料 |

---

## 快速部署到 GitHub Pages

### 方法一：直接上傳（最簡單）

1. 在 GitHub 建立新的 repository（例如：`taiwan-stock-agent`）
2. 把這個資料夾的所有檔案上傳到 repository 的根目錄
3. 進入 **Settings → Pages → Source**，選 `Deploy from a branch`
4. Branch 選 `main`，資料夾選 `/ (root)`
5. 儲存後約 1-2 分鐘，網址會顯示在 Pages 設定頁

部署完成後即可用瀏覽器開啟：
```
https://你的帳號.github.io/taiwan-stock-agent/
```

### 方法二：GitHub CLI

```bash
git init taiwan-stock-agent
cd taiwan-stock-agent
# 複製本專案所有檔案到此目錄
git add .
git commit -m "Initial deploy"
gh repo create taiwan-stock-agent --public --push
```

---

## 設定 EmailJS（到價通知）

1. 前往 [emailjs.com](https://www.emailjs.com) 免費註冊
2. 新增一個 Email Service（例如 Gmail）
3. 建立一個 Email Template，範本內容範例：

```
股票代號：{{stock_code}}
股票名稱：{{stock_name}}
觸發條件：{{condition}}
當前價格：{{price}}
建議進場：{{suggest_entry}}
建議停損：{{suggest_sl}}
建議停利：{{suggest_tp}}
觸發時間：{{time}}
```

4. 取得以下三組資訊：Service ID、Template ID、Public Key（Account → API Keys）
5. 在網站右上角點 ⚙ 設定，填入上述三組 ID

---

## 資料來源

- **台股報價/K線**：TWSE即時查詢 + Yahoo Finance（透過自建 Cloudflare Worker 代理）
- **台股基本面**：TWSE OpenAPI（本益比/殖利率、三大法人買賣超、產業類股指數）— **僅涵蓋上市，上櫃資料源不可行**
- **美股報價/K線**：Yahoo Finance（同一組代理）— **本益比/法人資料美股不可行**（Yahoo相關端點需要登入授權，非公開）
- **大盤指數**：^TWII（加權指數）、^SOX（費半，AI循環判斷用）
- **重大事件時程**：官方年度公告，寫死在程式碼裡（FOMC/CPI/PCE/非農/台灣央行），**每年須手動更新**
- **本地存儲**：持股資料儲存在瀏覽器 localStorage，不會上傳伺服器

### ⚠️ CORS 代理重要提醒

程式預設使用**自建的 Cloudflare Worker**（`flat-resonance-0773.s51511830-74e.workers.dev`）作為主要代理，這是實測過在大流量（開盤時段）下最穩定可靠的選擇。

**不要在設定裡填入 `corsproxy.io`、`api.allorigins.win` 等公開代理服務**——這些服務在開盤時段極不穩定（曾實測出現403封鎖、9秒逾時等狀況），會導致整個網站載入時間暴增到45秒以上。若設定裡已經存過這類代理，可在瀏覽器 Console 執行以下指令清除：

```js
localStorage.removeItem('twsa-settings'); location.reload();
```

自訂代理設定目前會被加進代理清單「當備援使用」，不會覆蓋掉可靠的預設代理。

---

## 技術架構

```
taiwan-stock-agent/
├── index.html          # 主頁面
├── css/
│   └── style.css       # 全部樣式（深色主題固定，無淺色模式）
└── js/
    ├── data.js         # 資料抓取層（報價/K線/基本面/法人/代理輪替）
    ├── chart.js        # K 線圖繪製（Canvas）、預測延伸線引擎
    ├── analysis.js      # 技術分析、AI評分引擎、歷史相似情境比對
    └── app.js           # 主應用邏輯、訊號系統、回測沙盒、選股篩選器、
                          # 資金分配、重大事件、日曆、投資組合管理
```

**使用的外部函式庫：**
- [Chart.js 4.4](https://chartjs.org) — MACD / KD 圖表
- [EmailJS](https://emailjs.com) — Email 通知

**無需 Node.js、無需編譯、無需後端**

---

## 已知限制（誠實揭露）

- 本益比/殖利率/法人買賣超**只支援台股上市**，上櫃跟美股皆因資料源限制無法取得
- 法說會/財報日期評估後判定投入產出比不佳，**未實作**
- 回測時 VIX 固定關閉（沒有逐日歷史VIX資料，用現在的VIX套用在過去會偷看未來）
- 重大事件時程表為官方公告後手動寫入，**每年須更新一次**（Fed/BLS通常於前一年秋冬公告次年時程，台灣央行於前一年12月公告）
- 回測結果有樣本內測試限制（訊號門檻調整時參考的是同一批歷史資料）

---

## 免責聲明

本工具提供的 AI 分析、訊號、回測結果僅供參考，**不構成投資建議**。股票市場有風險，請自行判斷並負擔投資決策。
