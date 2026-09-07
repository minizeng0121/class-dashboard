(function () {
  var STARS_LABEL = { 3: '有效的自主合作中！', 2: '逐漸進入軌道', 1: '需要較多支持' };
  var LIGHT_CHIP_LABEL = { green: '綠', yellow: '黃', red: '紅' };
  var LIGHT_TEXT = { green: '目前綠燈', yellow: '目前黃燈', red: '目前紅燈' };
  // 學生前台用的語意文字：不只是講顏色，而是直接講這個顏色現在代表什麼意思。
  var LIGHT_MEANING = {
    green: '目前很專注音量很適當',
    yellow: '注意小組討論不超過第三人聽',
    red: '目前像進到菜市場'
  };
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
  // 特殊表現球的色票，只用來區分不同座號、跟燈號顏色沒有語意關係。
  // 8 色循環，一般班級座號不超過 26 號，大約循環 3 輪，色階偏亮一點、不要太暗。
  var BALL_COLORS = ['#e15c4e', '#e2833c', '#d9a83c', '#3cae6c', '#2aa398', '#4a86c2', '#8268b8', '#db6f95'];

  var mode = 'display'; // 'display'（預設，學生看的）｜'teacher'（密碼通過後）
  // session 是畫面實際顯示的資料 = confirmedSession（後端最後一次確認過的底稿）
  // 疊上 pendingOps（還在排隊、尚未確認的樂觀猜測），由 recomputeSession() 算出。
  // 不要直接對 session 賦值整包資料，除非同時也更新 confirmedSession，
  // 否則下一次 recomputeSession() 會把手動塞進去的內容蓋掉。
  var session = null;
  var confirmedSession = null;
  var pendingOps = []; // { applyOptimistic }，依送出順序排列
  var loadError = null;
  var syncState = 'idle'; // 'idle'｜'syncing'｜'synced'｜'offline'｜'error'
  var pendingRetry = null;
  var undoTimer = null;
  var correctingIndex = null; // null＝沒有在更正；否則是「本節燈號紀錄」清單裡正在更正的那筆索引

  var displayScreen = document.getElementById('displayScreen');
  var teacherScreen = document.getElementById('teacherScreen');
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

  var passwordModal = document.getElementById('passwordModal');
  var passwordInput = document.getElementById('passwordInput');
  var passwordError = document.getElementById('passwordError');

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
  // 把畫面整包蓋掉——這是之前「連點下一個，上一個的結果就被復原」那個
  // bug 的根本原因：以前是直接拿後端回應整包取代畫面，但後端回應只反映
  // 它自己那一筆，會把還沒確認的下一筆效果一起蓋掉。
  //
  // actionQueue：真正送到後端的請求排隊、一次一筆，不是連按幾下就同時送出去。
  // 原因：後端處理一筆要 0.5~2 秒，畫面上的樂觀更新已經先讓使用者「感覺很快」，
  // 如果請求不排隊，連續點擊時後面的請求會帶著還沒更新到的舊 revision 送出，
  // 後端會誤判成「被別的裝置改過」而回報衝突——其實只是自己跟自己搶而已。
  // 排隊之後，每一筆送出前都會先等前一筆確認完、拿到最新 revision 才送，不會誤判。

  var actionQueue = Promise.resolve();

  // 畫面永遠是「後端確認過的底稿」疊上「還沒確認的樂觀猜測」，不是直接等於
  // 後端最新回應——這樣某一筆確認回來時，才不會把還沒確認的下一筆蓋掉。
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
      // 還有其他還沒確認的猜測排在後面，就繼續顯示「同步中」，不要提早顯示已同步/失敗。
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
          pendingRetry = null;
          removeOp();
          recomputeSession();
          settleSyncState('error');
          render();
          showNotice('教師密碼跟後端設定不一致，請確認 js/config.js 與 backend/Code.gs 的 PIN 是否相同。');
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

  // 用畫面上的小提示取代 alert()：alert() 會整個網頁完全卡住等使用者關掉它，
  // 上課中萬一沒注意到跳出來的視窗，會誤以為整頁當機、怎麼點都沒反應。
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

  // 分頁重新可見時呼叫：失敗就靜默略過，畫面維持最後一次成功取得的資料（對應文件 16.2）。
  // 即使這時候還有排隊中的樂觀猜測（pendingOps），也只是換掉底稿，猜測繼續疊在上面。
  function refreshSession() {
    Store.getCurrentSession().then(function (data) {
      setConfirmedSession(data);
      loadError = null;
      render();
    }).catch(function () {});
  }

  // 頁面第一次載入呼叫：失敗要讓教師看得出「連不上後端」，不能悄悄停在等待畫面。
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

  // ---------- 整體畫面切換 ----------

  function render() {
    renderDisplay();
    renderTeacher();
    displayScreen.hidden = mode !== 'display';
    teacherScreen.hidden = mode !== 'teacher';
  }

  // ---------- 學生前台（預設畫面） ----------

  function renderDisplay() {
    var waiting = document.getElementById('d-waitingState');
    var active = document.getElementById('d-activeState');
    var ended = document.getElementById('d-endedState');
    waiting.hidden = true;
    active.hidden = true;
    ended.hidden = true;

    if (!session) {
      waiting.hidden = false;
      waiting.querySelector('h1').textContent = loadError
        ? '無法連線到後端，請確認網路連線或 js/config.js 的 API_URL 設定'
        : '等待課堂開始…';
      return;
    }
    if (session.status === 'completed') { ended.hidden = false; return; }

    active.hidden = false;
    document.getElementById('d-className').textContent = session.className;

    var latest = latestLight(session);
    var dotEl = document.getElementById('d-lightDot');
    dotEl.className = 'dot-big' + (latest ? ' on-' + latest : '');
    document.getElementById('d-lightText').textContent = latest ? LIGHT_MEANING[latest] : '尚未設定';
    document.getElementById('d-lightSub').textContent = latest ? LIGHT_TEXT[latest] : '';

    var historyEl = document.getElementById('d-lightHistory');
    historyEl.innerHTML = '';
    if (!session.lights.length) {
      historyEl.innerHTML = '<p class="light-history-empty">尚未開始記錄</p>';
    } else {
      session.lights.forEach(function (entry, index) {
        historyEl.appendChild(makeChip(entry, index === session.lights.length - 1));
      });
    }

    var groupsEl = document.getElementById('d-groupsSection');
    groupsEl.innerHTML = '';
    session.groups.forEach(function (g) {
      var card = document.createElement('div');
      card.className = 'group-display-card' + (g.stars === 3 ? ' full-stars' : '') + (g.stars === 1 ? ' low-stars' : '');
      card.innerHTML =
        '<div class="group-card-head">' +
        '<span class="g-name">' + g.name + '</span>' +
        '<span class="g-bulb-badge' + (g.bulbs === 0 ? ' zero' : '') + '">' + bulbLabel(g.bulbs) + '</span>' +
        '</div>' +
        '<span class="g-stars">' + starsDisplayHtml(g.stars) + '</span>' +
        '<p class="g-stars-label">' + STARS_LABEL[g.stars] + '</p>';
      groupsEl.appendChild(card);
    });

    renderAchievements(session, 'd-achTrack');

    var banner = document.getElementById('d-syncBanner');
    if (syncState === 'offline' || syncState === 'error') {
      banner.hidden = false;
      banner.textContent = '暫時無法同步，目前顯示的是最後一次成功取得的資料';
    } else {
      banner.hidden = true;
    }
  }

  function latestLight(s) {
    return s.lights.length ? s.lights[s.lights.length - 1].color : null;
  }

  function formatTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '--:--';
    return d.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
  }

  function bulbLabel(count) {
    if (count >= 2) return '💡 × ' + count;
    return '💡';
  }

  // 學生前台用的唯讀星星：跟教師端一樣用 ⭐ emoji，已選全不透明、未選淡化。
  function starsDisplayHtml(stars) {
    var html = '';
    for (var i = 1; i <= 3; i++) {
      var filled = i <= stars;
      html += '<span class="star-char' + (filled ? ' filled' : '') + '">⭐</span>';
    }
    return html;
  }

  function renderAchievements(s, elId) {
    var trackEl = document.getElementById(elId);
    var list = s.achievements || [];
    trackEl.innerHTML = '';
    list.forEach(function (entry, index) {
      var ball = document.createElement('span');
      ball.className = 'ball ' + (entry.type === 'question' ? 'ball-question' : 'ball-help');
      ball.style.setProperty('--ball-color', BALL_COLORS[(entry.seat - 1) % BALL_COLORS.length]);
      ball.textContent = entry.seat;
      ball.dataset.index = index;
      trackEl.appendChild(ball);
    });
  }

  function makeChip(entry, isCurrent) {
    var span = document.createElement('span');
    span.className = 'chip chip-' + entry.color + (isCurrent ? ' current' : '');
    span.innerHTML = '<span class="dot dot-' + entry.color + '"></span>' + formatTime(entry.at);
    return span;
  }

  // ---------- 教師控制台（密碼通過後） ----------

  function renderTeacher() {
    var showConsole = !!session && session.status !== 'completed';
    startScreen.hidden = showConsole;
    consoleScreen.hidden = !showConsole;
    if (!showConsole) {
      // 開課失敗時（例如連不上後端）在這裡給提示，不能只靠 syncBadge——
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

  // ---------- 密碼登入 ----------

  function openPasswordModal() {
    passwordInput.value = '';
    passwordError.hidden = true;
    passwordModal.hidden = false;
    passwordInput.focus();
  }

  function closePasswordModal() {
    passwordModal.hidden = true;
  }

  function tryLogin() {
    var pin = window.APP_CONFIG && window.APP_CONFIG.TEACHER_PIN;
    if (passwordInput.value === pin) {
      mode = 'teacher';
      closePasswordModal();
      render();
    } else {
      passwordError.hidden = false;
    }
  }

  document.getElementById('teacherLoginBtn').addEventListener('click', openPasswordModal);
  document.getElementById('endedLoginBtn').addEventListener('click', openPasswordModal);
  document.getElementById('passwordCancelBtn').addEventListener('click', closePasswordModal);
  document.getElementById('passwordSubmitBtn').addEventListener('click', tryLogin);
  passwordInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') tryLogin();
  });
  passwordModal.addEventListener('click', function (e) {
    if (e.target === passwordModal) closePasswordModal();
  });

  function backToDisplay() {
    mode = 'display';
    render();
  }
  document.getElementById('backToDisplayBtn').addEventListener('click', backToDisplay);
  document.getElementById('backToDisplayFromStartBtn').addEventListener('click', backToDisplay);

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

  // 點一下已經加進去的球就移除（例如座號打錯了），只在教師端可以點。
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
    if (!confirm('確定要結束本節課嗎？結束後畫面會切回投影模式，顯示「本節課已結束」。')) return;
    mode = 'display';
    correctingIndex = null;
    var actionId = Store.newActionId();
    performAction(function () {
      return Store.endSession(session.sessionId, session.revision, actionId);
    });
  });

  // 分頁重新可見時（例如另一台已授權裝置切回來），重新取得最新狀態。
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) refreshSession();
  });

  render();
  initialLoad();
})();
