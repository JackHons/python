# Phase 1：資料基礎、帳戶、RBAC、班別與課程

## 目標

建立可持久化、可測試的伺服器端基礎：SQLite／Drizzle 連線與 migration、帳戶登入、首次改密碼、密碼重設、三角色 RBAC、班別、教師名單匯入、課程建立及班別／課程代碼加入。所有授權必須在伺服器端以資料範圍檢查。

## 非目標

- 不實作教材轉換、題庫、提交、Runner、AI、電郵、報表或即時課堂。
- 不在前端用隱藏按鈕代替權限。
- 不改變既有產品視覺，除非為登入／錯誤狀態提供最小整合。

## 允許修改範圍

- `db/**`、Drizzle migration／設定。
- 新增後端 domain／API／auth／validation／repository 檔案（建議 `server/`、`app/api/` 或既有框架等價位置）。
- `.env.example`、必要的部署設定及 P1 測試檔。
- `docs/任務包/**` 可補充契約，但不可改寫已完成 phase 的驗收結論。

## 禁止修改範圍

- `services/runner/**`、Runner 契約及評分邏輯。
- AI、通知、分析、備份及前端整頁功能。
- 不得刪除既有 migration 或破壞原型 `/api/run`。

## 具體交付物

- 可重建的 SQLite schema／migration／seed（不得包含真實學生資料）。
- `users`、`auth_sessions`、`classes`、`class_memberships`、`courses`、`course_class_assignments`、`course_enrollments`、`units` 的 CRUD／查詢服務。
- CSV／Excel 匯入的格式驗證、重複及錯誤報告；初始密碼只以一次性流程交付並強制首次更改。
- Session token 雜湊保存、登出、失效、登入節流／鎖定及審計事件骨架。
- 每個 SQLite 連線明確執行 `PRAGMA foreign_keys = ON`，並測試 `foreign_key_check`／`integrity_check`。
- API 錯誤格式、角色／範圍授權表及 P1 契約測試。

## 驗收條件

1. 管理員可建立教師／學生；教師只能管理所屬班別與自己擁有或獲分派的課程。
2. 學生不能讀取其他班別、教師草稿或任意 `course_id`／`student_id` 資料。
3. CSV／Excel 匯入對壞資料逐列報錯且不半成功；成功建立的學生首次登入必須改密碼。
4. 班別加入及課程代碼加入具冪等性，離班／封存不破壞教務稽核資料。
5. 啟用 foreign keys 後，孤兒外鍵寫入被拒絕；migration、重啟及交易回滾後資料一致。
6. 密碼、session token、匯入檔案及權限錯誤不會出現在一般日誌。

## 測試方式／命令

```bash
pnpm exec drizzle-kit check
pnpm exec tsc --noEmit
pnpm exec eslint db server app/api tests
node --test tests/auth.integration.test.mjs tests/rbac.integration.test.mjs tests/import.integration.test.mjs
```

測試需使用隔離臨時 SQLite；最少涵蓋登入／換密碼／重設、三角色越權、課程加入冪等、匯入回滾、foreign key check、session 撤銷及審計事件。

## 必須保存的證據

- migration hash、SQLite pragma／integrity 輸出。
- API 測試完整輸出及 fixture 路徑。
- 角色矩陣與每個拒絕案例的 HTTP status／錯誤碼。
- 匯入前後資料筆數及失敗列報告。

## 風險與回退策略

- 風險：現有 schema 與產品關係不一致。回退：新增 migration，保留舊欄位；不得以 destructive migration 修正。
- 風險：SQLite connection pool 忘記開啟 foreign keys。回退：把 pragma 放入唯一連線 factory，並用測試攔截每次新連線。
- 風險：session 方案與 vinext／Worker runtime 不相容。回退：先抽象 `SessionStore`，可用 SQLite store，保留日後 D1／Postgres adapter。

