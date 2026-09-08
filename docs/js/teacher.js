/*
 * 教師控制台頁。這一頁不再要求輸入密碼——網址本身不公開，就是門檻
 * （投影頁上沒有任何連過來的連結，見 display.js／index.html）。
 *
 * 密碼還是會自動帶給後端（Store.setPin），因為 backend/Code.gs 那邊的
 * TEACHER_PIN 檢查沒有拿掉：這只是「零成本擋掉學生手滑誤觸」，擋不住
 * 真的懂技術、有心繞過的人——真正的保護要等之後接 Google 帳號登入
 * （文件 19.1），現在還沒做到那一步。
 *
 * TEACHER_PIN 這裡要跟 backend/Code.gs 裡的 TEACHER_PIN 保持一致。
 */
(function () {
  var TEACHER_PIN = '5787';
  Store.setPin(TEACHER_PIN);

  var STARS_LABEL = RenderShared.STARS_LABEL;
  var LIGHT_CHIP_LABEL = RenderShared.LIGHT_CHIP_LABEL;
  var LIGHT_MEANING = RenderShared.LIGHT_MEANING;
  var formatTime = RenderShared.formatTime;
  var latestLight = RenderShared.latestLight;
  var bulbLabel = RenderShared.bulbLabel;
  var renderAchievements = RenderShared.renderAchievements;

  var SYNC_LABEL = {
    idle: '已同步',
    synced: '已同步',
    syncing: '同步中',
    offline: '離線，點一下重試',
    error: '同步失敗，點一下重試'
  };
  var ACTION_LABEL = {
    stars: '剛調整了小組星級',
    bulb: '剛調整了 💡 數量'
  };

  // session 是畫面實際顯示的資料 = confirmedSession（後端最後一次確認過的底稿）
  // 疊上 pendingOps（還在排隊、尚未確認的樂觀猜測），由 recomputeSession() 算出。
  var session = null;
  var confirmedSession = null;
  var pendingOps = []; // { applyOptimistic }，依送出順序排列
  var loadError = null;
  var syncState = 'idle'; // 'idle'｜'syncing'｜'synced'｜'offline'｜'error'
  var pendingRetry = null;
  var undoTimer = null;
  var correctingIndex = null; // null＝沒有在更正；否則是「本節燈號紀錄」清單裡正在更正的那筆索引

  var startScreen = document.getElementById('startScreen');
  var startError = document.getElementById('startError');
  var consoleScreen = document.getElementById('consoleScreen');
  var groupsSection = document.getElementById('groupsSection');
  var classSelect = document.getElementById('classSelect');
  var groupCountInput = document.getElementById('groupCount');
  var undoBar = document.getElementById('undoBar');
  var undoText = document.getElementById('undoText');
  var syncBadge = document.getElementById('syncBadge');
  var syncNotice = document.getElementById('syncNotice');
  var syncNoticeTimer = null;

  Store.DEFAULT_CLASSES.forEach(function (name) {
    var opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    classSelect.appendChild(opt);
  });

  // ---------- 跟後端溝通：統一的「送出動作」流程 ----------
  // applyOptimistic（選填）：對文件 6.5「讓教師點擊後立即看到結果」的實作——
  // 傳入的話，會先在畫面上套用「假設會成功」的結果，背景才真的送出確認。
  // 這個猜測會被記錄成一筆 pendingOps，在畫面上維持有效，直到「它自己」
  // 確認或失敗為止；不會因為「其他更早送出、比它先確認回來」的操作
  // 把畫面整包蓋掉。
  //
  // actionQueue：真正送到後端的請求排隊、一次一筆，不是連按幾下就同時送出去，
  // 避免連續點擊時後面的請求帶著還沒更新到的舊 revision 送出、被誤判成衝突。

  var actionQueue = Promise.resolve();

  function recomputeSession() {
    var s = confirmedSession ? cloneSession(confirmedSession) : null;
    if (s) {
      pendingOps.forEach(function (op) { s = op.applyOptimistic(s); });
    }
    session = s;
  }

  function setConfirmedSession(data) {
    confirmedSession = data;
    recomputeSession();
  }

  function performAction(promiseFactory, applyOptimistic) {
    var op = applyOptimistic ? { applyOptimistic: applyOptimistic } : null;
    if (op) {
      pendingOps.push(op);
      recomputeSession();
    }
    syncState = 'syncing';
    pendingRetry = function () { performAction(promiseFactory, applyOptimistic); };
    render();

    function removeOp() {
      if (!op) return;
      var idx = pendingOps.indexOf(op);
      if (idx !== -1) pendingOps.splice(idx, 1);
    }
    function settleSyncState(base) {
      syncState = pendingOps.length ? 'syncing' : base;
    }

    actionQueue = actionQueue.then(function () {
      return promiseFactory().then(function (res) {
        if (res.ok) {
          pendingRetry = null;
          removeOp();
          setConfirmedSession(res.data);
          settleSyncState('synced');
          render();
        } else if (res.error === 'revision_conflict') {
          pendingRetry = null;
          removeOp();
          setConfirmedSession(res.data);
          settleSyncState('synced');
          render();
          showNotice('有其他裝置剛更新過這堂課的資料，畫面已重新整理成最新狀態，請確認後再繼續操作。');
        } else if (res.error === 'invalid_pin') {
          // 這一頁不用手動登入，密碼是 teacher.js 開頭自動帶的；
          // 真的出現這個錯誤，代表這裡的 TEACHER_PIN 跟 Code.gs 裡的不一致。
          pendingRetry = null;
          removeOp();
          recomputeSession();
          settleSyncState('error');
          render();
          showNotice('教師密碼設定不一致，請檢查 teacher.js 與 backend/Code.gs 的 TEACHER_PIN 是否相同。');
        } else {
          removeOp();
          recomputeSession();
          settleSyncState('error');
          render();
        }
      });
    }).catch(function () {
      removeOp();
      recomputeSession();
      settleSyncState(navigator.onLine ? 'error' : 'offline');
      render();
    });
  }

  function cloneSession(s) {
    return JSON.parse(JSON.stringify(s));
  }

  // 用畫面上的小提示取代 alert()：alert() 會整個網頁完全卡住等使用者關掉它。
  function showNotice(text) {
    syncNotice.textContent = text;
    syncNotice.hidden = false;
    clearTimeout(syncNoticeTimer);
    syncNoticeTimer = setTimeout(function () { syncNotice.hidden = true; }, 6000);
  }

  function findGroup(s, groupId) {
    for (var i = 0; i < s.groups.length; i++) {
      if (s.groups[i].id === groupId) return s.groups[i];
    }
    return null;
  }

  // 分頁重新可見時呼叫：失敗就靜默略過，畫面維持最後一次成功取得的資料。
  function refreshSession() {
    Store.getCurrentSession().then(function (data) {
      setConfirmedSession(data);
      loadError = null;
      render();
    }).catch(function () {});
  }

  // 頁面第一次載入呼叫：失敗要讓教師看得出「連不上後端」。
  function initialLoad() {
    Store.getCurrentSession().then(function (data) {
      setConfirmedSession(data);
      loadError = null;
      render();
    }).catch(function (err) {
      loadError = err;
      render();
    });
  }

  // ---------- 畫面渲染 ----------

  function render() {
    var showConsole = !!session && session.status !== 'completed';
    startScreen.hidden = showConsole;
    consoleScreen.hidden = !showConsole;
    if (!showConsole) {
      // 開課失敗（例如連不上後端）在這裡給提示，不能只靠 syncBadge——
      // 那個徽章只存在於 consoleScreen 裡，這個畫面還沒有 session 可以進到那裡。
      startError.hidden = !(syncState === 'error' || syncState === 'offline');
      return;
    }

    document.getElementById('className').textContent = session.className;
    document.getElementById('startedAtText').textContent =
      '開始時間：' + new Date(session.startedAt).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });

    renderSyncBadge();
    renderTeacherPreview();
    renderTeacherLights();
    renderGroups();
    renderAchievements(session, 'achTrack');
    renderUndoBar();
  }

  function renderSyncBadge() {
    syncBadge.textContent = SYNC_LABEL[syncState] || SYNC_LABEL.idle;
    syncBadge.className = 'sync-badge sync-' + syncState;
    syncBadge.onclick = (syncState === 'error' || syncState === 'offline') && pendingRetry
      ? function () { pendingRetry(); }
      : null;
    syncBadge.style.cursor = syncBadge.onclick ? 'pointer' : 'default';
  }

  // 教師端看不到投影畫面，補一個小預覽，讓教師知道學生現在實際看到什麼。
  function renderTeacherPreview() {
    var latest = latestLight(session);
    document.getElementById('previewDot').className = 'dot-mini' + (latest ? ' on-' + latest : '');
    document.getElementById('previewText').textContent = latest ? LIGHT_MEANING[latest] : '尚未設定';
  }

  function renderTeacherLights() {
    var historyEl = document.getElementById('lightHistory');
    historyEl.innerHTML = '';
    if (!session.lights.length) {
      historyEl.innerHTML = '<p class="light-history-empty">還沒有紀錄，點上方燈號按鈕開始記錄。</p>';
    } else {
      session.lights.forEach(function (entry, index) {
        var isCurrent = index === session.lights.length - 1;
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'light-record' + (isCurrent ? ' current' : '') + (index === correctingIndex ? ' selected' : '');
        btn.dataset.index = index;
        btn.setAttribute('aria-label', formatTime(entry.at) + ' ' + LIGHT_CHIP_LABEL[entry.color] + '燈，點選以更正');
        btn.innerHTML = '<span class="dot dot-' + entry.color + '"></span>' + formatTime(entry.at);
        historyEl.appendChild(btn);
      });
    }

    renderCorrectPicker();
  }

  function renderCorrectPicker() {
    var wrap = document.getElementById('correctPicker');
    if (correctingIndex === null) {
      wrap.hidden = true;
      return;
    }
    var entry = session.lights[correctingIndex];
    wrap.hidden = false;
    document.getElementById('correctHint').textContent =
      '正在更正 ' + formatTime(entry.at) + ' 的燈號，目前是' + LIGHT_CHIP_LABEL[entry.color] +
      '燈，點選新顏色，或再點一次這筆紀錄取消。';
    document.querySelectorAll('.correct-btn').forEach(function (btn) {
      btn.classList.toggle('active', btn.dataset.color === entry.color);
    });
  }

  function renderGroups() {
    groupsSection.innerHTML = '';
    session.groups.forEach(function (g) {
      var card = document.createElement('div');
      card.className = 'group-card' + (g.stars === 3 ? ' full-stars' : '') + (g.stars === 1 ? ' low-stars' : '');
      card.dataset.groupId = g.id;

      var starsHtml = '';
      for (var i = 1; i <= 3; i++) {
        var filled = i <= g.stars;
        starsHtml += '<button type="button" class="star' + (filled ? ' filled' : '') +
          '" data-value="' + i + '" aria-label="設為 ' + i + ' 顆星">⭐</button>';
      }

      card.innerHTML =
        '<div class="group-card-head">' +
        '<h3>' + g.name + '</h3>' +
        '<button type="button" class="bulb-badge' + (g.bulbs === 0 ? ' zero' : '') +
        '" aria-label="新增一次深度提問">' + bulbLabel(g.bulbs) + '</button>' +
        '</div>' +
        '<div class="stars">' + starsHtml + '</div>' +
        '<p class="stars-label">' + STARS_LABEL[g.stars] + '</p>';

      groupsSection.appendChild(card);
    });
  }

  function renderUndoBar() {
    if (session.lastAction) {
      undoBar.hidden = false;
      undoText.textContent = describeAction(session.lastAction);
      clearTimeout(undoTimer);
      undoTimer = setTimeout(function () { undoBar.hidden = true; }, 5000);
    } else {
      undoBar.hidden = true;
    }
  }

  function describeAction(action) {
    if (action.type === 'light-add') {
      return '剛記錄了一筆燈號';
    }
    if (action.type === 'light-correct') {
      var entry = session.lights[action.index];
      return '剛更正了' + (entry ? ' ' + formatTime(entry.at) : '') + ' 的燈號';
    }
    if (action.type === 'achievement-add') {
      var ach = session.achievements[action.index];
      return '剛新增了一顆球' + (ach ? '（座號 ' + ach.seat + '）' : '');
    }
    if (action.type === 'achievement-remove') {
      return '剛移除了一顆球' + (action.entry ? '（座號 ' + action.entry.seat + '）' : '');
    }
    return ACTION_LABEL[action.type] || '剛完成一次操作';
  }

  // ---------- 教師操作 ----------

  document.getElementById('startBtn').addEventListener('click', function () {
    var className = classSelect.value;
    var groupCount = parseInt(groupCountInput.value, 10) || 5;
    correctingIndex = null;
    var actionId = Store.newActionId();
    performAction(function () { return Store.startSession(className, groupCount, actionId); });
  });

  // 上方：永遠是「記錄新的一筆」，不限筆數，1 次點擊完成。
  document.querySelectorAll('.light-buttons .light-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var actionId = Store.newActionId();
      var color = btn.dataset.color;
      performAction(function () {
        return Store.addLight(session.sessionId, session.revision, color, actionId);
      }, function (s) {
        s.lights.push({ color: color, at: new Date().toISOString() });
        s.lastAction = { type: 'light-add', index: s.lights.length - 1 };
        return s;
      });
    });
  });

  // 下方：點某一筆既有紀錄進入更正模式（純本地畫面狀態，不呼叫後端）。
  document.getElementById('lightHistory').addEventListener('click', function (e) {
    var recordBtn = e.target.closest('.light-record');
    if (!recordBtn) return;
    var index = parseInt(recordBtn.dataset.index, 10);
    correctingIndex = correctingIndex === index ? null : index;
    renderTeacherLights();
  });

  document.getElementById('correctPicker').addEventListener('click', function (e) {
    var btn = e.target.closest('.correct-btn');
    if (!btn || correctingIndex === null) return;
    var index = correctingIndex;
    var newColor = btn.dataset.color;
    correctingIndex = null;
    if (newColor === session.lights[index].color) {
      render();
      return;
    }
    var actionId = Store.newActionId();
    performAction(function () {
      return Store.correctLight(session.sessionId, session.revision, index, newColor, actionId);
    }, function (s) {
      var prevColor = s.lights[index].color;
      s.lights[index].color = newColor;
      s.lastAction = { type: 'light-correct', index: index, prevColor: prevColor };
      return s;
    });
  });

  groupsSection.addEventListener('click', function (e) {
    var card = e.target.closest('.group-card');
    if (!card) return;
    var groupId = card.dataset.groupId;

    var starBtn = e.target.closest('.star');
    if (starBtn) {
      var stars = parseInt(starBtn.dataset.value, 10);
      var actionId = Store.newActionId();
      performAction(function () {
        return Store.setStars(session.sessionId, session.revision, groupId, stars, actionId);
      }, function (s) {
        var g = findGroup(s, groupId);
        var prevStars = g ? g.stars : null;
        if (g) g.stars = stars;
        s.lastAction = { type: 'stars', groupId: groupId, prevStars: prevStars };
        return s;
      });
      return;
    }

    var bulbBtn = e.target.closest('.bulb-badge');
    if (bulbBtn) {
      var actionId2 = Store.newActionId();
      performAction(function () {
        return Store.addBulb(session.sessionId, session.revision, groupId, 1, actionId2);
      }, function (s) {
        var g = findGroup(s, groupId);
        var prevBulbs = g ? g.bulbs : 0;
        if (g) g.bulbs = Math.max(0, g.bulbs + 1);
        s.lastAction = { type: 'bulb', groupId: groupId, prevBulbs: prevBulbs };
        return s;
      });
    }
  });

  function addAchievementFromInput(type) {
    var seatInput = document.getElementById('achSeatInput');
    var seat = parseInt(seatInput.value, 10);
    if (!seat || seat < 1) return;
    var actionId = Store.newActionId();
    performAction(function () {
      return Store.addAchievement(session.sessionId, session.revision, seat, type, actionId);
    }, function (s) {
      s.achievements.push({ seat: seat, type: type, at: new Date().toISOString() });
      s.lastAction = { type: 'achievement-add', index: s.achievements.length - 1 };
      return s;
    });
  }
  document.getElementById('achQuestionBtn').addEventListener('click', function () {
    addAchievementFromInput('question');
  });
  document.getElementById('achHelpBtn').addEventListener('click', function () {
    addAchievementFromInput('help');
  });

  // 點一下已經加進去的球就移除（例如座號打錯了）。
  document.getElementById('achTrack').addEventListener('click', function (e) {
    var ball = e.target.closest('.ball');
    if (!ball) return;
    var index = parseInt(ball.dataset.index, 10);
    var actionId = Store.newActionId();
    performAction(function () {
      return Store.removeAchievement(session.sessionId, session.revision, index, actionId);
    }, function (s) {
      var entry = s.achievements[index];
      s.achievements.splice(index, 1);
      s.lastAction = { type: 'achievement-remove', index: index, entry: entry };
      return s;
    });
  });

  // 復原：跟後端 handleUndo_ 用同一套還原邏輯，鏡射一份在前端，
  // 這樣點下去能立刻看到復原結果，不用等後端來回確認。
  document.getElementById('undoBtn').addEventListener('click', function () {
    var actionId = Store.newActionId();
    performAction(function () {
      return Store.undo(session.sessionId, session.revision, actionId);
    }, function (s) {
      var action = s.lastAction;
      if (!action) return s;
      if (action.type === 'light-add') {
        s.lights.splice(action.index, 1);
      } else if (action.type === 'light-correct') {
        s.lights[action.index].color = action.prevColor;
      } else if (action.type === 'achievement-add') {
        s.achievements.splice(action.index, 1);
      } else if (action.type === 'achievement-remove') {
        s.achievements.splice(action.index, 0, action.entry);
      } else if (action.type === 'stars') {
        var g1 = findGroup(s, action.groupId);
        if (g1) g1.stars = action.prevStars;
      } else if (action.type === 'bulb') {
        var g2 = findGroup(s, action.groupId);
        if (g2) g2.bulbs = action.prevBulbs;
      }
      s.lastAction = null;
      return s;
    });
  });

  document.getElementById('endSessionBtn').addEventListener('click', function () {
    if (!confirm('確定要結束本節課嗎？結束後投影畫面會顯示「本節課已結束」。')) return;
    correctingIndex = null;
    var actionId = Store.newActionId();
    performAction(function () {
      return Store.endSession(session.sessionId, session.revision, actionId);
    });
  });

  // 分頁重新可見時（例如切回這個分頁），重新取得最新狀態。
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) refreshSession();
  });

  render();
  initialLoad();
})();
