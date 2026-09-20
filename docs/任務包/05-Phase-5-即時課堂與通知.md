# Phase 5：即時課堂、公告、站內通知與電郵

## 目標

提供教師課堂控制面：發布即時題目／活動、查看全班進度、匿名展示、開始／結束／鎖定活動；同時建立站內通知、教師公告及可重試的電郵投遞。

## 非目標

- 不把瀏覽器切頁偵測宣稱為絕對防作弊。
- 不重新實作課程／提交／AI／報表核心。
- 不強行指定正式 SMTP vendor；以可替換 adapter 及本地 fake mailbox 驗收。

## 允許修改範圍

- 新增 `server/classroom/**`、`server/notifications/**`、email adapter 及相關 migration。
- `app/api/**`、教師即時課堂及學生活動頁面的必要整合。
- Compose／`.env.example` 的郵件設定、job runner 及 P5 測試。

## 禁止修改範圍

- 不改變 P1 的授權邊界；不向學生送其他學生的姓名、答案、程式或私密活動資料。
- 不以 WebSocket 連線狀態作唯一成績來源。
- 不直接在 request 內無限重試電郵。

## 具體交付物

- 即時課堂 session／活動／participant presence／lock／匿名答案 projection。
- 教師開始、暫停、結束、鎖定及重新開放活動的權限與冪等 API。
- `announcements`、`notifications`、`email_deliveries` 及事件觸發（功課發布、截止提醒、批改完成、公告）。
- Email provider interface、佇列／重試／退避／冪等 key、失敗及退信狀態。
- 教師投影頁與學生狀態頁，斷線重連後可從伺服器恢復狀態。

## 驗收條件

1. 只有授權教師可控制其課程／班別活動；學生不能控制、讀取未加入班別或已封存活動。
2. 全班進度、匿名答案及鎖定狀態在重新整理／短暫斷線後與伺服器一致。
3. 同一事件重送不重複通知或電郵；電郵失敗可查詢、重試且不阻塞提交。
4. 通知只送到事件發生時有效且獲授權的收件人；電郵正文不含 hidden test、API key 或非必要個資。
5. 活動鎖定時學生提交 API 在伺服器端拒絕，不能靠前端 disabled 避免。

## 測試方式／命令

```bash
pnpm exec tsc --noEmit
node --test tests/classroom.integration.test.mjs tests/notifications.integration.test.mjs tests/email.retry.test.mjs tests/classroom.rbac.security.test.mjs
```

使用 fake clock／fake mailer 測試活動狀態機、斷線重連、併發控制、事件冪等、退避重試、取消／退信及通知範圍。

## 必須保存的證據

- 活動狀態轉移及教師／學生授權 response。
- 匿名 projection fixture（無原作者個資）及鎖定時拒絕提交 response。
- notification／email delivery idempotency key、重試次數、fake mailbox 與退信輸出。

## 風險與回退策略

- 風險：即時傳輸依賴特定 runtime。回退：先用 polling／SSE 及版本號完成正確性，WebSocket 只作優化。
- 風險：郵件 provider 未決定。回退：保留站內通知為可靠通道，email adapter 可停用，所有失敗寫入 delivery 狀態。
- 風險：匿名答案仍可由內容推斷學生。回退：只展示教師選擇的匿名投影並可停用，不能承諾完全匿名。

