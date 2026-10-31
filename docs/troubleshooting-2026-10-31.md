# 排查记录：2026-10-31 手机远程访问全链路故障

> 本文记录 2026-10-31 一次完整的「手机远程操控 DSH」故障排查。当天问题从**宿主进程起不来**一路延伸到**手机端首屏慢**，共 6 个独立故障点，另有 3 个被实测**否证**的假设。留档目的是避免重复踩坑，以及让后来者能直接跳过已经被排除的方向。
>
> 涉及仓库：`deepseek-harness`、`dsh-client-config`、`dsh-computer-use`、`dsh-remote-mobile`。
> 本文所有数字均来自本机实测，标注了测量方式。

## 环境基线

| 项 | 值 |
|---|---|
| 宿主启动命令 | `pnpm dsh web --no-open --trusted-host dsh-mobile.20261314.xyz --trusted-host desktop-msi-laptop` |
| 宿主工作目录 | `C:\AITask\deepseek-harness` |
| 监听 | `127.0.0.1:3080`（Web UI）+ `127.0.0.1:8788`（本插件代理） |
| 手机入口 | `https://dsh-mobile.20261314.xyz`（Cloudflare Tunnel → 8788 → 3080） |
| PC 网络 | 企业 Wi-Fi `SLYY_NEI`，`10.25.99.212`，出口 `58.56.30.218`（聊城电信） |
| 手机网络 | 家宽 `123.233.206.38`（济南联通） |

链路拓扑：

```
手机 ──HTTPS──▶ Cloudflare 边缘(SIN) ──隧道──▶ cloudflared ──▶ 127.0.0.1:8788 ──▶ 127.0.0.1:3080
                                                                  (本插件)          (dsh web)
```

---

## 故障 1：宿主一启动就退出，报找不到 `@deepseek-ai/schemastery`

### 现象

```
Cannot find package '@deepseek-ai/schemastery'
imported from .../packages/mcp/mcp-client/src/index.ts
```

进程立即退出，3080 无监听。启动脚本因为「工作区有 40 处本地改动」走了 `-SkipInstall`，从不补依赖。

### 根因

`vendor/schemastery` 整个目录被删（6 个文件：`package.json`、`src/index.ts`、`tsconfig.json`、`tsdown.config.ts`、`LICENSE`、`README.md`），而它是 workspace 包 `@deepseek-ai/schemastery`，被 `mcp-client` 以及上百个包 import。

### 修复

```powershell
git -C C:\AITask\deepseek-harness restore vendor/schemastery
```

---

## 故障 2：恢复后换成找不到 `@deepseek-ai/dsh-tools`，36 个插件全挂

### 现象

```
Cannot find package '@deepseek-ai/dsh-tools'
```

启动诊断里 **36 个插件**全部 `failed to import`。

### 根因（两层）

1. `packages/core/tools`（包名 `@deepseek-ai/dsh-tools`）整目录被删 34 个文件——也是那批「本地改动」之一，是核心包。
2. 更麻烦的是 **pnpm 不会重建 workspace 软链**。顶层 `node_modules/@deepseek-ai/*` 只放根依赖（46 个），workspace 包本来靠各自 `packages/x/y/node_modules` 解析；install 时目录早已不存在，软链从未创建。
   - `pnpm install --frozen-lockfile` 认为 *Already up to date*，直接跳过链接步骤。
   - `pnpm install --force --frozen-lockfile` 跑完（6m39s，EXIT=0），`.pnpm` 里依然**一个 `vendor/*` 条目都没有**。
   - 关于可选依赖：那些 linux/macos 平台的 esbuild/rolldown binding 下载失败是噪声，不影响 Windows。

### 修复

```powershell
git -C C:\AITask\deepseek-harness restore packages/core/tools
```

然后按各包 `package.json` 的真实 `name` 补建顶层软链（**共 335 个**），指向 `packages/*`、`vendor/*` 源码：

```powershell
$root = "C:\AITask\deepseek-harness"
$all = Get-ChildItem "$root\packages", "$root\vendor" -Directory -Recurse -Depth 3 |
  Where-Object { $_.Name -ne 'node_modules' } |
  ForEach-Object { Join-Path $_.FullName 'package.json' } |
  Where-Object { Test-Path $_ } | Select-Object -Unique
foreach ($pj in $all) {
  try { $j = Get-Content $pj -Raw | ConvertFrom-Json } catch { continue }
  if (-not $j.name -or $j.name -notmatch '^@deepseek-ai/') { continue }
  $scope, $pkg = $j.name -split '/'
  $link = Join-Path $root "node_modules\$scope\$pkg"
  if (Test-Path $link) { continue }
  New-Item -ItemType Directory -Force -Path (Split-Path $link -Parent) | Out-Null
  New-Item -ItemType SymbolicLink -Path $link -Target (Split-Path $pj -Parent) | Out-Null
}
```

