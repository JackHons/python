# Phase 7：前後端整合、雙語、錯誤狀態與端到端流程

## 目標

將前端原型由展示資料改為真實 API／資料：登入及角色導覽、教材／功課／編程工作台、學生提交、教師審核／課堂／報表、管理員設定全部反映伺服器狀態，並保持中英雙語及響應式主要流程。

## 非目標

- 不在此 phase 新增未列入 P1–P6 的商業功能。
- 不以視覺完成度代替後端權限、資料一致性及安全測試。
- 不把手機編程體驗承諾為與桌面完全相同；需明確標示支援界面。

## 允許修改範圍

- `app/**`、前端 API client／hooks／狀態管理、錯誤／loading／空狀態及 i18n。
- 必要的 server DTO／API adapter（不得重寫已驗收 domain 規則）。
- `tests/**` 的 rendered HTML、browser／contract／E2E 測試及測試 fixture。
- `docs/網站架構.md`、部署／操作說明的對應更新。

## 禁止修改範圍

- 不繞過伺服器端 RBAC、審核、答案公布或 hidden test projection。
- 不把真實學生資料、API key 或測試答案硬編碼到前端 bundle。
- 不因 UI 方便而刪除 P1–P6 已定義的審計／交易欄位。

## 具體交付物

- 真實登入、首次改密碼、角色／課程／班別視圖及安全登出。
- 教師課程 studio、教材／題目／功課發布；學生讀取、作答、編程、結果及通知。
- 即時課堂、AI 提示／review、分析匯出、管理員設定／備份狀態 UI。
- 中英介面切換、教材雙語欄位、鍵盤／基本螢幕閱讀器、桌面／平板／手機 responsive。
- 對每個非同步操作提供 loading、錯誤、重試及成功後重新驗證資料。

## 驗收條件

1. 以測試帳戶完成「管理員建帳戶→教師建班／課→學生登入→讀教材→作答／執行→提交→教師查看／評分→報表」完整流程。
2. 每個成功狀態都有對應資料庫／API 證據；刷新後不回到假資料或遺失提交。
3. 角色切換只存在開發／預覽模式；正式 session 由後端決定，學生不能偽造教師／管理員請求。
4. 主要頁面中英切換不出現空 key／overflow；手機與 iPad 可完成閱讀／提交基本流程。
5. 學生端從未出現 hidden test、未公布答案、他人提交、AI 未審核內容或管理員秘密。

## 測試方式／命令

```bash
pnpm run lint
pnpm run build
node --experimental-strip-types --test tests/rendered-html.test.mjs tests/backend.contract.test.mjs tests/backend.e2e.test.mjs
```

若使用 Playwright／瀏覽器 runner，固定測試 Chrome 桌面、Safari／WebKit 或等價 iPad viewport、手機 viewport；端到端測試使用一次性 fixture 與自動清理。

## 必須保存的證據

- E2E run ID、測試帳戶／fixture 版本及主要 API response／DB event。
- build／lint／contract 輸出、雙語 key 掃描及 responsive viewport 結果。
- hidden test／未審核內容前端 bundle／network response 的負向掃描。

## 風險與回退策略

- 風險：原型資料結構與正式 DTO 不一致。回退：以 typed API client／schema validation 為唯一入口，逐頁切換而不混用假資料。
- 風險：SSR／Worker runtime 對 session／file download 行為不同。回退：以實際 Docker Web runtime 做 contract smoke，不能只靠 dev server。
- 風險：手機編輯器不適合長程式碼。回退：手機提供閱讀、基本修改與提交，提示桌面最佳體驗，保留自動保存。
