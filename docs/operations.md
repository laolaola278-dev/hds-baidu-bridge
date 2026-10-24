# 运维手册

## 前置条件

- Windows 10/11
- Node.js ≥ 22（本项目只用标准库，不需要 `npm install`）
- 百度网盘开发者应用，已获取 access token
- 所有项目文件在 G 盘（默认 `G:\project\deepseek-harness\work_hds\hds-baidu-bridge`）

## 首次配置

### 1. 复制配置

```powershell
Copy-Item .\config\config.example.json .\config\config.json
```

### 2. 获取 access token

1. 打开 <https://pan.baidu.com/union>
2. 创建应用，拿到 `AppKey` / `SecretKey`
3. 走 OAuth 拿 access token（scope 至少包含 `basic,netdisk`）

### 3. 保存 token

方式 A（推荐，进程级）：

```powershell
$env:BAIDU_NETDISK_ACCESS_TOKEN = '你的token'
```

方式 B（持久化到 G 盘）：

```powershell
.\scripts\set-token.ps1 -Token '你的token'
```

方式 C（交互式）：

```powershell
node .\bin\hds-baidu.mjs token set
```

### 4. 验证

```powershell
node .\bin\hds-baidu.mjs doctor
```

期望输出包含：

```json
{
  "ok": true,
  "environment": {
    "tempDir": "G:\\...\\var\\tmp",
    "tempAudit": { "TEMP": { "ok": true } }
  },
  "live": { "quota": { ... }, "root": [ ... ] }
}
```

如果 `ok` 为 `false` 且 `reason` 是 `token missing`，返回码为 2，说明 token 没读到。

## 日常操作

### 列出远端

```powershell
node .\bin\hds-baidu.mjs ls /HDS
node .\bin\hds-baidu.mjs ls /HDS/projects --recursive
```

### 上传/下载单文件

```powershell
node .\bin\hds-baidu.mjs upload G:\work\report.pdf /HDS/docs
node .\bin\hds-baidu.mjs download /HDS/docs/report.pdf G:\work\report.pdf
```

下载先写 `<target>.part` 再校验 MD5；中断可重跑，会自动续传。

### 工程上传

```powershell
node .\bin\hds-baidu.mjs project plan G:\project\demo /HDS/projects/demo
node .\bin\hds-baidu.mjs project apply G:\project\demo /HDS/projects/demo --apply
```

排除规则来自 `config.json` 的 `sync.exclude`。Git 仓库会额外生成 `_git/demo.bundle`，保留完整历史。

不需要 bundle 时加 `--no-bundle`。

### 建立本地镜像

```powershell
node .\bin\hds-baidu.mjs mirror demo /HDS/projects/demo --apply
```

盯住变化：

```powershell
node .\bin\hds-baidu.mjs watch G:\...\mirrors\demo /HDS/projects/demo --interval 2m
```

查看状态：

```powershell
node .\bin\hds-baidu.mjs mirror status G:\...\mirrors\demo /HDS/projects/demo
```

### 备份

```powershell
node .\bin\hds-baidu.mjs backup plan
node .\bin\hds-baidu.mjs backup run --apply
node .\bin\hds-baidu.mjs backup list
```

常驻调度：

```powershell
node .\bin\hds-baidu.mjs backup watch --interval 1h --project G:\project\demo
```

Windows 计划任务：

```powershell
node .\bin\hds-baidu.mjs backup task --every 60
node .\bin\hds-baidu.mjs backup task --every 60 --apply
node .\bin\hds-baidu.mjs backup task --status
node .\bin\hds-baidu.mjs backup task --remove --apply
```

### 恢复

```powershell
node .\bin\hds-baidu.mjs restore plan 2026-10-24T09-12-17-168Z
node .\bin\hds-baidu.mjs restore apply 2026-10-24T09-12-17-168Z --plan-digest <digest> --apply
```

换机器：

```powershell
node .\bin\hds-baidu.mjs restore plan <id> `
  --map-hds-home G:\.dsh `
  --map-project work_hds=G:\project\deepseek-harness\work_hds
```

### 接入 HDS

```powershell
node .\bin\hds-baidu.mjs install status
node .\bin\hds-baidu.mjs install mcp --apply
node .\bin\hds-baidu.mjs install storage --apply
node .\bin\hds-baidu.mjs install domain --apply     # 高风险，见下
node .\bin\hds-baidu.mjs install rollback --apply
```

`install mcp`：追加 MCP 客户端行，**改完即生效，无需重启**（DSH 用 Cordis HMR 监听 `cordis.patch.yml`）。
`install storage`：创建 junction 并注册 `baidu` 后端，**不切换** domain。
`install domain`：把 `storage-domain.backend` 改成 `baidu`。

## 热加载

`G:\.dsh\profiles\desktop\cordis.patch.yml` 是**被监听的**。DSH 启动时调用 `watchUserPatches`（`@deepseek-ai/dsh-app-boot`），把该文件注册进 Cordis HMR 服务；文件一发生新增、修改或删除，就重新读入整个 patch 列表并事务性重组插件树。

所以：

| 改动 | 是否要重启 |
|---|---|
| `cordis.patch.yml` 增删改条目（含 `install mcp`） | ❌ 不用 |
| 改 `config/config.json` | ✅ 要（MCP 子进程的 `env` 在 spawn 时固化） |
| 改 `plugin/dsh-storage-baidu/index.js` 源码 | ✅ 要（插件已加载进进程） |
| 换 token（`state/credentials.json`） | ❌ 不用（MCP 每次调用现读） |

失败行为（源码测试 `packages/boot/app-boot/tests/user-patches.spec.ts` 逐条验证）：

