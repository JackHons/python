# Phase 3：安全 Python Runner、執行、公開／隱藏測試與批改

## 目標

把學生編程題接到可追蹤的安全執行與評分流程：程式碼自動保存、snapshot、run queue、資源限制、教師套件白名單、公開／隱藏 test case、分題結果、總分及立即回饋。評分輸入必須來自 P2 的固定 submission snapshot。

## 非目標

- 不把目前長駐 Docker Runner 宣稱為最終零風險沙箱；強隔離 hardening 在 P8。
- 不實作 AI 評語／AI 分數（P4）。
- 不做即時課堂、報表或電郵。

## 允許修改範圍

- `services/runner/**`、`worker/run-api.ts`、`worker/index.ts`、Runner Docker 設定及其測試。
- 新增執行／評分 domain、queue adapter、test projection、submission API 及相關 migration。
- `scripts/` 中 Runner／整合測試及 `docs/本地部署.md` 的準確性修訂。
- 練習工作台所需的最小 `app/**` 整合。

## 禁止修改範圍

- 不得回傳 hidden test 的輸入、預期輸出、權重、完整錯誤 trace 或參考答案。
- 不得讓學生程式得到 Web／Runner token、API key、資料庫秘密或宿主機路徑。
- 不得在正式評分時從可變 `questions` 重新生成 submission 題目。

## 具體交付物

- `code_snapshots`／`code_runs`／`test_results`／grade 交易及狀態機；每個 run 明確關聯 `submission_answer_id`、snapshot ID、actor、limits、image／runner version。
- Runner 認證、輸入 schema、超時、CPU／記憶體／PID／檔案／輸出限制、無外網策略及清理流程。
- 公開測試投影：輸入／預期／實際／stderr（按政策）；隱藏測試投影只含通過／失敗及必要錯誤碼。
- 允許套件設定及執行版本固定；提交／執行／自動保存／貼上事件可供教師查詢。
- 自動評分、rubric 權重、教師覆核及答案／分數公布時間。

## 驗收條件

1. 每次 run 可追溯至一個不可變 code snapshot 及一個 submission answer；重試不覆蓋歷史 run。
2. 同一提交的公開案例顯示詳情，隱藏案例只顯示通過／失敗；任何 API、HTML、log、錯誤回應都沒有 hidden secret。
3. `os`／`subprocess`／網路嘗試、無限迴圈、fork bomb、超大輸出、超大檔案及超時按政策失敗或被殺死，Runner 可回收資源。
4. 只允許管理員／教師設定的套件；學生不能 pip install 或讀取其他執行的工作目錄。
5. 學生可立即看到允許的分數／測試結果；完整答案只在教師設定的時間後發布。
6. 40 個並發請求不會越過 Runner／Web 的 token、timeout、memory、queue 邊界；忙碌時回傳可理解的 429／重試訊號。

## 測試方式／命令

```bash
sh scripts/test-runner.sh
pnpm exec tsc --noEmit
node --test tests/runner-proxy.test.mjs tests/execution.integration.test.mjs tests/grading.integration.test.mjs tests/hidden-tests.security.test.mjs
docker compose build web runner
docker compose up -d
sh scripts/smoke-test-compose.sh
```

安全測試要包括 token／schema fuzz、資料外洩 grep、超時及輸出限制、無網路、資源清理、snapshot/run 關係及隱藏測試回應 schema。若 host 不是 Linux，Docker 測試仍是必要證據，不能只報 host unit test。

## 必須保存的證據

- 每個 run 的 `snapshot_id`、`submission_answer_id`、runner version、限制及狀態轉移。
- hidden test 負向測試的完整 response schema 與掃描結果。
- Docker compose health、Runner smoke、資源限制及 429 壓測結果。
- 惡意程式 fixture 的輸入、預期封鎖結果及實際輸出；不可把秘密放進 log。

## 風險與回退策略

- 風險：長駐同一容器不是強隔離。回退：P8 前只准內部測試，限制教師提供的程式／套件；正式放行需 gVisor、Kata 或 microVM／cgroup 方案及安全審查。
- 風險：hidden test 在例外或 debug log 泄漏。回退：集中式 response projection，禁止 runner 原始 payload 直接進學生端，加入反向測試。
- 風險：snapshot 與 run 關聯在重試時被覆寫。回退：run append-only、snapshot hash 唯一，評分讀固定 snapshot，schema 加 foreign key／unique constraint。

