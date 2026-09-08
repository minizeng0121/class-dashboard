/*
 * 班級經營儀表板 —— Apps Script 後端
 *
 * 用途：取代前端原本的 localStorage「假後端」，把課堂資料讀寫進這個 Google
 * Sheet（Sessions / SessionGroups 兩個分頁）。部署方式與步驟見專案根目錄的
 * 「後端部署步驟.md」。
 *
 * 對應開發需求文件 v2.0：
 *   十七、Google Sheet 資料結構（Sessions / SessionGroups）
 *   十八、後端功能介面
 *   十五、跨裝置同步規格（revision 版本檢查、action_id 防重複）
 */

// ---------- 設定 ----------

// 教師 PIN：docs/js/teacher.js 也寫死同一組（Store.setPin 自動帶上，教師不用手動輸入）。
// 這不是真正的存取控制，只是零成本擋掉學生手滑誤觸教師控制台，兩邊都是公開檔案、
// 都會進 git——真正的保護要等之後接 Google 帳號登入（文件 19.1），這次沒有做到那一步。
var TEACHER_PIN = '5787';

var SESSIONS_SHEET = 'Sessions';
var SESSION_GROUPS_SHEET = 'SessionGroups';

var SESSIONS_HEADERS = [
  'session_id', 'class_name_snapshot', 'lesson_date', 'started_at', 'ended_at',
  'status', 'lights_json', 'achievements_json', 'revision',
  'last_action_json', 'recent_action_ids_json', 'updated_at'
];

var SESSION_GROUPS_HEADERS = [
  'session_group_id', 'session_id', 'group_id', 'group_name_snapshot',
  'initial_stars', 'current_stars', 'bulb_count', 'updated_at'
];

// 每堂課最多記住幾個 action_id 用來防重複送出，不需要無限累積。
var ACTION_ID_WINDOW = 30;

// ---------- 一次性初始化：在 Apps Script 編輯器手動執行這個函式 ----------

function setupSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheetWithHeaders_(ss, SESSIONS_SHEET, SESSIONS_HEADERS);
  ensureSheetWithHeaders_(ss, SESSION_GROUPS_SHEET, SESSION_GROUPS_HEADERS);
}

function ensureSheetWithHeaders_(ss, name, headers) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
  }
}

// ---------- HTTP 入口 ----------

function doGet(e) {
  try {
    var action = e.parameter.action;
    if (action === 'getCurrentSession') {
      return jsonResponse_({ ok: true, data: getCurrentSession_() });
    }
    return jsonResponse_({ ok: false, error: 'unknown_action' });
  } catch (err) {
    return jsonResponse_({ ok: false, error: 'server_error', message: String(err) });
  }
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  var lockAcquired = false;
  try {
    lock.waitLock(10000);
    lockAcquired = true;

    // 明確指定用 UTF-8 解碼，不用「猜猜看有沒有被誤讀」那種修法——之前用
    // escape()+decodeURIComponent() 去猜，猜錯過，直接指定字元集才是正解。
    var body = JSON.parse(e.postData.getDataAsString('UTF-8'));
    if (body.pin !== TEACHER_PIN) {
      return jsonResponse_({ ok: false, error: 'invalid_pin' });
    }

    var handlers = {
      verifyPin: handleVerifyPin_,
      startSession: handleStartSession_,
      addLight: handleAddLight_,
      correctLight: handleCorrectLight_,
      setStars: handleSetStars_,
      addBulb: handleAddBulb_,
      addAchievement: handleAddAchievement_,
      removeAchievement: handleRemoveAchievement_,
      undo: handleUndo_,
      endSession: handleEndSession_
    };
    var handler = handlers[body.action];
    if (!handler) return jsonResponse_({ ok: false, error: 'unknown_action' });

    return jsonResponse_(handler(body));
  } catch (err) {
    // lock.waitLock 逾時也會被這裡接住，一律回傳固定格式的 JSON，
    // 前端才不會收到 Apps Script 預設的錯誤頁面而解析失敗。
    return jsonResponse_({ ok: false, error: 'server_error', message: String(err) });
  } finally {
    if (lockAcquired) lock.releaseLock();
  }
}

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------- 讀取 ----------

function getCurrentSession_() {
  var row = findLatestSessionRow_();
  if (!row) return null;
  return sessionRowToObject_(row);
}

