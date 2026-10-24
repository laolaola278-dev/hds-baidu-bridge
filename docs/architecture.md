# 架构说明

## 目标

把百度网盘当作 HDS 的一等存储，同时不破坏 HDS 对本地文件系统的假设。

核心约束：

1. 本地写入只允许 G 盘；`C:` 在任何路径上都被拒绝。
2. 百度网盘没有 Windows 文件系统驱动，因此不能“挂载后直接编辑”。
3. 百度 OpenAPI 的写入是**最终一致**的远端对象，不是 POSIX 文件。
4. 会话日志是 zstd 压缩的 JSONL，恢复时不能安全改写内部 `cwd`。

## 分层

```text
┌──────────────────────────────────────────────┐
│ HDS（agent / tools / workspace）              │
├──────────────────────────────────────────────┤
│ MCP stdio 服务（15 个工具）                    │
├──────────────────────────────────────────────┤
│ 能力层                                         │
│  ├─ SyncEngine        本地镜像 ↔ 远端          │
│  ├─ BackupEngine      内容寻址快照             │
│  ├─ RestoreEngine     计划/校验/落地            │
│  ├─ ProjectUploader   工程树 + git bundle      │
│  └─ MirrorDaemon      文件监听 + 周期对账       │
├──────────────────────────────────────────────┤
│ BaiduNetdiskClient（XPAN REST + 分片上传/下载） │
├──────────────────────────────────────────────┤
│ 路径策略 / 日志脱敏 / 临时目录重定向             │
└──────────────────────────────────────────────┘

旁路：
DSH storage hub ── register('baidu') ── BaiduStorageBackend
                                    └─ /HDS/dsh/units/<unit>.json
```

## 为什么不是“挂载”

| 需求 | 挂载 | 本地镜像 |
|---|---|---|
| 原子重命名 | 网盘不保证 | 本地 NTFS 保证 |
| 文件监听 | 不可靠 | `fs.watch` 递归 |
| Git 写入 | 可能半写 | 正常 |
| 离线可用 | 否 | 是 |
| 延迟 | 每次 IO 走网络 | 本地 |
| 冲突可见性 | 隐藏 | 显式报告 |

镜像的代价是“双份空间”和“同步窗口”。项目用 `MirrorDaemon` 把窗口压到秒级，并在冲突时**只报告、不覆盖**。

## 同步模型

状态保存在 `state/sync/<id>.json`，`id = sha256(localRoot\0remoteRoot)[:16]`。

每个文件记录三元组：

```json
{
  "localMd5": "...",
  "remoteMd5": "...",
  "localMtimeMs": 0,
  "remoteMtime": 0,
  "syncedAt": "..."
}
```

判定表（`direction=both`）：

| 本地 | 远端 | baseline | 动作 |
|---|---|---|---|
| 有 | 无 | 无 | upload（new） |
| 有 | 无 | 有 | upload（remote-missing） |
| 无 | 有 | 无 | download（new） |
| 无 | 有 | 有 | skip（local-deleted-remote-kept） |
| 有 | 有 | md5 相同 | record |
| 改 | 未改 | 有 | upload |
| 未改 | 改 | 有 | download |
| 改 | 改 | 有 | **conflict** |

关键设计：

- 删除不会传播。本地删了，远端保留；远端删了，本地保留。避免一次误删双向扩散。
- 冲突永远不自动解决。
- 上传是“临时对象 + move 覆盖”，下载是“.part + MD5 校验 + rename”。

## 备份模型

远端布局：

```text
/HDS/backups/
├─ catalog.json
├─ objects/<sha256[0:2]>/<sha256>
├─ snapshots/<snapshotId>/manifest.json
└─ live/...            # 可选的人类可读镜像
```

- 对象按 SHA-256 寻址，天然去重；同一文件在多个快照里只存一份。
- 快照 manifest 记录 `source / relative / size / mtimeMs / sha256 / object`。
- catalog 是快照索引，最多保留 100 条。
- 上传并发受 `sync.concurrency` 限制，默认 3。
- `.credentials.yaml` 永远不在备份源里。

