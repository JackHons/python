# Phase 8 具體 Review Prompt

你是最終 reviewer。請只根據下列變更與證據判斷；Docker/Colima 內部測試已有實證，但不要把未執行的外部服務或強沙箱測試推定為通過。

## 本次改了甚麼

1. 把 Compose 補成 `gateway`、`web`、`backend`、`runner` 四服務；gateway 是唯一 host 3000 入口，`/api/v1/**` 只轉 backend 並在私有 hop 注入 server-only token，其他路由轉 web。backend health/readiness、SQLite/storage/export/backup volumes、required secrets、resource/security options、runner internal network 已加入，並在 macOS ARM64 Colima 實際建置啟動。
2. backend 啟動建立檔案根目錄並回報 integrity/FK；production web 預設拒絕 legacy `/api/run`。
3. 新增 gateway Node proxy、`scripts/phase8-host-load.mjs`、`scripts/phase8-runner-host-smoke.py`、init/seed/backup/restore/log wrappers；修正 analytics route 讀取 scope query，移除 host-load lint 問題。
4. 修復 Node/undici web proxy streamed POST 的 `duplex: half` 問題；同步 package-lock；更新 README、`docs/本地部署.md`、Phase 8 證據及放行報告；保留單一 `package-lock.json`。
5. 新增 production-safe local Docker `admin-local` provision/rotate CLI；隨機初始密碼只寫入 0600 `.local-secrets/admin.json`，並封存/撤銷 Phase 8 load fixture 帳戶；load script 改用隨機密碼並在 finally cleanup。
6. UI 收尾接通 `TeacherWorkspace` 的真實課程→單元→教材→題目→功課工作流（列表、建立、編輯、安全封存，七種題型及 code 題 public/hidden metadata）；assignment 題目可多選、移除、排序及計算總分。學生課程代碼加入及 submission snapshot→逐題保存→execute/grade→submit 練習流程已接通；Practice 支援 stdin、非程式題控件、file/project quarantine-release reference、public 詳情及 hidden status-only，不再顯示假測試／假 AI 結果。

## 實際跑了甚麼

- Node 22 bundled runtime 的全回歸：50 passed, 0 failed（原 P1–P7/rendered/proxy 加新增 assignment、execution、UI contract 覆蓋）。
- `package.json` 的 `test:all` 以 bundled pnpm 執行成功；本機沒有 npm，未執行 clean `npm ci`。
- TypeScript noEmit、ESLint、vinext build、rendered HTML：均 passed，rendered 4/4（含 production legacy route disabled）。
- Host HTTP 40-user：course/material reads 40/40、grade 40/40、submit 40/40、analytics 200、hidden canary 0、FK=1、integrity=ok、40 distinct run students；p50 19.06 ms、p95 877.62 ms、max 1248.59 ms。
- Host Runner：unauthorized、health、network/subprocess/pip AST policy、timeout、output limit 均 passed；本次 40 concurrent 產生 18 個 200、22 個 bounded 429；queue 分布受排程影響，非固定契約。
- Ruby YAML static Compose check：gateway/web/backend/runner 存在、gateway 唯一 host port、runner 無 host port；只屬靜態檢查。
- Runtime setup：Homebrew user-level Docker/Colima 已安裝並使用；setup 與 image/platform 證據見 `docs/任務包/證據/phase8b-runtime-setup.txt`。
- Seed credential smoke：一次性 0600 憑證檔、覆寫拒絕、production 禁用均通過。
- `tsc --noEmit`、ESLint、vinext build、`sh -n scripts/*.sh`、Ruby Compose YAML 靜態檢查、`git diff --check` 均通過。
- Homebrew user-level Colima 0.10.3、Docker client 29.7.2/server 29.5.2、Compose 5.5.0、buildx 0.36.1；Colima aarch64 4 CPU/4 GiB/50 GiB。
- `docker compose config --quiet`、sequential ARM64 `build --pull`（gateway/web/backend/runner）、`up -d` 及四服務 health 均 passed；首次 build 的 lockfile drift 已以 Node 22 container `npm install --package-lock-only` 修正，後續 image `npm ci` passed。
- `scripts/smoke-test-compose.sh` passed gateway health、web、backend `/ready`、未登入 `/api/v1/me` 401、production legacy `/api/run` 404、Runner package execution。
- 實際 role smoke：admin dashboard、teacher workspace、student learning dashboard 均登入後呈現；證據 `docs/任務包/證據/phase8b-ui-wiring.json`。測試 fixture 已封存，沒有憑證寫入證據。
- 學生 Courses/Resources 導航已接通 `courses`、`units`、`materials` 真實 API；無課程、無教材空狀態及中英雙語文案已由瀏覽器驗證，app 內沒有「下一階段／next phase／coming soon／待接入」提示。
- 教師教材中心現有兩個真實 API 區域：教材庫上傳/drag-drop/progress/scope/download，以及 course/unit/asset 選用、雙語 metadata、allowDownload、draft/publish、queued conversion。指定 PPTX 實測 2,572,119 bytes，SHA-256 `1d9ef8a46d0672c59eca58b44d9cd3b54dd3e9a0cf34f8e98d686e8817805384`；同 owner 重傳與兩課程 reuse 後 file asset 仍一份。學生只見 published/ready，原檔下載按 enrollment/allowDownload；證據在 `docs/任務包/證據/material-library-validation.txt`。
- Conversion status endpoint 已依真實 schema 修正為 `created_at/started_at/finished_at/output_asset_id`；HTTP regression 驗證 queued job GET 200，output/start/finish 為 null，沒有不存在的 `updated_at/completed_at`，亦未宣稱 preview 或 conversion 完成。
- 本次 UI source/rendered contract 已驗證 `TeacherWorkspace`、Content Editor、`joinCourse`、`beginSubmission`、逐題保存、stdin、`grade`、`submit`、多題型控件及 public/hidden projection；targeted integration 9/9，包含提交前移除中間題後 positions 連續、重排可重試、提交後依賴 409 且無部分寫入；`pnpm test` rendered 4/4，`pnpm run test:all` 50/50；40 個瀏覽器分頁負載仍未執行。
- Fresh UI／試用帳戶驗證：`/_next/static/css/*.css` 由全新首頁請求回 200；登入頁採 teal/navy 雙欄品牌布局，360／768／1440 viewport 均無水平溢出，login card max-width=480px；`student-demo` API login/course/assignment/submission smoke 通過，hidden case 只保留安全 projection。截圖及脫敏數字見 `docs/任務包/證據/student-demo-ui-evidence.txt` 及同目錄 `ui-login-*.png`。
- 高優先功能摘要已同步為 API 49 pass／1 fail、UI 6 pass／1 not implemented；C teacher workspace 與 D student join/practice 為 PASS，F 40 瀏覽器分頁仍為 NOT_IMPLEMENTED，E CSRF 仍為 P1 FAIL。詳見 `docs/任務包/證據/functional-test-summary.json` 的 `uiMvp`。
- 真實 host→web→backend→runner container 40-user load：40/40 course/material reads、40/40 grade、40/40 submit、hidden canary 0；p50 38.78 ms、p95 475.79 ms、max 1509.97 ms。這是本次樣本，queue/429 分布非固定。
- `docker compose restart` 後 login/course read passed；full backup manifest/database checksum verify passed；isolated restore foreign_keys=1、integrity=ok；container Runner network/subprocess/pip block、timeout/output-limit/canary fixture passed。
- local admin security cleanup：43/43 fixture accounts archived、admin-local active + must-change、old fixed fixture passwords all 401、secret file 0600 and gitignored；no password in stdout/evidence.

