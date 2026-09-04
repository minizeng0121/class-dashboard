# 在本機開一個簡易網頁伺服器，並自動開啟瀏覽器。
# 用法：在 PowerShell 裡執行 .\start.ps1
$port = 8000
Start-Process "http://localhost:$port/index.html"
python -m http.server $port
