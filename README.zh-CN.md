# dsh-remote-mobile —— 手机远程操控 DSH Desktop 桌面客户端插件

为 **DeepSeek Harness (DSH) Desktop 客户端** 提供基于 **Tailscale** 安全组网的手机 Web 远程操控能力。

手机端打开浏览器即可获得与电脑端完全一致的 DSH 桌面交互界面（会话管理、多 Agent 协作、工具调用实时状态、审批确认、终端日志查看），并带有为移动端优化的手势交互、悬浮控制球与 PWA 全屏支持。

---

## 1. 为什么需要这个插件？

1. **DSH Desktop 的内部网络边界**：
   - DSH 桌面客户端底层采用 Electron + Node 宿主双层架构，内部 Web 服务与 RPC 网关默认**仅绑定回环地址 `127.0.0.1`**（动态分配高位端口，例如 61153）。
   - 官方核心模块为了防止网络侧远程代码执行 (RCE)，**显式禁止监听 `0.0.0.0` 通配地址**。
   - 客户端内部的 API Gateway 与 WebSocket 通道受随机生成的进程 Launch Token 和绑定在 `127.0.0.1` authority 的签名 Cookie 严格防护，外部网络设备直接连入会被判定为 `401 Unauthorized` 或 `403 Forbidden`。

2. **本插件的工作原理**：
   - 作为 DSH 宿主插件运行在同一个 Cordis 上下文中，可直接读取内部连接服务获取会话令牌。
   - 启动一个专为手机端服务的独立代理服务（默认端口 `8788`），**仅绑定在 Tailscale 虚拟网卡 (`100.68.50.93`) 与回环地址**。
   - 在服务端安全维护与 DSH 内部的会话 Cookie，完成 HTTP 请求头重写与 WebSocket 双向二进制流的透明中继。
   - 自动在 Web 页面中挂载移动层增强脚本（FAB 悬浮控制球、快捷键映射、PWA 全屏应用支持）。

---

## 2. 安全与鉴权体系

| 防护层级 | 实现方式 | 说明 |
|---|---|---|
| **网络层访问控制** | Tailscale 虚拟专网 + 客户端 IP 白名单 | 仅允许 `100.64.0.0/10`（Tailscale 网段）和回环访问；局域网 (LAN) 或公网其他 IP 访问会直接被拒绝 (403 Forbidden)。 |
| **应用层访问密钥** | 10 位无混淆大写字符 (Crockford Base32) | 排除了容易混淆的 `0, 1, I, O`。支持在 URL Query 参数中自动交换签名 Cookie，也可在登录页手动输入。 |
| **防暴力破解** | 滑动窗口与锁定保护 | 同一 IP 连续 8 次输入错误密钥将自动锁定 5 分钟 (429 Too Many Attempts)。对比使用常数时间算法 (`timingSafeEqual`) 防止时序攻击。 |
| **手机独立会话** | HMAC-SHA256 签名 Cookie (`dshm`) | 首次使用密钥登录后，手机端浏览器会获得 30 天有效的 HttpOnly 会话凭据，避免重复输入密钥。内部桌面 Launch Token 永不出机。 |

---

## 3. 移动端优化特性 (Mobile Layer)

由于 DSH Desktop 原生界面针对桌面显示器设计，插件在向手机端提供页面时自动挂载了轻量级 Shadow DOM 移动交互层：

1. **悬浮控制球 (FAB)**：
   - 位于手机屏幕右下角安全区（支持 iOS/Android 底部手势横条与虚拟键盘避让）。
   - 点击弹出半屏控制面板，提供桌面快捷操作：
     - **☰ 侧栏切换**：触发 `Ctrl+Alt+B` 展开/折叠左侧会话历史列表。
     - **⌨ 聚焦输入框**：一键激活底部 Prompt 输入框并平滑滚动到视口中央。
     - **⬇ 最新消息**：快速回到长对话记录的最底部。
     - **＋ 新会话**：快速创建空白会话。
     - **⟳ 刷新页面** / **⛶ 全屏模式**。
     - **🖥 桌面版切换**：点击后切换到桌面原生无约束排版，带 `?desktop=1` 或 `?mobile=1` 随时切回。
     - **ⓘ 状态查看** / **⏻ 退出当前设备**。
2. **移动端 CSS 调优**：
   - 输入框文字自动强制不低于 `16px`，彻底杜绝 iOS Safari 聚焦输入时整个页面被错误放大的问题。
   - 触摸元素开启 `touch-action: manipulation`，消除双击缩放延迟，点击响应更跟手。
   - 支持 PWA `standalone` 独立窗口展示，适配刘海屏与灵动岛顶部安全边距。

---

## 4. 安装与配置

本插件已经注册并挂载在 `dsh-client-config` 中，配置位于：
- **权威源**：`C:\Users\Admin\DeepSeek_Harness\dsh-client-config\profiles\desktop\cordis.patch.yml`
- **运行时镜像**：`C:\Users\Admin\.dsh\profiles\desktop\cordis.patch.yml`
- **模块软链接**：`C:\Users\Admin\.dsh\profiles\node_modules\dsh-remote-mobile` -> 本插件目录

