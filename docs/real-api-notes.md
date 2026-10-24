# 真实 API 行为记录

这些是**用真实百度网盘账号跑出来的事实**，不是从文档抄的。每一条都对应一次真实失败，以及代码里的一处防御。

记录的原因：这些行为官方文档没有写，本地假服务器也想不出来。以后改客户端、换账号或百度改接口时，先看这一页。

账号信息：UK `1100000000000`，VIP 2 级，配额 6.6 TB。

---

## 1. 查询接口返回的 `md5` 不是 MD5

**这是最容易踩的坑。**

| 接口 | 返回的 md5 可信吗 |
|---|---|
| `precreate` / `superfile2` / `create`（上传） | ✅ 真 MD5，逐字节正确 |
| `file_list`（列目录） | ❌ 混淆值 |
| `filemetas`（查元数据） | ❌ 混淆值 |
| dlink 元数据 | ❌ 混淆值 |

实测样本：

```text
本地真实 MD5 : 6b84f901d476e86bbcbbe12f80365222
file_list     : d555ad0cei2f34ee8115174535102cc0   ← 含 i
filemetas     : d555ad0cei2f34ee8115174535102cc0
真实下载后计算: 6b84f901d476e86bbcbbe12f80365222   ← 与本地一致
```

注意 `i`、`n`、`p`、`s` 这些字符**不是十六进制**，所以它不可能是 MD5。长度可能是 32 也可能是 33。

它的性质（都验证过）：

- **稳定**：同一文件多次调用返回相同值
- **内容相关**：相同内容的不同文件返回相同值；不同内容返回不同值
- **跨接口一致**：`file_list` 和 `filemetas` 返回同一值

所以它只能当**不透明等值键**用，不能当校验和。

### 代码怎么处理的

`src/baidu-api.mjs` 的 `isVerifiableMd5()` 用 `/^[0-9a-f]{32}$/i` 判定。只有通过判定的值才作为下载校验依据：

```js
const remoteMd5 = options.expectedMd5 ?? link.md5
const expectedMd5 = isVerifiableMd5(remoteMd5) ? remoteMd5.toLowerCase() : undefined
```

- 是合法 MD5 → 严格比对，不符则删掉 `.part` 并报 `download-corrupt`
- 不是合法 MD5 → 退化为**字节数校验**（`expectedSize`），并在返回值里标 `verified: false` 和原始 `remoteMd5`

同步清单（`sync-manifest.json`）里存的 `remoteMd5` 就用这个不透明值做增量判断——它稳定且内容相关，足够。**不要**把它和本地计算的 MD5 直接比较。

> 症状提醒：如果哪天 `download` 报 `MD5 mismatch after download`，先打印 `remoteMd5` 看是否含非十六进制字符。如果含，是本文档描述的情况；如果是合法十六进制却不匹配，那才是真的传坏了。

---

## 2. `filemanager` 的 `ondup` 对 move 无效

文档说 `ondup` 支持 `overwrite` / `fail` / `newcopy` / `skip`。实测**移动**操作时：

| ondup | 目标已存在时的实际行为 |
|---|---|
| `overwrite` | ❌ errno 12 |
| `fail` | ❌ errno 12 |
| `skip` | ❌ errno 12 |
| `newcopy` | ✅ 成功，但改名为 `name(1).ext` |

也就是说**没有一种方式能让 move 覆盖已存在的目标**。`overwrite` 是被静默忽略的。

### 后果

`uploadAtomic` 的"先写临时对象再 move 到目标"必须改成**先删目标再 move**。这引入一个毫秒级窗口，期间目标是缺失的（不是半个文件）。这是该 API 的固有限制。

### 更危险的连带问题

删除目标时，如果目标其实是**目录**，`filemanager delete` 会**递归删除整棵子树**。

这是真实发生的事故：一次失败的备份把 `/HDS/backups` 整个目录改名成了 `/HDS/backups_20261024_193628`，新目录为空。原因是 `uploadAtomic` 的 `stat` 看到目标路径"存在"就删，而它是个目录。

现在 `uploadAtomic` 会先检查 `isdir`，是目录就抛 `target-is-directory` 拒绝执行。

---

## 3. 批量返回的 `errno` 在 `info[]` 里，不在外层

`filemanager` 的 move / rename / delete 返回长这样：

```json
{
  "errno": 0,
  "info": [
    { "errno": 12, "path": "/HDS/backups/.hds-tmp/x.tmp", "to_path": "/HDS/backups/x" }
  ]
}
```

**外层 `errno` 是 0，意思是"请求本身成功送达"，不是"操作成功"。** 每个文件的结果在 `info[].errno` 里。

