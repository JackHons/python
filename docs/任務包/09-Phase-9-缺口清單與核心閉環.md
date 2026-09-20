# Phase 9：缺口清單與內部試教核心閉環

日期：2026-08-23（Asia/Macau）  
定位：Phase 8 後的真實功能審計與 P0/P1 修復；不是「全需求完成」聲明。

## 1. 本批次目標與可改範圍

本批次把內部試教最容易造成越權、錯誤公布或「畫面可按但後端未執行」的缺口收斂：Gateway CSRF、學生發布範圍、功課政策、Python 套件白名單、帳戶／班別／整班加課、教師批改發布、學生跨課功課及伺服器自動保存／貼上事件。

允許修改 `gateway/**`、`server/**`、`db/**`、`drizzle/**`、`services/runner/**`、`app/**`、`tests/**`、`scripts/**`、Compose／套件契約及文件。禁止修改真實 `.env`、`.data`、`.local-secrets`、Docker volumes 或使用者原始教材；功能測試使用記憶體或臨時資料庫。

## 2. 需求—狀態—證據矩陣

| 需求 | Phase 9A 狀態 | 程式／測試證據 | 優先級 | 批次 |
| --- | --- | --- | --- | --- |
| Gateway mutation CSRF | Implemented | `gateway/server.mjs`；`tests/gateway-csrf.integration.test.mjs` 驗 evil Origin 403、same-origin 成功、無 Origin 僅內部 token | P0 | 本批次 |
| 學生不得以已知 ID 看草稿／封存課程、單元、教材、功課 | Implemented | `server/education.ts`、`server/content.ts`；`tests/phase9a.integration.test.mjs` | P0 | 本批次 |
| 跨課程功課 | Implemented | `app/page.tsx` 聚合所有已加入課程的 assignments，課程篩選並從真實 assignment 開始 | P0 | 本批次 |
| 發布／截止／逾期／次數／重交／隨機／抽題 | Implemented | `AssignmentService` 伺服器 clock policy；教師政策表單；Phase 9A policy test | P0 | 本批次 |
| 分數、測試、答案／解答公布時間 | Implemented | submission／execution projection 分開控制；教師 UI 的立即分數與立即測試結果為兩個獨立開關；false/false server roundtrip test；教師 release；學生顯示 release 狀態 | P0 | 本批次 |
| 教師提交列表、手動批改、評語與 release | Implemented（MVP） | `/assignments/:id/submissions`、grade、release route；`TeacherGradingDesk`。目前 UI 逐題批改先以選中提交的第一題為入口 | P1 | 本批次；多題批改 UX 後續優化 |
| Python 可用套件 | Implemented | course/system setting 是唯一來源；Runner AST 實際允許 stdlib 及課程啟用的 NumPy／Pandas／Matplotlib，拒絕 pip／未允許第三方；macOS Python 3.9 以 stdlib path 並排除 purelib/platlib，3.12 使用原生 module-name set；host 3.9、bundled 3.12、Docker 3.12 各 12/12 | P0 | 本批次 |
| 自動保存與貼上紀錄 | Implemented（核心契約） | code snapshot HTTP route；900ms debounce；paste 事件含字數；analytics 已能讀 snapshot history | P1 | 本批次；離線恢復 UX 後續 |
| 管理員帳戶 list/create/archive/reset + session revoke | Implemented | `EducationService`、education API、`AdminCentre`；初始密碼只在當前 React state 顯示一次，無 localStorage | P0 | 本批次 |
| 帳戶 CSV/XLSX 批量匯入 | Implemented（安全預覽／提交 MVP） | client 解析預覽，server 全批驗證後 transaction 匯入；既有 CSV/XLSX tests | P1 | 本批次 |
| 班別／名單／整班加入課程／join code | Implemented | class/member/course-class APIs；`TeacherClassManager` | P1 | 本批次 |
| 教師授權重設學生密碼 | Implemented | 僅共同有效班別的學生；session revoke；Phase 9A scope test | P0 | 本批次 |
| 題庫 archive／共享範圍 | Partial | 題目封存有 dependency 409；course／school 共享資料欄位存在。缺完整共享庫搜尋、複製、匯入／匯出 UI | P1 | 後續 9B |
| 教材庫、原檔、跨課重用 | Implemented | 真實 PPTX quarantine/signature/release/dedup/reuse/download 測試 | P0 | 既有＋本批次回歸 |
| PPT 網站播放／轉網頁 | Implemented（內部試教） | Phase 9B 獨立 converter 以 LibreOffice／Poppler 真實產生 PDF＋逐頁 PNG；學生 scoped viewer；真實 PPTX fixture test | P1 | 9B 完成；版面 fidelity 仍需教師抽查 |
| AI 助教／教材生成／翻譯／題目／評語 | Partial | Phase 11 完成多 provider 顯式單一啟用、學生安全 status、教師／AI draft 審核及持久逐層提示；教材生成／翻譯完整 authoring UX 仍未完成 | P1 | 提示核心完成；authoring 後續 |
| 真實 AI vendor | Configurable／未配置 | OpenAI-compatible provider factory 已完成；校方 vendor/key 尚未提供，無配置時 503 fail closed；本地 fake HTTP 只驗 adapter | P1 | 後續校方配置與資料處理審批 |
| 即時課堂 | Implemented（內部試教） | Phase 11 完成教師／學生 list/detail、start/pause/lock/reopen/end、join/heartbeat/events polling、匿名進度、刷新恢復、lock/ended 423 及 ended 唯讀 | P1 | Phase 11 完成；browser 視覺 QA 待獨立驗收 |
| 通知／公告 | Partial | 後端 recipient snapshot、站內通知、已讀完成；教師公告 UI 不完整 | P1 | 後續 9B |
| SMTP 電郵 | Partial | Phase 9B 保留標準 SMTP adapter／背景 worker及本地 fake SMTP 證據；校方 SMTP／完整管理 UI 未配置且 fail closed | P2 | 依最新優先次序停止擴展 |
| 分析與 Excel/PDF | Partial | Phase 9B 教師 Dashboard 已接完成率、分數、學習時間、作答、AI 提示、常見錯誤及 course/class/student filter；XLSX/PDF 後端仍已測，完整下載中心後續 | P1 | 9B 核心分析完成；匯出中心後續 |
| 管理員備份／稽核／登入日誌 UI | Partial | 後端、隔離還原、audit redaction 已測；UI 目前只顯設定狀態，缺操作台 | P1 | 後續 9B |
| 防抄襲／程式相似度 | Missing | paste/history 是資料基礎，但沒有相似度分析與教師報告 | P2 | 後續 9C |
| 考試模式／切頁限制／停用 AI | Missing | classroom lock 不等同完整考試模式 | P1 | 後續 9C |
| 遊戲化 XP／徽章／連續紀錄／排行榜開關 | Stub | 視覺區存在，但沒有可信的完整計分資料域；頁面不得把靜態數字當真實成績 | P2 | 後續 9C |
| 中英介面與教材欄位 | Partial | 核心新 UI 有繁中／英文；全站文案與所有 server error 尚未完成本地化 | P2 | 後續 9C |
| 40 個瀏覽器分頁 | Missing | 已有 host／HTTP 40-user 負載，不等同 40 真瀏覽器分頁 | P2 | 後續驗收 |
| Runner 強沙箱 | Partial／風險保留 | Docker 無 host port、網絡限制、rlimit、queue；長駐容器仍不是逐 job disposable sandbox | P0（正式公開前） | 架構升級 |

