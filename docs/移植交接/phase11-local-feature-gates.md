# Phase 11 本機功能驗收紀錄

驗證日期：2026-09-21

本紀錄只描述目前交接工作區的本機驗證，不代表正式部署、正式 AI／SMTP 供應商或瀏覽器／裝置驗收已完成。

## 本輪完成的功能域

- AI 摘要、翻譯、評語、建議分數：後端以結構化輸出建立 `pending_review` 草稿；教師批准後才可發布，建議分數不會直接改寫正式成績。
- 考試模式：限制教材、提示、AI 與同一學生的其他進行中考試；tab／visibility／focus／route 事件只作稽核記錄，不宣稱防作弊。
- 程式相似度：只比較同一作業中已提交的程式答案，保存可覆核報告，教師可確認或駁回，學生無法讀取報告。
- 遊戲化：提交事件以唯一事件鍵去重，產生 XP、連續學習日與徽章；學生可讀自己的成就，課程排行榜受管理員開關控制。

## 實跑結果

```text
npx tsc --noEmit                       PASS
node --test tests/gamification.integration.test.mjs       PASS (1/1)
node --test tests/gamification-http.integration.test.mjs  PASS (1/1)
npm run test:all                       PASS (132 passed, 0 failed, 2 skipped, 134 total)
```

兩個 skipped 測試需要外部提供 `PPTX_FIXTURE_PATH`，不是測試失敗：

- 真實 PPTX release／dedup／reuse／byte-for-byte download
- 真實 PPTX conversion／PDF／slide manifest

## 剩餘風險

- Runner 仍不是公網／高風險考試所需的 disposable 強隔離沙箱。
- 正式 AI provider、SMTP vendor/domain/TLS、真實 PPTX fixture、Python runtime matrix、其他 OS/CPU 尚未在此環境完成。
- 完整瀏覽器、裝置、鍵盤／無障礙與 40 真分頁驗證尚未完成；考試切頁事件目前只能提供 server-side policy 與稽核資料。
- 程式相似度的閾值、誤報處理與資料保留政策仍需由學校確認。