### 配置项参考

在 `cordis.patch.yml` 中即可调整插件参数：

```yaml
- insert:
    - id: remote-mobile
      name: dsh-remote-mobile
      config:
        enabled: true           # 是否启用手机远程插件
        port: 8788              # 手机访问监听端口 (默认 8788)
        bind: auto              # 绑定模式: auto (Tailscale+回环) | tailscale | loopback | 指定IP
        accessKey: ''           # 自定义固定密钥（留空则自动随机生成 10 位高强度密钥）
        mobileLayer: true       # 是否启用移动端浮动按钮与交互层
        allowedNetworks:        # 允许访问的 IP/CIDR 白名单
          - '100.64.0.0/10'
          - '127.0.0.0/8'
          - '::1/128'
        cookieMaxAgeDays: 30    # 手机登录状态保存天数
        trustProxy: false       # 若前面有反代/Tailscale Serve，开启后可信任 X-Forwarded-Proto
```

---

## 5. 快速使用步骤

### 第一步：完全重启 DSH Desktop 桌面客户端
退出电脑右下角托盘及任务管理器中的 `DeepSeek Harness` 进程，重新打开客户端。
客户端启动时会在控制台输出手机访问 URL，并将密钥持久化保存至：
`C:\Users\Admin\.dsh\remote-mobile\state.json` 与 `url.txt`。

### 第二步：在电脑端查看手机访问地址
在 PowerShell 中运行附带的查看脚本：
```powershell
cd C:\Users\Admin\DeepSeek_Harness\dsh-client-config\plugins\dsh-remote-mobile\scripts
.\show-mobile-url.ps1
```
输出示例：
```text
==========================================================
          DeepSeek Harness 手机远程访问信息               
==========================================================
[Tailscale 本机 IP]   : 100.68.50.93
[Tailscale 机器域名] : desktop-rf2a4jo.tail8c398c.ts.net
[手机访问密钥 (Key)] : K7M2QP9X4R
[服务状态]           : 正在运行 (监听端口: 8788)

----------------------- 访问方式 -------------------------
【方式 1：Tailscale HTTP 直连（开箱即用，WireGuard 内网加密）】
  👉 http://100.68.50.93:8788/?key=K7M2QP9X4R

【方式 2：Tailscale HTTPS 域名访问（支持 PWA 全屏安装）】
  👉 https://desktop-rf2a4jo.tail8c398c.ts.net/?key=K7M2QP9X4R
==========================================================
```

### 第三步：手机端打开访问
1. 确保手机已连接 **Tailscale** App，且处于同一个 Tailnet 局域网。
2. 手机浏览器（Safari / Chrome / Edge）输入上述 `http://100.68.50.93:8788/?key=...` 链接。
3. 网页自动通过密钥建立会话并跳转至主界面，开始操控 DSH！

---

## 6. 进阶：配置 Tailscale HTTPS 域名访问与 PWA 全屏应用

如果你希望像使用原生手机 App 一样全屏使用 DSH，无需输入端口号，可在电脑端执行：

```powershell
cd C:\Users\Admin\DeepSeek_Harness\dsh-client-config\plugins\dsh-remote-mobile\scripts
.\enable-tailscale-https.ps1
```

该脚本将自动通过 `tailscale serve` 为本机的 `8788` 端口绑定标准的 HTTPS 443 端口并获取有效证书：
1. **无需输入端口**：直接在手机浏览器访问 `https://desktop-rf2a4jo.tail8c398c.ts.net/?key=...`
2. **添加到主屏幕**：
   - **iPhone (iOS)**：在 Safari 底部点击「分享」按钮 -> 选择「添加到主屏幕」
   - **Android**：在 Chrome 右上角菜单选择「添加到主屏幕」或「安装应用」
3. 从桌面图标启动后，将以**独立全屏应用模式**运行，无多余浏览器地址栏与导航条，体验极佳。

---

## 7. 常用排查与诊断

1. **手机打不开网页（连接超时 / Connection Refused）**：
   - 检查手机端 Tailscale VPN 是否开启并显示为 Connected。
   - 在电脑端运行 `tailscale status` 确认手机设备是否在线（例如 `dgj-xiaomi-phone`）。
   - 在电脑端运行 `Get-NetTCPConnection -LocalPort 8788` 确认 8788 端口是否处于 `Listen` 状态。

2. **提示 403 Forbidden**：
   - 说明当前手机连接的 IP 地址不在 `allowedNetworks` 白名单中（例如手机连了家用 WiFi 但没有走 Tailscale VPN）。开启手机 Tailscale 即可。

3. **提示 401 Unauthorized**：
   - 访问地址没有携带有效的 `?key=` 参数，或者密钥已被重置。直接在页面输入 `show-mobile-url.ps1` 打印的 10 位 Key 即可重新登录。

4. **想重置访问密钥**：
   - 直接删除 `C:\Users\Admin\.dsh\remote-mobile\state.json`，重启 DSH 客户端，系统将自动生成新密钥。