## 3. 驗收條件

1. evil Origin 經實際 Gateway 被 403，same-origin mutation 能轉發；內部 token 不進瀏覽器。
2. 草稿／封存內容用已知 ID 仍不可被學生取得或開始。
3. 功課在發布、截止、逾期、次數、重交、答案／成績／測試公布各時間邊界由伺服器判定；分數與測試結果立即顯示政策可獨立關閉並保存 false。
4. 客戶端送入任意 `allowedPackages` 不可改變 Runner 政策；pip 及未允許第三方拒絕；同一安全策略在 Python 3.9 與 3.12 通過。
5. 管理員與教師只看到其 scope 內帳戶／班別；reset／archive 撤銷 session。
6. 學生能看到所有已加入課程的已發布功課；教師能整班加課、設定政策、批改及 release。
7. 完整測試、TypeScript、lint、build、Compose health/smoke 通過；不清除 live volumes。

## 4. 回退

- Gateway：回退 `gateway/server.mjs` 與 `PUBLIC_ORIGINS` 配置，但不可在沒有替代 CSRF 的情況下對外提供 mutation。
- Domain：本批次沒有 destructive migration；可逐檔回退服務與 UI，現有 SQLite 資料不需轉換。
- Runner：回退 allowed-packages 傳輸前必須同時禁用第三方套件，不能回到「由瀏覽器自行聲稱允許」狀態。
- UI：可停用新面板但保留 server RBAC、scope、policy enforcement。

## 5. 放行結論

Phase 9A、9B 加 Phase 11 支持「內部試教核心流程」的條件式放行；上述 Partial／Missing／Stub 不得在校內文件或畫面中宣稱已完成。正式跨校／公網使用前，Runner 強沙箱、考試／防抄襲、校方 AI／SMTP 配置、依賴審查、獨立 browser UI QA 與 40 瀏覽器驗收仍是必做項。