// ---------- 寫入 action handlers ----------
// 每個 handler 收到的 body 至少含 { action, pin, actionId }，
// 除了 startSession 外都還會有 sessionId、revision。

// 前端登入時呼叫：能執行到這裡，代表 doPost 開頭的 pin 檢查已經通過了，
// 不用再做任何事，回傳成功就好。前端不再內建正確密碼，靠這個動作問後端。
function handleVerifyPin_(body) {
  return { ok: true };
}

function handleStartSession_(body) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SESSIONS_SHEET);
  var groupsSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SESSION_GROUPS_SHEET);
  var now = new Date().toISOString();
  var sessionId = Utilities.getUuid();

  // 對應文件廿一「同一班只能有一堂進行中課堂」：如果上一堂課忘記按「結束課堂」
  // 就直接開新的一堂，先把舊的那堂自動標記結束，避免同時存在兩堂 active 課堂、
  // 造成歷史資料/學期統計對不起來。
  var staleActive = findActiveSessionRow_();
  if (staleActive) {
    staleActive.row.status = 'completed';
    staleActive.row.ended_at = now;
    writeRowBack_(sheet, SESSIONS_HEADERS, staleActive.rowIndex, staleActive.row);
  }

  var row = {
    session_id: sessionId,
    class_name_snapshot: body.className,
    lesson_date: now.slice(0, 10),
    started_at: now,
    ended_at: '',
    status: 'active',
    lights_json: '[]',
    achievements_json: '[]',
    revision: 1,
    last_action_json: '',
    recent_action_ids_json: JSON.stringify([body.actionId]),
    updated_at: now
  };
  appendRow_(sheet, SESSIONS_HEADERS, row);

  // 所有小組一次寫入（一次 setValues 呼叫），不要每組各呼叫一次試算表 API——
  // 那樣 5 組就要 5 次網路來回，是開課速度慢的主因之一。
  var groupRows = (body.groups || []).map(function (g) {
    return {
      session_group_id: Utilities.getUuid(),
      session_id: sessionId,
      group_id: g.id,
      group_name_snapshot: g.name,
      initial_stars: 3,
      current_stars: 3,
      bulb_count: 0,
      updated_at: now
    };
  });
  appendRows_(groupsSheet, SESSION_GROUPS_HEADERS, groupRows);

  // 剛寫入的內容已經在記憶體裡，不用再讀一次試算表確認。
  var groups = groupRows.map(function (g) {
    return { id: g.group_id, name: g.group_name_snapshot, stars: g.current_stars, bulbs: g.bulb_count };
  });
  return { ok: true, data: sessionRowToObject_({ row: row }, groups) };
}

function handleAddLight_(body) {
  return withSession_(body, function (ctx) {
    var lights = JSON.parse(ctx.row.lights_json || '[]');
    lights.push({ color: body.color, at: new Date().toISOString() });
    ctx.row.lights_json = JSON.stringify(lights);
    ctx.row.last_action_json = JSON.stringify({ type: 'light-add', index: lights.length - 1 });
    return ctx;
  });
}

function handleCorrectLight_(body) {
  return withSession_(body, function (ctx) {
    var lights = JSON.parse(ctx.row.lights_json || '[]');
    var entry = lights[body.index];
    if (!entry) throw new Error('light_index_out_of_range');
    var prevColor = entry.color;
    entry.color = body.color;
    ctx.row.lights_json = JSON.stringify(lights);
    ctx.row.last_action_json = JSON.stringify({ type: 'light-correct', index: body.index, prevColor: prevColor });
    return ctx;
  });
}

function handleSetStars_(body) {
  if ([1, 2, 3].indexOf(body.stars) === -1) throw new Error('invalid_stars');
  return withSessionGroup_(body, function (groupRow) {
    var prevStars = groupRow.current_stars;
    groupRow.current_stars = body.stars;
    return { lastAction: { type: 'stars', groupId: body.groupId, prevStars: prevStars } };
  });
}

function handleAddBulb_(body) {
  return withSessionGroup_(body, function (groupRow) {
    var prevBulbs = groupRow.bulb_count;
    groupRow.bulb_count = Math.max(0, prevBulbs + body.delta);
    return { lastAction: { type: 'bulb', groupId: body.groupId, prevBulbs: prevBulbs } };
  });
}

