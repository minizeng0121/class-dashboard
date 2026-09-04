/*
 * Store：前端原型的「假後端」。
 * 現在還沒有 Google Sheet／Apps Script，所有資料先存在瀏覽器的 localStorage。
 * 之後真的接後端時，只需要把這個檔案裡的函式改成呼叫真正的 API，
 * teacher.js／display.js 呼叫這些函式的方式不用變。
 */
(function (global) {
  var STORAGE_KEY = 'cm_demo_session_v1';

  var DEFAULT_CLASSES = [
    '六年一班', '六年二班', '六年三班', '六年四班',
    '六年五班', '六年六班', '六年七班'
  ];

  var GROUP_NAME_POOL = [
    '第一組', '第二組', '第三組', '第四組',
    '第五組', '第六組', '第七組', '第八組'
  ];

  function loadSession() {
    var raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  function saveSession(session) {
    session.revision = (session.revision || 0) + 1;
    session.updatedAt = new Date().toISOString();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    return session;
  }

  function clearSession() {
    localStorage.removeItem(STORAGE_KEY);
  }

  function createGroups(count) {
    var n = Math.max(1, Math.min(8, count || 5));
    var groups = [];
    for (var i = 0; i < n; i++) {
      groups.push({
        id: 'g' + (i + 1),
        name: GROUP_NAME_POOL[i] || ('第' + (i + 1) + '組'),
        stars: 3,
        bulbs: 0
      });
    }
    return groups;
  }

  function startSession(className, groupCount) {
    var session = {
      className: className,
      groups: createGroups(groupCount),
      // lights 不再是固定 3 格，而是自然增長的清單，每筆是 {color, at}。
      lights: [],
      // achievements：個別學生的特殊表現（好問題／幫助別人），跟小組資料無關。
      achievements: [],
      status: 'active',
      startedAt: new Date().toISOString(),
      revision: 0,
      // syncDemoState 只是拿來在畫面上模擬「同步中／離線／同步失敗」，
      // 之後接真的後端時，這個欄位會換成真的網路請求狀態。
      syncDemoState: 'synced',
      lastAction: null
    };
    return saveSession(session);
  }

  // 記錄一筆新燈號：不限筆數，永遠附加在清單最後面，對應「自然切換」。
  function addLight(session, color) {
    session.lights.push({ color: color, at: new Date().toISOString() });
    session.lastAction = { type: 'light-add', index: session.lights.length - 1 };
    saveSession(session);
  }

  // 更正清單裡「既有的某一筆」，不會新增筆數，也不會動到其他筆的時間戳記。
  function correctLight(session, index, color) {
    var prevColor = session.lights[index].color;
    session.lights[index].color = color;
    session.lastAction = { type: 'light-correct', index: index, prevColor: prevColor };
    saveSession(session);
  }

  // 記錄一顆「特殊表現」球：type 是 'question'（好問題／花色球）或 'help'（幫助別人／實心球）。
  function addAchievement(session, seat, type) {
    // 舊版本開的課堂沒有這個欄位，這裡順手補上，不需要特別重開一堂課。
    if (!session.achievements) session.achievements = [];
    session.achievements.push({ seat: seat, type: type, at: new Date().toISOString() });
    session.lastAction = { type: 'achievement-add', index: session.achievements.length - 1 };
    saveSession(session);
  }

  // 移除一顆球（例如座號打錯了）。記下被刪的內容和位置，讓復原可以放回原位。
  function removeAchievement(session, index) {
    var entry = session.achievements[index];
    if (!entry) return;
    session.achievements.splice(index, 1);
    session.lastAction = { type: 'achievement-remove', index: index, entry: entry };
    saveSession(session);
  }

  function setStars(session, groupId, stars) {
    var g = findGroup(session, groupId);
    if (!g) return;
    session.lastAction = { type: 'stars', groupId: groupId, prevStars: g.stars };
    g.stars = stars;
    saveSession(session);
  }

  function addBulb(session, groupId, delta) {
    var g = findGroup(session, groupId);
    if (!g) return;
    session.lastAction = { type: 'bulb', groupId: groupId, prevBulbs: g.bulbs };
    g.bulbs = Math.max(0, g.bulbs + delta);
    saveSession(session);
  }

  function undoLastAction(session) {
    var action = session.lastAction;
    if (!action) return false;
    if (action.type === 'light-add') {
      session.lights.splice(action.index, 1);
    } else if (action.type === 'light-correct') {
      session.lights[action.index].color = action.prevColor;
    } else if (action.type === 'achievement-add') {
      session.achievements.splice(action.index, 1);
    } else if (action.type === 'achievement-remove') {
      session.achievements.splice(action.index, 0, action.entry);
    } else if (action.type === 'stars') {
      var g1 = findGroup(session, action.groupId);
      if (g1) g1.stars = action.prevStars;
    } else if (action.type === 'bulb') {
      var g2 = findGroup(session, action.groupId);
      if (g2) g2.bulbs = action.prevBulbs;
    }
    session.lastAction = null;
    saveSession(session);
    return true;
  }

  function endSession(session) {
    session.status = 'ended';
    saveSession(session);
  }

  function findGroup(session, groupId) {
    for (var i = 0; i < session.groups.length; i++) {
      if (session.groups[i].id === groupId) return session.groups[i];
    }
    return null;
  }

  global.Store = {
    STORAGE_KEY: STORAGE_KEY,
    DEFAULT_CLASSES: DEFAULT_CLASSES,
    loadSession: loadSession,
    saveSession: saveSession,
    clearSession: clearSession,
    startSession: startSession,
    addLight: addLight,
    addAchievement: addAchievement,
    removeAchievement: removeAchievement,
    correctLight: correctLight,
    setStars: setStars,
    addBulb: addBulb,
    undoLastAction: undoLastAction,
    endSession: endSession
  };
})(window);
