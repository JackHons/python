# Phase 9B 獨立 Review Prompt

你是獨立安全、產品及平台 reviewer。請在 `/Users/hon/Documents/ChatGPT/學習平台` 唯讀審查 Phase 9B；不要相信實作者摘要，逐項以程式、測試及脫敏 HTTP／容器證據證明。不得讀出或回報 `.env`、`.local-secrets`、session cookie、初始密碼、AI/SMTP key 或任何學生個資；不得修改 live DB／storage／Docker volumes。

## 本批次聲稱改了甚麼

1. `server/ai.ts`、`server/http/backend.ts`：固定 unavailable provider 改為 runtime `ConfiguredAiProvider`；OpenAI-compatible base URL/path/model/timeout/key 可配置；key authenticated-encryption、response masked；429/5xx/timeout 安全映射；quota reserve/settle/rollback、conversation/review/redaction 保留。
2. `app/page.tsx`、`app/lib/api-client.ts`：管理員 AI provider／policy／限額／保留期；學生 AI 按鈕每次解鎖下一層且重載仍保留次數；教師 AI review queue。
3. `server/conversion/service.ts`、`server/storage.ts`、`server/content.ts`、`services/converter/**`：durable conversion worker 用 LibreOffice＋Poppler 真實產生 PDF／逐頁 PNG；job claim/status/failure；受控 storage、temp、timeout/page/output limit、權限 manifest/slide/PDF endpoints。
4. `app/page.tsx`、`app/globals.css`：學生真實首頁提醒、課程→單元→PPT／教材／練習層級、選中狀態與空狀態；`MaterialPreview` polling、prev/next/page number；教師 role navigation 與 scoped analytics/filter dashboard。
5. `server/analytics/service.ts`：學生 filter 必須仍在教師 course/class scope，不可用已知 ID 查其他學生。
6. `server/notifications/smtp.ts`、notifications worker／Compose：保留一個標準 SMTP adapter/outbox worker 的安全切片；依最新優先次序沒有擴展成完整 SMTP 管理／通知 UI，不得審成正式 SMTP 完成。
7. `drizzle/0008_moaning_nemesis.sql`、`drizzle/0009_absent_war_machine.sql`：只新增 AI provider path/timeout 及 conversion page count；請確認 migration 非 destructive 且 snapshot/journal 一致。
8. 文件：Phase 9 matrix、Phase 9B plan、README、本地部署及 validation evidence 已更新；未做項必須仍列 Partial/Missing。
9. P1 驗收修正：學生 assignment DTO 依非 null `due_at` 升序、null 最後；跨課程 page aggregation 使用同一順序，past/closed 有明確不可作答狀態。Python 3.9 fallback 對任何含完整 `site-packages`／`dist-packages` component 的解析路徑 fail closed。

## 必須重跑

```sh
pnpm run test:all
pnpm exec tsc --noEmit
pnpm run lint
pnpm run build
/usr/bin/python3 -m unittest services.runner.tests.test_runner
/Users/hon/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 -m unittest services.runner.tests.test_runner
runner_image=$(docker compose images -q runner)
docker run --rm --entrypoint python -v "$PWD/services/runner/tests:/opt/runner/tests:ro" "$runner_image" -m unittest tests.test_runner
docker compose config --quiet
docker compose build converter
sh scripts/smoke-test-compose.sh
docker compose ps
git diff --check
```

不要使用真 AI／SMTP key。AI HTTP integration 應使用本地 fake server但必須證明 backend adapter 真發 HTTP；PPT test 應只讀使用文件指定 fixture，確認 source SHA 不變。若 fixture或 LibreOffice 不可用，必須列為未跑，不可用假 PDF／PNG代替。

## 必查功能與安全性

- StudentHome 的提醒是否來自 assignments／classroom sessions；沒有資料時是否為可解釋空狀態，而非硬編「今日課堂」。
- 用相反建立次序建立 far/null/near/past/closed 功課：server DTO 是否仍按 past、closed、near、far、null；page 聚合多課程後是否一致；upcoming 提醒是否先顯示 near，past/closed 是否明確標示及禁止開始，late-enabled past 是否仍可補交。
- 課程頁是否真能選 course、再選 unit，並只載該 unit 的 material/assignment；已知 ID 是否仍受 published/enrollment scope。
- 練習是否仍以 submission snapshot 載入 starter code、stdin、公開結果；hidden input/expected/weight/stderr canary 是否永不出學生 payload。
- AI hint 是否由 server 以同一 scoped conversation 的成功 usage 計數為 1→2→3；學生能否自行竄改 conversation/course/question；full answer 是否服從政策。
- Provider key 是否只加密儲存及 masked；瀏覽器 bundle／response／一般 log 是否無 key；沒有 master key/provider/settings 時是否 fail closed。
- quota 在 timeout/429/5xx 是否正確 rollback/settle；重試 request key 是否冪等；provider error body是否被脫敏。
- 教師 analytics 的 course/class/student filter 是否 scope-first；用另一課程學生 ID 必須 403，而非空中全校資料再前端過濾。
- converter 是否原子 claim job、無網絡、隔離 temp、清理、限制頁數/逾時/輸出；失敗不能標 succeeded；source bytes不能改寫。
- preview manifest/PDF/slide 是否只允許 material owner或已選課學生；DTO/URL/log 不得有 storage path。queued/running/failed UI 不得顯示可用 preview。
- Compose converter 是否 linux/arm64、healthy、read-only、network none、無 host port；不得為通過測試清除 live volumes。
- Phase 9A Gateway CSRF、RBAC、assignment policy、allowed packages、autosave、snapshot/run 安全不得回歸。
- 在 Python 3.9 fallback 模擬 stdlib root 下的 nested `site-packages` 及 `dist-packages`：兩者必須被視為第三方，即使 purelib/platlib 沒列出該路徑。不要只測本機已安裝的 setuptools；builtin/frozen/json/math 必須仍可用，pip與任意第三方仍拒絕，三個教學套件只可由 policy 開啟。

## 已有證據位置

- `docs/任務包/證據/phase9b-validation.txt`
- `docs/任務包/10-Phase-9B-外部服務與營運界面.md`
- `tests/phase9b-ai-http.integration.test.mjs`
- `tests/phase9b-assignment-order.integration.test.mjs`
- `tests/ppt-conversion.integration.test.mjs`
- `tests/phase9b-ui.contract.test.mjs`
- `tests/analytics.integration.test.mjs`
- `server/conversion/service.ts`
- `services/converter/Dockerfile`
- `services/runner/tests/test_runner.py`

## reviewer 輸出格式

1. 結論：Pass／Conditional Pass／Fail；分學生流程、教師分析、AI、PPT、平台安全五域。
2. 改動核對：列實際存在的 route、state transition、UI reachability；不要照抄摘要。
3. 測試：命令、數量、runtime、結果、skip及未跑項。
4. 證據：精確檔案／行號及脫敏狀態；真 fixture請報 source hash及 pageCount條件，不附原檔。
5. 問題：P0–P3 排序，附可重現步驟；優先查 IDOR、key leakage、hint escalation、conversion traversal、hidden leakage。
6. 風險：npm audit 的 20 application＋1 converter high observation需逐項審查，不得直接等同已確認 CVE；另列強沙箱、校方 AI/SMTP、LibreOffice fidelity。
7. 未完成：完整 live-class UI、通知／SMTP 營運 UI、backup/audit UI、exam/similarity/gamification、40 browser tabs、逐作業強沙箱必須保留。
8. 回退：確認 migrations 非 destructive；AI 可 fail closed、converter可停而保留queued job、Compose回退不刪volume。
