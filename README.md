# 游戏投放数据看板

> 基于 4399 买量平台 BI（mailiang.4399dev.com）真实数据，按游戏维度汇总，支持日期/游戏筛选实时刷新。

## 数据流

```
BI 服务器 ──► GitHub Actions (每 10 分钟) ──► data.json ──► GitHub Pages ──► 前端自动加载
                                                       ▲
                                              setInterval(10min)
```

- **服务端同步**：`.github/workflows/sync-data.yml` 每 10 分钟运行 `sync-data.js`，用 `COOKIE_SECRET` 调 BI 接口
- **数据快照**：脚本输出 `data.json`（含今日 / 最近 7 日 / 最近 30 日三个范围的 gameName 维度 + dateKey 维度）
- **前端读取**：页面每 10 分钟 `fetch('./data.json')` 重新渲染（`setInterval`），同源无 CORS
- **失败兜底**：全部 range 失败时保留旧 data.json 不覆盖，cookie 过期时页面回退到原有数据不空白

## 部署步骤

### 一次性：导入仓库并启用 Pages
1. 把仓库 `catnine-9/game-ads-dashboard` 设为 **Public**（Pages 免费版要求）
2. Settings → Pages → Source 选 `main` 分支 / `/` 根目录 → Save
3. 等待首次部署（约 1 分钟），访问 `https://catnine-9.github.io/game-ads-dashboard/`

### 一次性：设置 BI cookie 为 Secret
1. 重新登录 BI 让 cookie 有效
2. 从浏览器 DevTools → Application → Cookies 复制 mailiang.4399dev.com + .4399dev.com 下的全部 cookie
3. 用 `gh` CLI 或 API 设置 secret：
   ```bash
   gh secret set COOKIE_SECRET --repo catnine-9/game-ads-dashboard --body "zentaosid=xxx; e_token=xxx; ..."
   ```

### 触发首次同步
- 进入 Actions → sync-bi-data → Run workflow

## cookie 过期处理

`e_token` 是 JWT（一般 2-4 小时过期），过期后 Actions 会失败。重新登录后：
1. 浏览器导出新 cookie
2. 更新 repo 的 `COOKIE_SECRET`
3. 手动触发 workflow 跑一次立即同步

## 本地调试

```bash
cd 项目目录
COOKIE="..." node sync-data.js   # 生成 data.json
python -m http.server 8000        # 起静态服务
# 访问 http://127.0.0.1:8000/game-ads-dashboard.html
```