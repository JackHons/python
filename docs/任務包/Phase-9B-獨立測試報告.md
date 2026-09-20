# Phase 9B 獨立測試報告

日期：2026-08-23（Asia/Macau）
工作區：/Users/hon/Documents/ChatGPT/學習平台
角色：獨立驗收 worker；產品碼、schema、migration、Compose 設定及 live volume 均唯讀。

## 1. 結論

**CONDITIONAL PASS（兩項 P1 已修正並由獨立測試通過；保留正式放行風險）**。

本輪重驗證實學生截止排序／狀態 projection 及三 runtime 套件政策的兩項 P1 修正有效；學生課程階層、練習／提交、真實 AI HTTP adapter、教師分析 API、PPT 轉換及 Compose/Runner 回歸亦有可重跑證據。這是校內內部測試的條件式通過，不是公網、正式考試或完整 UI 視覺放行。

1. **P1-9B-01 已解決：學生首頁按截止時間排序。** server/content.ts:521-536 以 due_at 升序、null 置後並以 id tie-break；app/page.tsx:92-93 及 app/lib/api-client.ts:34-44 對跨課程 flatMap 使用相同規則，並顯示 reminder_state/can_start。
2. **P1-9B-02 已解決：system Python 3.9 fallback 排除 nested site-packages/dist-packages。** services/runner/server.py:100-145 檢查 path component；system 3.9、bundled 3.12、Docker 3.12 的同一 temporary-module matrix 均拒絕未批准第三方，builtin/stdlib 允許，numpy/pandas/matplotlib 只在 policy allowlist 中允許。

兩個 P1 均由本輪獨立重驗證通過；本 worker 沒有修改產品碼。仍保留正式放行前的 P0/P2 風險：長駐 Runner 尚非逐作業強沙箱；沒有真實校方 AI/SMTP vendor；沒有 40 個真瀏覽器；沒有教師目視 PPT fidelity；依賴 audit 仍有待逐項處理。這些不能被本輪的 HTTP、source contract 或 container 測試代替。

## 2. 範圍及資料安全

- 沒有讀取或輸出 .env、.local-secrets、session cookie、初始密碼、AI/SMTP key 或學生個資。
- AI/backend HTTP 測試使用臨時 SQLite/storage 及本機 fake HTTP provider；沒有寫入 live DB 或 Docker volume。
- PPT fixture 以唯讀方式讀取；沒有改寫來源檔。來源檔只報必要的測試指紋：2,572,119 bytes，SHA-256 1d9ef8a46d0672c59eca58b44d9cd3b54dd3e9a0cf34f8e98d686e8817805384，MIME application/vnd.openxmlformats-officedocument.presentationml.presentation。
- 未進行瀏覽器操作、截图、DOM QA；UI 結論限於 source/rendered/typed contract，不宣稱 viewport 或視覺驗收。

## 3. 驗收矩陣

