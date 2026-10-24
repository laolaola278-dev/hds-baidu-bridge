# 在 HDS 里使用 MCP 工具

这份文档回答一个问题：**装好之后，到底怎么用。**

先说结论：不需要进终端。装好之后，你直接跟我说人话就行——「把 `docs` 传到网盘」「列一下网盘根目录」「恢复 11:55 那个快照」。我会去调对应的工具。

---

## 一、现在装的是什么

15 个工具，统一前缀 `mcp__hds-baidu__`，来自一个本地 stdio 服务器。

安装位置：

```text
G:\.dsh\profiles\desktop\cordis.patch.yml   ← 末尾一段，id 是 'mcp-hds-baidu'
```

装进去的那一行大概长这样：

```yaml
- id: 'mcp-hds-baidu'
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    transport: 'stdio'
    serverName: 'hds-baidu'
    command: 'D:\path\to\node.exe'
    args:
      - 'G:\path\to\hds-baidu-bridge\mcp-server.mjs'
    env:
      HDS_BAIDU_CONFIG: 'G:\...\config\config.json'
    toolCallTimeoutMs: 120000
    failOnStartupError: false
    reconnect:
      enabled: true
```

`serverName: 'hds-baidu'` 决定了工具名前缀：`mcp__hds-baidu__<工具名>`。

---

## 二、三种用法

### 用法 A：直接说话（推荐）

不用记工具名。说清楚「哪个文件 / 哪个目录 / 要干什么」就行：

| 你说 | 我调 |
|---|---|
| 「网盘根目录有什么」 | `hds_baidu_list` |
| 「把 docs 传到网盘 /HDS/docs」 | `hds_project_sync_plan` → `hds_project_sync_apply` |
| 「网盘还剩多少空间」 | `hds_baidu_doctor` |
| 「备份一下我的会话」 | `hds_backup`（action: `run`） |
| 「看看有哪些备份」 | `hds_backup`（action: `list`） |
| 「把那个目录拉到本地」 | `hds_project_download` |
| 「下个月在一台新电脑上恢复」 | `hds_restore`（action: `plan`） |

我会先 `plan` 给你看要传什么，你确认后再 `apply`。**不会不问就动网盘。**

### 用法 B：直接点工具

HDS 界面上工具调用会显示出来，带参数和返回值。你可以不走我，自己指定某个工具和参数。

### 用法 C：CLI（不经过 HDS）

同一套能力，换成命令行：

```powershell
cd G:\path\to\hds-baidu-bridge
node bin/hds-baidu.mjs <子命令>
```

CLI 和 MCP **共用同一份配置和同一个 token**，两边效果一样。差别是 CLI 输出给人看，MCP 输出给我看。

---

## 三、15 个工具全表

### 只读（随便用，不会改东西）

| 工具 | 必填参数 | 说明 |
|---|---|---|
| `hds_baidu_status` | — | 本地配置、路径、token 是否就绪 |
| `hds_baidu_doctor` | — | 联网体检：账号、配额、根目录 |
| `hds_baidu_list` | `path` | 列目录，`recursive: true` 递归 |
| `hds_project_sync_plan` | `localDir`, `remoteDir` | 算差异，**不动任何一边** |
| `hds_backup` | `action` | `action: "list"` 是只读 |
| `hds_mirror_status` | `localDir`, `remoteDir` | 看镜像守护进程状态 |
| `hds_restore` | `action`, `snapshotId` | `action: "plan"` 只出计划 |

### 写（改网盘或本地）

| 工具 | 必填参数 | 说明 |
|---|---|---|
| `hds_baidu_upload` | `localPath`, `remoteDir` | 传单文件 |
| `hds_baidu_download` | `remotePath`, `localPath` | 下单个文件 |
| `hds_baidu_mkdir` | `path` | 建目录 |
| `hds_project_sync_apply` | `localDir`, `remoteDir`, `confirm` | 执行同步，需 `confirm: true` |
| `hds_backup` | `action` | `action: "run"` + `confirm` |
| `hds_restore` | `action`, `snapshotId` | `action: "apply"` + `planDigest` |
| `hds_project_upload` | `localDir`, `remoteDir`, `confirm` | 整个工程上传（可带 git bundle） |
| `hds_project_download` | `remoteDir`, `name`, `confirm` | 整个工程拉到本地镜像 |
| `hds_mirror_prepare` | `remoteDir`, `name` | 建本地镜像目录 |
| `hds_baidu_delete` | `paths`, `confirm` | **默认禁用**，见下 |

### `hds_baidu_delete` 为什么默认关着