## 證據位置

- `docs/任務包/證據/phase8-tests.txt`
- `docs/任務包/證據/phase8-host-load.json`
- `docs/任務包/證據/phase8-runner-host.json`
- `docs/任務包/證據/phase8-compose-static.txt`
- `docs/任務包/證據/phase8-runtime-probe.txt`
- `docs/任務包/證據/phase8-security-scan.txt`
- `docs/任務包/證據/phase8-dependency-audit.txt`
- `docs/任務包/證據/phase8-seed-smoke.txt`
- `docs/任務包/證據/phase8b-runtime-setup.txt`
- `docs/任務包/證據/phase8b-compose-load.json`
- `docs/任務包/證據/phase8b-persistence.json`
- `docs/任務包/證據/phase8b-backup.json`
- `docs/任務包/證據/phase8b-restore.json`
- `docs/任務包/證據/phase8b-runner-security.json`
- `docs/任務包/證據/phase8b-account-cleanup.json`
- `docs/任務包/證據/phase8b-ui-wiring.json`
- `docs/任務包/證據/functional-test-summary.json`
- `docs/任務包/Phase-8-放行報告.md`

## 必須保持的未跑項

不要標記以下項目通過：每作業即棄強沙箱、完整 cgroup/egress/UID 安全證明、真 AI provider、真 SMTP、PPT conversion、繁中 PDF 字型、長時資源圖與網絡 CVE audit。Docker config/build/up/health、volume persistence、container path Runner smoke 已實跑，但只代表本機內部測試範圍。

## 風險與回退

- P0：本地 ARM64 Compose gate 已通過；正式公開/考試仍不放行。
- P1：長駐 Runner 非強安全沙箱；外部 AI/SMTP/PPT/PDF production integration 未驗證。
- P2：單次容器負載不足以代表正式 SLO；依賴 20 audit findings 未作 CVE 結論；外部整合仍未驗證。
- gateway 解決的是 Vinext runtime env 注入問題，不等同完整反向代理產品；正式部署仍需驗證 header、超大串流上傳與長連線 SLO。
- 安全運維：`.local-secrets/admin.json` 是本機唯一初始憑證交付位置；遺失時使用明確 `--rotate`，不要把密碼放入 shell history、log 或 repo。
- 負載隔離：本次使用現有 Compose project 但以 `container-*` 帳戶 namespace 加 cleanup 降低影響；正式長期負載應使用獨立 Compose project/volume。
- 回退：停 backend/runner 或 `docker compose down`；保留 volumes，先驗證 backup，禁止用 `down -v` 當一般回退。

請輸出：改動是否符合需求、每條證據是否可重現、哪些 gate 阻塞、P0/P1/P2 風險、以及「macOS ARM64 Docker 內部測試有條件放行／正式考試與公開服務不放行」的明確決定。