> ⚠️ 这是权宜之计。规范做法是让工作区保持干净后重跑一次 `pnpm install`，由 pnpm 重新接管依赖树。
> ⚠️ 注意：目录名不一定等于包名（`packages/core/tools` → `@deepseek-ai/dsh-tools`），必须读 `package.json` 的 `name`。

---

## 故障 3：插件注册导致致命错误，宿主直接退出

### 现象

```
JsonSchemaError: parameters.type must be a value schema object
dsh: fatal load failure
```

不是 fatal 后降级，而是**整个宿主退出**。

### 根因

`dsh-computer-use` 子模块里未提交的改动新增了 4 个工具（`scroll_to` / `reach_last_page` / `wait_until` / `computer_use_documents`），参数沿用旧式 JSON Schema：

```js
parameters: {
  type: 'object',
  additionalProperties: false,
  properties: { window: WIN_SCHEMA, ... },
  required: ['window'],
}
```

而新版 harness 的 `defineTool.parameters` 是**属性表 DSL**：逐属性写 `required: true`，object 节点不允许再带 `required` 数组。

### 修复

把 4 处全部改成 DSL 写法：

```js
const WIN_SCHEMA = {
  app: { type: 'string', required: true },
  id:  { type: 'integer', required: true },
  title: { type: 'string' },
}
```

并在需要复用「整块作必填参数」的地方额外声明 `WIN_PARAM = { ...WIN_SCHEMA, required: true }`。改完 `node --check src/tool.js` 通过。

---

## 故障 4：手机上点「选择文件夹」报 `directoryPicker/pick` 502

### 现象

```
directory picker failed: client api: directoryPicker/pick failed:
transport failure for /api/directoryPicker/pick: HTTP 502
```

会话列表因此为空（选不到工作区）。

### 根因链（四步，缺一不可）

1. `@deepseek-ai/dsh-host-directory-picker-auto` 在**启动时**根据三项事实选后端（`packages/host/directory-picker-auto/src/resolve.ts:55`）：

   ```ts
   if (facts.allowsRemoteAuthorities || !isLoopbackHost(facts.bindHost)) return 'browse'
   if (facts.ssh) return 'browse'
   if (facts.platform === 'darwin' || facts.platform === 'win32') return 'native'
   ```

   设计注释写得很明确：要排除 *remote browsers **no OS chooser can reach***。
2. 三态全读成「纯本地」：`allowsRemoteAuthorities` 为 false（`--trusted-host` 没传）、`bindHost` 是 `127.0.0.1`、非 SSH → 命中 `native`。
3. `native` 的 `pick()` 弹的是**宿主机 Windows 上**的系统文件夹对话框。手机端看不到也点不到，请求就一直挂着。
4. 本插件的 `upstreamTimeoutMs` 默认 **30000ms**（`lib/core.js:167`），超时后销毁上游请求 → `sendJson(502, {error:'upstream_unavailable'})`。

雪上加霜的一点：本插件转发时会**重写 Host**（`lib/core.js:667`）：

```js
out.host = this.upstreamAuthority   // → 127.0.0.1:3080
```

于是宿主从「`/api` 信任围栏」到「picker 自动选择」全链路都认为**只有本机回环连进来**，它不可能自己发现「有远程浏览器通过隧道接进来了」。

### 修复（推荐做法：声明部署事实）

给启动命令加 `--trusted-host`，让 `allowsRemoteAuthorities` 变真：

```powershell
$trustedHosts = @(
    'dsh-mobile.20261314.xyz'  # Cloudflare Tunnel → 127.0.0.1:8788
    'desktop-msi-laptop'       # tailscale serve → 127.0.0.1:3080
)
$trustedArgs = @(foreach ($h in $trustedHosts) { '--trusted-host'; $h })
```

链路：`--trusted-host` → `webStartup.trustedHosts` → `allowsRemoteAuthorities = trustedHosts.some(isRemoteAuthority)`（`packages/client/connection/src/rpc-host.ts:101`，`isRemoteAuthority` 见 `api-request-trust.ts:92`）→ `resolve` 走 `browse` 分支。**auto 自己就选对了**，不需要任何本地钉住。

### 备用做法（不推荐，但有效）

`directory-picker-auto` **完全没有 `Config`**，不能写 `backend: browse`。只能在 profile 里「disabled 掉 auto 行 + insert browse 双面」：

