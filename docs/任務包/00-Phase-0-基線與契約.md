# Phase 0：基線盤點與實作契約

## 目標

把現有原型、資料模型、Runner、Docker 及測試變成後續實作可依賴的明確基線；拆解產品範圍、依賴、API／資料契約及每個 phase 的驗收證據。

## 非目標

- 不實作登入、API、資料庫服務、AI、通知、報表或新的 UI 功能。
- 不宣稱現有 Runner 已達正式不可信程式隔離要求。
- 不啟動瀏覽器、Docker 或部署環境。

## 允許修改範圍

- `docs/任務包/**`。
- 只有在主 agent 明確批准後，才可修改根 `README.md`；本 phase 不需要。

## 禁止修改範圍

`app/`、`worker/`、`db/`、`services/`、`Dockerfile`、`docker-compose.yml`、`scripts/`、`tests/`、package／migration／設定檔、`.openai/` 及任何產品程式碼。

## 具體交付物

- 總索引及 phase 依賴圖。
- P1–P8 計劃，每份包括目標、非目標、修改範圍、禁止範圍、交付物、驗收、測試、證據、風險與回退。
- 通用 subagent 執行 prompt。
- 最終 review prompt 模板。
- 盤點報告：已存在資產、缺口及五項 P1 風險的安排。

## 驗收條件

1. 任何後續 worker 能只閱讀任務包便知道自己可改甚麼、要交付甚麼及如何驗收。
2. 五項 P1 風險已安排在最早合理 phase：submission／question 關係（P2）、snapshot／run 關係及 test case 泄漏（P3）、AI quota 原子性（P4）、SQLite `foreign_keys`（P1）。
3. 任務包涵蓋需求中的帳戶、內容、作業、Runner、AI、即時課堂、通知、分析、匯出、稽核、備份、前後端整合及 40 人測試。
4. 沒有把原型畫面、手動點擊或未執行的命令寫成已驗收功能。

## 測試方式／命令

```bash
find docs/任務包 -maxdepth 1 -type f -name '*.md' -print | sort
rg -n '目標|非目標|允許修改|禁止修改|交付物|驗收條件|測試方式|證據|風險|回退' docs/任務包/*.md
git diff --check -- docs/任務包
```

Phase 0 只做文件自檢，不跑應用、Docker 或瀏覽器。

## 必須保存的證據

- `git diff -- docs/任務包/`。
- 文件清單、`rg` 自檢輸出及 `git diff --check` 輸出。
- 盤點時使用的 repo 檔案路徑及明確「已存在／未證明／缺失」分類。

## 風險與回退策略

- 風險：現有 schema 可能比文件更完整或更不完整。回退：每個實作 phase 以實際 migration／查詢測試為準，不能只依賴本文件。
- 風險：Docker 在當前工作環境不可用。回退：先完成不依賴 Docker 的契約／單元測試，將 Compose smoke test 保留為 P8 閘門。
- 風險：不同 worker 同時改動相同 API。回退：由主 agent 鎖定契約檔，跨 phase 修改須先回報。

