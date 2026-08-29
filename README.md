# Face2Face — AI Negotiation Coach

用 3D Avatar 模擬真實面對面談判，練習談薪、議價與應對策略，結束後給評分與改進建議。

Avatar 與語音由 [Perxona Connect](https://console.perxona.ai) 提供，談判對手由 LLM 扮演。

## 本機執行

```bash
npm install
cp .env.example .env    # 填入你的 key
npm start               # http://localhost:3000
```

`.env` 需要：

| 變數 | 說明 |
|---|---|
| `PERXONA_API_BASE_URL` | 區域專屬，例如 `https://console.perxona.ai/asia` |
| `PERXONA_CONNECT_SECRET_KEY` | 僅 server 使用，allowed domains 留空 |
| `PERXONA_CONNECT_PUBLISHABLE_KEY` | 給瀏覽器的 Presenter 用，要設 allowed domains |
| `OPENAI_API_KEY` | 談判引擎 |

### region 一定要一致

Presenter engine 的 CDN URL 是**區域專屬**的，由 `PERXONA_API_BASE_URL` 的
`/asia` 或 `/eu` 推導。兩者不一致時，Presenter 會對錯誤的 region 認證，
瀏覽器會看到整排 401，但 server 端的 REST 呼叫全部正常——症狀離原因很遠。

啟動時會印出實際生效的值，先確認這兩行再往下查：

```
  Region    : asia
  Presenter : https://cdn.perxona.ai/asia/prod/latest/widget/entry/presenter.js
```

## 談判情境

內建五個，方向分兩類：

| 情境 | 方向 |
|---|---|
| Junior / Senior SWE、Product Manager、接案報價 | 爭取更高 |
| 買二手車 | 壓低價格 |

也可以自訂：填身分、方向、開價、目標、底線與回合數即可。
**對手的授權極限不由使用者提供**，而是 server 從目標與底線之間隨機推導——
連底價都自己填的話就沒有談判可言，出題的人也不該知道確切值。

## 部署（Render）

`render.yaml` 是 Blueprint，secrets 一律在儀表板填，不進版控。

部署後還要做兩件事：

1. **Perxona Console** → Publishable Key 的 Allowed Domains 加上部署網域，
   否則 Presenter 會被拒（`CONNECT_KEY_REJECTED`）。
2. 設 `DEMO_ACCESS_CODE`。公開連結若不設，任何人都能打 `/api/*`，
   而每次談判回應都會燒 OpenAI 額度、每次 presentation 會燒 Perxona 額度。

### 保護層

`src/middleware/guard.js`：每個 IP 每小時的頻率上限、全站每日總量上限
（`DAILY_LLM_LIMIT` / `DAILY_PRESENTATION_LIMIT`）、選填的存取碼。

狀態存在記憶體，單一 instance 才準確。要水平擴充時必須換成 Redis。

## 架構

```
server.js
├── src/routes/connect.js      Perxona Connect：資源清單、Presenter 設定、Connect Key
├── src/routes/negotiation.js  談判：start / respond / report / scenarios
├── src/services/perxona.js    Connect REST（Secret Key，僅 server）
├── src/services/llm.js        HR 角色 prompt、輸出驗證、洩底價攔截
├── src/services/scoring.js    六項配分與教練回饋
├── src/utils/negotiation.js   session 狀態、自訂情境、白名單投影
└── public/                     Presenter 初始化與談判介面
```

談判的隱藏狀態（`internalLimit`）只存在 server；送到瀏覽器的東西一律
經過 `toClient()` 白名單投影。

## 授權

MIT
