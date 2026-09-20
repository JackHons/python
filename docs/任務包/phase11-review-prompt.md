# Phase 11 獨立 Review Prompt

請以 commit `09dd0e1048ee73b3f567c816bd5283ac563f1cc3` 為基線，只讀審查 branch `codex/phase11-role-routing`；不要修改 live database、Docker volumes、`.env`、`.local-secrets` 或使用者 PPT。先讀 `docs/任務包/11-Phase-11-角色路由與教學流程.md` 與 `docs/任務包/證據/phase11-validation.txt`。

請逐項核對並回報 Pass／Fail／Not run：

1. 真正 canonical role route files、URL-driven deep-link refresh、獨立角色 Link/router 導覽、same-origin returnTo；直接刷新 student course/unit/assignment/practice 與 teacher course/material/submissions 必須載入 path 指定資源，快速切換時舊請求不可覆蓋新 route。錯誤角色及 known-ID scope 必須由 API fail closed。特別指出 client/API guard 不等於 SSR first-response 403。
2. API method matrix：逐 endpoint 核對 manifest 與實際 handler；未知 method 405+精確 Allow；method-specific roles 尤其 users/import/files/execution-policy/assignment submissions/submission commands；backup verify 不可命中 list；command 保留 POST body/method；舊 AI alias 及 course/class/unit PUT 有 Deprecation/Sunset/Link，不使用 301/302 mutation redirect；canonical client 必須 PATCH。
3. 教材雙入口、預設 school、owner/admin 編輯與 DELETE、reference/copy、不可變 asset version、latest-only version extension、published pin、顯式 upgrade、被引用檔案刪除 409、bytes lifecycle、draft-before-publish、request-id 與任意 absolute path sanitized unknown-error log。
4. 多 AI provider 唯一 active、顯式 activate、失敗無 fallback、rotate/mask/disable；admin/teacher/student RBAC；student status 不含任何 quota/token/cost/provider/model/key；每次 AI conversation request 需重驗 assignment/question/unit scope，失效狀態 404 且 provider 不呼叫。
5. teacher/manual 或 AI draft hints、AI 必須 approved、最大 3 層、逐層 unlock、refresh persistence、idempotency、100 同 key、40 student isolation，student 不見 quota；已 unlock 的 approved hint 不可改寫，AI draft 不可覆蓋 approved layer，course archive／enrollment revoke 後 404。
6. classroom start/pause/lock/reopen/end、session end、events since、join/heartbeat/poll、匿名 projection、reconnect、ended read-only；lock/ended 時 save/execute/submit 423。特別驗證三個 idempotency recheck 與 event write 同在 `BEGIN IMMEDIATE`，100/40 replay 不重複、不 500；course archive 後 404。學生 snapshot/execute/grade/getRun 亦需重驗 active enrollment、published course 與 assignment scope，退選/封存後 404。
7. migration 0010/0011 在隔離 DB 的 rollback/reapply、foreign_keys/integrity/FK；完整 Node、system Python 3.9、bundled 3.12、Docker runner、typecheck/lint/build、isolated Compose health/smoke。
8. 掃描 student response/client bundle/log，確認 hidden test、API/internal token、AI key、其他學生身份及 storage path 不外洩。

截至 `b4a4dc7` 的最新證據是：完整 Node `97 total（95 pass、0 fail、2 skip；兩個 real-PPT tests 需 reviewer 顯式提供 `PPTX_FIXTURE_PATH`）`；修復後 route/API targeted `34/34`、backend security targeted `31/31`、AI/security worker targeted `18/18`（parent targeted `10/10`）；TypeScript、ESLint、production build、git diff check 均重新通过；最新 b4a4dc7 隔离 Compose 六服务 build `6/6`、healthy、smoke、Gateway origin gate 均通过。system Python 3.9、bundled Python 3.12、Docker Python 3.12 matrix 与 security scan 9/9 属历史证据，本次没有重跑。请逐项自行重跑，不要只采信数字。干净 install 仍报 application 20 项与 converter 1 项依赖风险，必须保留为 review item。

Review 報告必須列：實際改了甚麼、實際跑了甚麼命令／測試與數量、證據路徑、每個未跑項、剩餘風險、未完成事項及建議回退 commit。不得把 fake AI、local SMTP、queued job、host Runner 或 client guard描述成正式供應商、完成轉換、強沙箱或 SSR 403。