function handleAddAchievement_(body) {
  return withSession_(body, function (ctx) {
    var list = JSON.parse(ctx.row.achievements_json || '[]');
    list.push({ seat: body.seat, type: body.type, at: new Date().toISOString() });
    ctx.row.achievements_json = JSON.stringify(list);
    ctx.row.last_action_json = JSON.stringify({ type: 'achievement-add', index: list.length - 1 });
    return ctx;
  });
}

function handleRemoveAchievement_(body) {
  return withSession_(body, function (ctx) {
    var list = JSON.parse(ctx.row.achievements_json || '[]');
    var entry = list[body.index];
    if (!entry) throw new Error('achievement_index_out_of_range');
    list.splice(body.index, 1);
    ctx.row.achievements_json = JSON.stringify(list);
    ctx.row.last_action_json = JSON.stringify({ type: 'achievement-remove', index: body.index, entry: entry });
    return ctx;
  });
}

function handleUndo_(body) {
  return withSession_(body, function (ctx) {
    var action = ctx.row.last_action_json ? JSON.parse(ctx.row.last_action_json) : null;
    if (!action) return { noop: true };

    if (action.type === 'light-add') {
      var lights = JSON.parse(ctx.row.lights_json || '[]');
      lights.splice(action.index, 1);
      ctx.row.lights_json = JSON.stringify(lights);
    } else if (action.type === 'light-correct') {
      var lights2 = JSON.parse(ctx.row.lights_json || '[]');
      lights2[action.index].color = action.prevColor;
      ctx.row.lights_json = JSON.stringify(lights2);
    } else if (action.type === 'achievement-add') {
      var ach = JSON.parse(ctx.row.achievements_json || '[]');
      ach.splice(action.index, 1);
      ctx.row.achievements_json = JSON.stringify(ach);
    } else if (action.type === 'achievement-remove') {
      var ach2 = JSON.parse(ctx.row.achievements_json || '[]');
      ach2.splice(action.index, 0, action.entry);
      ctx.row.achievements_json = JSON.stringify(ach2);
    } else if (action.type === 'stars') {
      setGroupField_(body.sessionId, action.groupId, 'current_stars', action.prevStars);
    } else if (action.type === 'bulb') {
      setGroupField_(body.sessionId, action.groupId, 'bulb_count', action.prevBulbs);
    }

    ctx.row.last_action_json = '';
    return ctx;
  });
}

function handleEndSession_(body) {
  return withSession_(body, function (ctx) {
    ctx.row.status = 'completed';
    ctx.row.ended_at = new Date().toISOString();
    return ctx;
  });
}

// ---------- 共用邏輯：讀 session → 檢查 pin/revision/action_id → 套用變更 → 存回 ----------

function withSession_(body, mutate) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SESSIONS_SHEET);
  var found = findRowByValue_(sheet, SESSIONS_HEADERS, 'session_id', body.sessionId);
  if (!found) return { ok: false, error: 'session_not_found' };

  // 順便把這堂課的小組資料一起讀出來，待會組回傳結果直接用，不用再多讀一次
  // SessionGroups（這幾個 handler 本身不會動到小組資料，只是回應要附上）。
  var groupsSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SESSION_GROUPS_SHEET);
  var groupRows = findRowsByValue_(groupsSheet, SESSION_GROUPS_HEADERS, 'session_id', body.sessionId);
  var groups = groupRows.map(function (g) {
    return { id: g.row.group_id, name: g.row.group_name_snapshot, stars: g.row.current_stars, bulbs: g.row.bulb_count };
  });

  var recentIds = JSON.parse(found.row.recent_action_ids_json || '[]');
  if (recentIds.indexOf(body.actionId) !== -1) {
    // 同一個 action_id 已經套用過，直接回傳目前狀態，不重複套用。
    return { ok: true, data: sessionRowToObject_(found, groups) };
  }
  if (typeof body.revision === 'number' && body.revision !== found.row.revision) {
    return { ok: false, error: 'revision_conflict', data: sessionRowToObject_(found, groups) };
  }

  var ctx = mutate({ row: found.row });
  if (ctx && ctx.noop) {
    // mutate 判斷這次操作實際上什麼都沒改（例如沒有上一步可以復原），
    // 不消耗 revision、不佔用 action_id 名額，避免其他裝置被誤判成版本衝突。
    // noop 一定沒有動到 SessionGroups，precomputed 的 groups 還是準的。
    return { ok: true, data: sessionRowToObject_(found, groups) };
  }
  ctx.row.revision = ctx.row.revision + 1;
  ctx.row.updated_at = new Date().toISOString();
  recentIds.push(body.actionId);
  if (recentIds.length > ACTION_ID_WINDOW) recentIds = recentIds.slice(-ACTION_ID_WINDOW);
  ctx.row.recent_action_ids_json = JSON.stringify(recentIds);

  writeRowBack_(sheet, SESSIONS_HEADERS, found.rowIndex, ctx.row);
  // 這裡故意不重用上面 precompute 的 groups：handleUndo_ 復原星等/💡 時
  // 會透過 setGroupField_ 直接寫入 SessionGroups，發生在 mutate() 執行期間，
  // 比 groups 的讀取時間點還晚——如果沿用舊的 groups，回傳給前端的小組資料
  // 會是「復原前」的舊值，前端顯示會跟試算表裡真正存的資料對不起來。
  // 這幾個 handler 大多數情況不動小組資料，多這次讀取換取一定正確，值得。
  return { ok: true, data: sessionRowToObject_({ row: ctx.row, rowIndex: found.rowIndex }) };
}

