# Phase 9A 獨立測試報告

日期：2026-08-23（Asia/Macau）  
工作區：`/Users/hon/Documents/ChatGPT/學習平台`

## 1. 結論

**Conditional PASS（Phase 9A 核心驗收／Docker 內部測試範圍）。**

所有產品碼、schema、migration、Compose 設定、live database／volume 均保持不變；本報告只更新本報告與證據 JSON。Gateway、scope、作業伺服器政策、教師 release policy 及 Docker health/smoke 均有獨立通過證據。Phase 9A 指定的三個 Runner runtime gate 現已全部通過：

```sh
python3 -m unittest services.runner.tests.test_runner
```

在本機 `/usr/bin/python3` 3.9.6、bundled Python 3.12.13 及 Docker runner image（`python:3.12-slim-bookworm`）均為 12/12 pass。另以隔離臨時目錄模擬 site-packages/purelib，確認 Python 3.9 fallback 不會把未批准第三方模組當成 stdlib；`pip`、未批准套件及客戶端偽造套件仍被拒絕。教師端兩個 immediate-score/test-results 開關均存在、可獨立 true→false roundtrip，payload 使用 state 而非硬編碼；server/student release projection 的 release 前後邊界亦通過。

因此本次沒有 P0/P1 測試失敗根因；Conditional PASS 只代表已實作的 Phase 9A 核心閉環，不代表真 AI、PPT conversion worker、SMTP/scheduler、40 個真實 browser context 或正式公開用 strong sandbox 已完成。這些仍列為明確的產品範圍風險。

## 2. 狀態統計

以本報告 24 個驗收檢查群組計（MISSING 另列，不混入 FAIL）：

| 狀態 | 數量 |
| --- | ---: |
| PASS | 17 |
| PARTIAL | 4 |
| MISSING | 3 |
| FAIL | 0 |
| BLOCKED | 0 |

原先兩項 FAIL（Runner host gate、完整放行 gate）及教師 UI PARTIAL 均已由本次重驗收收斂；P0 fail：0；P1 fail：0。MISSING／PARTIAL 項目是尚未接通的產品範圍，不是本次已實作核心 gate 的測試失敗。

## 3. 驗收矩陣

