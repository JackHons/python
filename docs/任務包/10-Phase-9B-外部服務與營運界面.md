# Phase 9B：學生學習流程、AI 與教材預覽

日期：2026-08-23（Asia/Macau）  
定位：依校內試教優先次序，把學生登入後的課程／單元／教材／練習流程、教師學習分析及 AI 管理接成真實 API；不是全需求完成聲明。

## 1. 本批次範圍

### 目標

1. 學生首頁以真實課堂、功課及評量資料顯示近期提醒；課程頁可逐層選擇「課程 → 單元 → PPT／教材／練習」，而不是單一長頁或靜態卡片。
2. 練習維持 Phase 9A 的 snapshot、starter code、stdin、公開／隱藏測試、安全 Runner、自動保存及提交契約；AI 提示每次只解鎖下一層並持久記錄成功提示次數。
3. 教師 Dashboard 以 server-scoped analytics 顯示完成率、分數、學習時間、作答次數、AI 提示及常見錯誤，支援課程／班別／學生篩選。
4. 管理員可配置供應商中立的 OpenAI-compatible HTTP 端點、模型、加密 API key、逾時、每日個人／全校限額、提示／答案策略、對話保存開關及保留日數；無配置或停用時 fail closed。
5. 獨立 converter 在 Apple Silicon Docker 以 LibreOffice + Poppler 真實轉換 PPT/PPTX，學生可在單元內查看逐頁投影片並按權限下載原檔。

### 明確停止擴展

本批次不繼續擴展 SMTP 管理介面、完整通知中心、備份／稽核 UI、考試／相似度、遊戲化或 40 個真瀏覽器分頁。此前已安全完成的 SMTP adapter／worker 保留，但只算後端基礎，不能宣稱正式電郵功能已放行。

## 2. 需求—狀態—證據矩陣

| 需求 | 狀態 | 主要證據 | 驗收邊界 |
| --- | --- | --- | --- |
| 真實首頁提醒 | Implemented | `AssignmentService.listAssignments` 依 due_at 升序、null 最後並投影 reminder state；`sortAssignmentsByDue` 聚合跨課程仍保持同序；`StudentHome` 聚合 assignments、assessment 及 classroom sessions | upcoming 不被較遠 deadline 截掉；past/closed 明確標示且不可開始，允許補交的 past due 例外 |
| 課程 → 單元 → 教材／練習 | Implemented | `StudentCourses`、`learningApi.units/materials/assignments`、selected breadcrumb；`tests/phase9b-ui.contract.test.mjs` | 已發布及已選課 scope 由 server 再驗證 |
| Python 練習、自訂 stdin、公開／隱藏結果、autosave／提交 | Implemented（Phase 9A 回歸） | `StudentWorkspace`、`server/execution.ts`、`server/content.ts`、execution/hidden/Phase 9A tests | hidden 只回 pass/fail/score；正式考試強沙箱仍未完成 |
| 三層 AI 提示及持久計數 | Implemented | `server/ai.ts`、`AiService.startConversation/request`、學生提示 UI；真 HTTP 測試驗 levels 1→2→3 及 reused conversation count | 第 1 層概念、第 2 層語法／除錯、第 3 層偽碼／局部例子；是否給完整答案仍服從管理政策 |
| AI provider factory／OpenAI-compatible HTTP | Implemented | `OpenAICompatibleProvider`、`ConfiguredAiProvider`；`tests/phase9b-ai-http.integration.test.mjs` 以本地 fake HTTP server 證明真網絡請求 | 沒有校方 provider/key 時 503；測試 fake 不等於正式 vendor |
| AI 金鑰、限額、保存及 review | Implemented | authenticated encryption、masked provider DTO、atomic quota、既有 review state machine；`AdminAiCentre`／`TeacherAiReviewQueue` | key 不進前端／log；未批准 artifact 不向學生發布 |
| 教師分析及篩選 | Implemented | `TeacherAnalyticsDashboard`；overview/question accuracy/common errors/AI/code history/learning time API；analytics scope regression | 老師只可查自己課程／班別學生；某些原始事件缺失時顯示資料缺口，不偽造 |
| 真實 PPT 轉換 | Implemented（內部 Docker） | `server/conversion/service.ts`、`services/converter/**`、Compose converter、真實 fixture test | 無外網、temp 隔離、timeout/page/output limit；LibreOffice layout fidelity 仍需教師目視抽查 |
| 學生 PPT viewer | Implemented | scoped manifest/PDF/slide routes、`MaterialPreview` polling/prev-next/page count | 只有 succeeded job 顯示；queued/running/failed 誠實顯示，不提供假 preview |
| SMTP adapter／worker | Partial（保留既有安全切片） | `server/notifications/smtp.ts`、notification worker、本地 fake SMTP test | 未完成校方 SMTP 設定／browser QA，本批次不再擴展 |
| 即時課堂完整操作 UI | Partial | 後端 session/activity 已有；首頁能讀真課堂提醒，完整教師控制台仍未接完 | 後續批次 |
| 通知／公告完整 UI | Partial | 後端 recipient snapshot／站內通知已有；本批次不擴展 | 後續批次 |
| 備份／audit 操作 UI | Partial | 後端及隔離 restore 已有，本批次不擴展 | 後續批次 |
| 考試模式／相似度／遊戲化 | Missing／Stub | Phase 9 gap matrix | 後續批次，不得用現有視覺占位宣稱完成 |
| 40 真瀏覽器／逐作業強沙箱 | Missing／Partial | 只有既有 HTTP/container load 與長駐 Runner 限制 | 正式考試或公網前必做 |

