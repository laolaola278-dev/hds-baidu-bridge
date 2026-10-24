# 项目总结

**hds-baidu-bridge** —— 一个把百度网盘接入 HDS 的本地优先桥接层。

写于 2026-10-24，真实账号验收完成时。

---

## 一句话

把百度网盘当成 HDS 的一块磁盘用：目录能像本地一样编辑，会话记忆能定时备份过去，换电脑能原样恢复回来。

---

## 五个需求，五个交付

| 需求 | 交付物 | 真实账号验证 |
|---|---|---|
| 网盘目录像本地一样编辑 | 本地镜像 + 双向同步 + 冲突不覆盖 + 守护进程 | ✅ 增量同步第二次上传 0 |
| 网盘作为 HDS 原生存储后端 | DSH storage `baidu` 后端，内容落 `/HDS/dsh/units` | ✅ 契约测试通过（未装入运行中的 HDS） |
| 可写的 MCP 工程上传 | 15 个 MCP 工具 | ✅ 已装入 HDS，握手返回 15 工具 |
| 会话记忆定时备份 | SHA-256 内容寻址快照 + 调度器 + Windows 计划任务 | ✅ 备份 156 文件 / 154 MB，去重生效 |
| 新电脑恢复会话与工程 | 迁移计划 + digest 校验 + 安全副本 + 路径映射 | ✅ 恢复文件 SHA-256 与 manifest 完全一致 |

---

## 规模

```text
src/       20 文件   4428 行    ← 客户端、引擎、调度、安装器
bin/        1 文件    608 行    ← CLI，30+ 子命令
plugin/     2 文件    381 行    ← DSH storage 后端插件
test/      24 文件   3017 行    ← 128 个测试
scripts/    6 文件    277 行    ← 演示、安装、doctor
docs/        5 文件   ~37 KB    ← 含真实 API 陷阱记录
```

**零 npm 依赖。** `dependencies: {}`，`devDependencies: {}`。只用 Node 标准库。

这不是洁癖——每个依赖都是别人 C 盘上的一份缓存、一次 `npm install` 的失败可能、一个版本冲突的来源。这个项目从 `node:fs` 到 `node:test` 全部自给。

---

## 测试：128 个，四层

| 层 | 数量 | 证明什么 |
|---|---|---|
| 单元（路径策略、排除、分片、YAML） | ~45 | 边界条件 |
| 引擎（同步、备份、恢复、调度、上传） | ~40 | 业务逻辑 |
| **真实 HTTP**（`acceptance-http`） | 11 | 真实 `BaiduNetdiskClient` 打进程内 XPAN 服务器，走真 fetch、真 multipart、真 Range 续传 |
| **真实 DSH 契约**（`dsh-contract`） | 6 | 用**已安装的** cordis + dsh-storage + dsh-storage-domain，不是替身 |

另有 `patch-schema` 用真实 `dsh-mcp-client` 的 Schemastery 校验生成的配置行，`oauth` 覆盖授权全流程。

**零真实网络、零真实 token**——除了一层需要手工执行的真实账号验收。

---

## 真实账号抓出的 6 个 bug

这是整个项目最有价值的部分。**128 个离线测试全部通过的情况下，真实 API 打崩了 6 次。**

### 1. `file_list` 返回的 `md5` 不是 MD5

```text
本地真实 MD5 : 6b84f901d476e86bbcbbe12f80365222
file_list    : d555ad0cei2f34ee8115174535102cc0   ← 含字母 i
```

含 `i`/`n`/`p`/`s`，长度可能 33。稳定、内容相关、跨接口一致——能当等值键，不能当校验和。

**后果**：`download()` 拿它比对真实 MD5，**每一次下载都报 `download-corrupt`**。

**为什么离线测试没抓到**：假服务器返回真 MD5。因为我是按文档实现的，文档没说它会骗人。

### 2. `move` 的 `ondup=overwrite` 是空操作

四种取值全部 errno 12，只有 `newcopy` 能过——但它改名成 `name(1)`，不是覆盖。

**后果**：`uploadAtomic` 的“先写临时再 move”在目标存在时必然失败。**第二份备份因此直接崩掉。**

### 3. 连带的**数据丢失**事故

先删后 move 时，如果目标是**目录**，`filemanager delete` 递归删整棵树。

真实后果：`/HDS/backups` 被改名成 `/HDS/backups_20261024_193628`，新目录空的。**我的第一次备份数据在那一瞬间全部失联。**

现在 `uploadAtomic` 检查 `isdir`，是目录就抛 `target-is-directory`。

### 4. 批量 `errno` 在外层永远是 0

```json
{ "errno": 0, "info": [{ "errno": 12, "path": "...", "to_path": "..." }] }
```

