# 頁面與功能測試矩陣（c2c_b84d）

日期：2026-09-22  
環境：全新隔離 Docker Compose（`http://127.0.0.1:3333`）及瀏覽器隔離環境（`http://127.0.0.1:3332`）  
結論：所有已實作的靜態與動態入口均可達；角色頁面、深連結、返回／前進／重新整理與主要端到端流程通過。

## 靜態頁面

| 角色 | 頁面 | 驗證內容 | 結果 |
|---|---|---|---|
| 學生 | `/student/dashboard` | 首頁與伺服器課程／功課摘要 | PASS |
| 學生 | `/student/courses` | 課程列表、加入課程入口 | PASS |
| 學生 | `/student/notifications` | 通知列表與內容連結 | PASS |
| 學生 | `/student/missions` | 學習任務列表 | PASS |
| 學生 | `/student/practice` | 未選擇功課安全空狀態 | PASS |
| 學生 | `/student/resources` | 已發布教材列表 | PASS |
| 學生 | `/student/classrooms` | 即時課堂列表／空狀態 | PASS |
| 教師 | `/teacher/dashboard` | 學習分析首頁 | PASS |
| 教師 | `/teacher/courses` | 課程、單元、教材、題目與功課工作台 | PASS |
| 教師 | `/teacher/materials` | 教材庫與上傳入口 | PASS |
| 教師 | `/teacher/classes` | 班別與學生 | PASS |
| 教師 | `/teacher/announcements` | 公告草稿、收件範圍與發布入口 | PASS |
| 教師 | `/teacher/exports` | 報告建立、執行與下載入口 | PASS |
| 教師 | `/teacher/assessment` | 功課政策、套件政策、相似度與批改 | PASS |
| 教師 | `/teacher/classrooms` | 即時課堂建立與控制 | PASS |
| 教師 | `/teacher/analytics` | 課程／班別／學生分析 | PASS |
| 教師 | `/teacher/analytics/ai` | AI 用量分析 | PASS |
| 教師 | `/teacher/ai-review` | AI 產物審核佇列 | PASS |
| 管理員 | `/admin/dashboard` | 系統概況與建立帳戶／班別 | PASS |
| 管理員 | `/admin/users` | 帳戶建立、重設與封存入口 | PASS |
| 管理員 | `/admin/classes` | 班別建立與教師指派 | PASS |
| 管理員 | `/admin/courses` | 課程建立、發布與封存入口 | PASS |
| 管理員 | `/admin/settings/ai` | AI 供應商與政策 | PASS |
| 管理員 | `/admin/settings` | 系統／學習化設定及管理快捷入口 | PASS |
| 管理員 | `/admin/backups` | 備份設定、建立與驗證 | PASS |
| 管理員 | `/admin/audit` | 稽核搜尋與安全文字輸出 | PASS |
| 管理員 | `/admin/email` | SMTP 設定與 Email Outbox | PASS |

## 動態深連結

| 路徑模式 | 驗證內容 | 結果 |
|---|---|---|
| `/student/courses/:courseId` | 課程卡片點擊、URL 與課程內容同步 | PASS |
| `/student/courses/:courseId/units/:unitId` | 單元點擊、教材與功課載入 | PASS |
| `/student/courses/:courseId/assignments/:assignmentId` | 功課詳情與開始作答 | PASS |
| `/student/practice/:submissionId` | 建立提交後進入真實作答頁 | PASS |
| `/student/classrooms/:sessionId` | 路由、角色守衛與深連結解析 | PASS |
| `/teacher/courses/:courseId` | 路由、角色守衛與深連結解析 | PASS |
| `/teacher/courses/:courseId/units/:unitId/materials` | 教材深連結與參數解析 | PASS |
| `/teacher/classes/:classId` | 班別深連結與參數解析 | PASS |
| `/teacher/assignments/:assignmentId/submissions` | 批改深連結與參數解析 | PASS |
| `/teacher/classrooms/:sessionId` | 課堂深連結與參數解析 | PASS |

## 跨頁與安全行為

| 行為 | 結果 |
|---|---|
| 頂部導覽、側欄、課程卡片、麵包屑、單元、功課、通知與管理快捷入口 | PASS |
| 瀏覽器 Back／Forward／Reload 保持 URL 與內容一致 | PASS |
| `/admin/settings/ai` 只高亮「AI 設定」，不誤亮「系統設定」 | PASS |
| 不同角色登入後從舊角色路徑回到自己的首頁 | PASS |
| 未登入、錯誤角色、CSRF、未宣告 HTTP method | PASS |
| Gateway gzip／deflate 解壓與瀏覽器 zstd 協商 | PASS |

## 主要功能流程

隔離 Compose 實跑：管理員建立教師／學生 → 教師建立班別、課程、單元、教材、題目與功課 → 學生執行真實 Runner、提交 → 教師批改及放榜 → 學生讀取結果；另驗證 XLSX 匯出、備份與 checksum、稽核、隱藏測試資料不外洩、CSRF、RBAC 與 method boundary，全部 PASS。

全套 Node 回歸為 **137 passed、0 failed、2 skipped**。兩項跳過只因本機未設定 `PPTX_FIXTURE_PATH`，其餘教材驗證、偽造檔案拒絕與轉換工作流測試均通過。