| 情况 | 结果 |
|---|---|
| 条目配置校验失败 | 广播 `hmr/config-update-failed`，**旧配置继续生效** |
| YAML 语法错误（如 `invalid: [unclosed`） | 同上，旧配置不动 |
| 修好后重新写入 | 自动恢复，新配置生效 |
| 删掉文件 | 回落到 app 自带的 patch 层 |

也就是说**写错了不会把 HDS 弄崩，但改动也不会生效**。改完发现工具没出现，先看 HDS 日志里有没有 `config-update-failed`。

### MCP 子进程的边界（实测）

MCP 服务器是 stdio 子进程，它的加载/卸载**不是**纯热替换：

- **新增** `mcp-hds-baidu` 条目 → 子进程被 spawn，工具立即出现。实测 patch 19:06 写入，进程未重启，`hds_baidu_status` 可调用。
- **删除**该条目 → 子进程被终止，工具立即消失。
- 但**只改文件内容、条目不变**（比如手工重新保存同一份 YAML）会触发一次重组，而子进程**不保证**被重新拉起——实测出现过长约 10 秒的空窗期，之后工具报 `unknown tool`。

所以改 MCP 条目要**增删条目**，不要原地重存文件。真丢了就重跑一次：

```powershell
node .\bin\hds-baidu.mjs install mcp --apply
```

它会先备份再写入，子进程随即回来。

### 别用 PowerShell 5.1 的 `Set-Content -Encoding utf8` 改这个文件

它会加 UTF-8 BOM（多 3 字节）。YAML 能解析带 BOM 的输入，但文件大小会变、diff 会脏，而且这一步会触发上面说的重组空窗。要手工改就用：

```powershell
[System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding $false))
```

本项目的安装器已经这么做了。

回滚同样热生效：`install rollback --apply` 改完文件后工具立刻消失。

## 切换 storage domain 的注意事项

切换后：

- 每次 `workspace.json`、`session_projcache.json` 等写入都要等一次网盘上传。
- 网络不可用时写入失败，DSH 会看到 `backend-not-found` / 网络错误。
- 冷启动要从网盘下载 unit 文件，比本地 JSON 慢。

建议顺序：

1. 先 `install storage --apply`（热生效，无需重启）
2. 确认 `storage-baidu` 后端加载成功（`install status` 或日志）
3. 用一个小工程验证读写
4. 再 `install domain --apply`（热生效）
5. 观察一周，出问题立刻 `install rollback --apply`（热生效）

## 冲突处理

`mirror status` 或 `sync plan` 会给出冲突文件：

```json
{ "relative": "src/a.ts", "reason": "both-changed" }
```

处理方式（手动）：

1. 下载远端版本到临时路径核对
2. 决定保留哪一版
3. 修改本地文件，或删除本地文件后 `--direction pull`
4. 再跑一次 apply

项目**不会**自动做这种决定。

## 备份保留

catalog 默认保留最近 100 个快照。object 不会被自动回收，因为其他快照可能仍在引用。

清理对象需要手动：

1. 列出所有快照的 `sha256`
2. 计算不在任何快照里的 object
3. 用 `hds_baidu_delete` 或网盘网页端删除

不要直接删 `catalog.json`，否则 `backup list` 会当成空目录。

## 日志

- `state/logs/cli.log`
- `state/logs/mcp.log`

`access_token` 会被替换成 `[REDACTED]`。

## 排障

### `token missing`

- 检查 `$env:BAIDU_NETDISK_ACCESS_TOKEN`
- 或 `state/credentials.json` 是否存在且含 `accessToken`

### `baidu-api: file_list: errno -6`

token 无效或过期。重新走 OAuth。

### `baidu-api: file_list: errno -7`

权限不足。scope 需要包含 `netdisk`。

### `download-corrupt`

MD5 不符，`.part` 已删除。重跑即可；反复失败说明远端文件在变或网络代理改写了内容。

### `upload-conflict`

`ondup=fail` 时目标已存在。用默认 `overwrite`，或先删除远端文件。

### `path-policy`

路径不在 G 盘，或经过 junction 跳到了别的盘。检查 `config.json` 的 `allowedDrives` 和实际目录。

### `storage backend 加载失败`

- 确认 junction 存在：`node .\bin\hds-baidu.mjs install status`
- 确认 DSH 进程有 `BAIDU_NETDISK_ACCESS_TOKEN`
- 查看 DSH 日志里的 `storage-baidu` 行

### `schedule task` 没跑

```powershell
Get-ScheduledTask -TaskName 'HDS-Baidu-Backup'
Get-ScheduledTaskInfo -TaskName 'HDS-Baidu-Backup'
```

检查“上次运行结果”和“上次运行时间”。常见原因：Node 路径含非 ASCII 字符（本机是 `D:\前端\nodejs\node.exe`），或计划任务没有该用户的环境变量。

解决办法：在任务里显式设置环境变量，或改用 `backup watch` 常驻进程。

## 安全清单

- [ ] token 只存在环境变量或 `state/credentials.json`
- [ ] `state/` 和 `var/` 在 `.gitignore` 里
- [ ] 没有把 `C:` 加进 `allowedDrives`
- [ ] 百度账号开启二次验证
- [ ] 备份内容含会话，确认网盘端访问权限
- [ ] `mcp.allowDestructiveTools` 保持 `false`，除非确实需要远端删除

## 卸载

```powershell
node .\bin\hds-baidu.mjs install rollback --apply
node .\bin\hds-baidu.mjs backup task --remove --apply
```

然后删除项目目录。远端数据需要自行在网盘端清理。
