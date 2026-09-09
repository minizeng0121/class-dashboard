/*
 * 學生投影頁。純讀取，不寫入，所以不需要教師頁那套樂觀更新機制——
 * 這裡的 session 就是後端最後一次回應的內容，靠定期輪詢保持更新。
 */
(function () {
  var STARS_LABEL = RenderShared.STARS_LABEL;
  var LIGHT_MEANING = RenderShared.LIGHT_MEANING;
  var formatTime = RenderShared.formatTime;
  var latestLight = RenderShared.latestLight;
  var bulbLabel = RenderShared.bulbLabel;
  var renderAchievements = RenderShared.renderAchievements;
  var LIGHT_TEXT = { green: '目前綠燈', yellow: '目前黃燈', red: '目前紅燈' };

  var session = null;
  var loadError = null; // 只在「第一次都還沒連上過」時使用
  var fetchFailed = false; // 已經有過資料，這次輪詢失敗時使用，不清空畫面

  var POLL_INTERVAL_MS = 4000; // 對應文件 15.2：學生前台每 3–5 秒取得最新狀態

  function render() {
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
    if (fetchFailed) {
      banner.hidden = false;
      banner.textContent = '暫時無法同步，目前顯示的是最後一次成功取得的資料';
    } else {
      banner.hidden = true;
    }
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

  function makeChip(entry, isCurrent) {
    var span = document.createElement('span');
    span.className = 'chip chip-' + entry.color + (isCurrent ? ' current' : '');
    span.innerHTML = '<span class="dot dot-' + entry.color + '"></span>' + formatTime(entry.at);
    return span;
  }

  // Apps Script 回應快慢不一，兩次輪詢的請求／回應順序可能顛倒：慢的那次
  // 明明先送出，卻晚到，回來的是比較舊的資料，如果直接套用會把畫面上已經
  // 顯示的新資料蓋回舊的，看起來就像燈號/星等自己在亂跳。用 revision 版本號
  // 判斷：新回應的版本號比目前畫面還舊，就直接丟棄，不套用。
  function applyIfNewer(data) {
    if (session && data && data.sessionId === session.sessionId && data.revision < session.revision) {
      return; // 過期的輪詢回應，忽略
    }
    session = data;
  }

  function refresh() {
    Store.getCurrentSession().then(function (data) {
      applyIfNewer(data);
      loadError = null;
      fetchFailed = false;
      render();
    }).catch(function () {
      fetchFailed = true;
      render();
    });
  }

  function initialLoad() {
    Store.getCurrentSession().then(function (data) {
      applyIfNewer(data);
      loadError = null;
      render();
    }).catch(function (err) {
      loadError = err;
      render();
    });
  }

  // 分頁重新可見時額外刷新一次、順便重新起算輪詢間隔，避免「剛好切回來」跟
  // 「輪詢剛好也到時間」兩個幾乎同時觸發，短時間內打兩次一樣的請求。
  var pollTimer = null;
  function restartPolling() {
    clearInterval(pollTimer);
    pollTimer = setInterval(refresh, POLL_INTERVAL_MS);
  }
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) {
      refresh();
      restartPolling();
    }
  });

  restartPolling();

  render();
  initialLoad();
})();
