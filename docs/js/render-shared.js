/*
 * display.js／teacher.js 共用的畫面小工具。
 * 避免同一段常數/函式在兩個檔案各寫一份，以後改一邊忘記改另一邊。
 */
(function (global) {
  var STARS_LABEL = { 3: '有效的自主合作中！', 2: '逐漸進入軌道', 1: '需要較多支持' };
  var LIGHT_CHIP_LABEL = { green: '綠', yellow: '黃', red: '紅' };
  // 學生前台用的語意文字：不只是講顏色，而是直接講這個顏色現在代表什麼意思。
  var LIGHT_MEANING = {
    green: '目前很專注音量很適當',
    yellow: '注意小組討論不超過第三人聽',
    red: '目前像進到菜市場'
  };
  // 特殊表現球的色票，只用來區分不同座號、跟燈號顏色沒有語意關係。
  // 8 色循環，一般班級座號不超過 26 號，大約循環 3 輪，色階偏亮一點、不要太暗。
  var BALL_COLORS = ['#e15c4e', '#e2833c', '#d9a83c', '#3cae6c', '#2aa398', '#4a86c2', '#8268b8', '#db6f95'];

  function formatTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '--:--';
    return d.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
  }

  function latestLight(s) {
    return s.lights.length ? s.lights[s.lights.length - 1].color : null;
  }

  function bulbLabel(count) {
    if (count >= 2) return '💡 × ' + count;
    return '💡';
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

  global.RenderShared = {
    STARS_LABEL: STARS_LABEL,
    LIGHT_CHIP_LABEL: LIGHT_CHIP_LABEL,
    LIGHT_MEANING: LIGHT_MEANING,
    BALL_COLORS: BALL_COLORS,
    formatTime: formatTime,
    latestLight: latestLight,
    bulbLabel: bulbLabel,
    renderAchievements: renderAchievements
  };
})(window);