只检查外层 `errno` 会把失败的 move 当成成功——这正是第 2 节那次目录丢失的直接原因。

`assertBaiduOk` 现在会遍历 `info[]`，有任何非零项就抛出，并带上前三个失败项的路径。

---

## 4. dlink 下载必须在 URL 里带 `access_token`

只带 `User-Agent: pan.baidu.com` 会返回：

```json
{"error_code":31045,"error_msg":"user not exists"}
```

HTTP 状态是 403。必须在 dlink 查询串里追加 `&access_token=<token>`——查询参数可以，`Authorization: Bearer` 头**不行**。

`BaiduNetdiskClient.withToken()` 负责这件事。注意这意味着 token 会出现在 URL 里，所以任何日志都不能记录完整 dlink（`redact()` 会处理 `access_token=` 形式）。

---

## 5. 首次推送的目标目录可能不存在

新用户第一次 `sync plan --direction push` 时，远端目录还不存在，`file_list` 返回 errno `-9`。

`SyncEngine.listRemote()` 把 `-9 / 31066 / 31061` 当作"空目录"，其余错误照常抛出。

---

## 6. 目录无法真正清空后删除

`filemanager delete` 对目录是递归的，但没有"删除空目录"的独立语义——删目录就是删树。所以清理 staging 目录时必须确认路径正确，没有 undo。

---

## 7. `free` 不是“剩余空间”，是“免费容量”

官方字段表（[获取网盘容量信息](https://pan.baidu.com/union/doc/基础网盘服务/获取网盘容量信息/)）原文：

| 字段 | 官方描述 |
|---|---|
| `total` | 总空间大小，单位字节 |
| `used` | 已使用大小，单位字节 |
| `free` | **免费容量**，单位字节 |

三者**没有算数关系**。`free` 是账号的另一项免费额度，不是 `total - used`。

实测这一台：

```text
total          6602.44 GB
used            455.63 GB
free            112.74 GB   ← 恰好 105.00 GiB 整
total - used   6146.81 GB   ← 真正的剩余
```

`112742891520` 正好等于 `105 × 1024³`。一个精确到 GiB 的整数不可能是补数，它来自另一套配额。

**踩坑后果**：早期 `doctor` 把 `free` 当“可用空间”展示，把这个账号的余量少报了约 **6 TB**（报 112 GB，实际 6.15 TB）。

现在 `doctor` 输出：

```json
"quota": {
  "total": 6602438475776,
  "used": 455631438653,
  "available": 6146807037123,      // total - used，真正能用的
  "freeAllowance": 112742891520,   // API 的 free 原值，改名后保留
  "expiresWithin7Days": false
}
```

`fake-xpan-server.mjs` 现在也返回一个**刻意对不上的** `free`（5 GiB vs 10 GiB 余量），这样谁再把 `free` 当余量用，CI 立刻红。

### 同族的另外两个字段

- `expire`：7 天内是否有容量到期。`false` 表示 `total` 稳定。
- `recyclestatus`：回收站状态。回收站占用的空间通常仍计入 `used`，所以清空回收站能立刻腾出 `used`。

---

## 8. 配额是账号级的，不是目录级的

`/api/quota` 返回整个账号的用量，跟 `/HDS` 目录无关。

备份前算一下：`backup plan` 会给出 `totalBytes`。当前 DSH 会话约 155 MB，首份快照 154 MB，后续增量只传变化的对象。这远小于可用空间，但**大项目**（含 `node_modules`、模型权重）需要先确认。

---

## 8. 上传分片的真实参数

- 分片大小：4 MiB
- `block_list` 是**每个分片**的 MD5，不是整个文件的
- 9.4 MB 文件 = 3 片，实测上传 7.9 秒、下载 4.8 秒（家庭宽带）
- 整个文件 MD5 由 `precreate` 的响应或 `create` 的响应给出，是真实的

---

## 复现这些实验

真实账号的验收脚本不放在 `test/`（需要 token，不能进 CI）。手工复现：

```powershell
node .\bin\hds-baidu.mjs doctor                    # 账号、配额、目录
node .\bin\hds-baidu.mjs upload <file> /HDS/probe  # 看返回 md5 是否正确
node .\bin\hds-baidu.mjs ls /HDS/probe             # 看 md5 是否被混淆
node .\bin\hds-baidu.mjs download /HDS/probe/<file> <local>
```

`test/acceptance-http.test.mjs` 覆盖了上述所有行为的**离线**版本——`fake-xpan-server.mjs` 刻意复现了 md5 混淆、move 冲突 errno 12、批量 `info[].errno` 这三个陷阱，所以这类 bug 以后会在 CI 里被发现，而不是在真实网盘上。