## 3. 安全與資料邊界

- AI provider 設定由伺服器從加密資料建立 adapter；API key 只回 mask。provider timeout、429、5xx 均映射為安全錯誤，quota 會 settle 或 rollback，provider response body 不進一般錯誤。
- 分層提示使用原有對話 scope，重新載入仍從成功的 `ai_usage` 計數；學生不能藉 request body 指定其他人的 conversation。
- Analytics 以課程／班別 scope SQL 起步，新增學生 filter 仍需教師與學生存在共同有效 scope，禁止全校取回後由前端過濾。
- 轉換 worker 沒有外部網絡或 host port；輸入、輸出與 temp 路徑均在受控 storage 內。preview route 不暴露 storage key，下載仍驗 enrollment、發布狀態及 `allowDownload`。
- 本批次不降低 Phase 9A 的 Gateway CSRF、RBAC、hidden test、snapshot/run、套件 allowlist 或 Runner 限制。
- Python 3.9 stdlib fallback 不只排除 sysconfig 的 purelib/platlib；任何解析後路徑含獨立 `site-packages`／`dist-packages` component 均視為第三方。builtin/frozen／真正 stdlib 仍可用，NumPy／Pandas／Matplotlib 仍只在 server policy 明確允許時通過。

## 4. 驗收方式

主要命令與精確結果見 `docs/任務包/證據/phase9b-validation.txt`。獨立 reviewer 至少重跑：

```sh
pnpm run test:all
pnpm exec tsc --noEmit
pnpm run lint
pnpm run build
/usr/bin/python3 -m unittest services.runner.tests.test_runner
docker compose config --quiet
docker compose build converter
docker compose up -d backend converter web gateway
sh scripts/smoke-test-compose.sh
docker compose ps
```

AI 必須使用本地 fake HTTP server，證明 request 確實離開 backend adapter，但不可使用真 key。PPT 必須只讀使用指定 fixture，驗證 source SHA 未變、pageCount > 0、PDF/PNG 可開啟、學生 scope 與 outsider 拒絕。功課排序 fixture 必須以相反建立次序覆蓋 near/far/null/past/closed；Runner 的同一 13 項矩陣必須在 macOS Python 3.9、bundled 3.12 及 Docker 3.12 通過。UI 本批次只做 typed contract／rendered 測試，未做 browser QA，不能把它寫成三 viewport browser pass。

## 5. 回退與剩餘風險

- 可停用 AI policy 或 provider；沒有 provider 時學生得到明確未配置狀態，不回退到 fake provider。
- 可停止 converter；queued job 保留，原 PPT 不受影響。不可把 queued 改寫為 completed。migration 只新增 provider path/timeout 與 conversion page count，沒有 destructive migration。
- Compose 回退只重建相關 image／service，不刪 volumes；禁止 `down -v`。
- 剩餘 P0/P1 風險：長駐 Runner 不是逐作業強沙箱、正式 AI vendor 與資料處理協議未驗、完整即時課堂／通知營運 UI 未完成、依賴漏洞未逐項修復。40 真瀏覽器、考試／相似度及遊戲化仍未驗收。

## 6. 放行結論

Phase 9B 支持 macOS ARM64 Docker 的校內功能試教：學生可走完整課程／單元／教材／練習路徑，教師可查看真實學習分析，AI 可在管理員配置後使用且未配置時安全停用，PPT 可真實轉換並受權限播放。它不等於正式考試、公網、真 AI／SMTP 供應商或全需求放行。