function withSessionGroup_(body, mutate) {
  var sessionSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SESSIONS_SHEET);
  var sessionFound = findRowByValue_(sessionSheet, SESSIONS_HEADERS, 'session_id', body.sessionId);
  if (!sessionFound) return { ok: false, error: 'session_not_found' };

  var recentIds = JSON.parse(sessionFound.row.recent_action_ids_json || '[]');
  if (recentIds.indexOf(body.actionId) !== -1) {
    return { ok: true, data: sessionRowToObject_(sessionFound) };
  }
  if (typeof body.revision === 'number' && body.revision !== sessionFound.row.revision) {
    return { ok: false, error: 'revision_conflict', data: sessionRowToObject_(sessionFound) };
  }

  // 一次讀出這堂課全部小組列：同時用來找目標小組、也用來組回傳的 groups 清單，
  // 不用像原本那樣「找目標組讀一次、組回傳結果又整份重讀一次」。
  var groupsSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SESSION_GROUPS_SHEET);
  var groupRows = findRowsByValue_(groupsSheet, SESSION_GROUPS_HEADERS, 'session_id', body.sessionId);
  var groupFound = null;
  for (var i = 0; i < groupRows.length; i++) {
    if (groupRows[i].row.group_id === body.groupId) { groupFound = groupRows[i]; break; }
  }
  if (!groupFound) return { ok: false, error: 'group_not_found' };

  var result = mutate(groupFound.row);
  groupFound.row.updated_at = new Date().toISOString();
  writeRowBack_(groupsSheet, SESSION_GROUPS_HEADERS, groupFound.rowIndex, groupFound.row);

  sessionFound.row.revision = sessionFound.row.revision + 1;
  sessionFound.row.updated_at = new Date().toISOString();
  if (result && result.lastAction) {
    sessionFound.row.last_action_json = JSON.stringify(result.lastAction);
  }
  recentIds.push(body.actionId);
  if (recentIds.length > ACTION_ID_WINDOW) recentIds = recentIds.slice(-ACTION_ID_WINDOW);
  sessionFound.row.recent_action_ids_json = JSON.stringify(recentIds);
  writeRowBack_(sessionSheet, SESSIONS_HEADERS, sessionFound.rowIndex, sessionFound.row);

  var groups = groupRows.map(function (g) {
    return { id: g.row.group_id, name: g.row.group_name_snapshot, stars: g.row.current_stars, bulbs: g.row.bulb_count };
  });
  return { ok: true, data: sessionRowToObject_(sessionFound, groups) };
}

function setGroupField_(sessionId, groupId, field, value) {
  var groupsSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SESSION_GROUPS_SHEET);
  var found = findRowByValue_(groupsSheet, SESSION_GROUPS_HEADERS, 'group_id', groupId, 'session_id', sessionId);
  if (!found) return;
  found.row[field] = value;
  found.row.updated_at = new Date().toISOString();
  writeRowBack_(groupsSheet, SESSION_GROUPS_HEADERS, found.rowIndex, found.row);
}

// ---------- 試算表存取小工具 ----------
// Apps Script 沒有現成的「依欄位名稱讀寫一列」功能，這裡用標題列自己包一層，
// 讓上面的商業邏輯可以直接用欄位名稱（例如 row.current_stars），不用管欄位在第幾欄。