## 恢复模型

1. `plan(snapshotId, mapping)` 计算每个条目的目标路径，并检查路径策略。
2. 生成 `planDigest = sha256(排序后的 target+sha256+object)`。
3. `apply(plan, {confirm, planDigest})` 先校验 digest，再下载到 staging 并逐个校验 SHA-256。
4. 只有全部下载校验通过，才进入落地阶段。
5. 落地前把将被覆盖的文件复制到 `state/restore-safety/<timestamp>/`。

这是“先全量校验、后统一落地”，避免恢复一半留下混合状态。

## DSH 存储后端

`plugin/dsh-storage-baidu` 实现 `KvFacet` / `KvUnit` 契约：

- `open(descriptor)` 从 `/HDS/dsh/units/<name>.json` 读取远端真身；失败按 `offlinePolicy` 处理。
- 写入协议：序列化完整候选状态 → 原子上传远端 → 成功后更新内存与本地缓存。
- 远端失败时内存和缓存都不变，因此读到的永远是可持久化的状态。
- `offlinePolicy: 'reject'`（默认）保证“远端持久化”语义；`'cache'` 只保证本地。

它注册为 `baidu`，**不自动**替换 `json`。切换 `storage-domain.backend` 是单独一步，因为那会让每次 DSH 存储写入都等一次网盘上传。

## 路径策略

`src/paths.mjs` 是所有写入的必经之路：

1. 只接受绝对路径或相对 `local.root` 的路径。
2. `C:` 无条件拒绝（即使 `allowedDrives` 里误加了 C）。
3. UNC 路径拒绝。
4. 非 `allowedDrives` 的盘符拒绝。
5. `resolveLocalPathChecked` 向上找到最近的已存在祖先，用 `realpath` 确认没有通过 junction/symlink 跳到别的盘。
6. `assertInside` 拒绝 `..` 逃逸。
7. 远端路径必须绝对、必须无 `..`、必须位于 `remoteRoot` 下。

`src/temp.mjs` 额外把 `TEMP`/`TMP`/`TMPDIR` 指向 G 盘的 `var/tmp`，防止第三方库或 Node 内部把临时文件写到 C 盘。

## 日志与密钥

- `access_token` 在日志、错误消息、MCP 返回里都会被 `redact()` 替换。
- Token 只从环境变量或 `state/credentials.json` 读取；后者已在 `.gitignore` 中。
- Profile patch 里**不写** token，MCP 子进程自行解析。

## 失败模式

| 场景 | 行为 |
|---|---|
| Token 缺失 | CLI 返回码 2；MCP 工具返回 `token-missing` |
| 远端 429/503/504 | 指数退避重试 3 次 |
| 上传中断 | 临时对象残留，最终对象不受影响 |
| 下载中断 | `.part` 保留，下次 Range 续传 |
| 下载 MD5 不符 | 删除 `.part`，报 `download-corrupt` |
| 备份部分失败 | 不写 manifest、不写 catalog，保持旧 catalog 可用 |
| 恢复对象损坏 | 整个 apply 在下载阶段失败，本地不变 |
| 同步冲突 | 记录并跳过，不覆盖任何一侧 |
| 网盘不可用 + storage backend | `reject` 模式下写入直接失败，调用方可见 |

## 目录职责

```text
bin/hds-baidu.mjs        CLI：所有命令的入口，逐条命令做安全校验
mcp-server.mjs           MCP stdio 入口（薄封装）
src/baidu-api.mjs        REST 客户端、分片、续传、校验
src/sync-engine.mjs      plan/apply 同步
src/backup-engine.mjs    内容寻址备份
src/restore-engine.mjs   恢复计划与落地
src/project-upload.mjs   工程树 + git bundle
src/watch.mjs            镜像守护进程
src/scheduler.mjs        周期备份 + 计划任务
src/installer.mjs        DSH profile 安装/回滚
src/patch.mjs            YAML patch 生成（零依赖）
src/paths.mjs            路径策略
src/temp.mjs             临时目录重定向
plugin/dsh-storage-baidu DSH 存储后端
```
