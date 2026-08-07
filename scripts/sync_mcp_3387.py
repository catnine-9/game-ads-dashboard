#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Sync 3387 single-game ad dashboard data from mailiang MCP.

Canonical data source:
- topic: fx_3387youxi_event
- reportType: ad
- NO dimensionFilters (state/platformType are topic constants; filters return 0 rows)
- date format: YYYYMMDD

Output:
- data.json at repository root
"""
from __future__ import annotations

import datetime as _dt
import json
import os
import re
import subprocess
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

MCP_URL = os.getenv("MAILIANG_MCP_URL", "https://demo.4399dev.com/mailiang-mcp/mcp")
BEIJING_TZ = _dt.timezone(_dt.timedelta(hours=8))
TOPIC = "fx_3387youxi_event"
REPORT_TYPE = "ad"
ROOT = Path(__file__).resolve().parents[1]
OUT_PATH = ROOT / "data.json"

# Safe 18 measures. Do not add tgActiveUserCountRate here: combining it with >=19
# measures causes ClickHouse/linkData join failure and returns 0 rows.
CORE_MEASURES = [
    "tgRealCost",
    "tgNewUserCount",
    "tgStartCount",
    "tgPayCountPrice",
    "tgRoi0",
    "tgMfRoi0",
    "tgPayCount",
    "tgPayAmount",
    "tgMfPayAmount",
    "tgPayRate",
    "tgRechargeTotalAmount0d",
    "tgMfRechargeTotalAmount0d",
    "tgMfLtv0",
    "tgMfLtv1",
    "tgMfLtv3",
    "tgMfLtv7",
    "tgLtv0",
    "tgArpu",
]

SLOT_MEASURES = ["tgNewUserCount", "tgRealCost", "tgStartCount", "tgPayCount"]
CHART_MEASURES = ["tgRealCost", "tgNewUserCount", "tgMfRoi0", "tgMfLtv0"]


def _curl_json(args: List[str], *, input_body: Optional[str] = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args,
        input=input_body,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )


def initialize_session() -> str:
    body = json.dumps(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "github-actions-3387-sync", "version": "1.0"},
            },
        },
        ensure_ascii=False,
    )
    proc = _curl_json(
        [
            "curl",
            "-sS",
            "-D",
            "-",
            "-o",
            os.devnull,
            "-X",
            "POST",
            MCP_URL,
            "-H",
            "Content-Type: application/json",
            "-H",
            "Accept: application/json, text/event-stream",
            "-d",
            body,
        ]
    )
    if proc.returncode != 0:
        raise RuntimeError(f"initialize curl failed: {proc.stderr}")
    m = re.search(r"(?im)^mcp-session-id:\s*(\S+)", proc.stdout)
    if not m:
        raise RuntimeError(f"initialize did not return Mcp-Session-Id. headers={proc.stdout[:500]!r}")
    session_id = m.group(1).strip()

    notify_body = json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"})
    # Some servers return 202/empty; ignore body but keep request.
    _curl_json(
        [
            "curl",
            "-sS",
            "-o",
            os.devnull,
            "-X",
            "POST",
            MCP_URL,
            "-H",
            "Content-Type: application/json",
            "-H",
            "Accept: application/json, text/event-stream",
            "-H",
            f"Mcp-Session-Id: {session_id}",
            "-d",
            notify_body,
        ]
    )
    return session_id


def call_query_report(session_id: str, arguments: Dict[str, Any]) -> List[Dict[str, Any]]:
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": "queryReport", "arguments": arguments},
    }
    proc = _curl_json(
        [
            "curl",
            "-sS",
            "-X",
            "POST",
            MCP_URL,
            "-H",
            "Content-Type: application/json",
            "-H",
            "Accept: application/json, text/event-stream",
            "-H",
            f"Mcp-Session-Id: {session_id}",
            "-d",
            json.dumps(payload, ensure_ascii=False),
        ]
    )
    if proc.returncode != 0:
        raise RuntimeError(f"queryReport curl failed: {proc.stderr}")
    raw = proc.stdout
    m = re.search(r"data:(\{.*\})", raw, re.DOTALL)
    if not m:
        raise RuntimeError(f"queryReport missing SSE data. raw={raw[:500]!r}")
    envelope = json.loads(m.group(1))
    if "error" in envelope:
        raise RuntimeError(f"queryReport error: {envelope['error']}")
    content = envelope["result"]["content"][0]["text"]
    parsed = json.loads(content)
    rows = parsed.get("rows", [])
    if rows is None:
        return []
    return rows


def parse_num(value: Any) -> Optional[float]:
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return float(value)
    s = str(value).strip().replace(",", "")
    if s.endswith("%"):
        s = s[:-1].strip()
        if s in ("", "NaN", "null", "None"):
            return None
        try:
            return float(s) / 100.0
        except ValueError:
            return None
    if s in ("", "NaN", "null", "None"):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def fmt_date(dt: _dt.datetime) -> str:
    return dt.strftime("%Y%m%d")


def beijing_now() -> _dt.datetime:
    return _dt.datetime.now(BEIJING_TZ)


def date_ranges(now: Optional[_dt.datetime] = None) -> Dict[str, Tuple[str, str]]:
    now = now or beijing_now()
    today = now
    return {
        "today": (fmt_date(today), fmt_date(today)),
        "last7d": (fmt_date(today - _dt.timedelta(days=6)), fmt_date(today)),
        "last30d": (fmt_date(today - _dt.timedelta(days=29)), fmt_date(today)),
    }


def aggregate_detail(rows: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    agg: Dict[str, Dict[str, float]] = defaultdict(lambda: defaultdict(float))
    for row in rows:
        game = str(row.get("gameName") or "").strip()
        if not game:
            continue
        item = agg[game]
        cost = parse_num(row.get("tgRealCost")) or 0.0
        new_user = parse_num(row.get("tgNewUserCount")) or 0.0
        for field in (
            "tgRealCost",
            "tgNewUserCount",
            "tgStartCount",
            "tgPayCount",
            "tgPayAmount",
            "tgMfPayAmount",
            "tgRechargeTotalAmount0d",
            "tgMfRechargeTotalAmount0d",
        ):
            item[field] += parse_num(row.get(field)) or 0.0
        for field in ("tgRoi0", "tgMfRoi0"):
            value = parse_num(row.get(field))
            if value is not None and cost:
                item[f"__{field}_weighted"] += value * cost
        for field in ("tgMfLtv0", "tgMfLtv1", "tgMfLtv3", "tgMfLtv7", "tgLtv0", "tgArpu"):
            value = parse_num(row.get(field))
            if value is not None and new_user:
                item[f"__{field}_weighted"] += value * new_user

    output: List[Dict[str, Any]] = []
    for game, item in agg.items():
        cost = item["tgRealCost"]
        new_user = item["tgNewUserCount"]
        out = {
            "gameName": game,
            "tgRealCost": round(cost, 2),
            "tgNewUserCount": round(new_user),
            "tgStartCount": round(item["tgStartCount"]),
            "tgPayCount": round(item["tgPayCount"]),
            "tgPayAmount": round(item["tgPayAmount"], 2),
            "tgMfPayAmount": round(item["tgMfPayAmount"], 2),
            "tgRechargeTotalAmount0d": round(item["tgRechargeTotalAmount0d"], 2),
            "tgMfRechargeTotalAmount0d": round(item["tgMfRechargeTotalAmount0d"], 2),
            "tgRechargeAmount0d": round(item["tgRechargeTotalAmount0d"], 2),
            "tgPayCountPrice": round(cost / new_user, 2) if new_user else 0,
            "tgPayRate": round(item["tgPayCount"] / new_user, 4) if new_user else 0,
        }
        if cost:
            out["tgRoi0"] = round(item["__tgRoi0_weighted"] / cost, 4)
            out["tgMfRoi0"] = round(item["__tgMfRoi0_weighted"] / cost, 4)
            out["tgRechargeAmountRate"] = round(item["tgRechargeTotalAmount0d"] / cost, 4)
        else:
            out["tgRoi0"] = 0
            out["tgMfRoi0"] = 0
            out["tgRechargeAmountRate"] = 0
        for field in ("tgMfLtv0", "tgMfLtv1", "tgMfLtv3", "tgMfLtv7", "tgLtv0", "tgArpu"):
            out[field] = round(item[f"__{field}_weighted"] / new_user, 4) if new_user else 0
        output.append(out)
    output.sort(key=lambda x: x.get("tgRealCost", 0), reverse=True)
    return output


def aggregate_slot(rows: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    agg: Dict[str, Dict[str, float]] = defaultdict(lambda: defaultdict(float))
    for row in rows:
        csite = str(row.get("csite") or "").strip()
        if not csite:
            continue
        item = agg[csite]
        for field in SLOT_MEASURES:
            item[field] += parse_num(row.get(field)) or 0.0
    output = []
    for csite, item in agg.items():
        output.append(
            {
                "csite": csite,
                "platform": "头条",
                "tgNewUserCount": round(item["tgNewUserCount"]),
                "tgRealCost": round(item["tgRealCost"], 2),
                "tgStartCount": round(item["tgStartCount"]),
                "tgPayCount": round(item["tgPayCount"]),
            }
        )
    output.sort(key=lambda x: x.get("tgNewUserCount", 0), reverse=True)
    return output


def normalize_chart(rows: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    output = []
    for row in rows:
        date_key = row.get("datekey") or row.get("dateKey") or row.get("date")
        if date_key is None:
            continue
        cost = parse_num(row.get("tgRealCost")) or 0.0
        new_user = parse_num(row.get("tgNewUserCount")) or 0.0
        output.append(
            {
                "dateKey": str(date_key),
                "tgRealCost": round(cost, 2),
                "tgNewUserCount": round(new_user),
                "tgMfRoi0": round(parse_num(row.get("tgMfRoi0")) or 0.0, 4),
                "tgMfLtv0": round(parse_num(row.get("tgMfLtv0")) or 0.0, 4),
            }
        )
    output.sort(key=lambda x: x["dateKey"])
    return output


def fetch_range(session_id: str, name: str, start: str, end: str) -> Dict[str, Any]:
    base = {"topic": TOPIC, "reportType": REPORT_TYPE, "dateStart": start, "dateEnd": end, "limit": 500}
    print(f"[{name}] {start}-{end}")
    detail_rows = call_query_report(
        session_id,
        {**base, "dimensions": ["gameName"], "measures": CORE_MEASURES},
    )
    slot_rows = call_query_report(
        session_id,
        {**base, "dimensions": ["csite"], "measures": SLOT_MEASURES},
    )
    chart_rows = call_query_report(
        session_id,
        {**base, "dimensions": [], "timeGranularity": "DAY", "measures": CHART_MEASURES},
    )
    result = {
        "detail": aggregate_detail(detail_rows),
        "slot": aggregate_slot(slot_rows),
        "chart": normalize_chart(chart_rows),
    }
    total_cost = sum(x.get("tgRealCost") or 0 for x in result["detail"])
    total_new = sum(x.get("tgNewUserCount") or 0 for x in result["detail"])
    print(
        f"  rows detail={len(detail_rows)} slot={len(slot_rows)} chart={len(chart_rows)} "
        f"=> games={len(result['detail'])} slots={len(result['slot'])} "
        f"cost={total_cost:.2f} new={total_new:.0f}"
    )
    return result


def build_data() -> Dict[str, Any]:
    session_id = initialize_session()
    now = beijing_now()
    ranges = {}
    for name, (start, end) in date_ranges(now).items():
        ranges[name] = fetch_range(session_id, name, start, end)
    return {
        "updatedAt": now.isoformat(timespec="seconds"),
        "source": "mailiang-mcp",
        "topic": TOPIC,
        "reportType": REPORT_TYPE,
        "syncMode": "github-actions-auto",
        "ranges": ranges,
    }


def main() -> int:
    data = build_data()
    OUT_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"written {OUT_PATH} ({OUT_PATH.stat().st_size} bytes)")
    today = data["ranges"]["today"]["detail"]
    total_cost = sum(x.get("tgRealCost") or 0 for x in today)
    total_new = sum(x.get("tgNewUserCount") or 0 for x in today)
    print(f"today: games={len(today)} cost={total_cost:.2f} new={total_new:.0f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
