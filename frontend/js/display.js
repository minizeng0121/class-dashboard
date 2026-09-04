(function () {
  var LIGHT_TEXT = { green: '目前綠燈', yellow: '目前黃燈', red: '目前紅燈' };
  var LIGHT_CHIP_LABEL = { green: '綠', yellow: '黃', red: '紅' };
  var STARS_LABEL = { 3: '自主合作', 2: '發展中', 1: '需要較多支持' };

  var session = Store.loadSession();

  var waitingState = document.getElementById('waitingState');
  var activeState = document.getElementById('activeState');
  var endedState = document.getElementById('endedState');
  var syncBanner = document.getElementById('d-syncBanner');

  function render() {
    waitingState.hidden = true;
    activeState.hidden = true;
    endedState.hidden = true;

    if (!session) { waitingState.hidden = false; return; }
    if (session.status === 'ended') { endedState.hidden = false; return; }

    activeState.hidden = false;
    renderOrderSection();
    renderGroups();
    renderSyncBanner();
  }

  function latestLight() {
    for (var i = session.lights.length - 1; i >= 0; i--) {
      if (session.lights[i]) return session.lights[i];
    }
    return null;
  }

  function renderOrderSection() {
    document.getElementById('d-className').textContent = session.className;

    var latest = latestLight();
    var dotEl = document.getElementById('d-lightDot');
    dotEl.className = 'dot-big' + (latest ? ' on-' + latest : '');
    document.getElementById('d-lightText').textContent = latest ? LIGHT_TEXT[latest] : '尚未設定';

    var historyEl = document.getElementById('d-lightHistory');
    historyEl.innerHTML = '';
    session.lights.forEach(function (l) {
      var span = document.createElement('span');
      span.className = 'chip' + (l ? ' chip-' + l : ' chip-empty');
      span.textContent = l ? LIGHT_CHIP_LABEL[l] : '尚未';
      historyEl.appendChild(span);
    });
  }

  function renderGroups() {
    var groupsEl = document.getElementById('d-groupsSection');
    groupsEl.innerHTML = '';
    session.groups.forEach(function (g) {
      var card = document.createElement('div');
      card.className = 'group-display-card';

      var starsStr = '★'.repeat(g.stars) + '☆'.repeat(3 - g.stars);
      var bulbStr = g.bulbs === 0 ? '' : (g.bulbs === 1 ? '💡' : '💡 × ' + g.bulbs);

      card.innerHTML =
        '<span class="g-name">' + g.name + '</span>' +
        '<span class="g-stars">' + starsStr + '</span>' +
        '<span class="g-stars-label">' + STARS_LABEL[g.stars] + '</span>' +
        '<span class="g-bulb">' + bulbStr + '</span>';

      groupsEl.appendChild(card);
    });
  }

  function renderSyncBanner() {
    if (session.syncDemoState === 'offline' || session.syncDemoState === 'error') {
      syncBanner.hidden = false;
      syncBanner.textContent = '暫時無法同步，目前顯示的是最後一次成功取得的資料';
    } else {
      syncBanner.hidden = true;
    }
  }

  // 模擬規格 15.2：教師端有動作就會寫入 localStorage，
  // 這裡的 storage 事件會在「另一個分頁」被觸發，用來模擬跨裝置同步。
  window.addEventListener('storage', function (e) {
    if (e.key === Store.STORAGE_KEY) {
      session = Store.loadSession();
      render();
    }
  });

  // 對應規格 15.2：切回這個分頁時立即重新同步一次。
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) {
      session = Store.loadSession();
      render();
    }
  });

  render();
})();
