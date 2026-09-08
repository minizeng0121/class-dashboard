/*
 * 前端設定檔。
 * 部署 Apps Script 成 Web App 之後，把拿到的網址貼到下面 API_URL。
 * 教師密碼不放在這裡（也不進 git）：登入時輸入什麼，就送去問後端對不對，
 * 正確答案只存在 backend/Code.gs 的 TEACHER_PIN，這樣公開 repo 裡才不會
 * 看得到真正的密碼。
 */
window.APP_CONFIG = {
  API_URL: 'https://script.google.com/macros/s/AKfycbzGC_uGZCBVLWIgZazazjiUIw_z7cFLhZIGqEOW_ykQRijtc7EQEp0hLgyglN0rGB2Opw/exec'
};