| 編號 | 驗收項目 | 狀態 | 優先級 | 獨立結果／邊界 |
|---|---|---|---|---|
| 9B-01 | 學生登入後首頁以後端課程、功課、通知、課堂資料聚合 | PASS | P2 | app/page.tsx:86-98 以 courses、notifications，再按已加入課程載入 assignments、classroomSessions；有資料及空狀態分支。不是固定今日課堂。 |
| 9B-02 | 首頁近期／截止提醒按截止日期排序 | PASS | P1 | server/content.ts:521-536 與 app/lib/api-client.ts:34-44 共用 due 升序/null 後/id tie-break；反向建立、多課程、同 due、null、past、closed、allowLate matrix 通過。 |
| 9B-03 | 課程→單元→教材/PPT→練習逐層到達，跨課程不串線 | PASS | P2 | app/page.tsx:564-581 按 course_id、unit_id 過濾；targeted tests 及 69 項 full Node tests 通過。 |
| 9B-04 | draft、archived、未入課及 known-ID projection 不可見 | PASS | P1 | phase9a known-ID projection、materials/material-library/education-api/backend E2E 均通過；學生 route 由 server scope 再驗。 |
| 9B-05 | Python starter、stdin、修改後執行、autosave/paste、提交回歸 | PASS | P1 | runner-proxy、execution、grading、hidden-tests、assignments、submissions、Phase 9A targeted：18/18；full regression 亦通過。 |
| 9B-06 | 公開/隱藏測試投影及答案／hidden leakage 防護 | PASS | P1 | hidden 只回 status/score；hidden-tests.security、assignment/submission/runner targeted 通過。 |
| 9B-07 | 三層提示、每次只下一層、刷新後持久化、學生隔離 | PASS | P1 | 真 backend HTTP + local fake provider：levels 1→2→3，重用 conversation 得 successful_hint_count=3；request body 不能指定他人 conversation；AI targeted 通過。 |
| 9B-08 | AI provider 未配置、timeout/429/5xx、quota rollback、key 不進 response/log | PASS | P1 | 真 HTTP 脫敏結果：failure HTTP 429/502/504，quota rollback，disabled fail-closed，server-only key/masked DTO；沒有回 provider body。未使用真 vendor/key。 |
| 9B-09 | 管理員 provider/model/base URL/key rotate/mask/disable、限額、提示策略、保存期 | PASS（server/API） | P2 | server/ai.ts、admin routes、AI privacy/quota/review 及 Phase 9B UI typed contract 通過；瀏覽器 UI/目視未驗，見 9B-17。 |
| 9B-10 | 教師 Dashboard 課程/班別/學生篩選、完成率/分數/作答/學習時間/AI用量/常見錯誤及空狀態 | PASS（server/typed） | P2 | analytics fixture 以 DB 報告並拒絕越權 student filter；app/page.tsx:932-960 呼叫六類 live analytics endpoint。 |
| 9B-11 | 教師 analytics 目視/瀏覽器完整 UI | PARTIAL | P2 | 有 source/typed contract；按本任務明確未跑 browser，不能宣稱 360/768/1440 或教師目視通過。 |
| 9B-12 | 真 PPT host 轉換：quarantine/release、PDF/PNG、page count、source SHA | PASS | P2 | tests/ppt-conversion.integration.test.mjs 1/1；LibreOffice + Poppler 真 fixture，pageCount=16、PDF/PNG signature、source/download SHA 相同。 |
| 9B-13 | 隔離 ARM64 converter container E2E、queued→running→succeeded/output asset | PASS | P1 | readonly fixture bind、temporary in-memory DB/storage；network=none、read-only root、tmpfs 512MiB、memory 1GiB、pids 128 的獨立 inline E2E PASS，pageCount=16、output asset 有值；未掛 live volume。 |
| 9B-14 | PPT viewer manifest/slide/PDF enrollment/RBAC/path、queued 狀態誠實 | PASS（API/source） | P1 | enrolled 可取 manifest/PDF/slide，outsider 403；manifest 不含 storage path；MaterialPreview queued/running 只顯示進度，只有 succeeded 才取 preview（app/page.tsx:614-655）。 |
| 9B-15 | converter failure/retry、temp cleanup、無 host port/無外網 | PASS（結構及 E2E） | P1 | 錯誤 converter → failed，sanitized error，不洩漏 path；重試為新 queued，真 converter 後 succeeded；service finally 清理 temp；Compose inspect 確認 network=none、ports={}、read-only、cap_drop ALL、no-new-privileges。 |
| 9B-16 | migration、Node、runner 三 runtime、TypeScript/lint/build、Compose/health/FK/smoke | PASS | P1 | migration journal/snapshot 0008/0009 non-destructive；Node 69/69；Python system/bundled/Docker 各 13/13；tsc/lint/build/config/converter build/smoke/health/FK 通過。 |
| 9B-17 | UI 及 PPT visual fidelity | PARTIAL | P2 | 未跑瀏覽器及教師目視 PPT；只能接受 typed/rendered source evidence，不能升級為完整 UI pass。 |
| 9B-18 | Python 3.9 fallback 只允許 stdlib、未批准第三方不得誤判 | PASS | P1 | 三 runtime 使用同一 temporary nested site-packages/dist-packages matrix；builtin/stdlib pass，pip/任意第三方 reject，numpy/pandas/matplotlib 只在 policy allowlist pass；13/13 runner tests。 |
| 9B-19 | secret/source scan、依賴風險 | PARTIAL | P2 | source scan 命中為 deterministic test canary/CSS/package name，沒有確認的 real secret；本環境沒有 npm，pnpm audit --prod 因缺 pnpm-lock.yaml 無法 audit；沿用 evidence 記錄 npm ci 20 app vulnerabilities、converter 1 high，須 package-by-package review。 |
| 9B-20 | 正式公網／考試級強沙箱及 40 browser | PARTIAL | P0/P1 | 長駐 Runner 仍是 MVP boundary，非逐作業強隔離；沒有 40 個真 browser。校內內部試教可作條件風險，不代表正式公網/考試放行。 |

矩陣統計：20 項中 PASS 16、PARTIAL 4、FAIL 0、BLOCKED 0。核心 backend/PPT/AI/Runner regression 有證據；UI browser、PPT fidelity、真 vendor、strong sandbox 仍保留 Partial/known risk。

## 4. 真實測試及結果

### 4.1 Node regression

執行命令：

    pnpm test:all

結果：**69/69 PASS，fail 0，skipped 0**。

