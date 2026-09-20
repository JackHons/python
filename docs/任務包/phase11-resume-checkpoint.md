# Phase 11 可恢復檢查點

更新時間：2026-09-17（Asia/Macau）

本文件是使用者要求暫停時的唯一恢復入口。Phase 11 尚未 merge、tag 或 push；恢復後不得重做已完成切片。

## Git 與工作區

- Phase 9B 基線：`09dd0e1048ee73b3f567c816bd5283ac563f1cc3`
- 基線 tag：`phase9b-baseline-20260823`
- Phase 11 worktree：`/Users/hon/Documents/ChatGPT/學習平台-phase11`
- Phase 11 branch：`codex/phase11-role-routing`
- 目前 branch HEAD：`6e49bff`（產品程式碼 HEAD：`b4a4dc7`）
- 主工作區：`/Users/hon/Documents/ChatGPT/學習平台`，暫停時為 clean，Phase 11 不在主工作區寫入。

## 已有 commits（由基線順序列出）

1. `ffe158d` — `feat: add role routes and API scope contracts`
2. `913d57c` — `feat: add versioned shared teaching materials`
3. `b6be494` — `wip: checkpoint Phase 11 role routing`
4. `e14c209` — `feat: complete AI provider and progressive hint flows`
5. `8ada3d6` — `feat: complete live classroom routes and controls`
6. `f1845f3` — `docs: finalize Phase 11 contracts and validation`
7. `70c570c` — `fix: enforce route methods and deep-link hydration`
8. `a7a22f1` — `fix: close archived question and stale fetch gaps`
9. `4a91ec3` — `fix: harden classroom hints files and scope revalidation`
10. `129b78d` — `fix: revalidate execution submission scope`
11. `b4a4dc7` — `fix: revalidate AI conversation scope`

## 已完成功能

- 學生、教師、管理員 canonical file routes、角色側欄、相容入口、安全 returnTo，以及 URL-driven course/unit/assignment/submission deep-link hydration。
- API method-specific route manifest、精確 405/Allow、command POST、legacy PUT/AI alias Deprecation/Sunset，以及 known-ID RBAC／404 scope。
- 教材庫及課程單元雙上傳入口、quarantine/signature/release、預設 school、reference/copy、不可變版本、published pin、顯式 upgrade、owner/admin 刪除與引用衝突 409。
- 教材及批改頁使用 AbortController + generation guard；舊成功或錯誤回應不可覆蓋新 route／selection。
- 多 AI provider 唯一 active、顯式 activate、mask/rotate/disable、無 fallback、學生安全 status DTO。
- 教師手寫／AI draft hints、教師審核、最多三層、學生逐層持久解鎖、冪等及學生隔離；已解鎖提示不可改寫。
- 教師／學生即時課堂 list/detail、start/pause/lock/reopen/end、events/heartbeat/reconnect、匿名 projection、lock/ended 時學生寫入 423。
- Classroom activity/transition/end 的 idempotency recheck 與 event write 位於同一 `BEGIN IMMEDIATE` transaction。
- 學生 submission/hint/classroom/AI 每次重驗 published course、active enrollment 及 assignment/question scope；退選、封存或功課／題目失效後 404。
- Backend／Gateway 自身錯誤回應均帶 `x-request-id`；未知錯誤 log 遮蔽 secret 與任意 absolute path。
- Migration 0010/0011 已在隔離 DB 驗證 rollback/reapply、`foreign_keys=1`、integrity/FK。

詳細產品及限制證據見：

- `docs/任務包/11-Phase-11-角色路由與教學流程.md`
- `docs/任務包/證據/phase11-validation.txt`
- `docs/任務包/phase11-review-prompt.md`

## 獨立驗收狀態

- 最新完整 Node 回歸：`97 total / 95 pass / 0 fail / 2 skip`；兩項真實 PPTX 測試因未提供 `PPTX_FIXTURE_PATH` 跳過，沒有讀取使用者 PPT。
- 最新獨立 route targeted：`34/34`；最新 backend security targeted：`31/31`；兩者 `P0/P1/P2 = 0`。
- 最新 `b4a4dc7` isolated Docker：config 通過、六服務 sequential build `6/6`、六服務 healthy、smoke 通過、Gateway evil-Origin `403`／same-origin 未認證 `401`；未接觸 live project/volumes/secrets。
- TypeScript、ESLint、production build、`git diff --check` 均通過；Python runner matrix 為歷史證據，本次沒有重跑。

## 暫停時尚未完成

- Backend 第三次安全複驗、修復後回歸與 isolated Docker gate 均已完成，P0/P1/P2 均為 0。
- 主 agent 對 baseline 到 Phase 11 HEAD 的完整 diff、證據與風險 review 已完成。
- Merge 到 baseline 與可選 tag；目前均未執行。
- Live Compose rebuild／recreate；必須由使用者再次明確確認後才可執行。

## 下次恢復順序

1. 若繼續工作，先讀本檢查點並從 `b4a4dc7` 開始，不要重做已完成切片。
2. 只有在沒有 P0/P1 且使用者明確同意後，才 merge 到 baseline；需要時再建立放行 tag。不得提前 tag。
3. Live Compose 只可在使用者明確確認後 rebuild/recreate；不得以 isolated 驗收自動推導 live 寫入授權。

## 恢復命令

```sh
cd '/Users/hon/Documents/ChatGPT/學習平台-phase11'
git branch --show-current
git rev-parse HEAD
git status --short
git log --oneline --decorate 09dd0e1048ee73b3f567c816bd5283ac563f1cc3..HEAD
export PATH='/Users/hon/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/Users/hon/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback:'"$PATH"
pnpm test:all
pnpm exec tsc --noEmit
pnpm lint
pnpm build
git diff --check 09dd0e1048ee73b3f567c816bd5283ac563f1cc3..HEAD
```

若要重跑真實 PPT 測試，必須由操作員顯式提供只讀 fixture，且不得把路徑寫回 repo：

```sh
PPTX_FIXTURE_PATH='/operator/provided/read-only-fixture.pptx' pnpm test:all
```

## Docker 與資料安全禁令

- 不得修改、提交或輸出 `.env`、`.local-secrets`、初始密碼、session token、AI key 或 backend/runner token。
- 不得使用 live SQLite、live storage、live exports/backups 或使用者 PPT 作測試資料。
- migration、HTTP、負載、restore、conversion 及 Docker 驗收只可使用 temp DB/storage 或獨立 Compose project/volumes。
- 不得執行 `docker compose down -v`，不得刪除、清空、重建或覆蓋既有 live volume。
- 不得在未取得使用者明確確認前 rebuild/recreate live Compose。
- 不得 merge、tag、push、設定 remote 或重寫歷史；恢復後仍由主 agent 獨立 review 再決定。
- 不得把 fake AI、local SMTP、queued conversion、client guard 或長駐 Runner 說成正式供應商、完成轉換、SSR 403 或強沙箱。
