# 获取百度网盘 Access Token

本项目调用百度网盘开放平台（XPAN OpenAPI），需要一个 OAuth access token。整个流程分四步，大约 10 分钟。

> 前提：你需要一个百度账号，并且能完成实名认证（个人认证即可）。

---

## 第一步：成为开发者并创建应用

1. 打开 <https://pan.baidu.com/union>
2. 用百度账号登录，点击右上角 **控制台**
3. 首次进入会要求**实名认证**。个人开发者选个人认证，需要身份证信息；企业开发者需要营业执照
4. 认证通过后进入 <https://pan.baidu.com/union/console/applist>
5. 点 **创建应用**

### 「创建应用」表单怎么填

弹窗里只有五个字段，全部必填：

| 字段 | 选什么 | 说明 |
|---|---|---|
| 应用用途 | **个人使用** | 自用选这个，不需要提交审核。选「公开发布」会进入审核流程，自用没必要 |
| 应用类型 | **软件** | 不要选硬件 |
| 应用分类 | **其他** | 下拉里选一个最接近的即可，不影响权限 |
| 应用名称 | `hds-baidu`（9 字符） | **上限 12 个字符**，中文算 1 个字符。`hds-baidu-bridge` 有 16 字符，会超限。不能留空 |
| 应用描述 | 见下方模板 | **上限 200 字**，写清楚用途即可，不严格审查 |

应用描述可以直接抄这一段（约 90 字）：

```text
本地开发工具，用于把个人百度网盘目录映射为本地工作目录，并通过 MCP 协议供本地 AI 助手读写。核心能力：文件列表、上传下载、目录管理、按哈希去重备份。仅限个人自用，不对外提供服务。
```

填完点 **立即创建**。

> **注意**：这个表单里**没有「回调地址」字段**。回调地址是创建完成后在应用详情页单独设置的，见下面的「设置回调地址」。
>
> 截图里的 `应用名称不能为空` 只是因为名称栏还没填——填上名字（不超过 12 字符）红色提示就会消失。

### 设置回调地址

创建完成后进入应用详情页（或在应用列表里点应用名称），找到 **回调地址 / redirect_uri** 设置项，填：

```text
oob
```

> `oob` 是 "out of band" 的缩写，百度用它表示"不跳转网页，直接把授权码显示在页面上"。这是桌面工具的标准做法，省得你自己搭一个回调服务。
>
> 如果你的控制台不接受 `oob`，就填一个你能控制但不需要真的起服务的形式，例如 `https://localhost/`，然后在授权时和换 token 时**保持完全一致**（本项目的 `--redirect-uri` 参数和 `token login` 会自动保证一致）。

### 记下两个凭证

在应用详情页找到：

- **AppKey**（也叫 API Key、client_id）
- **SecretKey**（也叫 Secret Key、client_secret）

**SecretKey 只显示一次**，关掉页面就看不到了。如果丢了，只能重新生成。

---

## 第二步：确认应用有权限

在应用详情页找 **权限 / 接口权限**，确认包含：

- `basic` —— 用户信息
- `netdisk` —— 文件列表、上传、下载、管理

如果应用还是"开发中"状态，通常开发者自己就能用全部权限。**不需要**提交上线审核——上线审核是给要公开发布的应用用的，自用不需要。

---

## 第三步：拿授权码

有两种方式，任选其一。

### 方式 A：用项目自带的命令（推荐）

```powershell
cd G:\project\deepseek-harness\work_hds\hds-baidu-bridge

# 把两个值换成你自己的
node .\bin\hds-baidu.mjs token login --client-id 你的AppKey --client-secret 你的SecretKey
```

它会打印一个授权 URL，例如：

```text
https://openapi.baidu.com/oauth/2.0/authorize?response_type=code&client_id=xxx&redirect_uri=oob&scope=basic+netdisk&display=page&state=abc123
```

1. 复制这个 URL 到浏览器打开
2. 登录百度账号，点 **同意授权**
3. 页面上会显示一串授权码（code）
4. 回到终端，粘贴这串 code，回车

命令会自动换取 token 并保存。

> 也可以直接把浏览器地址栏里那一整条回调 URL 粘进去，命令会自己从里面抽 `code`。

### 方式 B：手工拼 URL

如果不想把 SecretKey 交给命令行，可以只手工拿 code：

```powershell
$appKey = '你的AppKey'
$url = "https://openapi.baidu.com/oauth/2.0/authorize?response_type=code&client_id=$appKey&redirect_uri=oob&scope=basic+netdisk&display=page"
Start-Process $url
```

浏览器里同意授权后，页面上会显示授权码（code）。复制它，然后手工换成 token：

```powershell
$code = '页面上的授权码'
$appKey = '你的AppKey'
$secret = '你的SecretKey'
$r = Invoke-RestMethod "https://openapi.baidu.com/oauth/2.0/token?grant_type=authorization_code&code=$code&client_id=$appKey&client_secret=$secret&redirect_uri=oob"
$r.access_token
```

再存进项目：

```powershell
node .\bin\hds-baidu.mjs token set
# 提示时粘贴上面取到的 access_token（不是 code）
```

**注意**：`token set` 要的是 access_token，不是 code。code 只能用来换 token，而且有效期只有几分钟、只能使用一次。

### 回调地址必须前后一致

授权时的 `redirect_uri` 和换 token 时的 `redirect_uri` 必须**逐字符相同**，否则百度返回 `redirect_uri mismatch`。

如果控制台里的回调地址不是 `oob`，把两处都改成你实际的值：

```powershell
# 授权 + 换 token 都用同一个值
node .\bin\hds-baidu.mjs token login --client-id xxx --client-secret yyy --redirect-uri https://localhost/
```

