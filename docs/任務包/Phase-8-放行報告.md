# Phase 8 放行報告（2026-08-20，Asia/Macau）

## 結論

有條件放行「macOS ARM64（Colima）Docker Compose 內部測試」；不放行正式考試、公開服務或強安全不可信程式執行。Docker/Colima 已在本機實際建置並啟動 gateway、web、backend、runner，完成健康、代理、40 人負載、重啟持久化及 backup/isolated restore 閘門；Runner 長駐容器仍不是最終強沙箱，外部 AI/SMTP/PPT/PDF 仍未接通。

## Phase 8 交付

- Compose 已整理為 `gateway`／`web`／`backend`／`runner`：gateway 是唯一對外 3000 入口，將 `/api/v1/**` 轉 backend 並只在私有 hop 注入 internal token，其他路由轉 web；web/backend/runner 不直接對外 publish。backend 擁有 SQLite、storage、exports、backups volumes；runner 沒有 host port；容器設定含 read-only、tmpfs、no-new-privileges、cap drop、PID/CPU/memory 限制及 healthcheck。
- backend startup 會建立 storage/export/backup roots，`/health`／`/ready` 檢查 SQLite integrity、foreign keys 及 storage 設定。
- production web 預設關閉 legacy `/api/run`；正式評分路徑是已認證的 submission-answer route。
- 新增 gateway Node proxy（避免 Vinext build-time env replacement 導致 API 503）、host 40-user HTTP load、host Runner malicious/40-concurrent、Compose static YAML、runtime probe、redacted-log、seed/init/backup/restore wrapper scripts，以及 Compose 40-user/Runner container evidence；seed 憑證以指定檔案一次性 0600 寫出，Compose smoke 契約包含 gateway health、backend readiness、未登入 API 401 與 production legacy route 404。
- README 與 [本地部署](../本地部署.md) 已更新為 Docker 內部測試放行、volume 回退及未完成外部整合邊界。
- 新增本地 Docker `admin-local` provision/rotate CLI；隨機初始憑證只寫入 `.local-secrets/admin.json`（0600），Phase 8 load fixture 帳戶已封存並撤銷 sessions，資料及 volumes 保留。

## 已跑測試與證據

| 範圍 | 結果 | 證據 |
|---|---|---|
| 全回歸（P1–P7 + rendered HTML + gateway proxy + UI/assignment/execution additions） | 50 passed, 0 failed | `docs/任務包/證據/phase8-tests.txt`、`phase8b-ui-wiring.json`、`functional-test-summary.json` |
| `test:all` reproducible command | bundled pnpm run passed 47/47；本機沒有 npm，未跑 clean `npm ci` | `package.json`, `docs/任務包/證據/phase8-tests.txt` |
| TypeScript | passed | command output in phase run log |
| ESLint | passed | phase run log |
| vinext build | passed | phase run log；rendered HTML 4/4 |
| Host HTTP 40 users | course/material reads 40/40、grade 40/40、submit 40/40、analytics 200、hidden canary 0、FK=1、integrity=ok、40 distinct runs | `docs/任務包/證據/phase8-host-load.json` |
| Host Runner | policy/timeout/output/unauthorized/health all true；本次 40 concurrent = 18×200 + 22×429；queue 分布非固定 | `docs/任務包/證據/phase8-runner-host.json` |
| Compose static | services gateway/web/backend/runner、gateway 唯一 host port、runner 無 host port | `docs/任務包/證據/phase8-compose-static.txt`、`phase8b-ui-wiring.json` |
| Runtime probe/setup | 初始探測無 runtime；其後已用 Homebrew Colima/Docker ARM64 實跑 | `phase8-runtime-probe.txt`、`phase8b-runtime-setup.txt` |
| Secret/canary static scan | 無 canary in app/public/worker/dist；server-only token names remain in worker server code by design；無 actual secret values提交 | `docs/任務包/證據/phase8-security-scan.txt` |
| Lockfile/dependency review | package-lock v3 only；649 entries supply-chain check；2 deprecated transitive deps noted；無 CVE 結論 | `docs/任務包/證據/phase8-dependency-audit.txt` |
| Seed credential smoke | 一次性檔案 0600、覆寫拒絕、production 禁用 | `docs/任務包/證據/phase8-seed-smoke.txt` |
| M1 Docker runtime/build | Colima ARM64、三 image linux/arm64；Compose config/build/up/health passed | `docs/任務包/證據/phase8b-runtime-setup.txt` |
| Compose smoke | gateway health、web、backend `/ready`、未登入 `/api/v1/me` 401、legacy `/api/run` 404、container Runner passed | `scripts/smoke-test-compose.sh`、`phase8b-ui-wiring.json` |
| Real container load | web→backend→runner；40/40 grade+submit、hidden canary 0；p50 38.78 ms、p95 475.79 ms、max 1509.97 ms | `docs/任務包/證據/phase8b-compose-load.json` |
| Restart/persistence | restart 後 login/course read passed（1 course retained） | `docs/任務包/證據/phase8b-persistence.json` |
| Backup/restore | full backup checksum verified；isolated restore FK=1/integrity=ok | `phase8b-backup.json`、`phase8b-restore.json` |
| Container Runner security | network/subprocess/pip blocked、timeout/output limit、canary scan passed | `phase8b-runner-security.json` |
| Account security cleanup | 43 個 load fixture 全部 archived；admin-local active + must-change；舊固定密碼 401；credential file 0600/gitignored | `phase8b-account-cleanup.json` |