```yaml
- id: directory-picker
  name: "@deepseek-ai/dsh-host-directory-picker-auto"
  disabled: true
- insert:
    - id: directory-picker-browse
      name: "@deepseek-ai/dsh-host-directory-picker-browse"
    - id: ui-directory-picker-browse
      name: "@deepseek-ai/dsh-client-ui-directory-picker-browse"
```

> ⚠️ `applyEntryPatches`（`vendor/include/src/index.ts`）**不允许用 patch 改 `name`**：`name` 不匹配会整条跳过并 warn，所以只能 disabled + insert，不能原地改名。

### 验证

| 检查 | 结果 |
|---|---|
| `directoryPicker/list` | 返回真实目录（path + crumbs + entries） |
| `directoryPicker/pick` | **0 秒**返回 `directory-picker/unavailable`（capability=browse），不再挂 30s |
| 页面模块 | `ui-directory-picker-browse` 存在，`ui-directory-picker-native` 消失 |

---

## 故障 5：手机上选完工作区，侧栏仍然看不到历史会话

### 现象

工作区能选，但侧栏每个工作区下面都没有既往会话。

### 真因

**手机侧对 Cloudflare 的访问受限**。在手机上开启 Cloudflare Zero Trust（WARP）代理之后，历史会话立刻正常显示。

也就是说，这是**客户端到 CF 边缘这一段**的问题，不是服务端数据、不是 WebSocket、不是 workspace 选择。当天在没开代理时，部分 RPC 请求被拦/被降级，表现就是「界面出来了但数据是空的」。

### 被排除的假设（都已实测否证，别重复走）

| 假设 | 实测 | 结论 |
|---|---|---|
| 会话数据丢了 | `session/list` 直连 3080 返回 **88 条**；经 CF 隧道同样 **88 条**（4.5s） | 数据完好 |
| WebSocket 载体不通 | `/api/remote.mux` 升级探测：3080 / 8788 / CF **三跳全部 101 Switching Protocols** | 通道正常 |
| workspace 没选中 / 路径不匹配 | `~/.dsh/storages/workspace.json` 里 5 个工作区，`path` 与 `session.cwd` **逐字节一致** | 分组键正确 |
| 客户端渲染坏了 | 无头浏览器 430×932 全新状态打开，侧栏正常：工作区默认**折叠**，点一下工作区名即展开会话 | UI 正常 |
| 归档把会话藏了 | `global.archivedSessionIds` 里有 63/88 条，默认隐藏、可用「全部（含已归档）」筛选 | 是**并存事实**，但不是本次「看不到」的原因 |

> 保留这条归档知识，因为它确实会让侧栏显得很空：当时 dsh-client-config 46 条里 35 条归档、deepseek-harness 6 条全归档、CloudflareST 4 条全归档。归档会话只读（「归档会话暂时无法查看，请取消归档后查看」），且**归档会先停止该会话正在跑的工作**。

### 附带发现的小瑕疵

- `C:\AITask\deepseek-harness` 有 6 条会话但**没有对应的 workspace 记录**，只能落进「未分组」。
- `dsh-client-config` 注册表里挂了 41 条，实际 cwd 匹配 46 条，5 条没绑上。
- 会话归属判定是**严格字符串相等**：`candidateMatches = sessionPaths.get(id) === record.path`（`packages/workspace/workspace/src/index.ts`）。路径大小写或分隔符不同就会漏，不会做归一化。

### 自查建议

遇到「手机端数据空、电脑端正常」，先按这个顺序切：

1. 手机能否正常打开 `https://<你的隧道域名>/`（能打开只说明 HTML 拿到了）
2. 手机上开/关 Cloudflare Zero Trust 代理，对比结果
3. 换回 Tailscale 内网地址对比
4. 再怀疑服务端

---

## 故障 6：手机首屏极慢

### 量化（不是「感觉慢」）

| 指标 | 实测 |
|---|---|
| 首屏原始体积 | **12.8 MB**（6 个资源；64 个客户端插件模块被合并成 2 个大包，原始 6975 KB + 2681 KB） |
| 压缩后 | 优化前 3.4 MB → 优化后 **2.8 MB**（77%） |
| gzip 是否生效 | 生效，`Content-Encoding: gzip`，经 `tailscale serve` 与 CF 隧道均未被破坏 |
| 代理开销 | 同一 2 MB 文件：3080 直连 0.103s vs 8788 代理 0.109s，可忽略 |
| CF 隧道吞吐 | ~650 KB/s（5 Mbps），TTFB 1.0–1.3s |
| Tailscale 中继 | `relay MyCustomDerp`，RTT 300–390ms，DERP 节点 `186.244.241.67` 单程 155.8ms |

