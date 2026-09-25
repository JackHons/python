# C2C-6A3F 依賴風險審查與回歸證據

日期：2026-09-26（Asia/Hong_Kong）  
範圍：Phase 11 交接工作區 root application、converter runtime 與其 lockfile；不包含 Runner、UI 視覺、正式 AI/SMTP vendor 或其他 OS/CPU。

## 結論

本輪完成一次乾淨安裝、逐項 audit 分類、相容版本更新與正式建置回歸。沒有使用 `npm audit fix --force`、沒有加 dependency override，也沒有進行 major migration 或產品架構改動。

目前依賴風險不是「零 advisory」：

- production audit：`xlsx@0.18.5` 仍有 1 個 high severity advisory，npm 回報沒有可用修復版本。
- full audit：共 5 個 advisory（4 moderate、1 high）。另外 4 個是 Drizzle migration tooling 的 dev-only `esbuild` chain（`drizzle-kit`、`@esbuild-kit/core-utils`、`@esbuild-kit/esm-loader`、`esbuild`），不在 production/runtime dependency path；npm 提議退回 `drizzle-kit@0.18.1`，不是本輪可接受的相容安全修補。
- 因此本項完成「盤點、分類、可安全升級項目與明確例外」，但 `xlsx` 仍是交接中的 production exception，不能標成零風險結案。

## 安裝與版本變更

環境：Node `v24.21.0`、npm `11.19.0`、lockfile version 3。

乾淨隔離目錄的 baseline：`npm ci` 成功、`npm ls --all` 成功；audit 為 24 項（17 high、6 moderate、1 low）。production-only baseline 已由直接依賴 `xlsx@0.18.5` 形成 1 個 high advisory。

本輪套用的直接依賴更新：

- runtime：`react` / `react-dom` `19.2.6 → 19.3.0`。
- build/runtime tooling：`@cloudflare/vite-plugin` `1.37.1 → 1.60.1`、`@cloudflare/workers-types` `4.20260702.1 → 5.20260925.2`、`@vitejs/plugin-rsc` `0.5.26 → 0.5.35`、`drizzle-kit` `0.31.10 → 0.31.11`、`react-server-dom-webpack` `19.2.6 → 19.3.0`、`vinext` `1.0.0-beta.2 → 1.0.0-beta.12`、`vite` `8.0.13 → 8.3.1`、`wrangler` `4.92.0 → 4.140.0`。
- 以上版本更新同步更新 peer dependencies 與 lockfile；`xlsx` 保留原版本，因 upstream 沒有可用修復版本且它是目前的實際 import/export 路徑。
- `vite.config.ts` 保留 production 的 Cloudflare plugin；只有 `mode=test` 的 Node 測試 build 省略 Cloudflare plugin，避免把 workerd-only `cloudflare:workers` scheme 當成 Node module 載入。這不改 production build/deploy path。

更新後重新 `npm ci`、`npm ls --all` 均成功；以非 force `npm audit fix` 收斂可安全修補項目後，audit 變為上述 5 項。

## Production `xlsx` exception

使用路徑已確認：

- `server/education.ts` 以 `XLSX.read` 解析 staff spreadsheet import；會檢查格式、標頭、必要欄位、重複 student number/email 與 row-level 錯誤。
- `server/exports/service.ts` 以 XLSX 產生教師匯出 workbook。
- `/students/import` 受 staff route/auth contract 保護；`server/http/backend.ts` 對 request body 有 36 MiB 上限，base64/file upload 也有 canonical decode 與大小檢查。
- 匯入流程仍以交易、audit 與 scope 檢查收尾；這些是 mitigation，不是宣稱 parser advisory 已消失。

因 `xlsx@0.18.5` 沒有 upstream fix，本輪不改用無相容性證據的 major replacement，也不把 `npm audit` advisory 靜音。後續應由 owner 在獨立 bounded slice 決定可維護的 parser replacement／隔離策略，並重新執行 import、export 與檔案安全回歸。

## Dev-only migration tooling exception

剩餘的 4 個 moderate advisory 只由 `drizzle-kit` 的 migration tooling dependency chain 引入，沒有被 production image 的 `npm ci --omit=dev` 安裝。npm 提示的 `drizzle-kit@0.18.1` 是 major/相容性退回，會逆轉本輪安全版本更新；因此保留現代版本並記錄例外，不用 force downgrade。

## 回歸證據

- targeted import/export/backend tests：`11/11` passed。
- full Node suite：`137` passed、`2` 個既有 real-PPTX fixture tests skipped、`0` failed。
- full Node suite 以 `tests/register-cloudflare-workers-loader.mjs` 的 test-only shim 執行；shim 只將 production bundle 的 `cloudflare:workers` runtime specifier 映射成無 binding 的 Node 測試 stub，沒有放入 image 或 production code。
- `npx tsc --noEmit`：passed。為配合新版 Cloudflare worker types，`server/conversion/service.ts` 將 Buffer 的 default UTF-8 `toString()` 呼叫改成不傳 encoding argument，行為不變。
- `npm run security:phase8`：`11/11` passed。
- root production image：`learning-platform/web:dependency-audit` build passed，內含 updated lockfile 的 `npm ci` 與 `vinext build`。
- converter image：`learning-platform/converter:dependency-audit` build passed，converter 以 `npm ci --omit=dev --ignore-scripts` 安裝，build log 僅保留 production `xlsx` 的 1 high advisory。
- `docker compose -f docker-compose.yml -f docker-compose.strong-runner.yml config --quiet`：passed。
- `npm run lint`：仍有 6 個 `no-useless-escape` errors，全部位於既有 `scripts/migration/restore-compose.mjs`；本輪沒有改 migration script，故列為既有 lint observation，不把它誤報為依賴修補已清零。

## 交接判定

此項可標為「已完成 clean-install audit、相容升級與回歸；保留明確 production/dev exceptions」。`xlsx` production exception 仍須 owner 決定替代或接受風險；在該決定完成前，不應宣稱依賴風險全部關閉。
