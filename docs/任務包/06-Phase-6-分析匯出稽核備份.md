# Phase 6：學習分析、Excel／PDF、稽核與備份

## 目標

把提交、執行、AI、通知及課堂事件聚合成教師可用的進度／成績／錯誤／學習時間分析；提供權限受控的 Excel／PDF 匯出；建立完整 audit、可開關的排程備份、校驗及還原演練。

## 非目標

- 不在報表層重新計算或修改正式成績。
- 不把未授權的全校資料提供給教師；不以前端篩選代替服務端範圍。
- 不備份 Runner 臨時工作目錄或 API key 明文。

## 允許修改範圍

- 新增 `server/analytics/**`、`server/exports/**`、`server/audit/**`、`server/backups/**` 及 migration。
- Excel／PDF generator、job／storage adapter、管理員／教師報表頁面。
- `.env.example`、Compose volume／backup 設定、P6 測試及部署文件。

## 禁止修改範圍

- 不改寫 P1–P5 的原始事件／成績語義；若需修正，先更新契約並回報主 agent。
- 不在 audit metadata 保存密碼、token、API key、完整答案或 hidden test。
- 不允許報表 job 以未授權的任意 `student_id`／`course_id` 查詢。

## 具體交付物

- 學生完成率／分數／作答次數／學習時間、每題正確率／常見錯誤、AI 提示／用量、修改／貼上／執行歷程及班別比較查詢。
- 教師範圍的成績表 Excel、分析 PDF、匯出 job 狀態、下載期限及錯誤重試。
- 統一 audit event schema：登入、拒絕、內容、成績、AI、匯出、設定、備份等。
- 手動／每日排程 backup 開關、DB／檔案／設定清單、加密／校驗、保留期限、還原前驗證及記錄。

## 驗收條件

1. 教師報表只包含其有效課程／班別學生；學生只能讀自己；管理員才能讀全校設定及營運統計。
2. Excel／PDF 與頁面同一資料快照，包含生成時間、時區、篩選範圍及報表版本。
3. 每項敏感操作可由 audit 追到 actor、target、時間、結果及 request correlation id；秘密與完整答案已脫敏。
4. 備份開關關閉時不產生排程備份；開啟後可生成、校驗、保留及刪除舊備份，手動還原演練成功並留記錄。
5. 報表／備份失敗不改變正式資料或成績，且可安全重試。

## 測試方式／命令

```bash
pnpm exec tsc --noEmit
node --test tests/analytics.integration.test.mjs tests/export.excel.test.mjs tests/export.pdf.test.mjs tests/audit.integration.test.mjs tests/backup.restore.test.mjs
```

另用 fixture 測試範圍越權、時區／截止邊界、大資料量分頁、空資料、CSV formula injection、PDF 生成失敗、checksum mismatch、備份開關及還原 smoke。

## 必須保存的證據

- 查詢範圍／授權 SQL log 或測試 fixture、匯出檔 hash／metadata。
- Excel／PDF 開啟驗證結果及不含越權資料的掃描。
- audit schema／脫敏輸出。
- 備份檔 checksum、manifest、還原前後 integrity／foreign key check 及演練記錄。

## 風險與回退策略

- 風險：長報表阻塞 Web。回退：改為非同步 job，先返回 job ID；原始事件保留可重算。
- 風險：PDF／Excel library 在 M1／Docker 差異。回退：固定映像依賴並保留 CSV fallback，但未驗證格式不能宣稱完成。
- 風險：備份成功但無法還原。回退：每次發布前必須在隔離資料庫還原並執行 integrity／foreign key check；不通過則阻止 P8。