外层的 0 是“请求送达了”。**只看外层，第 2 条那个失败的 move 会被当成成功**——这就是第 3 条事故能发生的原因。

### 5. dlink 下载必须把 token 拼进 URL

`Authorization: Bearer` 无效，只带 UA 返回 `31045 user not exists`。

### 6. `.hds-tmp` 用完不清理

每个写过的目录留一个 staging 目录。真实网盘上攒了 5 个。

---

**六个都修了，都补了离线回归测试，假服务器也改了**——现在它刻意复现 md5 混淆、move 冲突 errno 12、`info[].errno` 这三个陷阱。这类 bug 以后会在 CI 里死掉，而不是在你的网盘上。

---

## 硬约束：不碰 C 盘

原话是「**注意我们的原则不可以以任何的形式对我的C盘进行写入**」。

不是“尽量不”，是“任何形式”——包括缓存、临时文件、日志、测试夹具、依赖安装。

实现方式：

- `paths.mjs` 里 `isCDrivePath` 对所有本地写入路径无条件拒绝
- 拒绝 UNC、拒绝未授权盘符、`realpath` 检查 junction/symlink 逃逸
- `useApprovedTempDir` 把 `TEMP`/`TMP`/`TMPDIR` 全部重绑到 `var/tmp`
- 测试夹具全部落在 `G:\...\var\test`
- 零依赖，所以没有 `node_modules` 缓存问题

**验证**：所有 `state/` 下文件都在 `G:\project\...\hds-baidu-bridge\state\`。凭证、日志、同步清单、恢复安全副本，一个没漏。

> 一个诚实的边界：DSH 自己会往 `C:\Users\JianXi\AppData\Local\Temp\dsh-spill-*` 写临时文件。那是宿主行为，不在本项目控制范围内。我没有去改它。

---

## 安全

| 项 | 做法 |
|---|---|
| 凭证存放 | `state/credentials.json` + `state/app-credentials.json`，G 盘，`chmod 600`，`.gitignore` |
| 备份排除 | `.credentials.yaml` 强制排除，`catalog.json` 已验证不含任何 token |
| 日志脱敏 | `redact()` 匹配 `access_token=`、`121.<32hex>` 裸 token 形状、`Bearer` 头 |
| 泄漏扫描 | 扫了 `state/` 下所有文件（除两个凭证文件本身），**0 处泄漏** |
| 删除保护 | MCP 的破坏性工具默认关闭，需显式开 `allowDestructiveTools` |

---

## 教训

**1. 文档是理想，API 是现实。**

六个 bug 全部源于“按文档实现”。文档说 `ondup` 支持 `overwrite`——它不支持。文档没说 `md5` 字段可以是伪造的——它是。

**2. 假服务器必须复现真实的坏行为。**

我的第一个假服务器返回真 MD5、允许 move 覆盖。它让我 128 个测试全绿，然后在真实网盘上连崩两次。**一个只会返回正确数据的假服务器，只能证明代码在正确数据下是对的。**

**3. 错误消息里的 JSON 会掩盖真正的问题。**

`HTTP 401: {"error":"invalid_client",...}` 让我花了额外时间才看出是 AppKey 错。现在它是 `HTTP 401: invalid_client: unknown client id`。

**4. 非交互式静默 exit 0 是最坏的失败模式。**

`token login` 在无 TTY 时 readline 永不返回，进程退出码 0。脚本会以为成功了。**任何“等待输入”都必须先检查 `process.stdin.isTTY`。**

---

## 现在的状态

**已完成并验证**：五个功能全部实现，128 测试通过，真实账号端到端跑通。

**已安装并已热加载**：MCP 进了 `G:\.dsh\profiles\desktop\cordis.patch.yml`，**无需重启**——DSH 的 `watchUserPatches` 监听该文件并即时重组插件树。实测进程 16:43 启动、patch 19:06 写入，未重启即可调用工具。

**未启用**（等着你决定）：

- storage `baidu` 后端 —— 已测通，但会让每次存储写入等一次网盘上传
- 定时备份 —— 随时可 `backup task --every 60 --apply`

**网盘现状**：`/HDS` 下 163 个内容对象 / 6 个快照 / 占用 154 MB / 账号剩 **6.15 TB**（`total - used`；API 的 `free` 字段是“免费容量”不是余量，见 [真实 API 行为记录](real-api-notes.md)）。

---

## 如果你想继续

```powershell
cd G:\project\deepseek-harness\work_hds\hds-baidu-bridge

npm test                      # 128 个测试
node scripts/demo.mjs         # 10 个场景端到端演示
node bin/hds-baidu.mjs doctor # 联网体检
node bin/hds-baidu.mjs install status
```

改代码前先读 [真实 API 行为记录](real-api-notes.md)。那 6 条每一条都对应一次真实的崩溃。
