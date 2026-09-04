(function () {
  var STARS_LABEL = { 3: '自主合作', 2: '發展中', 1: '需要較多支持' };
  var LIGHT_CHIP_LABEL = { green: '綠', yellow: '黃', red: '紅' };
  var SYNC_LABEL = {
    synced: '已同步',
    syncing: '同步中',
    offline: '離線，操作等待同步',
    error: '同步失敗，請重試'
  };
  var ACTION_LABEL = {
    light: '剛新增了一次燈號',
    stars: '剛調整了小組星級',
    bulb: '剛調整了 💡 數量'
  };

  var session = Store.loadSession();
  var undoTimer = null;

  var startScreen = document.getElementById('startScreen');
  var consoleScreen = document.getElementById('consoleScreen');
  var endedScreen = document.getElementById('endedScreen');
  var classSelect = document.getElementById('classSelect');
  var groupCountInput = document.getElementById('groupCount');
  var groupsSection = document.getElementById('groupsSection');
  var undoBar = document.getElementById('undoBar');
  var undoText = document.getElementById('undoText');
  var syncBadge = document.getElementById('syncBadge');
  var demoSyncSelect = document.getElementById('demoSyncSelect');

  Store.DEFAULT_CLASSES.forEach(function (name) {
    var opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    classSelect.appendChild(opt);
  });

  function showScreen(name) {
    startScreen.hidden = name !== 'start';
    consoleScreen.hidden = name !== 'console';
    endedScreen.hidden = name !== 'ended';
  }

  function render() {
    if (!session) { showScreen('start'); return; }
    if (session.status === 'ended') { showScreen('ended'); return; }
    showScreen('console');

    document.getElementById('className').textContent = session.className;
    document.getElementById('startedAtText').textContent =
      '開始時間：' + new Date(session.startedAt).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });

    renderSyncBadge();
    renderLights();
    renderGroups();
    renderUndoBar();
  }

  function renderSyncBadge() {
    syncBadge.textContent = SYNC_LABEL[session.syncDemoState] || SYNC_LABEL.synced;
    syncBadge.className = 'sync-badge sync-' + session.syncDemoState;
    demoSyncSelect.value = session.syncDemoState;
  }

  function renderLights() {
    var latest = null;
    for (var i = session.lights.length - 1; i >= 0; i--) {
      if (session.lights[i]) { latest = session.lights[i]; break; }
    }
    document.querySelectorAll('.light-btn').forEach(function (btn) {
      btn.classList.toggle('active', btn.dataset.color === latest);
    });

    var historyEl = document.getElementById('lightHistory');
    historyEl.innerHTML = '';
    session.lights.forEach(function (l) {
      var span = document.createElement('span');
      span.className = 'chip' + (l ? ' chip-' + l : ' chip-empty');
      span.textContent = l ? LIGHT_CHIP_LABEL[l] : '尚未';
      historyEl.appendChild(span);
    });
  }

  function renderGroups() {
    groupsSection.innerHTML = '';
    session.groups.forEach(function (g) {
      var card = document.createElement('div');
      card.className = 'group-card';
      card.dataset.groupId = g.id;

      var starsHtml = '';
      for (var i = 1; i <= 3; i++) {
        var filled = i <= g.stars;
        starsHtml += '<button type="button" class="star' + (filled ? ' filled' : '') +
          '" data-value="' + i + '" aria-label="設為 ' + i + ' 顆星">' +
          (filled ? '★' : '☆') + '</button>';
      }

      card.innerHTML =
        '<h3>' + g.name + '</h3>' +
        '<div class="stars">' + starsHtml + '</div>' +
        '<p class="stars-label">' + STARS_LABEL[g.stars] + '</p>' +
        '<div class="bulb-controls">' +
        '<button type="button" class="bulb-btn minus" aria-label="減少一次深度提問">－💡</button>' +
        '<span class="bulb-count">' + g.bulbs + '</span>' +
        '<button type="button" class="bulb-btn plus" aria-label="增加一次深度提問">＋💡</button>' +
        '</div>';

      groupsSection.appendChild(card);
    });
  }

  function renderUndoBar() {
    if (session.lastAction) {
      undoBar.hidden = false;
      undoText.textContent = ACTION_LABEL[session.lastAction.type] || '剛完成一次操作';
      clearTimeout(undoTimer);
      undoTimer = setTimeout(function () { undoBar.hidden = true; }, 5000);
    } else {
      undoBar.hidden = true;
    }
  }

  // 操作完成後：先假裝「同步中」一下，再變回「已同步」，
  // 讓畫面上看得出規格第 13.3 節要求的那幾種同步狀態。
  // 如果 demo 目前手動切成離線／同步失敗，就不要自動蓋回已同步。
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

  document.getElementById('startBtn').addEventListener('click', function () {
    var className = classSelect.value;
    var groupCount = parseInt(groupCountInput.value, 10) || 5;
    session = Store.startSession(className, groupCount);
    render();
  });

  document.querySelectorAll('.light-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var result = Store.addLight(session, btn.dataset.color);
      if (!result.ok) {
        alert('這堂課已經記錄三次燈號了，如需更正請使用復原或管理性資料維護流程。');
        return;
      }
      afterAction();
    });
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

    var bulbBtn = e.target.closest('.bulb-btn');
    if (bulbBtn) {
      var delta = bulbBtn.classList.contains('plus') ? 1 : -1;
      Store.addBulb(session, groupId, delta);
      afterAction();
    }
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

  document.getElementById('openDisplayBtn').addEventListener('click', function () {
    window.open('display.html', '_blank');
  });

  document.getElementById('endSessionBtn').addEventListener('click', function () {
    if (!confirm('確定要結束本節課嗎？結束後學生前台將顯示「本節課已結束」。')) return;
    Store.endSession(session);
    render();
  });

  document.getElementById('newSessionBtn').addEventListener('click', function () {
    Store.clearSession();
    session = null;
    render();
  });

  // 另一個分頁（例如另一台教師裝置）改了資料時，這個分頁也要跟著更新。
  window.addEventListener('storage', function (e) {
    if (e.key === Store.STORAGE_KEY) {
      session = Store.loadSession();
      render();
    }
  });

  render();
})();
