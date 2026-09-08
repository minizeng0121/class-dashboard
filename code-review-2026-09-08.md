# 第一上線版前的程式碼檢核（2026-09-08）

這份文件記錄「拆成教師/投影兩頁」完成後，上線前做的一次完整程式碼審查。審查範圍是這個 session 從一開始（baseline commit `1d0c74d`）到當時 `HEAD` 的所有異動，用五個角度分別跑：`/code-review`（找真的會出包的 bug）＋ 四個 `/simplify` 角度（reuse／simplification／efficiency／altitude）。

**結論**：`/code-review` 找到的 10 個問題全部確認為真、全部修好；四個 `/simplify` 角度找到的問題挑了風險高、值得修的動手，其餘留著、原因寫在下面。修完之後在自己複查時，又額外抓到一個「效能優化本身帶來新鮮度 bug」的問題，也一併修掉了——細節見最下面「事後追加」。

---

## 一、`/code-review` 找到的 bug（10 個，全部修好）

| # | 問題 | 檔案 | 修法 |
|---|---|---|---|
| 1 | 投影頁永遠看不到「本節課已結束」——後端查詢只挑 `status==='active'` 的列，課堂一結束就查不到任何資料 | `backend/Code.gs` | 改成一律回傳「最新一堂課」（不管狀態），前端自己判斷該顯示哪個畫面 |
| 2 | 開新課沒有檢查是否已有進行中課堂，忘記結束會留下孤兒 active 列，違反文件廿一「同一班只能有一堂進行中課堂」 | `backend/Code.gs`（`handleStartSession_`） | 開課前自動把上一堂還沒結束的課標記完成 |
| 3 | 「更正燈號」模式指著的那筆若被復原掉，`renderCorrectPicker` 沒有 null 檢查，直接讓整個 `render()` 噴錯卡死 | `docs/js/teacher.js` | 補防呆；復原時主動離開更正模式 |
| 4 | `lock.waitLock(10000)` 在 `try` 區塊外面，逾時例外沒被接住，前端會收到 HTML 錯誤頁而不是 JSON | `backend/Code.gs`（`doPost`） | 移進 `try` 裡，用旗標避免鎖沒拿到卻呼叫 `releaseLock` |
| 5 | `pendingRetry` 是單一變數，連續失敗多筆操作時只留得住「最後一筆」，更早失敗的悄悄消失 | `docs/js/teacher.js` | 改成陣列 `pendingRetries`，同步狀態徽章一次重試全部 |
| 6 | 註解宣稱密碼「不進 git」，但 `teacher.js` 其實把同一組密碼寫死並提交進版控，說法互相矛盾 | `backend/Code.gs`、`docs/js/store.js`、`backend/後端部署步驟.md` | 改成誠實描述目前的取捨（零成本防手滑，不是真的存取控制） |
| 7 | 「沒有上一步可以復原」時的空操作 undo，仍然照樣消耗 revision，可能讓其他裝置被誤判成版本衝突 | `backend/Code.gs`（`withSession_` / `handleUndo_`） | `mutate` 可回傳 `{noop:true}`，此時不消耗 revision、不佔 action_id 名額 |
| 8 | 教師頁沒有任何定時輪詢，只靠 `visibilitychange`；兩台裝置同時開教師頁時，另一台看到過期資料要等手動切頁 | `docs/js/teacher.js` | 補上 8 秒定時輪詢（文件 15.5） |
| 9 | `store.js` 檔頭註解說 `teacher.js`／`display.js` 已經不再使用、現行版面是 `index.html + app.js`——這是拆頁之前的舊說法，`app.js` 早就不存在了 | `docs/js/store.js` | 修正註解 |
| 10 | 中文編碼修法用 `escape()+decodeURIComponent()` 猜「有沒有被誤讀」，猜錯的話會丟出沒被正確處理的 `URIError`（這就是那幾輪「開課失敗」的根本原因） | `backend/Code.gs` | 改用 `e.postData.getDataAsString('UTF-8')` 明確指定字元集，不用猜的 |

---

## 二、`/simplify` 四個角度的發現

### Reuse（重複造輪子）

| 發現 | 處理 |
|---|---|
| `teacher.js` 自己重寫一份時間格式化，沒呼叫 `render-shared.js` 的 `formatTime`（還少了 NaN 防呆） | **已修**：改呼叫共用的 `formatTime` |
| `display.js`／`teacher.js` 各自重複寫了「星等滿/低樣式判斷」「💡 歸零樣式判斷」「燈號時間戳記 HTML」三段幾乎一樣的邏輯，CSS 也對應重複兩套類別名稱 | **跳過**：影響很小（純顯示邏輯），抽出來要動兩個檔案＋一份 CSS，上線前這個時間點動它，弄錯的風險比留著不管還高，不划算 |
| `sessionRowToObject_` 備援讀取邏輯手寫一份跟 `findRowsByValue_`幾乎一樣的迴圈 | **已修**（在事後追加那次一起改掉，見下方） |
| 小組列 `{id, name, stars, bulbs}` 的組裝邏輯在三個地方各寫一份 | **跳過**：三處寫法有些微差異（原始列 vs 包了一層的列），要抽成共用函式得先統一輸入格式，工程量不小，先留著 |
| `SpreadsheetApp.getActiveSpreadsheet().getSheetByName(...)` 重複呼叫 8 次 | **跳過**：純風格問題，agent 自己也標為低優先 |

