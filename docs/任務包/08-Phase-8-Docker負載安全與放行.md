# Phase 8：Apple Silicon Docker、40 人負載、安全與內部試用放行

## 目標

把所有 phase 組成可在 macOS M1 Docker Compose 本地重建、重啟及保留資料的完整後端平台，完成 40 人同時使用、Runner／權限／資料泄漏／備份還原的最終驗收，形成內部測試放行報告。

## 非目標

- 不在本 phase 擅自決定正式校內網域、SMTP、AI vendor 或 PostgreSQL 迁移。
- 不把 Docker Compose 的長駐 Runner 當作面向公眾的強安全執行環境。
- 不用「所有命令在本機未安裝」作為跳過驗收的理由；須保存可重現阻塞證據及替代測試。

## 允許修改範圍

- `Dockerfile`、`docker-compose.yml`、`services/runner/Dockerfile`、`.dockerignore`、`.env.example`。
- `scripts/**`、測試設定、migration entrypoint、healthcheck、volume／backup 配置。
- 必要的產品程式碼修補（須由測試證據驅動並在 review 報告列明）。
- `docs/本地部署.md`、README 及 P8 證據／放行報告。

## 禁止修改範圍

- 不降低 Runner 資源／網路／權限限制來「讓測試通過」。
- 不提交 `.env`、真實 API key、學生資料、備份內容或壓測個資。
- 不以刪除失敗測試、放寬 hidden test response 或關閉 audit 解決問題。

## 具體交付物

- M1／ARM64 可建置映像、明確健康檢查、Web／Runner／DB／檔案／backup volume 生命週期。
- 一鍵啟動／停止／migration／seed／smoke／backup／restore／log redaction scripts。
- 40 人場景的登入、教材讀取、執行、提交、教師查看進度及 AI fake provider／限額壓測。
- 安全測試：RBAC 越權、hidden test／他人答案泄漏、檔案路徑穿越、Runner escape／外網、秘密掃描、SQL／JSON 邊界、審計完整性。
- 內部測試放行報告、已知限制、監控指標、回退／停止服務步驟。

## 驗收條件

1. 在乾淨 Docker environment 可 build、start、health check；M1 不需強制 `linux/amd64`。
2. Web／DB／檔案容器重啟後帳戶、課程、提交、成績及設定仍在；backup restore 可在隔離環境重建。
3. 40 人同時使用不出現資料串線、權限越界、不可控 queue 或系統崩潰；失敗請求有明確狀態及可重試策略。
4. 所有 P1 風險均有負向測試證據：foreign keys、submission snapshot、snapshot/run、hidden test、quota atomicity。
5. 安全限制與剩餘風險明確寫入放行報告；未達強隔離不得用於正式考試或公開服務。

## 測試方式／命令

```bash
docker compose config
docker compose build --pull
docker compose up -d
docker compose ps
sh scripts/smoke-test-compose.sh
pnpm run lint && pnpm run build
node --test tests/**/*.test.mjs
```

負載測試使用固定、脫敏 fixture；記錄 p50／p95 latency、錯誤率、Runner queue／429、CPU／memory／disk、DB lock／foreign key 錯誤。安全測試及還原演練必須在獨立資料卷完成。

## 必須保存的證據

- `docker compose config`、image digest／platform、healthcheck、migration／restore log。
- 壓測工具版本、scenario、結果 JSON／HTML、資源圖及失敗請求樣本。
- 安全測試報告、秘密掃描結果、權限／資料泄漏負向案例。
- backup checksum／restore integrity、P1 風險 checklist 及放行／不放行決議。

## 風險與回退策略

- 風險：M1 依賴或第三方 binary 沒有 ARM64。回退：固定多架構映像或在隔離開發環境使用 amd64 並明確標記，不更改正式驗收標準。
- 風險：壓測暴露 SQLite lock／Runner queue。回退：調整佇列、索引、連線及限流；不能直接無限加資源或關閉資料一致性。
- 風險：Runner escape／外網限制不足。回退：停止正式使用，採 gVisor／Kata／microVM 或離線執行策略，直到安全 owner 簽核。

