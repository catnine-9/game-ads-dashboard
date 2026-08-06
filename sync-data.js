/* 4399 BI 数据同步脚本 —— 由 GitHub Actions 每 10 分钟运行一次（或本地手动运行）
 * 读取环境变量 COOKIE（BI 登录 cookie），调用 mailiang.4399dev.com 真实接口，
 * 生成 data.json 快照供前端读取。
 *
 * 2026-07-31 修复：数据源 = mailiang/report/basic/promote?orgId=43 报表
 *  - 接口: reportChannel/detailData + customId=594 + dimension=gameName
 *  - 关键: 请求 header 必须带 orgId: 43（缺这个返回空数据 EMPTY_DETAIL）
 *  - 返回字段原生为 tg* 前缀，与前端一致，无需映射
 * Node 18+ 运行，无第三方依赖。
 */
const fs = require('fs');
const BASE = 'https://mailiang.4399dev.com/user-growth';
const COOKIE = process.env.COOKIE || '';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/plain, */*',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      'Cookie': COOKIE,
      'orgId': '43',
      'Origin': 'https://mailiang.4399dev.com',
      'Referer': 'https://mailiang.4399dev.com/mailiang/report/basic/promote?orgId=43',
    },
    body: JSON.stringify(body),
  });
  if (res.status === 429) throw new Error('RATE_LIMITED');
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + path);
  const json = await res.json();
  if (json.code !== 1) throw new Error(json.msg || ('code=' + json.code + ' ' + path));
  return json.data;
}

// promote?orgId=43 报表参数
const COMMON = {
  customId: 594,
  dateType: 6,
  isCompare: false,
  channelTypeList: ['付费渠道'],
  deptList: ['社区市场部'],
};

// 分日 chart：chartData 单指标更稳定，逐指标拉取再合并
async function fetchChart(startDate, endDate) {
  const fields = ['tgRealCost', 'tgRechargeTotalAmount0d', 'tgNewUserCount', 'tgMfRoi0'];
  const merged = {};
  for (const f of fields) {
    let got = null;
    for (let i = 0; i < 4; i++) {
      try {
        got = await post('/reportChannel/chartData', {
          ...COMMON, dimension: 'dateKey',
          startDate, endDate,
          summaryType: 3,
          indicatorFields: [f],
        });
        break;
      } catch (e) {
        if (e.message === 'RATE_LIMITED' && i < 3) { await sleep(12000 * (i + 1)); continue; }
        if (i === 3) console.error('chart ' + f + ' failed: ' + e.message);
      }
    }
    if (got) {
      got.forEach(row => {
        const k = row.dateKey;
        if (!merged[k]) merged[k] = { dateKey: k };
        merged[k][f] = row[f];
      });
    }
    await sleep(1500);
  }
  return Object.values(merged).sort((a, b) => String(a.dateKey).localeCompare(String(b.dateKey)));
}

/* 把 BI 原始行转为统一格式：dateKey/gameName 保留；其他字段原样；
   注：csite 行没有 gameName，用空串填充 */
function toGameFormat(row) {
  return Object.assign({
    dateKey: row.dateKey || '',
    gameName: row.gameName || '',
    gameId: row.gameId || (row.gameName || '')  // csite 行无 gameId，用 gameName 占位
  }, row);
}

async function fetchSlot(startDate, endDate) {
  // 流量版位维度（platform 头条/快手/广点通等渠道）—— 单独请求，BI 的 csite 维度无明细
  let slot = null, slotErr = null;
  for (let i = 0; i < 4; i++) {
    try {
      slot = await post('/reportChannel/detailData', {
        ...COMMON, dimension: 'platform',
        startDate, endDate,
        pageNum: 1, pageSize: 100,
      });
      break;
    } catch (e) {
      slotErr = e;
      console.error('slot ' + startDate + ' retry ' + i + ' failed: ' + e.message);
      if (e.message === 'RATE_LIMITED' && i < 3) { await sleep(12000 * (i + 1)); continue; }
      if (i === 3) console.error('slot ' + startDate + ' all retries failed');
    }
  }
  const list = (slot && slot.list) || [];
  console.log('  slot ' + startDate + ' fetched ' + list.length + ' rows');
  return list.map(toGameFormat);
}