本輪另外重跑的功能集合（包含新 assignment-order integration）：

    node --experimental-strip-types --test \
      tests/education-api.integration.test.mjs \
      tests/materials.integration.test.mjs \
      tests/material-library.integration.test.mjs \
      tests/assignments.integration.test.mjs \
      tests/backend.e2e.test.mjs \
      tests/phase9a.integration.test.mjs \
      tests/phase9b-ui.contract.test.mjs \
      tests/analytics.integration.test.mjs \
      tests/phase9b-ai-http.integration.test.mjs \
      tests/ppt-conversion.integration.test.mjs

結果：**targeted PASS**；完整 Node regression 為 **69/69 PASS**。這是 API、scope、AI、PPT 及 typed UI contract 的 targeted 結果，不是 browser 結果。

已由 earlier independent backend HTTP probe 脱敏記錄：

    backend_ai_http=PASS {"httpCalls":5,"hintLevels":[1,2,3],"refreshedHintCount":3,"failureStatuses":[429,502,504],"quotaRollback":true,"outsiderDenied":true,"disabledFailClosed":true,"keyMaskedAndServerOnly":true}

### 4.2 學生首頁截止排序及狀態重驗

獨立 in-memory fixture 反向建立兩個課程中的 assignments，覆蓋同 due tie、null due、past due、closed、allowLate true/false，並將各課程 server DTO flatten 後交給 app/lib/api-client.ts:34-44 的同一 sort projection。結果：

    assignment_order_matrix=PASS
    count=7
    states=[past_due,past_due,closed,upcoming,upcoming,upcoming,no_due]
    canStart=[0,1,0,1,1,1,1]
    courseCount=2
    tieBreak=stable id ascending

server/content.ts:521-536 已按 due_at 升序、null 置後、id tie-break；app/page.tsx:92-93 及 StudentHome 的 actionable/upcoming/inactive branches 使用同一排序語意。這一項 P1 已 resolved。

### 4.3 Runner 三 runtime 及 fallback probe

執行命令：

    /usr/bin/python3 -m unittest services.runner.tests.test_runner
    /Users/hon/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 \
      -m unittest services.runner.tests.test_runner
    runner_image=$(docker compose images -q runner | head -n 1)
    docker run --rm --entrypoint python \
      -v "$PWD/services/runner/tests:/opt/runner/tests:ro" "$runner_image" \
      -m unittest tests.test_runner

結果全部 **13/13 PASS**（system 3.9.6、bundled 3.12.13、Docker 3.12.14）。另外用同一 stdin matrix（不依賴本機 setuptools）驗證：

    runner_policy_matrix=PASS runtime=3.9.6
    runner_policy_matrix=PASS runtime=3.12.13
    runner_policy_matrix=PASS runtime=3.12.14

matrix 建立 temporary modules，分別放在 nested site-packages/dist-packages；builtin/stdlib（math/json/sys）允許，pip 及任意第三方 fixture 拒絕，numpy/pandas/matplotlib 只有在對應 server policy allowlist 中允許；unapproved allowlist entry 亦拒絕。這一項 P1 已 resolved。

### 4.4 TypeScript、lint、build、migration

    pnpm exec tsc --noEmit       # PASS
    pnpm run lint                # PASS, 0 errors
    pnpm build                   # PASS, Vinext 5 environments
    pnpm exec drizzle-kit check  # PASS, Everything's fine

drizzle/0008_moaning_nemesis.sql 及 drizzle/0009_absent_war_machine.sql 只新增 AI provider path/timeout 及 conversion page count 欄位；journal/snapshot 有 0000–0009，未見 DROP/DELETE/破壞性資料搬移。

### 4.5 Compose、health、FK、converter 安全設定

    docker compose config --quiet                 # PASS
    docker compose build runner converter backend web # PASS with DOCKER_BUILDKIT=0
    sh scripts/smoke-test-compose.sh              # PASS
    docker compose ps --all                       # all six services healthy

本輪 ready/FK probe：

    backend_ready={"status":"ok","foreignKeys":1,"database":"ok"}
    converter_ready=PASS
    runner_health=PASS

converter container inspect（不含 env/key）：

    user=node
    readonly=true
    network=none
    ports={}
    tmpfs=/tmp rw,noexec,nosuid,nodev,size=512m
    memory=2147483648
    pids=256
    no_new_privileges=true
    cap_drop=[ALL]

第一次使用預設 Buildx build 遇到環境 header 錯誤：x-docker-expose-session-sharedkey 含 non-printable ASCII；改用 DOCKER_BUILDKIT=0 的 classic builder 後 runner/converter/backend/web build 均通過。這是環境風險，不是產品測試失敗。容器設定及 smoke/health 證據不等於每一個 job 都有強沙箱；長駐 Runner 風險仍見 9B-20。

### 4.6 PPT host/container/failure-retry

