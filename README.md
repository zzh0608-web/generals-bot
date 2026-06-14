# Generals.io Stats Worker

一个无需登录的 Cloudflare Worker 网站，用来查询 generals.io 玩家统计、胜率、交手记录和最近活跃高星玩家。

## 本地运行

```bash
npm install
npm run dev
```

打开 Wrangler 输出的本地地址，通常是：

```text
http://127.0.0.1:8787
```

## 部署到 Cloudflare

```bash
npm install
npx wrangler login
npm run deploy
```

部署完成后，Wrangler 会输出一个 `workers.dev` 地址。你也可以在 Cloudflare Dashboard 里给这个 Worker 绑定自己的域名。

## API

```text
GET /api/health
GET /api/profile?username=EklipZ
GET /api/today?username=EklipZ&hours=24
GET /api/winrate?username=EklipZ&mode=duel&days=30
GET /api/winrate?username=EklipZ&mode=ffa&days=30
GET /api/duel?p1=EklipZ&p2=bot&days=90
GET /api/recent?mode=duel&minutes=60&limit=10
GET /api/recent?mode=ffa&minutes=60&limit=10
GET /api/recent?mode=bigteam&minutes=120&limit=20
```

## 免费版 Worker 限制

Cloudflare Workers 免费版单次请求外部 subrequest 数较低。这个项目默认把最近榜限制在：

- 最近 replay 页数：8 页
- 当前星数补查候选：36 人
- 并发请求：最多 4-5 个一批

如果你使用付费 Worker，可以在 `wrangler.toml` 里提高这些变量：

```toml
[vars]
PLAYER_MAX_PAGES = "18"
RECENT_MAX_PAGES = "24"
RECENT_PROFILE_LIMIT = "200"
PAGE_BATCH_SIZE = "6"
PROFILE_BATCH_SIZE = "6"
```

## 说明

- 数据来自 generals.io public API。
- 最近活跃榜按当前 profile 星数排序，不使用 replay 里保存的旧星数排序。
- `/api/recent` 为了控制 Worker 成本，只补查最近活跃的一部分玩家；如果候选太多，响应里会包含提示。