Host HTTP latency（測試機、fake runner、SQLite，不是 M1 Docker SLO）：目前證據 p50 19.06 ms、p95 877.62 ms、max 1248.59 ms。p95 受 40 個 SQLite grade/submit 同時請求影響，正式環境須在 Docker/M1 再測並設定可接受 SLO。

## 未完成與風險

- **P0：無**（就本地 ARM64 Compose 內部測試範圍）。不得把此結論擴大為公開或正式考試放行。
- `npm ci` 在 Node 22 build container 中已實跑並修正 lockfile drift；本機仍沒有 npm，故沒有做 host-side clean npm install。依賴 audit 曾報 20 findings（1 low、4 moderate、15 high），未作 CVE 結論。
- **P1**：長駐 Runner 不是每作業即棄強沙箱；AST policy 不能取代 gVisor/Kata/microVM、egress deny 和完整 process/cgroup 回收。未完成前禁止正式考試／公開服務。
- **P1**：真 AI vendor、真 SMTP、實際 PPT 轉網頁及繁體中文 PDF 字型仍需外部配置／資產；本地 fake/provider-neutral contract 不等同 production integration。
- **P2**：未完成容器 CPU/memory 長時資源圖、依賴網絡 CVE audit、真 AI vendor、真 SMTP、實際 PPT 轉網頁、繁中 PDF 字型；`xlsx` 只完成 lockfile/本地測試審查。
- 40 人容器負載是單次本機樣本，p95 不代表正式 SLO；需按校內容量與課堂模式再壓測。
- gateway 解決的是 Vinext runtime env 注入問題，不等同完整反向代理產品；正式部署仍需驗證 header、超大串流上傳與長連線 SLO。
- Phase 8 load script 已改用隨機每次密碼，finally 透過 local admin rotate CLI 封存 fixture 並恢復 `admin-local` 首次改密碼狀態；不再保存固定測試密碼。
- 本次 load 使用現有 Compose project，但所有帳戶均有明確 `container-*` namespace，收尾只封存 fixture 並撤銷 sessions，不刪除正常資料或 volumes；正式長期負載應另用 Compose project/volume。
- UI 接線實測：admin、teacher、student 登入後均呈現 role dashboard；暫時 UI fixture 已封存並撤銷 session，`admin-local` 已恢復首次登入必改密碼狀態。細節見 `phase8b-ui-wiring.json`。
- 學生「課程」及「資源」導航已接通真實 courses/units/materials API；無課程或無教材時顯示中英雙語空狀態，未保留下一階段提示。
- 本次 UI 收尾已接通 Teacher Workspace（課程→單元→教材→題目→功課的真實列表、建立、狀態發布，七種題型及 code 題 public/hidden metadata）、學生課程代碼加入，以及 submission snapshot→保存→execute/grade→submit 練習流程；前端不再預填示範題或假測試結果。Rendered/source contract 與 47/47 回歸通過；40 人瀏覽器分頁負載仍未宣稱完成。
- 教材庫閉環新增非破壞 `0007` migration（purpose/private-school scope）、真實 signature/OOXML 驗證、同 owner SHA 去重、跨課程 asset reuse、安全學生原檔下載與 queued conversion 狀態。指定 2,572,119-byte PPTX 的 SHA-256 已實測吻合；兩課程/兩學生下載一致且 `file_assets` 仍一筆。全回歸目前 55/55，容器重建、DB migration/integrity、gateway/backend/runner smoke 均通過；詳見 `docs/任務包/證據/material-library-validation.txt`。
- 高優先功能摘要與本報告一致：API 49 pass／1 fail；UI 6 pass／1 not implemented。C teacher workspace、D student join/practice 為 PASS；F 40 瀏覽器分頁維持 NOT_IMPLEMENTED；E CSRF 維持 P1 FAIL。詳見 `docs/任務包/證據/functional-test-summary.json`。
- 本輪產品實作已標記 `IMPLEMENTATION_COMPLETE_PENDING_INDEPENDENT_TEST_SUBAGENT_PASS`：Teacher Content Editor 支援更新／安全封存及 assignment 題目多選排序移除；Practice 支援多題、多題型、stdin、upload asset reference 及 public/hidden 詳情。Assignment remove/reorder 已以暫存 position 修復 SQLite unique collision，targeted integration 9/9 覆蓋提交前中間題移除、可重試重排及提交後 409 原子性；全回歸 50/50；獨立隔離 Compose E2E、三 viewport 及 40 瀏覽器分頁仍是最終測試 subagent gate。
- 內部試用收尾：首頁 fresh request 的 hashed CSS 回 200；登入頁已改為參考圖 3 的 teal/navy 雙欄品牌版面，並補齊 teacher workspace、join course、practice navigation、editor、error、loading 及 mobile responsive selectors。`student-demo` provision CLI 只在 `.local-secrets/student-demo.json` 以 0600 保存隨機密碼，示範課程及公開／隱藏案例 smoke 通過；證據見 `docs/任務包/證據/student-demo-ui-evidence.txt`。

## 回退／停止

停止 host backend/runner 程序即可回到無服務狀態；Compose 環境使用 `docker compose down`，預設不移除 volumes。不要以 `down -v` 回退，除非已保存並驗證 backup。若 smoke、持久化或安全總測失敗，保留現行 volumes/host fixture，停止內部試用，修正後重新跑 P8 gate。
