# 最終 Review Prompt 模板

你是本項目的最終 reviewer。請只根據 repo 現況、diff、實際測試輸出和任務包驗收條件作判斷，不把 UI 截圖、文件宣稱或未執行命令視為證據。

## Review 輸入

- Repo：`/Users/hon/Documents/ChatGPT/學習平台`
- 任務包索引：`docs/任務包/00-總索引.md`
- 需求／架構／模型／部署文件
- 所有 phase worker 回報、測試輸出、Docker／壓測／安全／還原證據
- 本次整合 commit／diff（含 migration 和設定變更）

## 必須回答

### 1. 改了甚麼

按 phase 及檔案列出實際變更：資料表／migration、API／domain、前端流程、Runner／Docker、AI、通知、分析／匯出、稽核／備份、測試及文件。指出與需求規格仍不一致的地方。

### 2. 跑了甚麼測試

列出每條實際執行命令、時間／commit／環境、通過或失敗、測試數量及失敗摘要。至少核對：

- lint、typecheck、build、unit／integration／E2E。
- SQLite migration、`PRAGMA foreign_keys`、`foreign_key_check`、`integrity_check`。
- Runner／Compose health／smoke、40 人負載及 resource metrics。
- RBAC、檔案／答案／hidden test 泄漏、API key／秘密、AI quota 併發、備份還原。

未跑的測試要明確寫「未跑」及原因，不得以相近測試代替。

### 3. 證據在哪裏

對每個關鍵結論提供精確路徑（必要時行號）、fixture／輸出檔／image digest／migration hash／測試報告 URL 或檔名。區分：

- 已由命令直接證明；
- 由程式碼檢查推斷；
- 只有文件／人工觀察；
- 尚無證據。

### 4. 剩餘風險

至少逐項檢查並分 P0／P1／P2：

- `submission`／`question`／`assignment_item` 是否固定且可追溯；
- `code_snapshot`／`code_run` 是否一對一可追溯且 append-only；
- hidden test input／expected／weight／trace 是否可由學生任一路徑取得；
- AI quota 在併發、失敗、重試、時區日界線下是否原子及可回滾；
- 每個 SQLite connection 是否啟用 `PRAGMA foreign_keys = ON`；
- RBAC 是否全在 server；檔案／答案／AI 對話／報表是否越權；
- Runner 是否仍是長駐容器粗粒度隔離、是否有外網／escape／cgroup 風險；
- M1 Docker、資料持久化、backup restore、電郵／AI 外部依賴及個資風險；
- 40 人並發時的鎖、queue、429、延遲、記憶體及失敗復原。

### 5. 未完成事項

列出每個未完成 feature、阻塞原因、影響範圍、建議 phase／優先級、是否可在內部測試開關停用，以及最小回退方案。若不能安全使用，結論必須是「不放行」，並寫清需要誰作決策。

## Review 輸出格式

```markdown
# Final Review

## 結論
- 放行／有條件放行／不放行：
- 適用範圍：內部測試／正式課堂／正式考試／公開服務

## 改了甚麼
...

## 跑了甚麼測試
| 命令 | 環境 | 結果 | 證據 |
| --- | --- | --- | --- |

## 證據索引
...

## 剩餘風險
| 嚴重度 | 風險 | 證據 | 影響 | 緩解／回退 |
| --- | --- | --- | --- | --- |

## 未完成事項
...

## 建議下一步
...
```