它删的是网盘上的真实文件，且 `filemanager delete` **对目录是递归的**——删目录就是删整棵树，没有撤销。

启用方式（`config/config.json`）：

```json
{ "mcp": { "allowDestructiveTools": true } }
```

改完要重启 HDS（`config.json` 是 spawn 时读进 `env` 的，不吃热加载）。

**建议**：平时不开。真要删，用 CLI 并且先 `ls` 确认路径。

---

## 四、确认码：`confirm` 和 `planDigest`

写操作要求二次确认，这是有意的——网盘上没有回收站语义。

### `confirm: true`

同步、上传、删除这类，必须显式传 `confirm: true`。不传就报错，不会悄悄执行。

### `planDigest`

恢复最严格：三态。

```text
plan   → 给出计划 + planDigest（一串 sha256）
apply  → 必须原样带回 planDigest，对不上就拒绝
```

digest 覆盖快照 id、每个文件的目标路径、映射关系。**中途任何东西变了（快照被换、映射改了），digest 就变，apply 拒绝执行。**

这防的是「计划时看的是 A，执行时变成了 B」。

---

## 五、典型流程

### 传一个工程上去

```text
我：帮我把 docs 传到网盘
→ hds_project_sync_plan  localDir=...\docs  remoteDir=/HDS/docs  direction=push
  ← 6 个上传, 0 冲突

我：确认，传吧
→ hds_project_sync_apply  ...  confirm=true
  ← ok: true, 已上传 6
```

### 备份

```text
我：备份一下
→ hds_backup  action=plan        ← 先看要传多少
→ hds_backup  action=run  confirm=true
  ← uploaded: 2, reused: 154     ← 内容寻址，只传变化的
```

第二次跑通常 `uploaded: 0`，因为对象已经存在。

### 恢复（新电脑）

```text
1. 先配 token           node bin/hds-baidu.mjs token login
2. 看有哪些快照         hds_backup  action=list
3. 出计划               hds_restore  action=plan  snapshotId=<id>
4. 换路径（可选）       hds_restore  action=plan  snapshotId=<id>  mapping={"hds-home":"G:\\.dsh"}
5. 执行                 hds_restore  action=apply  snapshotId=<id>  planDigest=<上一步给的>  confirm=true
```

**注意**：恢复是文件级还原，会话头里记的原始 `cwd` 不会被改写。所以恢复后在新机器上打开旧会话，它可能指向一个不存在的目录——这是已知限制，不是坏了。

---

## 六、出错怎么办

| 现象 | 原因 | 处理 |
|---|---|---|
| `unknown tool "mcp__hds-baidu__..."` | 子进程没起来 | `node bin/hds-baidu.mjs install mcp --apply` |
| `Baidu Netdisk is not configured` | 没有 token | `node bin/hds-baidu.mjs token login` |
| 401 `invalid_client` | AppKey/SecretKey 错 | 重新配 `state/app-credentials.json` |
| `errno -6` | token 失效 | `node bin/hds-baidu.mjs token refresh` |
| `target-is-directory` | 目标路径是目录 | 换个文件名，别想用文件覆盖目录 |
| `path-policy` | 路径在 C 盘或未授权盘 | 换到 G 盘 |

查状态最省事：

```powershell
node bin/hds-baidu.mjs install status
node bin/hds-baidu.mjs token status
node bin/hds-baidu.mjs doctor
```

---

## 七、热加载提醒

改 `cordis.patch.yml` **不需要重启 HDS**。

但 MCP 子进程有个不对称：**增删条目**会正确地拉起/终止子进程；**原地重存同一份文件**（条目没变）会触发重组，而子进程不保证回来——实测有约 10 秒空窗，之后报 `unknown tool`。

所以改 MCP 配置请**增删条目**，别原地重存。真丢了就重跑 `install mcp --apply`。

另外别用 PowerShell 5.1 的 `Set-Content -Encoding utf8` 改这个文件，它会加 BOM。用：

```powershell
[System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding $false))
```

---

## 八、安全边界

无论走 MCP 还是 CLI，这些一律成立：

- **本地写入只在 G 盘**。`C:`、UNC、未授权盘符、junction 逃逸全部拒绝，删除网盘或本地文件之前也会校验。
- **网盘写入限制在 `remoteRoot`（`/HDS`）下**，越界直接拒。
- **凭证不进日志**。`redact()` 覆盖 `access_token=`、裸 token 形状、`Bearer` 头。
- **备份排除 `.credentials.yaml`**。

MCP 只是另一层包装，底层是同一套 `src/` 代码，所以约束完全一致。
