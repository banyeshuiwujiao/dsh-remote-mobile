# show-mobile-url.ps1 — 查看 DSH 手机远程访问地址与状态
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$homeDir = if ($env:DSH_HOME) { $env:DSH_HOME } else { "$env:USERPROFILE\.dsh" }
$urlFile = Join-Path $homeDir 'remote-mobile\url.txt'
$statusFile = Join-Path $homeDir 'remote-mobile\status.json'
$stateFile = Join-Path $homeDir 'remote-mobile\state.json'

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "          DeepSeek Harness 手机远程访问信息               " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# 1. 检查 Tailscale
$tsIp = $null
$tsDns = $null
try {
    $tsStatus = tailscale status --json 2>$null | ConvertFrom-Json
    if ($tsStatus -and $tsStatus.Self) {
        $tsIp = ($tsStatus.Self.TailscaleIPs | Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+$' }) | Select-Object -First 1
        $tsDns = $tsStatus.Self.DNSName.TrimEnd('.')
    }
} catch {}

if ($tsIp) {
    Write-Host "[Tailscale 本机 IP]   : $tsIp" -ForegroundColor Green
    if ($tsDns) {
        Write-Host "[Tailscale 机器域名] : $tsDns" -ForegroundColor Green
    }
} else {
    Write-Host "[Tailscale] 未检测到 Tailscale 正在运行或未分配 IPv4" -ForegroundColor Yellow
}

# 2. 检查访问密钥
$key = $null
if (Test-Path $stateFile) {
    try {
        $state = Get-Content $stateFile -Raw | ConvertFrom-Json
        $key = $state.accessKey
        Write-Host "[手机访问密钥 (Key)] : $key" -ForegroundColor Magenta
    } catch {}
}

# 3. 检查服务运行状态
if (Test-Path $statusFile) {
    try {
        $status = Get-Content $statusFile -Raw | ConvertFrom-Json
        $running = $status.running
        $port = $status.port
        if ($running) {
            Write-Host "[服务状态]           : 正在运行 (监听端口: $port)" -ForegroundColor Green
            Write-Host "[上游连接]           : $($status.upstream.origin)" -ForegroundColor Gray
            Write-Host "[已处理请求数]       : $($status.requests)" -ForegroundColor Gray
        } else {
            Write-Host "[服务状态]           : 未运行 (已停止)" -ForegroundColor Yellow
        }
    } catch {}
} else {
    Write-Host "[服务状态]           : 尚未生成状态文件（请先启动或重启 DSH Desktop 客户端）" -ForegroundColor Yellow
}

Write-Host "`n----------------------- 访问方式 -------------------------" -ForegroundColor Cyan

if (Test-Path $urlFile) {
    $urls = Get-Content $urlFile | Where-Object { $_.Trim() -ne '' }
    Write-Host "【方式 1：Tailscale HTTP 直连（开箱即用，WireGuard 内网加密）】" -ForegroundColor White
    foreach ($u in $urls) {
        Write-Host "  👉 $u" -ForegroundColor Yellow
    }
} elseif ($tsIp -and $key) {
    Write-Host "【方式 1：Tailscale HTTP 直连】" -ForegroundColor White
    Write-Host "  👉 http://$($tsIp):8788/?key=$key" -ForegroundColor Yellow
}

if ($tsDns -and $key) {
    Write-Host "`n【方式 2：Tailscale HTTPS 域名访问（支持 PWA 全屏安装）】" -ForegroundColor White
    Write-Host "  如已启用 tailscale serve，可通过以下 HTTPS 地址访问：" -ForegroundColor Gray
    Write-Host "  👉 https://$($tsDns)/?key=$key" -ForegroundColor Green
    Write-Host "  (若尚未配置 HTTPS 转发，可执行 .\enable-tailscale-https.ps1 开启)" -ForegroundColor DarkGray
}

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "提示: 首次在手机浏览器打开上述带 ?key= 链接后会自动完成免密认证，" -ForegroundColor Gray
Write-Host "并在手机端保持 30 天有效。页面右下角有移动端悬浮控制按钮。" -ForegroundColor Gray