| ID／驗收項 | 狀態／優先級 | 親自執行或核對的命令／證據 | 結果與缺口 |
| --- | --- | --- | --- |
| 1. 實際 Gateway evil／格式錯 Origin | PASS／P0 | `curl` 到 `http://127.0.0.1:3000/api/v1/auth/login`；`tests/gateway-csrf.integration.test.mjs` | evil Origin=403、malformed Origin=403；Gateway 未向 backend forwarding。 |
| 2. same-origin／無 Origin／外來 token | PASS／P0 | 實際 Gateway probe；`gateway/server.mjs:34-42,67-83` | same-origin 無效登入=401，證明到達 backend；無 Origin=403；偽造 `X-Backend-Token`=403。內部 token 只由 Gateway 注入，未在 probe 輸出。 |
| 3. 學生 known-ID draft／archived scope | PASS／P0 | `pnpm test:all`；`tests/phase9a.integration.test.mjs:9-25`；隔離 `:memory:` inline domain probe | 學生看不到 draft unit/material/assignment；另獨立驗證 archived course/unit/material/assignment 均不進 student projection，教師仍可編輯。 |
| 4. publish／due／late／attempt／resubmit 邊界 | PASS／P0 | `tests/phase9a.integration.test.mjs:29-65`；隔離 clock inline probe | publish 未到時間拒絕；due 等於截止仍可開始，超過截止且不允許 late 拒絕；allowLate、maxAttempts、allowResubmit false/true 均實測。 |
| 5. score／test／answer release 及 hidden DTO | PASS／P0 | `tests/phase9a.integration.test.mjs:87-110`；`tests/hidden-tests.security.test.mjs`；inline boundary probe | release 前 score／feedback／hidden test details 不出現；release 後按政策出現；hidden input/expected/answer key 不在學生 projection。 |
| 6. 教師作業政策 UI | PASS／P1 | `app/page.tsx:861-878`；`tests/phase9a-ui.contract.test.mjs`；獨立 source roundtrip contract | 兩個 checkbox 獨立綁定 state；choose 由 server 值 hydrate；save payload 使用 `showScoreImmediately`／`showTestResultsImmediately` state，沒有硬編碼 true；true→false contract pass。 |
| 7. server-owned Python package policy | PASS／P0 | `tests/execution.integration.test.mjs`；三個 Python runtime runner tests；Docker runner HTTP policy probe | forged `flask`=422、未啟用 numpy=422、啟用 numpy/pandas/matplotlib=200；client body 不能放寬 course policy；fallback site-packages exclusion 及 pip rejection pass。 |
| 8. host Python runner gate | PASS／P1 | `/usr/bin/python3 --version`；`/usr/bin/python3 -m unittest services.runner.tests.test_runner`；bundled Python；Docker bind-mounted test | `/usr/bin/python3` 3.9.6=12/12、bundled 3.12.13=12/12、Docker image=12/12；Python 3.9 fallback 不將臨時 purelib/site-packages 模組當 stdlib。 |
| 9. 帳戶 list/create/archive/reset/session revoke | PASS／P0 | `pnpm test:all`；`tests/auth.integration.test.mjs`、`tests/phase9a.integration.test.mjs:68-85`；scope inline probe | admin／teacher scope、shared-class reset、cross-class reset 403、reset/archive 撤銷 session、admin 不能 archive 自己均通過。 |
| 10. 班別 roster／整班加課／join code scope | PASS／P1 | `tests/rbac.integration.test.mjs`、`tests/backend.e2e.test.mjs` | teacher class/course scope、冪等整班 assignment、cross-class 越權均通過。 |
| 11. CSV/XLSX import | PASS／P1 | `tests/import.integration.test.mjs` | 全批驗證、壞列回報、交易不半成功、初始密碼不進 audit metadata 通過。 |
| 12. 學生跨課 assignment／autosave／paste | PASS（server）／P1 | `app/page.tsx:77-92,756`；inline isolated probe；`server/analytics/service.ts:116-120` | courses 聚合 assignments；900ms autosave、paste count/history、submission answer owner scope 均通過。尚無真 browser interaction evidence。 |
| 13. 教師 submission／manual grade／release | PASS（server）／P1 | inline isolated probe；`server/content.ts:601-626` | teacher list、manual score/feedback；student release 前隱藏，release 後可見。UI 目前以選中 submission 的第一題為批改入口。 |
| 14. 完整 Node regression | PASS／P1 | `pnpm test:all` | 62/62 pass、0 fail、0 skipped。targeted Phase 9A group 19/19 pass。 |
| 15. TypeScript／lint／build | PASS／P1 | `pnpm exec tsc --noEmit`；`pnpm exec eslint . --ignore-pattern dist --ignore-pattern .next`；`pnpm build` | 全部 pass；build 僅有既有 dynamic-route classification warning。 |
| 16. Docker config／health／FK／smoke | PASS／P1 | `docker compose config --quiet`；`sh scripts/smoke-test-compose.sh`；`docker compose ps --all`；backend `/ready` probe | 四服務 healthy；Gateway 3000；Runner 沒有 host port；`database=ok`、`foreignKeys=1`；legacy route=404；container runner smoke pass。沒有執行 volume deletion。 |
| 17. 完整放行 gate | PASS／P1（核心 gate） | 以上 Node、三個 Python runtime、build、Compose gates | Node 62/62、Python 三 runtime 12/12、tsc/lint/build、Compose smoke/health/FK 均通過；未把未接真服務功能當作完成。 |
| 18. 真 AI provider | MISSING／P1 | `server/http/backend.ts:26-28,141-147`；phase4 tests | backend 固定 `UnavailableAiProvider`，實際 AI request fail-closed 503；fake provider tests 不等於外部 AI integration。 |
| 19. PPT conversion | PARTIAL／P1 | material tests／`docs/任務包/教材上傳功能測試報告.md`；`app/page.tsx:579-586` | 只能證明 POST queue；沒有 conversion worker/output asset/preview。UI 誠實顯示等待服務，沒有假成功。 |
| 20. 即時課堂 UI | MISSING／P1 | `app/page.tsx:975-1005`、首頁 role branch | `TeacherLiveClass` 元件存在但沒有接入主頁，發布／lock controls disabled；後端 classroom contract 不能代替 UI。 |
| 21. SMTP／排程 | PARTIAL／P2 | `tests/email.retry.test.mjs`、phase5 evidence | FakeMailer/outbox/retry 通過；沒有真 SMTP transport 或 scheduler。 |
| 22. 分析／匯出／備份／稽核 UI | PARTIAL／P1/P2 | `tests/analytics.integration.test.mjs`、export/backup tests、backend routes | 後端 scope／檔案／checksum 有測；資料量小，完整 report/download/admin operation UI 未驗。 |
| 23. 40 browser tabs | MISSING／P2 | `phase8b-compose-load.json`、`phase9a-validation.txt` | 既有是 40 HTTP users，不是 40 Playwright/WebKit/Chrome browser contexts；沒有 browser runner。 |
| 24. Runner strong sandbox | PARTIAL／P0（正式公開前） | `phase8b-runner-security.json`、`services/runner/server.py:1-5`、Compose config | 容器、AST、rlimit、queue、no host port 有證據；長駐 container 不是逐 job disposable gVisor/Kata/microVM 強沙箱。 |

## 4. 親自執行紀錄

### Node／前端