Host tests/ppt-conversion.integration.test.mjs **1/1 PASS**：使用指定 fixture、只讀來源、quarantine/release、真 LibreOffice/Poppler、PDF/PNG 可解析、pageCount=16、enrolled viewer 可取、outsider 拒絕、原檔及下載 SHA 不變。

獨立 ARM64 converter inline E2E **PASS**：使用 docker run --network none --read-only --tmpfs /tmp ...，真 fixture read-only bind、in-memory DB/storage；queued status 的 outputAssetId/startedAt/finishedAt 為 null，實際 worker 後 succeeded、pageCount=16、output asset 存在，manifest/PDF/slide scope 通過，outsider 403，source SHA 未變。

獨立 host failure/retry probe **PASS**：故意使用不可用 converter 得 failed，錯誤不回顯本機 path；建立 retry 得 queued，真 converter 後得 succeeded。temp work directory 由 service finally 清理；container /tmp 隨隔離 container 結束。未做教師目視 slide fidelity。

## 5. P0–P3 問題清單

### P0：正式公網/考試前阻塞（目前未宣稱已完成）

- **P0-9B-01 強沙箱未達標**：長駐 Runner 仍共享服務級隔離，尚未做到逐作業 disposable sandbox、完整 syscall/namespace/CPU/memory/fs 強邊界。這不是本輪新回歸，但必須在公網或正式考試前關閉。

### P1：本輪退回項重驗結果

- **P1-9B-01 學生首頁截止排序 — RESOLVED**
  - 重驗：反向建立、多課程 flatten、同 due tie、null、past、closed、allowLate true/false；server DTO 與 app sort projection 同序。
  - 結果：states=[past_due,past_due,closed,upcoming,upcoming,upcoming,no_due]、canStart=[0,1,0,1,1,1,1]、courseCount=2；tie 以 id ascending。
  - 位置：server/content.ts:521-536、app/lib/api-client.ts:34-44、app/page.tsx:92-93、app/page.tsx:494-546。

- **P1-9B-02 Python 3.9 fallback 第三方誤判 — RESOLVED**
  - 重驗：system 3.9、bundled 3.12、Docker 3.12 使用同一 temporary module matrix；nested site-packages/dist-packages fixture 均拒絕，builtin/stdlib 允許，pip/任意第三方拒絕，numpy/pandas/matplotlib 只在 policy allowlist 允許。
  - 結果：runner_policy_matrix=PASS runtime=3.9.6/3.12.13/3.12.14；runner tests 各 13/13。
  - 位置：services/runner/server.py:100-145、services/runner/tests/test_runner.py:58-92。

### P2：可用性/運營風險

- 真 AI vendor、key、資料處理協議未配置；fake HTTP 只證明 adapter/錯誤處理。
- SMTP adapter/worker 有測試，但校方 SMTP 設定、credential policy、delivery UI 及正式送信未完成。
- 教師 analytics、PPT viewer、教材上傳 UI 未做瀏覽器視覺驗收；PPT layout fidelity 未由教師抽查。
- 本環境無 npm；pnpm audit --prod 回報缺少 pnpm-lock.yaml，不能當作 audit 通過。沿用 docs/任務包/證據/phase9b-validation.txt 的 clean npm ci observation：application 20 vulnerabilities（1 low、4 moderate、15 high），converter 1 high；須逐 package 審查，不能直接等同已確認 CVE。
- 完整即時課堂控制台、通知中心、backup/audit 操作 UI、exam mode、similarity、gamification 仍是後續範圍。

### P3：證據邊界

- 沒有 40 真瀏覽器分頁；HTTP/container 負載不可替代 browser evidence。
- rendered/source contract 測試不等於教師目視、鍵盤/螢幕閱讀器及三 viewport fidelity sign-off。

## 6. 修正後應新增的最小測試

1. 保持 tests/phase9b-assignment-order.integration.test.mjs 的多狀態／tie coverage，後續再補真正 render-level browser assertion。
2. 保持 services/runner/tests/test_runner.py 的 temporary nested package fixture，不依賴本機現成 setuptools。
3. 在 bundled 3.12、system 3.9、Docker 三 runtime 持續執行同一 runner package-policy matrix。
4. 後續補 browser/PPT fidelity/strong sandbox；這些本輪仍是 Partial/known risk。

## 7. 結論與回退

Phase 9B 的 server/API 及真實 PPT/AI adapter 證據足以支持**受控的校內內部測試（Conditional Pass）**；兩項 P1 已由獨立重驗 resolved。這不等於公網、正式考試或完整 UI 視覺放行：strong sandbox、真 AI/SMTP vendor、40 browser、教師 PPT fidelity 仍保留 Partial/known risk。AI 可停用並 fail closed；converter 可停而保留 queued job；migration 可回退而不刪 volumes。回退或重建 Compose 時不得使用 docker compose down -v。
