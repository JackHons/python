# Phase 2：教材、檔案、題庫、功課與提交快照

## 目標

完成教師內容工作流及學生作答資料模型：教材與 PPT／PPTX／PDF／Word／圖片／CSV／Python／ZIP 上傳、受權下載、網頁教材草稿、題庫、七種題型、作業規則、固定抽題、提交及教師評分草稿。

## 非目標

- 不在本 phase 執行學生 Python 或公開／隱藏測試（交 P3）。
- 不接 AI 生成／翻譯／評語（交 P4）。
- 不做完整報表、電郵及即時課堂（交 P5／P6）。

## 允許修改範圍

- `db/**` 及內容／作業／提交相關 migration。
- 新增 `server/materials`、`server/questions`、`server/assignments`、`server/submissions` 或等價 API／domain／repository。
- `app/api/**` 對應端點及最小教師／學生頁面整合。
- `storage/**` 或本地檔案 adapter、檔案驗證及 P2 測試。
- `.env.example`／Compose volume 設定如為本地檔案持久化所必需。

## 禁止修改範圍

- `services/runner/**`、AI vendor、通知／電郵、分析／備份。
- 不得把 hidden test input／expected output 放進學生 API、HTML、瀏覽器狀態或公開下載檔。
- 不得以修改原始題目取代 submission snapshot。

## 具體交付物

- 檔案上傳的 MIME／副檔名／大小／雜湊／所有權／quarantine 狀態及受權下載。
- `materials`／版本與雙語內容、PPT 原檔與播放／轉換狀態欄位；轉換可先以非同步 job 契約佔位。
- `questions`、`question_pools`、`test_cases`、`rubrics`、`assignments`、`assignment_items`。
- 選擇、填充、簡答、程式填空、完整編程、檔案上傳、專題的 schema／validation／草稿 UI/API。
- 開始作答交易：依規則抽題、固定排序，建立 `submissions` 及 `submission_answers` snapshot。
- 截止、逾期、補交、重試、公布答案／分數及教師手動評分契約。

## 驗收條件

1. 教師可建立／編輯／發布／封存內容；學生只能看到已發布且已到時間的版本。
2. 同一 submission 的 `(assignment_id, student_id, attempt_number)` 唯一；刷新、重送、併發開始不會得到兩份或不同題目集合。
3. `submission_answers` 保存題目版本／題幹／選項／評分設定的固定快照，原題日後修改不改寫歷史提交。
4. 檔案只可由擁有者、獲授權教師或符合課程範圍的學生下載；檔案類型與大小限制不可由前端繞過。
5. 學生提交後可立即收到允許的自動結果欄位；教師草稿、標準答案及未公布評語仍不可見。
6. 所有寫入具冪等鍵或明確交易邊界；失敗不能留下「submission 有了但沒有固定答案」的半完成狀態。

## 測試方式／命令

```bash
pnpm exec drizzle-kit check
pnpm exec tsc --noEmit
node --test tests/materials.integration.test.mjs tests/questions.integration.test.mjs tests/assignments.integration.test.mjs tests/submissions.integration.test.mjs
```

另以 API fixture 測試：多語內容、七種題型、逾期／重試／補交、併發開始作答、原題修改後 snapshot 不變、越權下載、檔案大小／MIME／路徑穿越及 hidden test 欄位不存在於學生回應。

## 必須保存的證據

- migration／schema diff 及資料庫約束列表。
- 開始作答前後的題目 ID、snapshot hash、attempt number。
- 學生 API response 的欄位白名單（證明沒有 hidden input／expected）。
- 上傳拒絕案例、受權下載案例及交易回滾 log。

## 風險與回退策略

- 風險：`submission`、`question`、`assignment_item` 關係含糊。回退：以固定 `submission_answers.question_snapshot_json`（或等價不可變版本）為唯一評分輸入，不能在評分時重新讀可變題目。
- 風險：物件儲存尚未決定。回退：使用可替換 local filesystem adapter，storage key 不暴露真實路徑，日後再換 S3／R2。
- 風險：PPT 轉換工具在 M1 不可用。回退：先可靠保存原檔、下載及轉換 job 狀態；轉換失敗不可阻止原檔教材發布。

