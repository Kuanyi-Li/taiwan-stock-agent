# 台股 Agent — 智能選股分析平台

> 完全靜態的台股追蹤與 AI 下單建議工具，可直接部署到 GitHub Pages

![screenshot](https://img.shields.io/badge/platform-GitHub%20Pages-blue)
![license](https://img.shields.io/badge/license-MIT-green)

---

## 功能一覽

| 功能 | 說明 |
|------|------|
| **投資組合管理** | 持股清單、均價、成本、市值、未實現損益、今日損益 |
| **即時報價** | 串接 Yahoo Finance API，每 60 秒自動更新 |
| **K 線圖** | 蠟燭圖 + 折線圖，支援 1日/1週/1月/3月/6月/1年 |
| **技術指標** | RSI(14)、MACD、KD(9)、布林帶、MA5/20/60 |
| **AI 下單建議** | 多指標綜合評分，給出進場價、停損停利建議 |
| **資金分配** | 依預算自動計算分批建議（1~4 批） |
| **Email 通知** | 整合 EmailJS，到達觸發條件時自動發信 |
| **自選清單** | 追蹤未持有的股票 |
| **資料持久化** | 使用 localStorage，重新整理不會遺失資料 |

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
# Clone 或初始化
git init taiwan-stock-agent
cd taiwan-stock-agent

# 複製本專案所有檔案到此目錄

git add .
git commit -m "Initial deploy"
gh repo create taiwan-stock-agent --public --push
```

然後到 GitHub 網頁開啟 Pages。

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

4. 取得以下三組資訊：
   - **Service ID**（格式：`service_xxxxxxx`）
   - **Template ID**（格式：`template_xxxxxxx`）
   - **Public Key**（在 Account → API Keys）

5. 在網站右上角點 ⚙ 設定，填入上述三組 ID

---

## 資料來源

- **股票報價**：Yahoo Finance API（透過 corsproxy.io 繞過 CORS）
- **大盤指數**：^TWII（加權指數）、^TWO（櫃買指數）
- **本地存儲**：持股資料儲存在瀏覽器 localStorage，不會上傳伺服器

### 注意事項

- Yahoo Finance 的台股代號格式：`2330.TW`（上市）
- 若 corsproxy.io 失效，可在設定中更換為：
  - `https://api.allorigins.win/raw?url=`
  - `https://cors-anywhere.herokuapp.com/`
- 報價可能有 15 分鐘延遲（Yahoo Finance 免費版限制）

---

## 技術架構

```
taiwan-stock-agent/
├── index.html          # 主頁面
├── css/
│   └── style.css       # 全部樣式
└── js/
    ├── data.js         # Yahoo Finance API 封裝
    ├── chart.js        # K 線圖繪製（Canvas）
    ├── analysis.js     # 技術分析與 AI 評分引擎
    └── app.js          # 主應用邏輯、訂單計算、通知
```

**使用的外部函式庫：**
- [Chart.js 4.4](https://chartjs.org) — MACD / KD 圖表
- [EmailJS](https://emailjs.com) — Email 通知

**無需 Node.js、無需編譯、無需後端**

---

## 免責聲明

本工具提供的 AI 分析與下單建議僅供參考，**不構成投資建議**。股票市場有風險，請自行判斷並負擔投資決策。
