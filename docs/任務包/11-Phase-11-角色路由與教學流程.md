# Phase 11：角色路由與教學流程

日期：2026-08-24（Asia/Macau）
基線：`09dd0e1048ee73b3f567c816bd5283ac563f1cc3`
實作分支：`codex/phase11-role-routing`

## 1. 目標與邊界

本階段把 Phase 9B 的單頁工作區拆成可直接連結及重新整理的角色路由，並收斂教材版本、AI 設定／逐層提示及即時課堂的真實 API 閉環。所有 known-ID 存取、提示解鎖、課堂鎖定及教材下載仍由 backend RBAC 判斷，前端導覽不作授權依據。

非目標：公網部署、40 個真瀏覽器分頁、校方正式 AI／SMTP 憑證、考試模式／相似度、遊戲化，以及逐作業即棄的強沙箱。本階段沒有修改 live database、Docker volumes、`.env`、`.local-secrets` 或使用者原始 PPT。

## 2. 角色頁面矩陣

| 角色 | Canonical 頁面 | 狀態／授權 |
| --- | --- | --- |
| 學生 | `/student/dashboard`、`/student/courses`、`/student/courses/:courseId`、`/student/courses/:courseId/units/:unitId`、`/student/courses/:courseId/assignments/:assignmentId`、`/student/practice/:submissionId` | 已登入 student；course／unit／assignment／submission 仍經 enrollment 與 published scope |
| 學生即時課堂 | `/student/classrooms`、`/student/classrooms/:sessionId` | 加入、heartbeat、事件／狀態恢復；結束後唯讀；活動 locked 時保存及提交 423 |
| 教師 | `/teacher/dashboard`、`/teacher/courses`、`/teacher/courses/:courseId`、`/teacher/courses/:courseId/units/:unitId/materials`、`/teacher/classes`、`/teacher/classes/:classId`、`/teacher/assignments/:assignmentId/submissions` | 只限 owner 或有效 class scope；known-ID 越權統一 404 |
| 教師 AI／課堂 | `/teacher/analytics`、`/teacher/analytics/ai`、`/teacher/ai-review`、`/teacher/classrooms`、`/teacher/classrooms/:sessionId` | 教師只看其課程用量／提示及待審內容；不可讀 provider key；課堂控制全在 server 狀態機 |
| 管理員 | `/admin/dashboard`、`/admin/users`、`/admin/classes`、`/admin/courses`、`/admin/settings`、`/admin/settings/ai`、`/admin/backups`、`/admin/audit` | admin session；AI provider/key、全校政策、備份與 audit 不向教師／學生投影 |
| 相容入口 | `/dashboard`、`/courses`、`/classroom` | 保留原 method/body，按已登入角色轉至 canonical；不作跨角色提升 |

目前 Vinext route shell 使用 client session probe 與 API RBAC。未登入頁面會引導至 `/?returnTo=<same-origin-relative>`；錯誤角色在 client guard 顯示 403。這不等於 SSR 在第一個 HTML response 已回 HTTP 403，故本階段只聲明「client/API guard」，不聲明完整 SSR HTTP status guard。canonical 導覽以 `Link`／router 改變網址；URL path 是 course／unit／assignment／submission 選擇的 source of truth。每次 path 改變都會重新從 API hydrate，並以 request generation/cancel guard 防止舊請求覆蓋新頁面。

## 3. API method 與相容契約

- 頁面只用 `GET`；資料 API 固定在 `/api/v1/**`。
- 一般資源使用 `GET`／`POST`／`PATCH`／`DELETE`；join、submit、release、conversion、transition、unlock 等命令使用 `POST`。
- 已知 API 路徑在進入 education adapter 或其他 handler 前先檢查 method；錯誤 method 回 `405` 及精確 `Allow`，不以 301/302 轉送 mutation。manifest 以 method-specific roles 記錄混合資源（例如 assignment submissions 的 GET=staff、POST=student），相同 path 的多項契約會按最高 specificity 合併，不會被泛化 `:id` route 吞掉。
- `GET /courses/:id` 是真 scope read；student projection 不含 join code／owner。舊 course／class／unit `PUT` 仍按原 method/body 執行，但 response 帶 `Deprecation`／`Sunset`／successor `Link`；新 client 只發 `PATCH`。
- 舊 `/admin/ai-provider`（POST）及 `/admin/ai-settings`（PATCH）只作相容 alias，response 帶 `Deprecation: true`、`Sunset`、`Link: rel="successor-version"`；新 client 只用 `/admin/ai/providers` 與 `/admin/ai/settings`。
- mutation 經 Gateway same-origin Origin 檢查；browser 不會取得 backend internal token。

自動化 method/role contract 來源為 `server/http/route-manifest.ts`；table-driven 測試逐一對每個 example 發送一個已允許 method（必須越過 405 gate）和 OPTIONS 負向（必須得到精確 Allow），並特別覆蓋 backup verify 不可誤命中 list。HTTP 負向證據見 `tests/phase11-routing-security.integration.test.mjs`、`tests/phase11-ai-http.integration.test.mjs` 及 `tests/phase11-classroom.integration.test.mjs`。

