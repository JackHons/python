# 智學 Python

聖若瑟教區中學第五校校內 Python 教學平台，面向初三及高中課堂。現有核心包括中英介面、帳戶/RBAC、班別與課程、教材與題庫、作業提交、固定 snapshot 評分、受限 Python Runner、AI 審核契約、即時課堂、分析匯出、稽核與備份服務。

目前 Phase 11 branch 已把 Phase 9B 工作區拆成學生／教師／管理員 canonical 深層路由，並完成教材不可變版本、多 AI provider／逐層提示及即時課堂的 server-backed 流程。Phase 11 已在隔離 Compose project 順序重建六服務並通過 health/smoke；完整證據及依賴風險見本階段 validation 文件。AI 沒有配置時安全停用；正式考試與公開服務仍須完成每作業即棄強沙箱、校方 AI/SMTP 供應商、依賴與運維 owner 驗收。

## 文件

- [完整需求規格書](docs/需求規格書.md)
- [網站及技術架構](docs/網站架構.md)
- [資料模型與權限](docs/資料模型.md)
- [本地部署](docs/本地部署.md)
- [Phase 8 放行報告](docs/任務包/Phase-8-放行報告.md)
- [Phase 11 角色路由與教學流程](docs/任務包/11-Phase-11-角色路由與教學流程.md)

## Docker Compose（macOS ARM64 內部測試已驗證）

Compose 定義 `gateway`、`web`、`backend`、`runner`、`converter` 及背景電郵 worker。gateway 對外提供 3000，將 `/api/v1/**` 轉發至 backend 並在私有 hop 注入 server-only token，其他路由轉發至 web；web 不 publish host port。Runner 與 converter 沒有 host port；backend 持有 SQLite、storage、exports、backups volumes。正式環境必須先設定至少 24 字元的 `BACKEND_INTERNAL_TOKEN`、`RUNNER_SERVICE_TOKEN` 及 `AI_MASTER_KEY`：

```bash
node scripts/create-local-env.mjs
docker compose config
docker compose build --pull
docker compose up -d
sh scripts/smoke-test-compose.sh
```

`docker compose down` 預設不刪除 volumes。若要進行破壞性清理，必須由管理員明確執行 `docker compose down -v` 並先保存備份。

本地管理員使用 `LOCAL_ADMIN_CONFIRM=PROVISION_LOCAL_ADMIN node scripts/provision-local-admin.mjs` 建立，或加 `--rotate` 輪替 `admin-local`。隨機初始密碼只寫入 `.local-secrets/admin.json`（0600、首次登入必須改密碼），不會印到 stdout；`.local-secrets/` 不會進入 git 或 Docker image。此命令也會封存 Phase 8 load fixture 帳戶並撤銷 sessions，但保留其學習資料與 volumes。

若要在本機內部試用學生流程，可使用 `LOCAL_STUDENT_DEMO_CONFIRM=PROVISION_STUDENT_DEMO node scripts/provision-student-demo.mjs` 建立／輪替 `student-demo`。它會建立一個已發布的 Python 示範課程、教材及含公開／隱藏案例的功課，並把隨機密碼只寫入 `.local-secrets/student-demo.json`（0600）；這是 demo-only 帳戶，刻意不要求首次改密碼，不能用於正式課堂。命令可安全重複執行，不會刪除既有課程、提交或 volumes，也不會把密碼印到 stdout。

## Host-only 開發與驗證

需要 Node.js 22.13 或以上，以及 Python 3（Runner 主機測試會使用不降權的明確 local-test override）。完整回歸命令是 `npm run test:all`：

```bash
npm ci
npm run build
npm run test:all
npm run load:phase8
python3 scripts/phase8-runner-host-smoke.py
```

Host Runner 測試只證明 request validation、AST policy、timeout、output limit 及 bounded 429，不證明 Docker network、cgroup、Linux UID 降權或 ARM64 映像。

容器 build 內的 Node 22 `npm ci` 已實跑；本機是否有 npm 仍不影響 Compose 內部驗證。若只做 host fallback，bundled Node/pnpm 驗證不等同 host-side clean npm install。Docker 40 人結果與證據見 `docs/任務包/證據/phase8b-compose-load.json`，queue 分布為本次樣本而非固定契約。

## 教師教材庫與課程選用

教師登入後，在「教師教材中心」完成以下流程：

1. 在「教材庫上傳」選擇或拖放 PPT/PPTX、PDF、Word、PNG/JPEG 或 ZIP（上限 25 MiB）。原檔先進 quarantine；伺服器會核對副檔名、MIME 與實際 signature，PPTX/DOCX 亦會檢查必要 OOXML entries。
2. 驗證通過後，教材會成為 ready library asset。預設為私人；owner 或管理員可改為「全校教師」。同一 owner 重傳相同 SHA-256 會重用原 asset，不另寫 bytes。
3. 在「課程教材選用」選擇課程、單元及已驗證 asset，填寫中英文標題/說明、下載權限與位置，先儲存草稿，再發布。相同 asset 可掛到多個課程/單元。
4. 已加入課程的學生只會看到已發布、ready 的教材；`allowDownload` 開啟時可下載原檔。下載仍由 server-side enrollment/RBAC 驗證。

PPT/PPTX 可由獨立、無外網的 converter 轉為 PDF 及逐頁 PNG；學生只可在已加入且教材已發布的課程查看投影片，並按 `allowDownload` 下載原檔。轉換中的 job 會顯示排隊／處理狀態，只有 `succeeded` 才提供預覽；失敗不會被標成完成。真實 fixture 驗證見 `docs/任務包/證據/phase9b-validation.txt`。

## 安全邊界

正式執行使用已登入學生的 `/api/v1/submission-answers/:id/grade`；production web 會關閉 legacy `/api/run`。backend 才持有 Runner token，瀏覽器 bundle 不應取得 server token。公開/隱藏測試從固定 question snapshot 讀取，學生 projection 不包含 hidden input、expected、weight、trace 或 secret。

目前長駐 Runner 仍是內部 MVP 防護，不是任意惡意程式的最終隔離。正式上線前必須改用每作業即棄的 gVisor、Kata 或 microVM，配合 cgroup、egress deny 及完整回收。

## 備份與回退

`BACKUP_ENABLED=false` 時排程備份不會執行；管理員 backup API 只寫入指定 backup volume，還原必須到空的隔離目錄並驗證 checksum、foreign keys 及 integrity，絕不覆蓋目前資料庫。真實 token、學生個資、quarantine、Runner temp 不應納入提交或備份。