async function fetchRange(startDate, endDate) {
  let detail = null;
  let detailErr = null;
  for (let i = 0; i < 4; i++) {
    try {
      detail = await post('/reportChannel/detailData', {
        ...COMMON, dimension: 'gameName',
        startDate, endDate,
        pageNum: 1, pageSize: 100,
      });
      break;
    } catch (e) {
      detailErr = e;
      if (e.message === 'RATE_LIMITED' && i < 3) { await sleep(12000 * (i + 1)); continue; }
      if (i === 3) console.error('detail ' + startDate + ' failed: ' + e.message);
    }
  }
  // detail 必须有 list 才算成功
  const detailList = (detail && detail.list) || [];
  if (detailList.length === 0) {
    throw new Error(detailErr ? detailErr.message : 'EMPTY_DETAIL');
  }
  const chart = await fetchChart(startDate, endDate);
  const slot = await fetchSlot(startDate, endDate);
  return { detail: detailList.map(toGameFormat), chart, slot };
}

async function main() {
  const today = new Date();
  const y = today.getFullYear();
  const m = String(today.getMonth() + 1).padStart(2, '0');
  const d = String(today.getDate()).padStart(2, '0');
  const todayStr = `${y}-${m}-${d}`;
  const fmt = dt => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  const d7Start = fmt(new Date(today.getTime() - 6 * 86400000));
  const d30Start = fmt(new Date(today.getTime() - 29 * 86400000));

  const out = { updatedAt: new Date().toISOString(), ranges: {} };
  const ranges = {
    today:  [todayStr, todayStr],
    last7d: [d7Start, todayStr],
    last30d: [d30Start, todayStr],
  };
  let okCount = 0;
  for (const [k, [s, e]] of Object.entries(ranges)) {
    try {
      out.ranges[k] = await fetchRange(s, e);
      const hasData = (out.ranges[k].detail.length > 0) || (out.ranges[k].chart.length > 0);
      if (hasData) okCount++;
      console.log((hasData ? 'OK  ' : 'EMPTY'), k, s, '~', e, '| detail:', out.ranges[k].detail.length, 'games | chart:', out.ranges[k].chart.length, 'days');
    } catch (err) {
      console.error('FAIL', k, err.message);
    }
    await sleep(2500);
  }
  if (okCount === 0) {
    // 全部失败/空：保留旧数据，避免覆盖成空文件
    console.error('ALL_RANGES_EMPTY — 保留旧 data.json（可能接口限流或登录态过期）');
    process.exit(0);
  }
  /* 清洗：BI 对无数据游戏返回字符串 "NaN"，统一转为 null，前端显示 — */
  const cleanRow = (row) => {
    const out = {};
    for (const [k, v] of Object.entries(row)) {
      if (v === 'NaN' || v === 'Infinity' || v === '-Infinity' || (typeof v === 'number' && isNaN(v))) {
        out[k] = null;
      } else {
        out[k] = v;
      }
    }
    return out;
  };
  /* 补全缺失字段：BI 不返回厂商流水金额字段（tgMfPayAmount/tgMfPayCount/tgMfNewUserPayCount），前端不需要金额字段故不再反算 */
  const fillMissing = (row) => {
    return row; // 保留原样，KPI 改用 BI 原值（tgMfRoi0, tgMfLtv0）
  };
  const cleanRange = (r) => ({
    detail: (r.detail || []).map(row => fillMissing(cleanRow(row))),
    chart: (r.chart || []).map(row => fillMissing(cleanRow(row))),
    slot: (r.slot || []).map(row => fillMissing(cleanRow(row))),
  });
  out.ranges = Object.fromEntries(Object.entries(out.ranges).map(([k, r]) => [k, cleanRange(r)]));
  fs.writeFileSync('data.json', JSON.stringify(out, null, 1));
  console.log('=> data.json written (' + fs.statSync('data.json').size + ' bytes)');
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
