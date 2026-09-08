/*
 * Store：跟 Apps Script 後端溝通的薄封裝層。
 * 資料實際存在 Google Sheet，這裡只負責打 API、回傳 Promise。
 * 被 docs/index.html（display.js）跟 docs/teacher.html（teacher.js）共用。
 */
(function (global) {
  var GROUP_NAME_POOL = [
    '第一組', '第二組', '第三組', '第四組',
    '第五組', '第六組', '第七組', '第八組'
  ];

  var DEFAULT_CLASSES = [
    '六年一班', '六年二班', '六年三班', '六年四班',
    '六年五班', '六年六班', '六年七班'
  ];

  function apiUrl() {
    return global.APP_CONFIG && global.APP_CONFIG.API_URL;
  }

  // 教師密碼不再內建於前端，登入時輸入什麼就記住什麼（只存在瀏覽器記憶體，
  // 重新整理就會清掉），之後每次 API 呼叫都帶著它，由後端判斷對不對。
  var enteredPin = null;

  function pin() {
    return enteredPin;
  }

  function newActionId() {
    if (global.crypto && global.crypto.randomUUID) return global.crypto.randomUUID();
    return 'a' + Date.now() + '-' + Math.random().toString(16).slice(2);
  }

  // 用 GET 讀資料。
  function apiGet(action, params) {
    var url = apiUrl() + '?action=' + encodeURIComponent(action);
    Object.keys(params || {}).forEach(function (k) {
      url += '&' + encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
    });
    return fetch(url).then(function (res) { return res.json(); });
  }

  // 用 POST 寫資料。Content-Type 故意用 text/plain，避開瀏覽器的 CORS 預檢請求
  // （Apps Script Web App 對這種簡單請求才會直接放行）。
  function apiPost(action, payload) {
    var body = Object.assign({ action: action, pin: pin() }, payload);
    return fetch(apiUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body)
    }).then(function (res) { return res.json(); });
  }

  function createGroups(count) {
    var n = Math.max(1, Math.min(8, count || 5));
    var groups = [];
    for (var i = 0; i < n; i++) {
      groups.push({ id: 'g' + (i + 1), name: GROUP_NAME_POOL[i] || ('第' + (i + 1) + '組') });
    }
    return groups;
  }

  global.Store = {
    DEFAULT_CLASSES: DEFAULT_CLASSES,
    newActionId: newActionId,

    // 登入時呼叫：先記住輸入的密碼，再問後端對不對。
    setPin: function (value) {
      enteredPin = value;
    },

    verifyPin: function () {
      return apiPost('verifyPin', {});
    },

    // 回傳 Promise<session|null>；連線失敗時把錯誤往外丟，由呼叫端處理畫面。
    getCurrentSession: function () {
      return apiGet('getCurrentSession').then(function (res) {
        if (!res.ok) throw new Error(res.error || 'request_failed');
        return res.data;
      });
    },

    // 以下寫入類函式都回傳 Promise<{ok, data, error}>，不丟例外（方便呼叫端統一處理失敗狀態）。
    startSession: function (className, groupCount, actionId) {
      return apiPost('startSession', {
        actionId: actionId,
        className: className,
        groups: createGroups(groupCount)
      });
    },

    addLight: function (sessionId, revision, color, actionId) {
      return apiPost('addLight', { actionId: actionId, sessionId: sessionId, revision: revision, color: color });
    },

    correctLight: function (sessionId, revision, index, color, actionId) {
      return apiPost('correctLight', { actionId: actionId, sessionId: sessionId, revision: revision, index: index, color: color });
    },

    setStars: function (sessionId, revision, groupId, stars, actionId) {
      return apiPost('setStars', { actionId: actionId, sessionId: sessionId, revision: revision, groupId: groupId, stars: stars });
    },

    addBulb: function (sessionId, revision, groupId, delta, actionId) {
      return apiPost('addBulb', { actionId: actionId, sessionId: sessionId, revision: revision, groupId: groupId, delta: delta });
    },

    addAchievement: function (sessionId, revision, seat, type, actionId) {
      return apiPost('addAchievement', { actionId: actionId, sessionId: sessionId, revision: revision, seat: seat, type: type });
    },

    removeAchievement: function (sessionId, revision, index, actionId) {
      return apiPost('removeAchievement', { actionId: actionId, sessionId: sessionId, revision: revision, index: index });
    },

    undo: function (sessionId, revision, actionId) {
      return apiPost('undo', { actionId: actionId, sessionId: sessionId, revision: revision });
    },

    endSession: function (sessionId, revision, actionId) {
      return apiPost('endSession', { actionId: actionId, sessionId: sessionId, revision: revision });
    }
  };
})(window);
