# Phase 7 Review Prompt

請以 repo 現況及 docs/任務包/證據/phase7-tests.txt 為唯一證據，審查本次前後端整合。

## 已改動

- 新增 server/http/backend.ts、server/http/index.ts、server/http/cli.ts：獨立 Node HTTP backend，持有 SQLite、storage、session、runner、AI、通知、分析、匯出及 backup domain service。
- worker/index.ts 新增 /api/v1/** 同源 proxy；只由 server side 注入 backend internal token，保留 /api/run 相容入口。
- 新增 app/lib/api-client.ts，前端 production 預設從 session 取得角色；任意角色切換只在 NEXT_PUBLIC_DEMO_MODE=true 顯示。
- backend 提供身份／課程／單元／教材／檔案／題目／功課／提交／執行／通知／AI fail-closed／課堂／分析／匯出／管理員狀態核心 route。
- 首次改密碼 gate：must_change_password session 只能使用 me、logout、change-password；production internal token 缺失或少於 24 字元時 backend startup fail closed。
- 新增 tests/backend.contract.test.mjs、tests/backend.e2e.test.mjs 及本證據檔；E2E 覆蓋帳戶、班別 enrollment、教材、公開／隱藏 testcase、作答／執行／評分／發布、AI review gate、課堂、XLSX 匯出及重啟持久化。

## 已跑測試

請重跑並列出實際輸出：

    node --experimental-strip-types --test tests/backend.contract.test.mjs tests/backend.e2e.test.mjs
    node --experimental-strip-types --test tests/auth.integration.test.mjs tests/rbac.integration.test.mjs tests/import.integration.test.mjs tests/education-api.integration.test.mjs
    node --experimental-strip-types --test tests/materials.integration.test.mjs tests/questions.integration.test.mjs tests/assignments.integration.test.mjs tests/submissions.integration.test.mjs
    node --experimental-strip-types --test tests/runner-proxy.test.mjs tests/execution.integration.test.mjs tests/grading.integration.test.mjs tests/hidden-tests.security.test.mjs
    node --experimental-strip-types --test tests/ai-provider.unit.test.mjs tests/ai-quota.concurrency.test.mjs tests/ai-review.integration.test.mjs tests/ai-privacy.security.test.mjs
    node --experimental-strip-types --test tests/classroom.integration.test.mjs tests/notifications.integration.test.mjs tests/email.retry.test.mjs tests/classroom.rbac.security.test.mjs
    node --experimental-strip-types --test tests/analytics.integration.test.mjs tests/export.excel.test.mjs tests/export.pdf.test.mjs tests/audit.integration.test.mjs tests/backup.restore.test.mjs
    node ./node_modules/typescript/bin/tsc --noEmit
    node ./node_modules/eslint/bin/eslint.js . --ignore-pattern dist --ignore-pattern .next
    node ./node_modules/drizzle-kit/bin.cjs check
    node ./node_modules/vinext/dist/cli.js build
    node --test tests/rendered-html.test.mjs

## 必須回報

1. 實際改了甚麼（按檔案與 API／安全邊界）。
2. 每條命令結果、測試數量與證據路徑。
3. hidden test、session／CSRF／RBAC、backend token、資料持久化是否有直接證據。
4. Docker backend/runner compose、40 人負載、瀏覽器 viewport、真實 AI／SMTP、PPT 轉換及 CJK PDF 字型均屬未驗證項，不能宣稱通過。
5. 剩餘風險及回退：P8 才驗證 Docker/負載；production AI 未配置時必須維持 fail-closed；UI 尚未提供完整內容 studio、submission list/grade 表單及 backup restore 表單，這些不得標示為已完成。
