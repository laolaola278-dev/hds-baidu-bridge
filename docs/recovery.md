# 灾难恢复演练

本文给出可复现的恢复步骤，用于在新机器或重装后把 HDS 会话、workspace 注册表和工程找回来。

## 前提

- 新机器上已安装 HDS
- 项目代码在 G 盘
- 有百度网盘 access token
- G 盘路径可以与旧机器不同，但**不能是 C 盘**

## 演练 0：确认备份可用（在旧机器上做）

```powershell
node .\bin\hds-baidu.mjs doctor
node .\bin\hds-baidu.mjs backup list
```

记下最新 `snapshotId`。如果 `backup list` 为空，先跑一次 `backup run --apply`。

## 演练 1：新机器准备

### 1.1 准备项目

把项目目录复制到新机器的 G 盘，例如：

```text
G:\project\deepseek-harness\work_hds\hds-baidu-bridge
```

### 1.2 安装 Node

Node ≥ 22。确认：

```powershell
node --version
```

### 1.3 配置 token

```powershell
$env:BAIDU_NETDISK_ACCESS_TOKEN = '你的token'
node .\bin\hds-baidu.mjs token status
```

### 1.4 确认配置

`config/config.json` 里的 `allowedDrives` 必须是新机器的盘符。如果新机器只有 G 盘，保持 `["G"]`。

`hds.home` 应指向新机器的 `G:\.dsh`。

## 演练 2：只读检查

```powershell
node .\bin\hds-baidu.mjs backup list
node .\bin\hds-baidu.mjs restore plan <snapshot-id>
```

`restore plan` 输出：

- `entries`：每个文件的目标路径
- `summary.files` / `summary.bytes`
- `planDigest`：落地时必须回传

**这一步不写任何文件。**

核对 `entries[].target` 是否都在 G 盘、路径是否符合预期。

## 演练 3：正式恢复

```powershell
node .\bin\hds-baidu.mjs restore apply <snapshot-id> --plan-digest <digest> --apply
```

成功输出：

```json
{
  "ok": true,
  "restored": 123,
  "safetyRoot": "G:\\...\\state\\restore-safety\\2026-10-25T01-00-00-000Z",
  "warnings": ["Session headers keep their original cwd..."]
}
```

`warnings` 是预期行为，见下文。

## 演练 4：路径变化时的恢复

旧机器 `G:\project\demo`，新机器改成 `G:\work\demo`：

```powershell
node .\bin\hds-baidu.mjs restore plan <snapshot-id> `
  --map-hds-home G:\.dsh `
  --map-project demo=G:\work\demo
```

确认 plan 里的 target 后，用新的 `planDigest` 执行 apply。

注意：

- `--map-project` 的 key 是备份 manifest 里的工程名（目录 basename）
- 未映射的工程会落到 `<local.root>\restored-projects\<name>`
- 映射目标必须通过路径策略（非 C 盘、非 UNC、非 junction 逃逸）

## 演练 5：启动 HDS

### 5.1 确认会话文件

```powershell
Get-ChildItem G:\.dsh\sessions -Recurse -Filter *.jsonl.zstd | Measure-Object
```

数量应与备份 manifest 中 `source = hds-sessions` 的条目数一致。

### 5.2 确认 workspace 注册表

```powershell
Get-Content G:\.dsh\storages\workspace.json | Select-Object -First 20
```

应当是合法 JSON，含 `unit` 与 `tables`。

### 5.3 启动 HDS

启动后看：

- 会话列表是否出现历史会话
- Workspace 列表是否有同名工程

### 5.4 路径不一致时

会话头里的 `cwd` 是旧路径。DSH 按原路径显示会话，这**不会**损坏数据，但：

- 旧路径不存在时，会话里的工具调用可能失败
- 解决办法：在 Workspace UI 里重新添加工程到新路径
- 历史会话仍可阅读，只是不能在新路径上直接继续

**本项目有意不重写 zstd 会话头。** 理由：

1. 会话是压缩流，改写需要解压-改-重压，破坏追加写语义
2. 会话内容是审计记录，不应被工具静默修改
3. 目前 `cwd` 只在头行出现一次，未来格式可能变化

## 演练 6：恢复工程

如果备份包含工程：

```powershell
node .\bin\hds-baidu.mjs restore plan <snapshot-id>
```

工程条目会落到 `restored-projects/<name>` 或你用 `--map-project` 指定的位置。

如果备份了 git bundle：

1. 从网盘下载 `_git/<name>.bundle`
2. `git clone <bundle> <dir>`
3. 得到完整历史

## 演练 7：验证

### 7.1 文件数量

```powershell
(Get-ChildItem G:\.dsh\sessions -Recurse -File).Count
(Get-ChildItem G:\.dsh\storages -Recurse -File).Count
```

### 7.2 哈希抽查

从 manifest 里挑 3 个文件：

```powershell
Get-FileHash -Algorithm SHA256 G:\.dsh\sessions\<proj>\<session>\session.jsonl.zstd
```

与 manifest 的 `sha256` 对比。

### 7.3 备份链路仍然可用

```powershell
node .\bin\hds-baidu.mjs backup plan
```

应显示 0 个上传（全部命中 catalog）。

## 回滚

恢复覆盖了错误内容时：

1. 从 `safetyRoot` 找回被覆盖的原文件

```powershell
Get-ChildItem "G:\...\state\restore-safety\<timestamp>" -Recurse
```

2. 复制回原位置

`restore-safety` 按 `source/relative` 组织，路径与备份 manifest 一致。

## 故障注入演练

用假客户端可以在不碰真网盘的情况下演练：

```powershell
$env:TEMP='G:\project\deepseek-harness\work_hds\hds-baidu-bridge\var\tmp'
node --test test/backup-restore.test.mjs
```

覆盖场景：

- 对象损坏 → 拒绝恢复
- planDigest 不符 → 拒绝落地
- C 盘映射 → 拒绝
- 冲突 → 跳过并报告

生产恢复前建议先跑一遍这个测试，确认本地代码行为符合预期。

## 常见问题

### `restore plan` 报 `restore-collision`

manifest 里两个条目指向同一目标（不同 source 同名相对路径）。检查 `--map-project` 是否把两个工程映射到同一目录。

### `restore apply` 报 `planDigest must be`

plan 生成后条目发生了变化（文件被再次备份、mapping 改了）。重新生成 plan 并使用新 digest。

### 恢复后 `workspace.json` 解析失败

- 从 `safetyRoot` 回滚
- 检查备份时 DSH 是否正在写这个文件
- 重新 `backup run --apply` 再试

### 会话显示但打不开

旧 `cwd` 不存在。在 Workspace 里重新添加工程路径，或把工程恢复到旧路径。