方式 B 手工换 token 时，`Invoke-RestMethod` 里的 `redirect_uri` 也要改成一样的。

---

## 第四步：验证

```powershell
node .\bin\hds-baidu.mjs doctor
```

期望看到：

```json
{
  "tokenConfigured": true,
  "ok": true,
  "live": {
    "user": { "uk": 123456789, "vip_type": 0 },
    "quota": { "total": 1099511627776, "used": 0, "free": 1099511627776 },
    "remoteRoot": "/HDS",
    "entries": 0
  }
}
```

`entries: 0` 是正常的——`/HDS` 目录刚被创建，还是空的。

然后用一个小文件测试真实上传下载：

```powershell
'hello baidu' | Out-File -Encoding utf8 G:\tmp-test.txt
node .\bin\hds-baidu.mjs upload G:\tmp-test.txt /HDS
node .\bin\hds-baidu.mjs ls /HDS
node .\bin\hds-baidu.mjs download /HDS/tmp-test.txt G:\tmp-test-back.txt
Get-Content G:\tmp-test-back.txt
```

三步都成功，说明整条链路通了。之后可以删掉测试文件。

---

## Token 存哪儿了

默认写在：

```text
G:\project\deepseek-harness\work_hds\hds-baidu-bridge\state\credentials.json
```

内容大致是：

```json
{
  "accessToken": "121.xxxxx",
  "refreshToken": "122.xxxxx",
  "scope": "basic netdisk",
  "expiresAt": "2027-01-23T11:00:00.000Z",
  "fingerprint": "a1b2c3d4e5f6",
  "savedAt": "2026-10-24T11:00:00.000Z"
}
```

这个文件：

- 在 G 盘，不在 C 盘
- 已加入 `.gitignore`
- 备份时被排除，不会传到网盘
- 日志里只会出现 `fingerprint` 前 12 位，不会出现 token 本体

也可以完全不用文件，改用环境变量：

```powershell
$env:BAIDU_NETDISK_ACCESS_TOKEN = '你的token'
```

环境变量优先级更高。

---

## 有效期和刷新

百度 token 通常 30 天有效。查看状态：

```powershell
node .\bin\hds-baidu.mjs token status
```

输出里的 `validity`：

| reason | 含义 | 怎么办 |
|---|---|---|
| `fresh` | 还能用 | 什么都不用做 |
| `expiring` | 2 小时内过期 | 跑 `token refresh` |
| `expired` | 已过期 | 跑 `token refresh` |
| `no-expiry-recorded` | 手工 `token set` 存的，没记过期时间 | 能用的就继续用，报错了再换 |

刷新（不需要重新授权）：

```powershell
node .\bin\hds-baidu.mjs token refresh --client-id 你的AppKey --client-secret 你的SecretKey
```

或者设成环境变量省得每次传：

```powershell
$env:BAIDU_APP_KEY = '你的AppKey'
$env:BAIDU_SECRET_KEY = '你的SecretKey'
node .\bin\hds-baidu.mjs token refresh
```

**注意**：百度在刷新时会换发新的 refresh_token，旧的立即失效。项目会自动保存新的那一对。

---

## 常见错误

### 创建应用时表单报错

| 报错 | 原因 | 解决 |
|---|---|---|
| `应用名称不能为空` | 名称栏是空的 | 填一个名字，**最多 12 个字符**，中文按 1 字符算 |
| 名称输入框变红、计数变成 `12/12` | 超过 12 字上限 | 缩短，例如 `hds-baidu`（9 字符） |
| `应用描述不能为空` | 描述栏是空的 | 填任意说明，**最多 200 字**，可抄前面的模板 |
| 找不到「回调地址」 | 它不在创建表单里 | 创建完成后回应用详情页设置 |

### `errno -6: access token invalid`

token 本身无效或已过期。先 `token status`，再 `token refresh`。

### `errno -7: 权限不足`

应用的 scope 不够。回控制台检查是否勾了 `netdisk`。如果 scope 补了还是不行，重新走一次授权——旧 token 的 scope 是签在里面的，不会自动升级。

### `oauth-failed: invalid_grant`

code 已过期（百度 code 有效期很短，通常几分钟）或已被用过。重新打开授权 URL 拿新的。

### `oauth-failed: invalid_client`

AppKey 或 SecretKey 错。注意别把 AppKey 和 SecretKey 弄反。

### `redirect_uri mismatch`

三处的回调地址必须逐字符相同：控制台里注册的、授权 URL 里的、换 token 时传的。本项目 `token login` 会自动保持一致；手工换 token 时要自己对齐。

### `login needs the app credentials`

没传 `--client-id` / `--client-secret`，也没设 `BAIDU_APP_KEY` / `BAIDU_SECRET_KEY`。

---

## 安全建议

1. **SecretKey 不要提交到任何仓库**。项目只从命令行参数或环境变量读。
2. **token 等同于账号权限**，拿到就能读写你的网盘。不要把 `state/credentials.json` 发给别人。
3. 网盘侧开启**二次验证**。这样即使 token 泄露，异常登录也有拦阻。
4. 如果怀疑泄露，回控制台**重置 SecretKey**，这会作废所有已发的 token。
5. 备份到网盘的内容包含会话记录，可能含敏感信息。至少给 `/HDS` 目录设一个只有自己知道的路径，或者干脆改 `config.json` 里的 `remoteRoot`。

---

## 参考

- 开放平台首页：<https://pan.baidu.com/union>
- 应用列表：<https://pan.baidu.com/union/console/applist>
- 授权码模式文档：<https://pan.baidu.com/union/doc/使用入门/接入授权/授权码模式/>
- 错误码：<https://pan.baidu.com/union/doc/平台简介/错误码/>
