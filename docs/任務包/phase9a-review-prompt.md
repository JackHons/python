# Phase 9A 最終 Review Prompt

你是獨立安全與產品 reviewer。請在 `/Users/hon/Documents/ChatGPT/學習平台` 進行唯讀審查；不要相信實作者摘要，逐項以程式、測試及實際 HTTP 證明。不要讀出或回報 `.env`、`.local-secrets`、session cookie、初始密碼或任何學生個資。

## 本批次改了甚麼

1. `gateway/server.mjs`：所有 browser mutation 在轉發前，以公開 Host／`PUBLIC_ORIGINS` 驗 Origin；evil Origin 403；無 Origin 只允許持有 internal token 的非瀏覽器；Gateway 只在驗證後注入後端 token 並改寫後端 Origin。
2. `server/education.ts`、`server/education-api.ts`、`server/http/backend.ts`：帳戶 scoped list、archive、reset＋session revoke；班別成員／課程班別列表；相關 HTTP routes。
3. `server/content.ts`：學生 course/unit/material/assignment published scope；功課 schedule/due/late/max attempts/resubmit/random/question count；分數與測試結果的立即公布政策可分別保存 true／false；答案／分數／評語 release projection；教師 submission/grade/release 邊界。
4. `server/execution.ts`、`services/runner/server.py`：套件政策改為 server-owned course/system setting；瀏覽器不能自選；Runner 僅允許 stdlib 及政策啟用的 numpy/pandas/matplotlib，pip／未允許第三方拒絕；Python 3.9 以 interpreter stdlib path 判斷且排除 purelib/platlib，3.10+ 使用 `sys.stdlib_module_names`；測試結果按公布政策；autosave/paste snapshot route。
5. `app/lib/api-client.ts`、`app/page.tsx`、`app/globals.css`：學生聚合所有課程功課及 release UI；教師班別／整班加課／政策／批改發布，並提供「立即顯示分數」和「立即顯示測試結果」兩個獨立開關；管理員帳戶／班別／匯入／重設；900ms autosave 與 paste event。一次性密碼只在 React state 顯示，不寫 localStorage。
6. `docker-compose.yml`、`.env.example`、`scripts/smoke-test-compose.sh`：公開 Origin 契約與 Runner allowlist smoke。
7. 測試與文件：新增 Gateway integration、Phase 9A domain/security、UI contract、Python allowlist tests，以及 Phase 9 缺口矩陣／驗證證據。

## 必須重跑

使用 repo 可用的 Node 22+／pnpm／Python 3；若 PATH 沒有 runtime，先定位 bundled runtime，不可略過。

```sh
node --experimental-strip-types --test tests/**/*.test.mjs
pnpm exec tsc --noEmit
pnpm exec eslint . --ignore-pattern dist --ignore-pattern .next
pnpm build
/usr/bin/python3 -m unittest services.runner.tests.test_runner
/Users/hon/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 -m unittest services.runner.tests.test_runner
runner_image=$(docker compose images -q runner)
docker run --rm --entrypoint python -v "$PWD/services/runner/tests:/opt/runner/tests:ro" "$runner_image" -m unittest tests.test_runner
docker compose config --quiet
sh scripts/smoke-test-compose.sh
docker compose ps
git diff --check
```

實際 Gateway（不要用真帳戶）：evil Origin POST `/api/v1/auth/login` 應為 403；`Origin: http://127.0.0.1:3000` 的無效登入應到 backend 並為 401。確認 runner 沒有 host port，四服務 healthy。

## 必查安全性

- Gateway 不得先改 Origin 再「驗證」；evil request 不得接觸 backend。
- 學生持已知 ID 仍不可看 draft/archived course、unit、material、assignment；staff 草稿編輯不可被誤封。
- 未到 publish、截止後不允許 late、超過 attempts、禁止 resubmit 均由 server 拒絕；清空日期是真正寫 null。
- score/test/answer/solution/teacher feedback 必須按各自 release 邊界；hidden input/expected/weight/stderr canary 不得出現在學生 payload。
- 教師 UI 的 score/test-result 立即顯示開關必須相互獨立；關閉後 API roundtrip 仍須為 false，不得由 UI 或 server 強制改回 true。
- browser body 中的 `allowedPackages` 不得改 Runner policy；course policy要實際轉發；stdlib 可用，pip/Flask 等未允許第三方拒絕。
- Runner 必須在 macOS `/usr/bin/python3` 3.9 與 bundled/Docker 3.12 都通過同一組 12 項測試；3.9 fallback 不得把 site-packages 或任意 sys.path 位置誤當 stdlib。
- teacher user list/reset 僅限共同有效班別學生；archive/reset 撤銷所有有效 session；管理員不能自行 archive；普通 response 不含 password hash。
- autosave/paste 必須 scope 到 submission answer owner；學生不能掛接他人 answer。
- UI 不得用靜態 Ready／成功 toast 代替後端；一次性密碼不得進 log/localStorage；AI/PPT/SMTP 未配置時必須誠實 fail closed。
- SQLite `foreign_keys=1`、integrity ok；不得修改或刪除 live volumes。

## 已有證據

- `docs/任務包/證據/phase9a-validation.txt`
- `docs/任務包/09-Phase-9-缺口清單與核心閉環.md`
- `tests/gateway-csrf.integration.test.mjs`
- `tests/phase9a.integration.test.mjs`
- `tests/phase9a-ui.contract.test.mjs`
- `services/runner/tests/test_runner.py`

## reviewer 輸出格式

1. 結論：Pass／Conditional Pass／Fail。
2. 改動核對：逐域列實際存在的行為，不照抄摘要。
3. 測試：命令、數量、結果、任何未跑項。
4. 證據：精確檔案與行號；必要時提供脫敏 HTTP 狀態。
5. 問題：按 P0–P3 排序，附可重現步驟；特別檢查 scope、release、Runner policy 與 UI 假成功。
6. 剩餘風險：至少包括 npm ci 報告的 20 個依賴漏洞（1 low／4 moderate／15 high，尚未逐項處理）、強沙箱、真 AI／SMTP／PPT worker、40 browser tabs。
7. 未完成：以 Phase 9 矩陣逐項核對，不得把 Partial／Stub 改寫成完成。
8. 回退：確認沒有 destructive migration，並列 Gateway、domain、Runner、UI 的安全回退條件。