// 回傳「最新一堂課」（Sessions 最後一列），不管是進行中還是已結束——
// 前端要靠 status 自己判斷該顯示「上課中」還是「本節課已結束」畫面。
// 之前這裡只挑 status==='active' 的列，導致課堂結束後找不到任何符合的列，
// 投影頁永遠看不到「本節課已結束」，只會顯示成「還沒開始」。
function findLatestSessionRow_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SESSIONS_SHEET);
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return null;
  var lastIndex = values.length - 1;
  return { row: rowArrayToObject_(SESSIONS_HEADERS, values[lastIndex]), rowIndex: lastIndex + 1 };
}

// 找目前是否有進行中的課堂（status==='active'），開課時用來自動結束
// 上一堂忘記結束的課，避免同時存在兩堂 active 的課互相打架。
function findActiveSessionRow_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SESSIONS_SHEET);
  var values = sheet.getDataRange().getValues();
  for (var i = values.length - 1; i >= 1; i--) {
    var row = rowArrayToObject_(SESSIONS_HEADERS, values[i]);
    if (row.status === 'active') return { row: row, rowIndex: i + 1 };
  }
  return null;
}

function findRowByValue_(sheet, headers, key, value, key2, value2) {
  var values = sheet.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    var row = rowArrayToObject_(headers, values[i]);
    if (row[key] === value && (!key2 || row[key2] === value2)) {
      return { row: row, rowIndex: i + 1 };
    }
  }
  return null;
}

// 回傳所有符合條件的列（例如同一堂課底下的所有小組），一次讀取重複使用，
// 避免呼叫端「找一筆」跟「列全部」分開各讀一次試算表。
function findRowsByValue_(sheet, headers, key, value) {
  var values = sheet.getDataRange().getValues();
  var results = [];
  for (var i = 1; i < values.length; i++) {
    var row = rowArrayToObject_(headers, values[i]);
    if (row[key] === value) results.push({ row: row, rowIndex: i + 1 });
  }
  return results;
}

function appendRow_(sheet, headers, rowObj) {
  var arr = headers.map(function (h) { return rowObj[h]; });
  sheet.appendRow(arr);
}

// 一次寫入多列（例如開課時建立好幾組），比逐筆呼叫 appendRow_ 少很多次網路來回。
function appendRows_(sheet, headers, rowObjs) {
  if (!rowObjs.length) return;
  var arr = rowObjs.map(function (rowObj) {
    return headers.map(function (h) { return rowObj[h]; });
  });
  var startRow = sheet.getLastRow() + 1;
  sheet.getRange(startRow, 1, arr.length, headers.length).setValues(arr);
}

function writeRowBack_(sheet, headers, rowIndex, rowObj) {
  var arr = headers.map(function (h) { return rowObj[h]; });
  sheet.getRange(rowIndex, 1, 1, headers.length).setValues([arr]);
}

function rowArrayToObject_(headers, arr) {
  var obj = {};
  headers.forEach(function (h, i) { obj[h] = arr[i]; });
  return obj;
}

// ---------- 組成回給前端的 session JSON（跟前端 store.js 原本的資料形狀對齊） ----------

// precomputedGroups：呼叫端如果剛好已經有這堂課的小組資料（例如才剛讀過或寫過），
// 直接傳進來用，省一次試算表讀取；沒有傳的話才自己去讀 SessionGroups 分頁。
function sessionRowToObject_(found, precomputedGroups) {
  var row = found.row;
  var groups = precomputedGroups;
  if (!groups) {
    var groupsSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SESSION_GROUPS_SHEET);
    var groupRows = findRowsByValue_(groupsSheet, SESSION_GROUPS_HEADERS, 'session_id', row.session_id);
    groups = groupRows.map(function (g) {
      return { id: g.row.group_id, name: g.row.group_name_snapshot, stars: g.row.current_stars, bulbs: g.row.bulb_count };
    });
  }

  return {
    sessionId: row.session_id,
    className: row.class_name_snapshot,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    revision: row.revision,
    lights: JSON.parse(row.lights_json || '[]'),
    achievements: JSON.parse(row.achievements_json || '[]'),
    lastAction: row.last_action_json ? JSON.parse(row.last_action_json) : null,
    groups: groups
  };
}
