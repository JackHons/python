# Phase 11 部署測試紀錄

日期：2026-09-21

測試使用獨立 Compose project `phase11-deploy-20260921`，Gateway 暴露於 `http://127.0.0.1:3331`；未讀取或修改既有 live project／volume。

## 結果

- Docker 29.6.2、Compose v5.3.1；`docker compose config --quiet` 通過。
- 六個服務均啟動並 healthy：gateway、web、backend、runner、converter、email-worker。
- Gateway `/health`：HTTP 200；回報 backend/web ready。
- 未登入 `/api/v1/me`：HTTP 401。
- production legacy `/api/run`：HTTP 404。
- backend `/ready`：`status=ok`、`database=ok`、`foreignKeys=1`。
- Runner 直接執行 Python：`print(2+3)` 成功。
- 管理員登入、強制改密碼、`/admin/status`：成功。
- 學生登入、課程／功課讀取、建立提交、保存答案：成功。
- 後端→Runner 實際評分：HTTP 200、execution `passed`，公開與隱藏案例均 passed。
- 提交後遊戲化 profile：HTTP 200、XP=10；學生讀取 admin API：HTTP 403。
- backend restart 後恢復 healthy；資料卷仍有 1 課程、3 帳戶、15 migrations。

## 建置注意

`docker compose up -d --build` 與 `docker compose build` 在本機 Docker Desktop BuildKit／Compose Bake 觸發既有錯誤：

```text
header key "x-docker-expose-session-sharedkey" contains value with non-printable ASCII characters
```

因此本次先以等價的 `docker build` 建立六個 Compose 對應 image，再以 `docker compose up -d --no-build` 啟動；服務運行與功能 smoke 通過，但該 Docker Desktop／Compose Bake 問題仍需在部署主機修復後重測原生 `compose --build` 路徑。

## 清理

測試完成後只執行 `docker compose -p phase11-deploy-20260921 down`，不使用 `-v`；容器移除，隔離 volumes 保留供檢查。未測試公網 TLS、正式 AI／SMTP、真實 PPTX、其他 OS／CPU 或 disposable 強沙箱。
