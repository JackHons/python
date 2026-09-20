# Phase 4：AI 供應商、原子限額、對話保存與教師審核

## 目標

建立 vendor-neutral AI service：管理員設定供應商／模型／加密 API key／每日及全校限額；學生獲得符合政策的逐步提示；對話、用量、延遲與錯誤可審計；AI 生成教材、翻譯、題目、評語及建議分數必須經教師預覽確認後才可發布或計入成績。

## 非目標

- 不把 AI 當作唯一評分器或權限來源。
- 不把 API key 傳入瀏覽器、Runner、學生 prompt 或一般 log。
- 不在本 phase 重做題目／提交／Runner 的核心資料模型。

## 允許修改範圍

- 新增 `server/ai/**`、provider adapter、prompt policy、quota service、review workflow 及對應 migration。
- `db/**` 的 AI／用量／審核欄位；必要 API／教師／學生頁面整合。
- `.env.example`、secret／加密設定、AI 單元／整合／併發測試。

## 禁止修改範圍

- 不更改 Runner 安全邊界或直接存取學生資料庫以外的秘密。
- 不繞過教師 review 狀態發布 AI 內容。
- 不以客戶端計數代替配額；不保存停用保存時的 prompt／response 正文。

## 具體交付物

- `AiProvider` interface 及至少一個可替換 adapter；timeout、重試、錯誤映射及模型記錄。
- key 加密保存、遮罩顯示、輪換／停用；設定變更寫 audit。
- 原子 `ai_daily_quotas` 預留／結算流程，支援請求數及 token 上限、時區日界線、併發 rollback。
- AI 對話保存／停用／保留期限清理；任課教師依課程範圍查看，學生只能看自己。
- AI 產物狀態機：`draft -> pending_review -> approved/rejected -> published`；教師批准人與時間可追溯。
- 提示層級、嘗試次數、完整解答開關及資料最小化。

## 驗收條件

1. 管理員可設定 vendor／model／限額；學生／教師 API 永不回傳明文 key。
2. 併發 AI 請求在 DB 原子條件下不超額；供應商失敗會釋放預留額，不產生虛假成功用量。
3. 停用對話保存時不寫正文，但仍可保存不含正文的用量／延遲統計；清理 job 遵守保留日數。
4. AI 生成教材／翻譯／題目／評語／建議分在教師批准前，學生端及正式 grade 查詢均不可見。
5. AI 助教只能收到必要題目／程式／錯誤資料，不帶姓名等非必要個資；不同角色及課程範圍無越權。
6. 用量、政策拒絕、provider 錯誤、review、key 變更均有不含秘密的 audit。

## 測試方式／命令

```bash
pnpm exec tsc --noEmit
node --test tests/ai-provider.unit.test.mjs tests/ai-quota.concurrency.test.mjs tests/ai-review.integration.test.mjs tests/ai-privacy.security.test.mjs
```

使用 fake provider，不依賴真實外部 API；以 40／100 個併發請求驗證 quota，模擬 timeout、429、5xx、部分流式回應及交易回滾。另測試時區日界線、停用保存、保留清理及教師／學生資料範圍。

## 必須保存的證據

- quota DB 前後值、每次 request 的 reservation／settlement／rollback ID。
- fake provider 呼叫 payload 的脫敏版本及 key 不存在證據。
- review 狀態轉移及未批准內容的學生 API 403／404 或欄位缺失。
- 併發測試、清理 job、audit 輸出及失敗 provider 的回滾結果。

## 風險與回退策略

- 風險：`UPDATE ... WHERE remaining >= cost` 以外的非原子計數會超額。回退：配額服務只能透過單一 transaction／conditional upsert，禁止 controller 直接寫 usage。
- 風險：第三方 SDK 把 prompt／key 寫入 debug log。回退：統一 adapter、redaction middleware 及 fake provider；預設 production log 不記正文。
- 風險：AI 分數被誤當正式分數。回退：資料庫分欄保存 `ai_suggested` 與 `final`，只有 approved teacher review 能推進 release。