### 根因

不是「没压缩」，而是 **12.8 MB 的原始体积 + 高 RTT 链路**。TCP 在 300ms RTT 下单流吞吐受 BDP 限制，通常只有 1–3 Mbps 量级，3.4 MB 需要 10–25 秒。

### 修复（两项，都在 harness）

1. **缓存头**：`packages/host/frontend-static/src/index.ts` —— `/assets/*`（文件名带内容 hash）从 `no-cache` 改为：

   ```ts
   const cache = target.startsWith(join(distRoot, 'assets') + sep)
     ? { 'cache-control': 'public, max-age=31536000, immutable', etag }
     : { 'cache-control': 'no-cache', etag }
   ```

   其余路径（`favicon`、插件合并批 `plugins/??...`、`index.html`）保持 `no-cache`，因为它们的文件名不随内容变化。二次打开省掉 4 个 304 往返。

2. **压缩等级**：`packages/bundle/web-app/cordis.patch.yml`

   ```yaml
   compression: gzip
   compressionLevel: 6        # 原为 1
   compressionThresholdBytes: 1024
   ```

   合并批 2546 KB → 2106 KB（-17%）；单批 6975→1684 KB（75%）、2681→422 KB（84%）。

   > 只提到 6，**不要提到 9**：level 6 压这 13 MB 约 1 秒 CPU，level 9 需要 5 秒以上，链路上省的时间抵不过。

### 副作用提示

`immutable` 一旦被浏览器接受，本地会缓存一年且不再回源。改回 `no-cache` 后，**老客户端必须手动清一次站点数据**（`Ctrl+Shift+R` 或 F12 → Application → Clear site data；手机用无痕模式最快）。

### 更彻底的优化方向（未做）

根因是 `compose()` 把除 bootstrap 外的**所有**模块都放进 `application` 阶段，`bootInjections` 逐个 `<link rel=preload>`。改它等于动启动协议，风险高。

稳妥的替代是**砍掉不用的客户端插件**（配置层可回滚）：`ui-schedule`(622KB)、`ui-trajectory`(456KB)、`ui-plugin-manager`(428KB)、`ui-sidebar-documentpreview`(320KB)。

---

## 故障 7：启动脚本把 `3080 已就绪` 判错

### 现象

脚本打印「3080 已就绪」，但宿主其实没起来 / 已被父进程树回收。

### 根因

- 只看「端口有监听」。`tailscaled.exe` 会常驻监听 `100.68.50.93:3080`，看起来像宿主。
- 端口比应用先就绪：端口已绑但 MCP 插件初始化、dist 装配还在跑，`GET /` 其实还不通。
- 报成功后不再复核，宿主被回收也照报成功。

### 修复（`start-dsh-web.ps1`）

新增 `Test-HttpStatus` / `Get-ManagedListenerPid` / `Test-WebReady` / `Write-PortEvidence`：

- **身份判据**：监听者命令行必须匹配 `bin.ts web`，`tailscaled` 会被标成 `[其它进程(不算数)]`
- **HTTP 探活**：`GET http://127.0.0.1:3080/` 必须返回可接受状态码（8788 接受 200/401/403）
- **3 秒存活复核**：报成功后再确认进程还在
- 就绪时打印**监听格局表**，逐行标注谁是真宿主

### 注意

HTTP 探测里要显式 `$req.Proxy = $null`，否则会被环境里的代理变量带偏。

---

## 链路诊断：三个被否证的假设

这部分价值最高——**已经花时间证伪的方向，不要再走**。

| 假设 | 做法 | 实测结果 | 判定 |
|---|---|---|---|
| DERP 延迟是被本地代理绕出来的 | 给 `186.244.241.67` 加 /32 直连路由走 Wi-Fi，绕开 TUN | 延迟 **156.2 → 155.8ms**，几乎不变；443/80 直连可达 | **否证**：DERP 物理上就在 150ms 外 |
| UDP 打洞被代理劫持 | 关掉 v2rayN TUN 后再测 | 仍是 `relay MyCustomDerp`，仍 `direct connection not established` | **否证**：与代理无关 |
| 端口映射到公网就能解决 | — | 见下 | **放弃** |

### 打洞失败的真实原因

- PC 侧：`netcheck` 显示 `UDP: true`、`MappingVariesByDestIP: false`（全锥 NAT），条件很好
- PC 上报 `58.56.30.218:53625`（聊城电信）+ `10.25.99.212:41641`（企业网）
- 手机上报 `123.233.206.38:36778` + `192.168.0.150:36778`（济南联通家宽）
- **两地跨城互打**，两端都在 NAT 后；企业网出口的入站过滤只放行已建立连接的回报包
- PC **无全球 IPv6 地址**，手机的 IPv6 候选完全用不上