- `node --experimental-strip-types --test ...` targeted group：19/19 pass；另 `phase9a + UI + assignment/submission` 重跑 11/11 pass。
- `pnpm test:all`：62/62 pass，0 fail。
- `pnpm exec tsc --noEmit`：pass。
- `pnpm exec eslint . --ignore-pattern dist --ignore-pattern .next`：pass，0 errors。
- `pnpm build`：pass，五個 Vinext build environments 完成。
- 獨立教師 UI source contract：兩個 checkbox、server-value hydrate、state payload 及 true→false roundtrip：pass；獨立 server projection：release 前 `scoreReleased=false`／`testResultsReleased=false`／`totalScore=null`，release 後分數及 feedback 可見：pass。
- `sh scripts/phase8-security-scan.sh`：8/8 Node security tests pass；hidden canary bundle scan pass。
- `git diff --check`：pass；工作區沒有可靠的 tracked commit baseline，不能把 `git diff` 當完整歷史變更清單。

### Python／Runner

- `/usr/bin/python3 --version` = 3.9.6；`/usr/bin/python3 -m unittest services.runner.tests.test_runner`：**12/12 pass**。
- bundled Python 3.12.13 同一命令：**12/12 pass**。
- Docker read-only bind-mounted runner image test：**12/12 pass**（`docker run --rm --entrypoint python -v "$PWD/services/runner/tests:/opt/runner/tests:ro" ... -m unittest tests.test_runner`）。
- Python 3.9 fallback isolation probe：臨時 purelib/site-packages 模組、`flask` 均判定非 stdlib；未批准 numpy/pandas/matplotlib 及 `pip` 均拒絕：pass。
- Compose runner HTTP policy：forged package=422、未允許第三方=422、課程允許的 numpy/pandas/matplotlib=200。

### Docker／Gateway

- `docker compose config --quiet`：pass。
- `sh scripts/smoke-test-compose.sh`：pass。
- `docker compose ps --all`：gateway、web、backend、runner 均 healthy；runner 無 published host port。
- backend `/ready`：`status=ok`、`database=ok`、`foreignKeys=1`。
- 真實 Gateway 脫敏狀態：`health=200`、evil=403、malformed=403、same-origin 無效登入=401、no-origin=403、偽造 internal token=403。

實際 Gateway probe 只使用空 JSON／無效登入資料，不使用真實帳戶、密碼、token、學生資料；沒有執行 `down -v`、volume delete、migration 或清理 live volume。Mutation endpoint 的無效登入可能留下正常的 denied audit event，除此以外沒有建立／修改教務資料。

## 5. 文件與誠實性核對

大部分 Phase 9 文件已正確標示 Partial／Missing：

- `09-Phase-9-缺口清單與核心閉環.md:30-43,62-64` 明確保留 PPT worker、真 AI、SMTP、40 browser、strong sandbox 等缺口。
- `phase9a-review-prompt.md:61-62` 要求 reviewer 保留依賴漏洞、強沙箱、外部服務及 40 browser 風險。
- `Phase-8-放行報告.md:42-50` 將 Docker 結論限制在 ARM64 內部測試，未宣稱公開／正式考試通過。

需留意的歷史證據解讀：

1. `證據/phase9a-validation.txt:17-18` 將 `python3 -m unittest` 記作 12/12，但未記錄 runtime path／version；本次獨立重驗已補足 `/usr/bin/python3` 3.9.6、bundled 3.12.13、Docker image 三組明確證據，均為 12/12。
2. `Phase-8-放行報告.md:20-21`、`證據/phase8-tests.txt` 的 47/50 歷史數字不應與本次 62/62 混稱 latest full regression；應標記為 historical evidence。
3. `證據/phase8b-ui-wiring.json` 的 browser role smoke 沒有可重跑 browser command；`student-demo-ui-evidence.txt` 明確表示 logged-in visual role smoke 未執行。因此不能將 source/rendered contract 視為完整 authenticated browser acceptance。

## 6. 風險與未完成

- **已解決（本次退回項）：** host Python 3.9 runner compatibility、site-packages fallback、教師兩個 immediate release controls 及 server/student release projection 已重驗通過。
- **P1：** 真 AI provider 未接通；backend 使用 `UnavailableAiProvider`。
- **P1：** PPT conversion worker 未配置；只有 queued status。
- **P1：** live-class UI 尚未接入；正式考試模式、切頁限制、防抄襲／相似度亦未完成。
- **P0（正式公開前）：** Runner 不是逐 job disposable strong sandbox。
- **P2：** 真 SMTP／scheduler、40 browser contexts、完整 analytics/export/admin UI、gamification 及 question-bank sharing 未完成。
- **依賴：**既有 `npm ci` evidence 報告 20 個 vulnerabilities（1 low／4 moderate／15 high），本機沒有 npm，這次沒有重新做 network CVE query；lockfile scan 僅確認兩個 deprecated transitive packages，不能宣稱無 CVE。

## 7. 回退／停止條件

本次沒有 destructive migration，亦沒有需要資料轉換的 schema 變更。若強沙箱、真 AI／SMTP／PPT worker 或 browser-level 40 users 未完成，維持「只限內部試教」條件，不放行正式考試、公開服務或不可信程式執行。
