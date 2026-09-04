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

// 教師 PIN：跟前端 app.js 的 TEACHER_PIN 要保持一致。
// 之後若換成正式 Google 帳號登入（文件 19.1），這個檢查會被取代，不是本次範圍。
var TEACHER_PIN = '1234';

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
  lock.waitLock(10000);
  try {
    var body = JSON.parse(e.postData.contents);
    if (body.pin !== TEACHER_PIN) {
      return jsonResponse_({ ok: false, error: 'invalid_pin' });
    }

    var handlers = {
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
    return jsonResponse_({ ok: false, error: 'server_error', message: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------- 讀取 ----------

function getCurrentSession_() {
  var row = findActiveSessionRow_();
  if (!row) return null;
  return sessionRowToObject_(row);
}

// ---------- 寫入 action handlers ----------
// 每個 handler 收到的 body 至少含 { action, pin, actionId }，
// 除了 startSession 外都還會有 sessionId、revision。

function handleStartSession_(body) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SESSIONS_SHEET);
  var now = new Date().toISOString();
  var sessionId = Utilities.getUuid();

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

  var groupsSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SESSION_GROUPS_SHEET);
  (body.groups || []).forEach(function (g) {
    appendRow_(groupsSheet, SESSION_GROUPS_HEADERS, {
      session_group_id: Utilities.getUuid(),
      session_id: sessionId,
      group_id: g.id,
      group_name_snapshot: g.name,
      initial_stars: 3,
      current_stars: 3,
      bulb_count: 0,
      updated_at: now
    });
  });

  return { ok: true, data: sessionRowToObject_(findRowByValue_(sheet, SESSIONS_HEADERS, 'session_id', sessionId)) };
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
    if (!action) return ctx;

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

  var recentIds = JSON.parse(found.row.recent_action_ids_json || '[]');
  if (recentIds.indexOf(body.actionId) !== -1) {
    // 同一個 action_id 已經套用過，直接回傳目前狀態，不重複套用。
    return { ok: true, data: sessionRowToObject_(found) };
  }
  if (typeof body.revision === 'number' && body.revision !== found.row.revision) {
    return { ok: false, error: 'revision_conflict', data: sessionRowToObject_(found) };
  }

  var ctx = mutate({ row: found.row });
  ctx.row.revision = ctx.row.revision + 1;
  ctx.row.updated_at = new Date().toISOString();
  recentIds.push(body.actionId);
  if (recentIds.length > ACTION_ID_WINDOW) recentIds = recentIds.slice(-ACTION_ID_WINDOW);
  ctx.row.recent_action_ids_json = JSON.stringify(recentIds);

  writeRowBack_(sheet, SESSIONS_HEADERS, found.rowIndex, ctx.row);
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

  var groupsSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SESSION_GROUPS_SHEET);
  var groupFound = findRowByValue_(groupsSheet, SESSION_GROUPS_HEADERS, 'group_id', body.groupId, 'session_id', body.sessionId);
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

  return { ok: true, data: sessionRowToObject_(sessionFound) };
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

function appendRow_(sheet, headers, rowObj) {
  var arr = headers.map(function (h) { return rowObj[h]; });
  sheet.appendRow(arr);
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

function sessionRowToObject_(found) {
  var row = found.row;
  var groupsSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SESSION_GROUPS_SHEET);
  var values = groupsSheet.getDataRange().getValues();
  var groups = [];
  for (var i = 1; i < values.length; i++) {
    var g = rowArrayToObject_(SESSION_GROUPS_HEADERS, values[i]);
    if (g.session_id === row.session_id) {
      groups.push({ id: g.group_id, name: g.group_name_snapshot, stars: g.current_stars, bulbs: g.bulb_count });
    }
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