结论：这种拓扑下打洞基本无解，**DERP 中继是唯一可行路径**。

### 为什么放弃端口映射

- `dsh web` 的 `--host` **明确拒绝 wildcard**：*binding every interface would expose remote code execution to the network*。要映射必须写具体 LAN IP。
- 还有 `--trusted-host` 一道 Host/Origin 围栏。
- 8788 的白名单默认只有 `100.64.0.0/10` + 回环，其余一律 403。
- 最关键：`DSH_WEB_NO_AUTH=1` 这个本地补丁让 `/api` **完全没有鉴权**（`browser-auth.ts` 里 `isAuthenticated` 直接 `return true`）。把它映射到公网 = 把一个能执行任意命令的 agent 控制台挂在互联网上。
- 而且 PC 在企业网 `10.25.99.212`，你在家里路由器上做映射也指不到这台机器。

### 为什么 CF 隧道比 DERP 好

- cloudflared 连的是 CF 的 **7844 端口（Tunnel 专用）**，不是 443，绕开企业网对 443 的干扰（v2rayN 日志里成片的 `failed to dial to 104.18.38.221:443 > EOF` 就是同类现象）
- 需要 `--edge-bind-address 10.25.99.212` 让它走物理网卡而不进 TUN
- 实测 650 KB/s，首屏 2.8 MB 约 4–5 秒，远好于 DERP 的 15–25 秒

---

## 附：可复用的诊断手法

### 1. 直连调 RPC（绕开界面）

信封格式固定，`payload` 必须**恰好**含一个 `args` 字段：

```bash
curl -s --noproxy '*' -X POST -H 'content-type: application/json' \
  -d '{"type":"client-request","rpcId":"p1","method":"directoryPicker/list","payload":{"args":{}}}' \
  http://127.0.0.1:3080/api/directoryPicker/list
```

流式方法（`workspace/follow`、`session/observeState` 等）不能这样调，会返回
`stream Remote methods must be opened through the stream carrier`——必须走 `/api/remote.mux` 的 WebSocket。

### 2. 探测 WebSocket 载体

```bash
node ws-probe.js      # 对 3080 / 8788 / CF 三跳做握手，期望全部 101
```

### 3. 看容器里到底分了多少会话

```bash
curl -s --noproxy '*' -X POST -H 'content-type: application/json' \
  -d '{"type":"client-request","rpcId":"s1","method":"session/list","payload":{"args":{"_request":{}}}}' \
  http://127.0.0.1:3080/api/session/list
```

`items[]` 里每条的 `cwd` 就是会话归属的工作区；`projections.values.title` 是标题。

### 4. 看工作区注册表原文

`~/.dsh/storages/workspace.json`

- `global.workspaceIds` 排序、`global.archivedSessionIds` 归档集合、`global.defaultWorkspaceId`
- `tables.workspaces[<id>]` 里 `path` + `sessionIds`

### 5. 判断「宿主真活着」而不是「端口被占」

```powershell
Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 3080 -State Listen |
  ForEach-Object {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)"
    "$($p.Name)  $($p.CommandLine)"
  }
```

必须看到 `node.exe ... bin.ts web`，只有 `tailscaled.exe` 说明宿主没起来。

### 6. 让服务脱离沙箱进程树存活

沙箱会在任务结束时回收整个进程树。要持久运行需经计划任务（`Register-ScheduledTask` + `Start-ScheduledTask`，由 svchost 托管）拉起，而不是普通子进程。

---

## 变更清单

| 仓库 | 文件 | 内容 |
|---|---|---|
| `deepseek-harness` | `packages/host/frontend-static/src/index.ts` | `/assets/*` 加 `immutable` 缓存头 |
| `deepseek-harness` | `packages/bundle/web-app/cordis.patch.yml` | `compressionLevel: 1 → 6` |
| `dsh-client-config` | `start-dsh-web.ps1` | 追加 `--trusted-host`；就绪判据改为「进程身份 + HTTP 探活 + 存活复核」 |
| `dsh-client-config` | `scripts/check-mobile-link.ps1` | 新增：链路体检脚本（relay/direct、RTT、首屏原始/gzip 体积） |
| `dsh-computer-use` | `src/tool.js` | 4 个新工具改用 harness DSL 参数表 |
| `dsh-remote-mobile` | `docs/troubleshooting-2026-10-31.md` | 本文 |
