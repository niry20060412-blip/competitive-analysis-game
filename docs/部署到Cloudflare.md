# 部署到 Cloudflare（当前真实架构）

> 本文档描述项目**当前实际**的部署方式：**单个 Cloudflare Worker + 自定义域名（custom domain）**。
> 静态页面和搜索 API 都走同一个 Worker，不再拆成「Pages + Worker」两套。

---

## 架构总览

```
comp.niry.cn ──▶ Cloudflare Worker (comp-dungeon)
                    ├── 静态资源（site/ 里的 index.html + assets）
                    └── /api/search  （调百度 AI 搜索）
```

---

## 前置准备

1. 一个 Cloudflare 账号，域名已托管到 Cloudflare。
2. 百度 AI 搜索的 API Key（申请方法见 [`申请搜索Key.md`](申请搜索Key.md)）。
3. 本地已安装 `wrangler`（Cloudflare 命令行工具）：

   ```bash
   npm install -g wrangler
   wrangler login
   ```

---

## 第 1 步：配置 secret（密钥不进代码库）

在项目根目录执行：

```bash
wrangler secret put BAIDU_API_KEY
```

粘贴你的百度 key 后回车。key 会以「secret」形式存到 Cloudflare，代码里用 `env.BAIDU_API_KEY` 读取，**不会出现在 GitHub 仓库或部署日志里**。

---

## 第 2 步：确认 wrangler.toml

核心配置如下（以实际文件为准）：

```toml
name = "comp-dungeon"
main = "worker.js"

[assets]
directory = "./site"

[[routes]]
pattern = "comp.niry.cn"
custom_domain = true
```

要点：

- `[assets]` 指向 `./site`，由 Worker 托管前端静态页面。
- `[[routes]]` 用 `custom_domain = true` 把整个 Worker 绑定到 `comp.niry.cn`。

---

## 第 3 步：部署

```bash
wrangler deploy
```

部署成功后，wrangler 会自动为 `comp.niry.cn` 创建 DNS 记录和证书。

---

## 第 4 步：验证

```bash
# 首页
curl -I https://comp.niry.cn/

# 健康检查（应返回 {"ok":true,"configured":true}）
curl https://comp.niry.cn/api/health

# 搜索（应返回真实搜索结果）
curl -X POST https://comp.niry.cn/api/search \
  -H "Content-Type: application/json" \
  -d '{"query":"中国国际大学生创新大赛"}'
```

---

## 一个关键坑（务必记住）

**不要**用「`routes` + `assets`」的旧式组合部署。那样会出现：

- 静态页面能打开（HTTP 200）
- 但 `/api/*` 接口返回 **522**（Worker 代码没被路由到）

**正确做法**：用 `custom_domain` 绑定整个 Worker（见上面 wrangler.toml）。

另外，**不能在有手动 CNAME 记录的 hostname 上建 custom domain**（会报 `100117`）。如果之前手动加过 CNAME，要先删掉它，再让 wrangler 自动建 DNS。

---

## 常见问题

| 现象 | 原因 | 解决 |
|------|------|------|
| 首页 200 但 API 522 | 用了 routes+assets 旧组合 | 改用 custom_domain |
| 部署报 100117 | hostname 已有手动 CNAME | 删掉手动 CNAME 再部署 |
| key 不生效 | secret 没配或名字错 | 确认是 `BAIDU_API_KEY` |
| 搜索返回旧信息 | 走了预置库兜底 | 检查 `/api/health` 是否 `configured:true` |
