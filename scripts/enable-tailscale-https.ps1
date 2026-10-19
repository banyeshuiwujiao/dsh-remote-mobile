# enable-tailscale-https.ps1 — 配置 Tailscale HTTPS 转发到 DSH 手机远程代理
#
# 作用：
#   通过 `tailscale serve` 把本机 8788 端口以 HTTPS (443) 形式暴露给 Tailscale 内网设备（手机）。
#   好处：
#     1. 手机端通过标准 443 端口访问，无需在 URL 后面输入端口号 :8788。
#     2. 自动获得 Let's Encrypt / Tailscale 权威证书，在 iOS / Android 上具备安全上下文 (Secure Context)。
#     3. 手机 Safari / Chrome 可直接「添加到主屏幕」安装为独立 PWA 全屏应用，体验媲美原生 App。
#
# 前提：
#   Tailnet 控制台已开启 HTTPS 功能（MagicDNS + HTTPS Certificates）。
[CmdletBinding()]
param(
    [int]$Port = 8788,
    [switch]$Reset
)

$ErrorActionPreference = 'Stop'

if ($Reset) {
    Write-Host "[Tailscale Serve] 正在清除 443 转发配置..." -ForegroundColor Yellow
    tailscale serve --https=443 off
    Write-Host "[Tailscale Serve] 已关闭 HTTPS 转发。" -ForegroundColor Green
    return
}

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "           配置 Tailscale HTTPS (443) 转发                " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# 检查当前 tailscale serve 状态
Write-Host "[1/3] 检查当前 Tailscale 状态..." -ForegroundColor White
$tsStatus = tailscale status --json 2>$null | ConvertFrom-Json
if (-not $tsStatus -or -not $tsStatus.Self) {
    Write-Error "Tailscale 未运行，请先启动 Tailscale 客户端！"
    exit 1
}

$dnsName = $tsStatus.Self.DNSName.TrimEnd('.')
Write-Host "      本机 MagicDNS 域名: $dnsName" -ForegroundColor Green

# 检查 8788 端口是否就绪
Write-Host "[2/3] 检查端口 127.0.0.1:$Port ..." -ForegroundColor White
$conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if (-not $conn) {
    Write-Host "      [注意] 端口 $Port 当前未检测到监听服务。" -ForegroundColor Yellow
    Write-Host "      若 DSH Desktop 尚未启动或插件未加载，可先完成转发配置，随后启动 DSH 即可生效。" -ForegroundColor Gray
} else {
    Write-Host "      [OK] 端口 $Port 正在监听。" -ForegroundColor Green
}

# 执行配置
Write-Host "[3/3] 配置 tailscale serve (443 -> 127.0.0.1:$Port)..." -ForegroundColor White
try {
    # 配置 HTTPS 443 转发到 http://127.0.0.1:8788
    & tailscale serve --bg --https=443 "http://127.0.0.1:$Port"
    if ($LASTEXITCODE -eq 0) {
        Write-Host "`n[成功] Tailscale HTTPS 转发已启用！" -ForegroundColor Green
        Write-Host "手机访问地址: https://$dnsName/" -ForegroundColor Cyan
        Write-Host "如需携带密钥免输入登录，请运行: .\show-mobile-url.ps1 查看完整 URL。" -ForegroundColor Gray
    } else {
        Write-Host "`n[提示] tailscale serve 返回状态码 $LASTEXITCODE，请检查 Tailnet 是否开启了 HTTPS 证书功能。" -ForegroundColor Yellow
    }
} catch {
    Write-Error "配置 tailscale serve 失败: $($_.Exception.Message)"
}

Write-Host "==========================================================" -ForegroundColor Cyan
