# HDS × 百度网盘桥接

把百度网盘接进 [DeepSeek-Harness](https://github.com/deepseek-ai/deepseek-harness)（HDS）：网盘目录可以像本地目录一样编辑，HDS 的会话记忆能定时备份到网盘，换电脑能原样恢复回来。

**零 npm 依赖**——只用 Node 标准库。`dependencies: {}`。

```
网盘目录 ⇄ 本地镜像 ⇄ HDS 工作区
                     ↕
          HDS 会话/存储 ──备份──> 网盘（内容寻址，去重）
                     ↖────恢复── 新机器
```

---

## 它解决什么

HDS 把会话记录和存储落成**磁盘上的普通文件**。这带来一个机会：如果这些文件能被异地保存，换机器就等于换一块硬盘，而不是重新开始。

百度网盘是很多人现成的异地存储，但它的 OpenAPI **只读写、不挂载**，且官方 MCP 是只读的。这个项目补上缺的那一层：

| 能力 | 实现 | 入口 |
|---|---|---|
| 网盘目录像本地目录一样直接编辑 | 本地镜像 + 双向同步 + 冲突保护 + 守护进程 | `mirror` / `watch` / `hds_mirror_prepare` |
| 网盘作为 HDS 原生存储后端 | DSH storage `baidu` 后端（内容落到 `/HDS/dsh/units`） | `install storage` / `install domain` |
| 可写的 MCP 工程上传 | 15 个 MCP 工具，含上传/下载/同步/备份/恢复 | `install mcp` |
| 会话记忆定时备份到网盘 | SHA-256 内容寻址快照 + 常驻调度 + 计划任务 | `backup run` / `backup watch` / `backup task` |
| 新电脑恢复会话与工程 | 迁移计划 + digest 校验 + 安全副本 + 路径映射 | `restore plan` / `restore apply` |

> **硬性安全边界：所有本地写入只允许 G 盘。代码对 `C:` 有显式拒绝，任何文件操作前都过一遍路径策略；项目不使用系统临时目录，测试、缓存、staging、日志全部落在项目 G 盘目录内。**

> 这条约束来自项目诞生时的明确要求。它可配置（`allowedDrives`），但默认行为是**拒绝**而不是回退，所以在 C 盘机器上开箱即用会失败——请先改配置。

---

## 实测结果

**已在真实百度网盘账号上跑通**（VIP 2，配额 6.6 TB）：

| 验证项 | 结果 |
|---|---|
| `doctor` 联网 | ✅ 账号、配额、`/HDS` 目录 |
| 小文件上传 → 列表 → 下载 | ✅ 逐字节一致 |
| 9.4 MB 三片上传 + 下载 | ✅ 往返 MD5 一致，上传 7.9s / 下载 4.8s |
| 增量同步（push / pull） | ✅ 第二次 plan 上传 0 |
| 真实备份 | ✅ 156 文件 / 154 MB，首份上传 156、去重 0 |
| 连续备份去重 | ✅ 第二次上传 0、复用 156 |
| 真实恢复 | ✅ 156 文件，恢复文件 SHA-256 与 manifest 完全一致 |
| 恢复路径映射 | ✅ `--map-hds-home` 生效，digest 随 mapping 变化 |
| 网盘残留清理 | ✅ `.hds-tmp` 与误命名目录已清零 |

**130 个自动化测试全部通过**（`node --test test/*.test.mjs`）：

- **真实 HTTP 验收**：11 个测试用生产 `BaiduNetdiskClient` 打到进程内 XPAN 假服务器——真 fetch、真 multipart 分片、dlink + Range 续传、原子替换、备份恢复、token 错误
- **真实 DSH 契约**：6 个测试用已安装的 `@deepseek-ai/cordis` + `dsh-storage` + `dsh-storage-domain` 跑通注册、domain 打开、远端持久化、重载、写失败回滚、版本不匹配
- **真实 schema 校验**：生成的 MCP 配置行通过 `dsh-mcp-client` 的 Schemastery `Config`
- **OAuth**：授权 URL、code 解析（裸码/查询串/完整 URL）、换取、刷新轮换、过期判定、凭证存储
- 端到端演示 `node scripts/demo.mjs` 跑通全部 10 个场景
- MCP 已装进 profile 的 `cordis.patch.yml`，按装好的那一行原样 spawn 验证返回 15 个工具

真实账号暴露了 **6 个本地测试完全测不出来的 API 陷阱**（`md5` 是混淆值、`move` 的 `ondup` 失效、批量 `errno` 在 `info[]` 里、dlink 必须带 token、首次推送目标不存在、目录删除是递归的）。全部已修复并补了离线回归测试，细节见 [真实 API 行为记录](docs/real-api-notes.md)。

**尚未启用**：DSH storage `baidu` 后端已实现并通过契约测试，但没有装进正在运行的 HDS（`install storage --apply` / `install domain --apply` 未执行）。理由：它要求 HDS 进程环境里有 `BAIDU_NETDISK_ACCESS_TOKEN`，且切换 domain 后每次存储写入都要等一次网盘上传。需要时再装。

---

## 目录

```text
hds-baidu-bridge/
├─ bin/hds-baidu.mjs              CLI 入口（所有命令）
├─ mcp-server.mjs                 MCP stdio 入口
├─ src/
│  ├─ baidu-api.mjs               百度 XPAN OpenAPI 客户端（分片/续传/MD5）
│  ├─ sync-engine.mjs             本地镜像 ↔ 百度网盘同步（plan/apply）
│  ├─ backup-engine.mjs           内容寻址备份
│  ├─ restore-engine.mjs          恢复计划/digest/安全副本
│  ├─ project-upload.mjs          工程树 + git bundle 上传
│  ├─ watch.mjs                   镜像守护进程
│  ├─ scheduler.mjs               周期备份 + Windows 计划任务
│  ├─ installer.mjs               DSH profile 安装/回滚
│  ├─ patch.mjs                   YAML patch 生成（零依赖）
│  ├─ mcp-server.mjs              可写 MCP 服务
│  ├─ paths.mjs                   G 盘路径策略
│  ├─ temp.mjs                    临时目录重定向
│  ├─ exclude.mjs                 排除规则
│  ├─ local-tree.mjs              安全目录遍历/发布
│  ├─ http.mjs                    重试/超时/脱敏
│  └─ log.mjs                     结构化日志 + 原子写
├─ plugin/dsh-storage-baidu/      DSH 存储后端插件
├─ scripts/                       demo、doctor、token、安装包装脚本
├─ docs/                          架构、运维、灾难恢复
├─ config/                        示例配置与实际配置
└─ test/                          Node 原生测试（130 个）
```

---

## 快速开始

### 0. 环境要求

| 项 | 要求 | 说明 |
|---|---|---|
| Node.js | **>= 22** | 用到 `node:test`、`fetch`、`process.loadEnvFile`。实测 24.9 |
| 系统 | Windows / macOS / Linux | 主路径策略默认偏 Windows（盘符概念），其他平台把 `allowedDrives` 配成对应值 |
| HDS | 可选 | 只有 `install mcp` / `install storage` 需要 |
| 百度网盘 | 已注册 + 开放平台应用 | 见 [获取 Token](docs/getting-token.md) |
| 本地磁盘 | 任意 | 默认只允许 G 盘，改 `allowedDrives` 即可 |
| npm 依赖 | **无** | 不需要 `npm install` |

```powershell
git clone <this-repo> hds-baidu-bridge
cd hds-baidu-bridge
node --test test/*.test.mjs      # 130 个测试，应全绿
```

**关于测试依赖**：生产代码零依赖，但测试需要两个外部包，缺失时相关用例会**跳过而不是失败**：

| 包 | 用途 | 缺失时 |
|---|---|---|
| `yaml`（devDependency） | 用真实解析器校验手写的 YAML 发射器 | 跳过 11 个用例 |
| `@deepseek-ai/dsh-storage` 等 | 用真实 DSH 包做契约测试 | 跳过 16 个用例 |

所以裸克隆（不 `npm install`、不装 DSH）会得到 **103 通过 / 27 跳过 / 0 失败**，这是预期行为。装了依赖则 130 全绿。

### 1. 配置

复制示例配置并按需修改：

```powershell
Copy-Item .\config\config.example.json .\config\config.json
```

默认配置已经把：

- `remoteRoot` 设为 `/HDS`
- 本地根、state、mirror、staging 全部放在项目所在盘
- `allowedDrives` 设为 `["G"]`

> **必须改的一处**：`config.example.json` 里的路径是 `G:\path\to\...` 占位符，`allowedDrives` 是 `["G"]`。如果你的项目不在 G 盘，这两处都要改成你自己的盘符，否则每个文件操作都会被路径策略拒绝（这是设计如此，不是 bug）。

### 2. 保存 Token

**还没有 token？** 见 [获取百度网盘 Access Token](docs/getting-token.md)——从创建应用到跑通 `doctor` 的完整步骤。

推荐流程（先把应用凭证存一次，之后登录不再重复输入）：

```powershell
node .\bin\hds-baidu.mjs token app --app-key 你的AppKey --secret-key 你的SecretKey
node .\bin\hds-baidu.mjs token login            # 打印授权 URL，浏览器同意后把 code 粘回来
```

应用凭证写在 `state/app-credentials.json`（权限 600，已 gitignore），token 写在 `state/credentials.json`。两者都只存指纹到日志。

获取 token 的优先级：

1. `BAIDU_NETDISK_ACCESS_TOKEN` 环境变量
2. `state/credentials.json`

也可以直接塞一个已有的 token：

```powershell
.\scripts\set-token.ps1 -Token '你的 Access Token'
# 或
node .\bin\hds-baidu.mjs token set
```

查看有效期：

```powershell
node .\bin\hds-baidu.mjs token status
node .\bin\hds-baidu.mjs token refresh    # 过期时免重新授权
```

> `token login` 需要交互。在非 TTY 环境（CI、脚本、某些终端封装）里它会**直接报错退出**而不是静默卡住；那种情况请用 `--code <code>` 或 `--token <token>`。

### 3. 验证

```powershell
node .\bin\hds-baidu.mjs doctor
```

成功时返回用户、配额、远端根目录，以及本地目录和临时目录的自检结果。没有 Token 时返回码为 2，但**本地自检仍然会输出**（`environment`、`localChecks`），可以先确认 G 盘路径、临时目录重定向、会话目录都正常。

### 4. 接入 HDS MCP

先看将要写入的 patch（不会改任何文件）：

```powershell
.\scripts\install-mcp.ps1
```

确认后应用：

```powershell
.\scripts\install-mcp.ps1 -Apply
```

等价于 `node .\bin\hds-baidu.mjs install mcp --apply`。它会在 `G:\.dsh\profiles\desktop\cordis.patch.yml` 追加一个 `mcp-hds-baidu` 条目，并先把原文件备份成 `cordis.patch.yml.bak-hds-baidu-<时间戳>`。

写入 `cordis.patch.yml` 后**不需要重启 HDS**。DSH 通过 Cordis HMR 服务监听这个文件（见 `dsh-app-boot` 的 `watchUserPatches`），文件一变就重新解析并重组插件树。实测：HDS 进程 16:43 启动，patch 19:06 写入，未重启，`hds_baidu_status` 立即可调用。

模型工具里会出现 15 个工具，前缀是 `mcp__hds-baidu__`：

| 工具 | 用途 |
|---|---|
| `hds_baidu_status` | 本地配置与 token 状态 |
| `hds_baidu_doctor` | 真实连通性/配额 |
| `hds_baidu_list` | 列目录（可递归） |
| `hds_baidu_upload` | 上传单文件 |
| `hds_baidu_download` | 下载单文件 |
| `hds_baidu_mkdir` | 建远端目录 |
| `hds_baidu_delete` | 删远端（默认禁用） |
| `hds_project_sync_plan` | 同步计划 |
| `hds_project_sync_apply` | 执行同步（需 `confirm`） |
| `hds_project_upload` | 工程整体上传（含可选 git bundle） |
| `hds_project_download` | 工程拉到本地镜像 |
| `hds_mirror_prepare` | 建镜像并拉取 |
| `hds_mirror_status` | 镜像守护状态 |
| `hds_backup` | plan/run/list |
| `hds_restore` | plan/apply（需 `planDigest`） |

### 5. 把百度网盘目录变成 HDS 工作目录

严格说，百度网盘没有 Windows 文件系统驱动，所以“直接当本地目录编辑”是通过**本地镜像**实现的：网盘目录在 G 盘有一份真实文件，HDS 编辑的是这份文件，桥接层负责和云端对齐。

```powershell
node .\bin\hds-baidu.mjs mirror demo /HDS/projects/demo --apply
```

输出中的 `localRoot` 例如：

```text
G:\project\deepseek-harness\work_hds\hds-baidu-bridge\mirrors\demo
```

在 HDS 里把这个目录添加为 Workspace。之后启动守护进程：

```powershell
node .\bin\hds-baidu.mjs watch G:\...\mirrors\demo /HDS/projects/demo --interval 2m
```

`watch` 同时做两件事：

- 监听本地文件变化（2 秒防抖），改动立刻上传
- 每 `--interval` 扫一次远端，把别处产生的改动拉下来

规则：

- 本地新增/修改 → 上传
- 远端新增/修改 → 下载
- 两边都改 → **跳过并报告冲突，绝不覆盖任何一侧**
- 本地删除 → 不传播到远端；远端删除 → 不传播到本地

查看状态：

```powershell
node .\bin\hds-baidu.mjs mirror status G:\...\mirrors\demo /HDS/projects/demo
```

### 6. 工程上传

```powershell
node .\bin\hds-baidu.mjs project plan G:\project\demo /HDS/projects/demo
node .\bin\hds-baidu.mjs project apply G:\project\demo /HDS/projects/demo --apply
```

和 `sync push` 的区别：`project` 会在 git 仓库里额外生成一个 bundle（`_git/<name>.bundle`）并上传，这样即使 `.git/` 被排除，历史也能完整恢复。只要树不要历史时加 `--no-bundle`。

默认排除 `node_modules`、`.git`、虚拟环境、构建产物等，规则在 `config.json` 的 `sync.exclude`。

### 7. 备份 HDS 会话和工程

计划：

```powershell
node .\bin\hds-baidu.mjs backup plan
node .\bin\hds-baidu.mjs backup plan --project G:\project\deepseek-harness\work_hds
```

执行：

```powershell
node .\bin\hds-baidu.mjs backup run --apply
```

远端布局：

```text
/HDS/backups/
├─ catalog.json
├─ objects/<sha256前两位>/<sha256>
└─ snapshots/<timestamp>/manifest.json
```

特点：

- 内容寻址，相同文件只上传一次（第二次备份实测只上传变化的对象）
- 备份的是文件当前字节，活动会话的追加写不会阻塞
- 不会上传 `.credentials.yaml`
- 每个快照带 SHA-256、大小、原路径和来源类型

### 8. 新机器恢复

先列快照：

```powershell
node .\bin\hds-baidu.mjs backup list
```

生成恢复计划：

```powershell
node .\bin\hds-baidu.mjs restore plan <snapshot-id>
```

按原路径恢复：

```powershell
node .\bin\hds-baidu.mjs restore apply <snapshot-id> --plan-digest <digest> --apply
```

如果新机器路径不同：

```powershell
node .\bin\hds-baidu.mjs restore plan <snapshot-id> `
  --map-hds-home G:\.dsh `
  --map-project work_hds=G:\project\deepseek-harness\work_hds
```

注意：**HDS 会话头里的 `cwd` 不会自动改写**，因为会话是 zstd 压缩的 JSONL。恢复后如果路径变了，在 HDS Workspace UI 里重新添加工程即可；已有会话仍可按原路径显示。这是有意为之，避免破坏会话日志。

### 9. 原生 DSH 存储后端

安装（默认 dry-run）：

```powershell
.\scripts\install-storage-backend.ps1
```

应用：

```powershell
.\scripts\install-storage-backend.ps1 -Apply
```

它会：

1. 在 `G:\.dsh\profiles\desktop\node_modules\@deepseek-ai\dsh-storage-baidu` 创建指向项目的 junction
2. 备份并追加 `storage-baidu` patch

等价 CLI：

```powershell
node .\bin\hds-baidu.mjs install storage --apply
```

之后还需要**显式**把 `storage-domain` 的后端切到 `baidu`，否则 DSH 仍使用本地 JSON：

```powershell
node .\bin\hds-baidu.mjs install domain --apply
```

这是有意拆成两步的：注册后端是安全的，切换 domain 会改变每一条 DSH 存储写入的语义。

切换后会发生什么：

- 每次 `workspace.json`、`session_projcache.json` 等写入都要等一次网盘上传
- 网络不可用时写入失败，DSH 直接看到错误（`offlinePolicy: reject`）
- 冷启动需要先从网盘下载 unit 文件

所以建议顺序是：`install storage` → 确认后端已加载 → 小工程验证 → `install domain` → 观察一周。每一步都是热生效，**不需要重启**。

回滚：

```powershell
node .\bin\hds-baidu.mjs install rollback --apply
```

它会删掉 junction，并用最新的 `.bak-hds-baidu-*` 覆盖 `cordis.patch.yml`。

### 10. 定时备份

两种方式，任选其一。

常驻进程（跨平台、行为最可预测）：

```powershell
node .\bin\hds-baidu.mjs backup watch --interval 1h
```

先看计划任务会怎么注册：

```powershell
.\scripts\install-backup-task.ps1
```

确认后应用：

```powershell
.\scripts\install-backup-task.ps1 -Apply -EveryMinutes 60
```

```powershell
node .\bin\hds-baidu.mjs backup task --status
node .\bin\hds-baidu.mjs backup task --remove --apply
```

计划任务只调用 G 盘上的 entry，工作目录也是 G 盘。

---

## MCP 工具

15 个工具，按能力分组。

**单文件与目录**

| 工具 | 作用 |
|---|---|
| `hds_baidu_status` | 本地配置、Token 是否存在 |
| `hds_baidu_doctor` | 真实连通性、配额、远端根 |
| `hds_baidu_list` | 列目录，支持递归 |
| `hds_baidu_upload` | 上传单文件 |
| `hds_baidu_download` | 下载单文件 |
| `hds_baidu_mkdir` | 建远端目录 |
| `hds_baidu_delete` | 删除远端，默认禁用 |

**工程**

| 工具 | 作用 |
|---|---|
| `hds_project_sync_plan` | 同步计划，不改动 |
| `hds_project_sync_apply` | 执行同步，需 `confirm=true` |
| `hds_project_upload` | 整个工程上传，可带 git bundle |
| `hds_project_download` | 工程拉到本地镜像 |
| `hds_mirror_prepare` | 建镜像并拉取远端 |
| `hds_mirror_status` | 镜像守护状态 |

**备份与恢复**

| 工具 | 作用 |
|---|---|
| `hds_backup` | plan/run/list |
| `hds_restore` | plan/apply，需原样回传 planDigest |

删除工具默认关闭，需要同时满足：

- 配置 `mcp.allowDestructiveTools: true`
- 调用时 `confirm: true`

---

## 为什么不做“网盘挂载”

HDS 和工程工具需要：

- 本地随机读写
- 原子重命名
- 文件监听
- Git/Node/Python 直接操作
- 稳定的权限和大小写语义

直接挂载百度网盘会引入延迟、锁、缓存不一致和 Git 写坏风险。这个项目采用**本地镜像 + 双向同步**，对 HDS 来说就是普通本地目录，同时保留云端副本。

---

## 路径安全模型

1. `local.allowedDrives` 默认 `["G"]`，配置里出现 `C` 会直接报错。
2. `resolveLocalPath` 对任何 `C:` 路径无条件拒绝，即使 `allowedDrives` 里误加了 C。
3. UNC 路径拒绝。
4. 写入前检查最近存在的祖先目录，用 `realpath` 防止 junction/symlink 跳到其他盘。
5. 远端路径必须位于 `remoteRoot` 下，禁止 `..`。
6. 下载先写 `.part`，校验 MD5 后原子重命名。
7. 上传先写远端 `.hds-tmp`，再 move 覆盖目标，避免半写文件。
8. 恢复前生成 planDigest，必须原样回传；恢复时先把被覆盖文件复制到 `state/restore-safety/<timestamp>`。
9. 进程启动时把 `TEMP`/`TMP`/`TMPDIR` 重定向到 G 盘 `var/tmp`，并对外报告审计结果（`doctor.environment.tempAudit`）。

---

## 测试与演示

```powershell
$env:TEMP='G:\project\deepseek-harness\work_hds\hds-baidu-bridge\var\tmp'
$env:TMP=$env:TEMP
$env:TMPDIR=$env:TEMP
node --test test/*.test.mjs
node scripts/demo.mjs
```

测试与演示都用内存版百度客户端，不会联网、不会触碰真实网盘。

覆盖范围：

| 文件 | 覆盖 |
|---|---|
| `paths.test.mjs` | C 盘、UNC、非授权盘、逃逸 |
| `exclude.test.mjs` | 排除规则 |
| `baidu-api.test.mjs` | 分片计划、哈希 |
| `http-client.test.mjs` | 请求形状、errno、脱敏、下载校验 |
| `acceptance-http.test.mjs` | **真实 HTTP 端到端**：分片上传、Range 续传、损坏拒绝、原子替换、目录保护、staging 清理、同步、备份恢复、token 错误 |
| `upload-blocks.test.mjs` | 每 4 MiB 分片 MD5、md5 可信性判定 |
| `http-response.test.mjs` | 错误消息结构化、脱敏、批量 `info[].errno` |
| `sync-engine.test.mjs` | push/pull/冲突/删除不传播/首次推送远端不存在 |
| `backup-restore.test.mjs` | 去重、快照、digest、损坏对象 |
| `restore-mapping.test.mjs` | 路径映射、C 盘拒绝、过期 plan |
| `storage-backend.test.mjs` | 后端契约（内存替身） |
| `dsh-contract.test.mjs` | **真实 DSH 包**：注册、domain 打开、远端落盘、重载、写失败回滚、版本不匹配 |
| `mcp-server.test.mjs` | 工具清单、握手、默认禁用删除、C 盘拒绝 |
| `patch.test.mjs` | YAML 生成与往返解析 |
| `patch-schema.test.mjs` | 生成的 patch 行通过真实 `dsh-mcp-client` Config |
| `installer.test.mjs` | 计划/应用/幂等/回滚 |
| `watch.test.mjs` | 守护进程周期与状态 |
| `scheduler.test.mjs` | 周期备份、失败记录、计划任务 dry-run |
| `project-upload.test.mjs` | 排除、git bundle、降级 |
| `oauth.test.mjs` | 授权 URL、code 解析、换取/刷新、过期判断、凭据存储 |
| `temp.test.mjs` | 临时目录重定向与 C 盘拒绝 |

---

## 文档

- [项目总结](docs/summary.md) ← 全貌、规模、6 个真实 API bug、教训
- [在 HDS 里怎么用 MCP](docs/using-mcp.md) ← 15 个工具怎么调、确认码、出错排查
- [获取百度网盘 Token](docs/getting-token.md)
- [真实 API 行为记录](docs/real-api-notes.md) ← 踩过的坑，改代码前先看
- [架构说明](docs/architecture.md)
- [运维手册](docs/operations.md)
- [灾难恢复演练](docs/recovery.md)

---

## 安全与隐私

| 项 | 做法 |
|---|---|
| 凭证存放 | `state/credentials.json` / `state/app-credentials.json`，权限 600，`.gitignore` 覆盖 |
| 备份排除 | `.credentials.yaml` 强制排除，远端 `catalog.json` 已验证不含任何 token |
| 日志脱敏 | `redact()` 覆盖 `access_token=`、裸 token 形状、`Bearer` 头 |
| 路径限制 | 本地写入只允许 `allowedDrives`；`C:`、UNC、junction 逃逸一律拒绝 |
| 网盘范围 | 所有远端操作限制在 `remoteRoot`（默认 `/HDS`）下 |
| 删除保护 | MCP 的 `hds_baidu_delete` 默认禁用，需显式开 `mcp.allowDestructiveTools` |
| 幂等写入 | 上传先写临时对象再原子替换；目标为目录时拒绝覆盖（`target-is-directory`） |

**你需要自己保管的东西**：`state/` 目录、`config/config.json`、`.env`。这三个已在 `.gitignore` 里，但如果你 fork 后改了忽略规则，凭证就可能进仓库。

---

## 已知限制

- **网盘没有文件系统驱动**。所谓“像本地目录一样编辑”是靠本地镜像实现的，不是真正的挂载。编辑在镜像里发生，再由 `sync`/`watch` 对齐云端。
- **恢复是文件级的**。会话头里记录的原始 `cwd` 不会被改写，恢复后打开旧会话可能指向不存在的目录；请在 HDS 中重新注册 workspace（详见 [灾难恢复演练](docs/recovery.md)）。
- **`filemanager move` 无法覆盖已存在的目标**。原子替换是“先删再 move”，中间有毫秒级窗口（目标缺失，不是半个文件）。
- **查询接口返回的 `md5` 不是 MD5**，是混淆值。只做不透明等值键，校验退化为字节数比对。详见 [真实 API 行为记录](docs/real-api-notes.md)。
- **`/api/quota` 的 `free` 是“免费容量”不是余量**，余量要自己算 `total - used`。
- **storage `baidu` 后端会让每次写存储都等一次网盘上传**，所以默认不启用。
- 大文件按 4 MiB 分片，`block_list` 是每片 MD5，受百度单文件上限约束（每个文件，不是总量）。
- `offlinePolicy: cache` 只保证本地缓存，不保证远端持久化，不应作为默认。
- 计划任务依赖 `schtasks`；Node 路径含非 ASCII 字符或空格时，某些 Windows 配置下任务可能起不来。此时改用 `backup watch` 常驻进程。
- **备份内容可能含敏感信息**。网盘端请自行开启二次验证与访问限制；如需更强保护，应在同步前加密。
- 首次使用建议先 `doctor`，再用一个小文件测试上传/下载，最后才跑 `backup run --apply`。

---

## 致谢

- [DeepSeek-Harness](https://github.com/deepseek-ai/deepseek-harness) —— 宿主，也是这套设计的起点：把会话落成普通文件，才让异地备份成为可能。
- [百度网盘开放平台](https://pan.baidu.com/union) —— XPAN API 与 OAuth。

本项目与百度、DeepSeek 官方均无隶属关系，是第三方集成。

---

## License

MIT，见 [LICENSE](LICENSE)。