## 4. 教材可靠性

- 教材庫與課程單元內直接上傳都先 quarantine、真 signature 驗證及 release，預設 `school` 共享。
- bytes 以不可變 asset version 保存；已發布 material pin 目前版本。owner 上傳新版本不會改變其他課程，引用教師需顯式 upgrade。
- 原 asset 只有 owner/admin 可編輯；其他教師可 reference／copy 全校 asset。reference 重用 bytes；copy 有獨立 material 綁定語義，不會把別人的 private asset 暴露。
- owner/admin 可刪除未被引用的 asset；被 material、submission、conversion 或後續 version 引用時回 409。刪除先作 logical deleted，再只移除受控 storage key 的 bytes；失敗會恢復原狀態。新版只能由目前 latest version 延伸，舊版不能建立分支。
- 課程內直接上傳只建立 draft，不會自動發布；PPT conversion 仍以真 job 狀態顯示。未知 backend error 會回安全 code 與 `x-request-id`，server log 只記脫敏 stage／request metadata。

Migration `0010` 提供版本 backfill；材料 scope、EACCES、未知 DB/runtime error 與 request-id 測試在 Phase 11 targeted suite。

## 5. AI 與逐層提示

- 管理員可保存多個 OpenAI-compatible provider；同時最多一個 active。切換必須顯式 activate，失敗不自動 fallback；key 只加密保存及 mask 顯示。
- `/admin/settings/ai` 管理 provider、base URL/path/model/timeout、全校／學生限額、提示策略、對話保存與保留期。教師 `/teacher/analytics/ai` 只看其 scope，用 `/teacher/ai-review` 審內容，不可讀／改 key。
- 學生 AI status 只含 `enabled`、`hintLevel`、`maxHintLevel`，不含 quota、token、cost、provider、model 或 key。
- 教師可建立手寫提示，或把 AI 生成結果存為 draft；AI 提示必須 approved 才可解鎖。全校最大 3 層，題目可少於 3 層。
- 每次學生 command 只解鎖下一層；student／submission／question／level 及 idempotency 在 SQLite 持久化。100 次同 key 不重複，40 個學生彼此隔離。
- approved hint 一旦被學生解鎖即不可變；AI draft 不能覆蓋 approved layer。學生每次讀取提示、提交或 AI 對話都重新驗證 active enrollment、published course 及 assignment scope；退選或封存後回 404。

## 6. 即時課堂

- 教師可建立課堂與活動，依 server 狀態機 start／pause／lock／reopen（UI 顯示「解除鎖定」）／end，並結束整個 session。
- 學生已入課才可 join；heartbeat 與 `events?since=` 支援重連／重新整理後恢復。學生事件 projection 不含 user ID、姓名或 ownership mapping。
- 教師看到 scope 內 participant presence、完成率及匿名答案；學生只看自己的狀態與匿名聚合。
- 活動 locked 時 begin/save/execute/submit 的 server guard 回 423；session ended 後活動、heartbeat 寫入及學生答案寫入均唯讀，已保存事件可重播。
- 活動建立、狀態 transition 與 session end 的 idempotency recheck 均在同一 `BEGIN IMMEDIATE` transaction 內完成；100／40 次 replay 只保留一個 event。課程封存後，即使已 join 或已 ended，教學 route 仍統一 404。

## 7. 驗收條件

1. canonical route files、URL-driven deep-link hydration、role sidebar 及相容入口契約通過；student course/unit/assignment/practice 與 teacher course/material/submissions 可直接刷新；跨角色／跨課／archived known-ID 統一 404，錯誤角色仍為 403。
2. 0011 migration 可在 transaction rollback 後重新 upgrade，`foreign_keys=1`、`integrity_check=ok`、`foreign_key_check` 為空。
3. 多 provider／唯一 active、無 fallback、mask、disable、student-safe DTO 及三角色 RBAC 通過。
4. hints 審核、逐層、刷新持久、idempotency、100 同 key 及 40 student 隔離通過。
5. classroom end/events、join/heartbeat/poll、lock 423、ended read-only、匿名 projection 及 scoped teacher 通過。
6. 完整 Node、三個 Python runtime Runner、typecheck、lint、build、Drizzle、隔離 migration、Docker sequential health/smoke 均需有證據；未跑項不得標示通過。

## 8. 回退

- 本 branch 不 merge 即不影響 Phase 9B baseline。每個切片有獨立 commit，可由主 agent 逐一 cherry-pick 或拒絕。
- Migration 0010/0011 均為非破壞新增。部署前先備份；回退程式時不要刪 column/table 或 live volume。
- 不得為回退 UI 而移除 backend known-ID scope、hidden projection、CSRF、Runner allowlist、hint approval 或 classroom lock guard。

## 9. 保留風險

- Vinext 尚未證明 SSR 第一個 response 的 401/403；API RBAC 為最終防線。
- 本階段不作 browser 視覺 QA；responsive/a11y 只由 CSS／rendered contract 驗證。
- 正式 AI vendor、SMTP owner、PPT 教師版面抽查、40 browser tabs、強沙箱、exam/similarity/gamification 仍未放行。
