/* 4399 BI 数据同步脚本 —— 由 GitHub Actions 每 10 分钟运行一次（或本地手动运行）
 * 读取环境变量 COOKIE（BI 登录 cookie），调用 mailiang.4399dev.com 真实接口，
 * 生成 data.json 快照供前端读取。
 *
 * 2026-07-31 修复：reportChannel/customId=594 报表已在 BI 下线（EMPTY_DETAIL），
 * 改用 reportLinkChannel + dimensionId=34（游戏维度）+ customId=287（已验证有效）。
 * 返回字段为 t* 前缀，统一映射为前端使用的 tg* 字段。
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
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      'Cookie': COOKIE,
      'Origin': 'https://mailiang.4399dev.com',
      'Referer': 'https://mailiang.4399dev.com/mailiang/report/basic/linkPromote?orgId=42',
    },
    body: JSON.stringify(body),
  });
  if (res.status === 429) throw new Error('RATE_LIMITED');
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + path);
  const json = await res.json();
  if (json.code !== 1) throw new Error(json.msg || ('code=' + json.code + ' ' + path));
  return json.data;
}

// 游戏维度报表参数（dimensionId=34 = 游戏维度；customId=287 = 3387游戏平台报表）
const COMMON = {
  userType: 1,
  dimensionId: 34,
  customId: 287,
  dateType: 6,
  isCompare: false,
  deptList: ['社区市场部'],
  tableType: 1,
};

/* t* -> tg* 字段映射（BI 报表字段 -> 前端字段） */
const FIELD_MAP = {
  tgRealCost: 'tOriginAmount',           // 消耗
  tgNewUserCount: 'tNewUser',            // 新增
  tgPayCount: 'tRechargeCount',          // 付费人数
  tgPayAmount: 'tRecharge',              // 付费金额
  tgRechargeTotalAmount0d: 'tRrechargeTotalAmount0d', // 首日R（厂商流水）
  tgNewUserPayCount: 'tNewUserRechargeCount', // 首日付费人数
  tgLtv0: 'tLtv0d',                      // 首日LTV
  tgaArppu0: 'tArppu0d',                 // 首日ARPPU
  tgArpu: 'tArpu',                       // ARPU
  tgPayRate: 'tRecharge0dRate',          // 付费率
  tgClickRate: 'tClickRate',             // 点击率
  tgActiveConvertRate: 'tActivationRat', // 激活率
  tgRoi0: 'tRoi0d',                      // 首日ROI（单游戏）
  tgRoi: 'tRoi',                         // ROI
  tgOriginPrice: 'tPrice',               // 单价
  tgStartPrice: 'tPrice',                // 启动单价
  tgRechargeConvertRate: 'tRechargeRate', // 转化率
  tgMfRoi0: 'tRoi0d',                    // 厂商流水ROI（近似整体ROI）
  tgMfLtv0: 'tLtv0d',                    // 厂商流水LTV
  tgMfRechargeConvertRate: 'tRecharge0dRate',
  tgMfRechargeTotalAmount0d: 'tRrechargeTotalAmount0d',
  tgMfPayAmount: 'tRecharge',
  tgMfPayCount: 'tRechargeCount',
  tgMfNewUserPayCount: 'tNewUserRechargeCount',
  tgActiveUserCountRate: 'tActivationRat',
  tgStartCount: 'tRegister',             // 启动数 ≈ 注册数
  tgRetention1: 'tStartGameRate',        // 次留率（近似，BI 无直接字段时用启动率占位）
};

function toGameFormat(row) {
  const out = { dateKey: row.dateKey || '', gameName: row.gameName || '' };
  // gameId：dimensionId=34 无 gameId，用 gameName 作为稳定 id（前端字符串匹配）
  out.gameId = row.gameName || '';
  for (const [tg, t] of Object.entries(FIELD_MAP)) {
    out[tg] = row[t] !== undefined ? row[t] : null;
  }
  return out;
}

// 分日 chart：chartData 单指标更稳定，逐指标拉取再合并
async function fetchChart(startDate, endDate) {
  const fields = ['tOriginAmount', 'tRrechargeTotalAmount0d', 'tNewUser'];
  const merged = {};
  for (const f of fields) {
    let got = null;
    for (let i = 0; i < 4; i++) {
      try {
        got = await post('/reportLinkChannel/chartData', {
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
  // 映射为前端 chart 字段
  return Object.values(merged).sort((a, b) => String(a.dateKey).localeCompare(String(b.dateKey)))
    .map(row => ({
      dateKey: row.dateKey,
      tgRealCost: row.tOriginAmount,
      tgRechargeTotalAmount0d: row.tRrechargeTotalAmount0d,
      tgNewUserCount: row.tNewUser,
    }));
}

async function fetchRange(startDate, endDate) {
  let detail = null;
  let detailErr = null;
  for (let i = 0; i < 4; i++) {
    try {
      detail = await post('/reportLinkChannel/detailData', {
        ...COMMON,
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
  return { detail: detailList.map(toGameFormat), chart };
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
  const cleanRange = (r) => ({
    detail: (r.detail || []).map(cleanRow),
    chart: (r.chart || []).map(cleanRow),
  });
  out.ranges = Object.fromEntries(Object.entries(out.ranges).map(([k, r]) => [k, cleanRange(r)]));
  fs.writeFileSync('data.json', JSON.stringify(out, null, 1));
  console.log('=> data.json written (' + fs.statSync('data.json').size + ' bytes)');
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
