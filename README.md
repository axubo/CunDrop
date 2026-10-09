# CunDrop · 私人云盘

基于 **Cloudflare Workers + R2 + KV** 的私人文件托管 / 分享站。
自己搭、自己用，不再依赖第三方网盘:上传视频后一键生成分享链接发给朋友。

![License](https://img.shields.io/badge/license-MIT-blue) ![Cloudflare](https://img.shields.io/badge/Cloudflare-Workers%20%2B%20R2-orange)

## ✨ 功能

- 📤 **拖拽上传** —— 文件直传 R2(不经过服务器中转), 支持超大视频(单文件上限 5GB), 上传队列带进度条 / 实时速度 / 剩余时间 / 取消 / 重试
- 🎬 **在线预览** —— 视频(自动截取缩略图)、图片、音频、文本直接在网页里看
- 🔗 **分享链接** —— 一键生成短链接, 可选有效期(1 天 / 7 天 / 30 天 / 永久)与提取密码, 带二维码, 统计下载次数, 随时撤销
- 📱 **分享页** —— 公开的精美下载页, 视频可直接在线播放, 支持断点续传(Range)
- 🔒 **管理员登录** —— 简单密码保护, 分享链接本身公开(可设密码)
- 🌌 **高颜值 UI** —— 深色玻璃拟态设计, 全中文界面

## 🏗 架构

```
浏览器 ──(1. 申请预签名 URL)──→ Worker ──(SigV4 签名)──→ 返回 PUT 地址
浏览器 ──(2. PUT 文件, 带进度)──→ R2 S3 兼容 endpoint (直传, 无大小瓶颈)
浏览器 ──(3. 登记文件信息)──→ Worker ──→ KV (文件名/大小/类型索引)

分享访问: 朋友打开 /s/xxx ──→ Worker 校验(密码/有效期) ──→ R2 取文件流式返回(支持 Range)
```

| 组件 | 用途 | 费用(免费额度) |
|---|---|---|
| Cloudflare Workers | API + 分享页 + 文件代理 | 每天 10 万次请求 |
| R2 | 文件存储 | 10 GB 存储 / 每月 100 万次写入 |
| KV | 文件索引 + 分享链接元数据 | 每天 10 万次读取 |

> 个人自用完全够, R2 传出流量免费是最大优势——分享视频不心疼。

## 🚀 部署步骤

### 1. 准备 Cloudflare 账号

注册 [cloudflare.com](https://cloudflare.com), 记下 **Account ID**(域名总览页右侧可看到)。

### 2. 创建 R2 存储桶

R2 → Create bucket, 名字例如 `cundrop-storage`。

### 3. 配置 R2 CORS(允许浏览器直传)

R2 → 点进你的桶 → Settings → CORS policy → Add CORS policy, 粘贴:

```json
[
  {
    "AllowedOrigins": ["https://你的域名"],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

> 本地调试时把 `http://localhost:8787` 也加进 `AllowedOrigins`。

### 4. 创建 R2 API Token

R2 → Manage R2 API Tokens → Create API token:

- Token name: `CunDrop`
- Permissions: **Object Read & Write**
- 指定到你第 2 步的桶(Apply to specific buckets only)

记下 **Access Key ID** 和 **Secret Access Key**(只显示一次)。

### 5. 创建 KV 命名空间

Workers & Pages → KV → Create a namespace, 名字例如 `cundrop-kv`, 记下它的 **ID**。

### 6. 本地配置

```bash
git clone <你的仓库地址> && cd cundrop
npm install
cp .dev.vars.example .dev.vars   # 填入真实值(仅本地开发用, 不会提交)
```

修改 `wrangler.toml`:

- `bucket_name` / `BUCKET_NAME` → 你的桶名
- `id`(kv_namespaces) → 第 5 步的 KV ID
- `R2_ACCOUNT_ID` → 你的 Account ID

### 7. 设置密钥(生产环境)

```bash
wrangler login
wrangler secret put ADMIN_PASSWORD        # 管理员登录密码, 自己定个强的
wrangler secret put R2_ACCESS_KEY_ID      # 第 4 步的 Access Key ID
wrangler secret put R2_SECRET_ACCESS_KEY  # 第 4 步的 Secret Access Key
wrangler secret put SESSION_SECRET        # 任意随机长字符串, 如: openssl rand -hex 32
```

### 8. 部署

```bash
npm run deploy
```

成功后会得到 `https://cundrop.<你的子域>.workers.dev`, 打开即用。

### 9. (推荐)绑定自定义域名

Workers & Pages → 你的 Worker → Settings → Domains & Routes → Add Custom Domain,
例如 `drop.example.com`, 然后把第 3 步 CORS 的 `AllowedOrigins` 改成它。

### 10. (可选)推送到 GitHub 开源

```bash
gh repo create CunDrop --public --source=. --push
# 或手动: git init && git add . && git commit -m "init" && git remote add origin <地址> && git push -u origin main
```

> ⚠️ 推送前确认 `.dev.vars` 没有被提交(已在 `.gitignore` 中), `wrangler.toml` 里不要写真实密钥。

## 🛠 本地开发

```bash
npm run dev        # 启动本地开发服务器 http://localhost:8787
npm run typecheck  # TypeScript 类型检查
```

## ❓ 常见问题

**Q: 上传时报网络错误?**
A: 99% 是 CORS 没配好。检查 R2 桶的 CORS policy 里 `AllowedOrigins` 是否包含你当前访问的域名(含 `https://`), `AllowedMethods` 是否包含 `PUT`。

**Q: 单文件最大能传多大?**
A: 5GB(S3 单 PUT 上限)。更大的文件可以分卷压缩后再传。

**Q: 分享链接永久有效安全吗?**
A: 链接是 10 位随机 ID, 猜不出来; 敏感文件请设置提取密码 + 有效期。

**Q: 想换登录密码?**
A: `wrangler secret put ADMIN_PASSWORD` 重新设置后重新部署(或等下次部署生效)。

**Q: 视频在线播放拖不动进度条?**
A: 后端已实现 HTTP Range(206) 分片, 正常seek。如果不行, 检查是否经过了某层缓存代理。

## 📁 目录结构

```
CunDrop/
├── src/
│   ├── worker.ts      # 路由: 登录/上传/文件/分享/下载
│   ├── auth.ts        # 会话 cookie(HMAC 签名)与分享密码
│   ├── sign.ts        # AWS SigV4 预签名 URL(浏览器直传 R2)
│   ├── share-page.ts  # 公开分享页 HTML 模板
│   └── types.ts       # 类型定义
├── public/
│   └── index.html     # 前端(单文件, Tailwind, 全中文 UI)
├── wrangler.toml      # 部署配置
└── README.md
```

## 📄 开源协议

MIT