### Simplification（多餘複雜度／死程式碼）

| 發現 | 處理 |
|---|---|
| `Store.verifyPin()`／後端 `handleVerifyPin_` 沒有任何頁面呼叫 | **刻意保留**：部署文件把它當作「密碼設定對不對」的除錯手段（這次好幾輪除錯都是靠這招定位問題），不是真的死代碼 |
| `store.js` 檔頭過時註解 | 已列在上面 code-review 第 9 項 |
| `teacher.js` 的 `loadError` 變數賦值了但從來沒被讀取；順便發現「第一次載入就連不上後端時完全沒有錯誤提示」的缺口 | **已修**：移除死變數，`initialLoad` 失敗時改成真的設定 `syncState`，讓畫面顯示錯誤 |
| 密碼視窗、demo 下拉選單殘留的死 CSS（`.modal-*`、`.demo-tools`、`.ended-inner`） | **已修**：清掉 |
| `handleUndo_` 的星等/💡 分支繞過 `withSessionGroup_`，改叫 `setGroupField_` | **確認非 bug**：agent 判斷這是刻意的，因為 `handleUndo_` 已經包在 `withSession_` 裡處理過 revision/action_id，不能再走一次 `withSessionGroup_` 重複累加 |
| 每個按鈕的 `performAction(promiseFactory, applyOptimistic)` 寫法重複 | **維持現狀**：agent 建議不要再抽象化，理由是這是初學者維護的小專案，過度抽象反而更難懂 |

### Efficiency（多餘的試算表讀寫）

| 發現 | 處理 |
|---|---|
| `withSessionGroup_`（星等/💡）已經在稍早的效能優化中改成一次讀取重複使用 | 維持現狀，正確 |
| `withSession_`（燈號/特殊表現球/結束課堂/復原）原本每次都多讀一次 SessionGroups | **已修，但過程中自己踩了一個新 bug**：見下方「事後追加」 |
| 投影頁輪詢（4 秒）跟 `visibilitychange` 刷新可能短時間內重複觸發 | **已修**：切回分頁時重新起算輪詢間隔 |
| `findActiveSessionRow_`/`findLatestSessionRow_` 每次都掃整張 Sessions 表 | **跳過**：Apps Script 沒有更好的查詢方式，這是合理的最低成本，只是隨著學期資料累積會越來越慢，先記著就好 |

### Altitude（修法深度夠不夠）

四個判斷裡，agent 認為「深度足夠、不是貼 OK 繃」的：
- `decodeUtf8Fallback_`（後來已經整個換掉，見上方 code-review 第 10 項）的 try/catch 判斷邏輯本身是可靠的，不是憑感覺猜。
- 教師頁的樂觀更新系統（`confirmedSession`/`pendingOps`/`actionQueue`）是這類問題的標準正解，不是繞過後端設計缺陷的權宜之計。

認為「深度不夠」、已經處理的：
- `readPostBody_` 那層「猜不到就吞掉例外、回傳 `{}`」的防呆，agent 判斷這是不信任既有錯誤處理的多餘保險，反而會把真正的錯誤訊息蓋掉。**已處理**：換成明確指定字元集後，整段 `readPostBody_`／`decodeUtf8Fallback_` 都拿掉了，直接讓例外照原本的方式被 `doPost` 的 `try/catch` 接住。
- PIN 相關的說法矛盾，已列在上面 code-review 第 6 項。

---

## 三、事後追加：效能優化本身帶來的新鮮度 bug

在把上面所有修正都寫進這份報告的過程中，重新複查自己寫的程式碼，發現「`withSession_` 一次讀好小組資料重複使用」這個效能優化，對 `handleUndo_` 復原星等/💡 這個情境是錯的：

- `handleUndo_` 復原星等/💡 時，是透過 `setGroupField_` **直接寫入** SessionGroups，發生在 `mutate()` 執行期間。
- 但小組資料是在呼叫 `mutate()` **之前**就先讀好的，比這次寫入還早。
- 結果：復原星等/💡 成功後，回傳給前端的小組資料是「復原前」的舊值，實際存進 Google Sheet 的資料是對的，只是回應给前端的資料跟 Sheet 對不起來——前端畫面會顯示錯的星等/💡 數字，要等下一次輪詢或手動整理才會更正。

**修法**：只有確定沒有動到 SessionGroups 的路徑（重複送出的 action_id、版本衝突、真的沒東西可復原的空操作）才重用預先讀好的資料；真的送出變更成功的那條路徑，改回即時重新讀取，寧可多一次試算表讀取也要保證資料正確。已修好、已測過語法、已推上 GitHub（commit `683f18d`）。

這個插曲值得記下來的教訓：**效能優化如果動到「讀取跟寫入的時間先後關係」，要特別小心，寧可先求對、再求快**。

---

## 四、部署狀態

以上所有修正都已經 push 到 GitHub，`backend/Code.gs` 需要**再部署一次新版本**才會生效（`683f18d` 這次修正在前一輪部署驗證之後才發現並修好，還沒有經過完整的線上測試）。
