(function () {
  // Demo 用固定密碼，只是為了擋掉學生隨手亂點教師控制台，不是真正的帳號驗證。
  // 之後接上真正後端時，這裡要換成規格文件裡的 Google 帳號登入。
  var TEACHER_PIN = '1234';

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
    synced: '已同步',
    syncing: '同步中',
    offline: '離線，操作等待同步',
    error: '同步失敗，請重試'
  };
  var ACTION_LABEL = {
    stars: '剛調整了小組星級',
    bulb: '剛調整了 💡 數量'
  };
  // 特殊表現球的色票，只用來區分不同座號、跟燈號顏色沒有語意關係。
  // 8 色循環，一般班級座號不超過 26 號，大約循環 3 輪，色階偏亮一點、不要太暗。
  var BALL_COLORS = ['#e15c4e', '#e2833c', '#d9a83c', '#3cae6c', '#2aa398', '#4a86c2', '#8268b8', '#db6f95'];

  var mode = 'display'; // 'display'（預設，學生看的）｜'teacher'（密碼通過後）
  var session = Store.loadSession();
  var undoTimer = null;
  var correctingIndex = null; // null＝沒有在更正；否則是「本節燈號紀錄」清單裡正在更正的那筆索引

  var displayScreen = document.getElementById('displayScreen');
  var teacherScreen = document.getElementById('teacherScreen');
  var startScreen = document.getElementById('startScreen');
  var consoleScreen = document.getElementById('consoleScreen');
  var groupsSection = document.getElementById('groupsSection');
  var classSelect = document.getElementById('classSelect');
  var groupCountInput = document.getElementById('groupCount');
  var undoBar = document.getElementById('undoBar');
  var undoText = document.getElementById('undoText');
  var syncBadge = document.getElementById('syncBadge');
  var demoSyncSelect = document.getElementById('demoSyncSelect');

  var passwordModal = document.getElementById('passwordModal');
  var passwordInput = document.getElementById('passwordInput');
  var passwordError = document.getElementById('passwordError');

  Store.DEFAULT_CLASSES.forEach(function (name) {
    var opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    classSelect.appendChild(opt);
  });

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

    if (!session) { waiting.hidden = false; return; }
    if (session.status === 'ended') { ended.hidden = false; return; }

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
    if (session.syncDemoState === 'offline' || session.syncDemoState === 'error') {
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

  // 舊版本開的課堂可能沒有 achievements 欄位，這裡用 || [] 防呆，不做資料遷移。
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
    var showConsole = !!session && session.status !== 'ended';
    startScreen.hidden = showConsole;
    consoleScreen.hidden = !showConsole;
    if (!showConsole) return;

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
    syncBadge.textContent = SYNC_LABEL[session.syncDemoState] || SYNC_LABEL.synced;
    syncBadge.className = 'sync-badge sync-' + session.syncDemoState;
    demoSyncSelect.value = session.syncDemoState;
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

  function afterAction() {
    renderUndoBar();
    if (session.syncDemoState === 'offline' || session.syncDemoState === 'error') {
      render();
      return;
    }
    session.syncDemoState = 'syncing';
    Store.saveSession(session);
    render();
    setTimeout(function () {
      session.syncDemoState = 'synced';
      Store.saveSession(session);
      render();
    }, 400);
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
    if (passwordInput.value === TEACHER_PIN) {
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
    session = Store.startSession(className, groupCount);
    correctingIndex = null;
    render();
  });

  // 上方：永遠是「記錄新的一筆」，不限筆數，1 次點擊完成。
  document.querySelectorAll('.light-buttons .light-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      Store.addLight(session, btn.dataset.color);
      afterAction();
    });
  });

  // 下方：點某一筆既有紀錄進入更正模式。
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
    Store.correctLight(session, index, newColor);
    afterAction();
  });

  groupsSection.addEventListener('click', function (e) {
    var card = e.target.closest('.group-card');
    if (!card) return;
    var groupId = card.dataset.groupId;

    var starBtn = e.target.closest('.star');
    if (starBtn) {
      Store.setStars(session, groupId, parseInt(starBtn.dataset.value, 10));
      afterAction();
      return;
    }

    var bulbBtn = e.target.closest('.bulb-badge');
    if (bulbBtn) {
      Store.addBulb(session, groupId, 1);
      afterAction();
    }
  });

  function addAchievementFromInput(type) {
    var seatInput = document.getElementById('achSeatInput');
    var seat = parseInt(seatInput.value, 10);
    if (!seat || seat < 1) return;
    Store.addAchievement(session, seat, type);
    afterAction();
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
    Store.removeAchievement(session, index);
    afterAction();
  });

  document.getElementById('undoBtn').addEventListener('click', function () {
    Store.undoLastAction(session);
    undoBar.hidden = true;
    render();
  });

  demoSyncSelect.addEventListener('change', function () {
    session.syncDemoState = demoSyncSelect.value;
    Store.saveSession(session);
    render();
  });

  document.getElementById('endSessionBtn').addEventListener('click', function () {
    if (!confirm('確定要結束本節課嗎？結束後畫面會切回投影模式，顯示「本節課已結束」。')) return;
    Store.endSession(session);
    mode = 'display';
    correctingIndex = null;
    render();
  });

  // 另一個分頁（例如另一台裝置）改了資料時，這裡也要跟著更新。
  window.addEventListener('storage', function (e) {
    if (e.key === Store.STORAGE_KEY) {
      session = Store.loadSession();
      render();
    }
  });

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) {
      session = Store.loadSession();
      render();
    }
  });

  render();
})();
