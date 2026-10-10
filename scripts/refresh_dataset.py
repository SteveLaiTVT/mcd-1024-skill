#!/usr/bin/env python3
"""从官方 MCP 刷新公开套餐样本；无下单、账户、订单和领券调用。"""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
import itertools
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import urllib.error
import urllib.request
from zoneinfo import ZoneInfo

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "src"))
from mcd_dataset import build_cart, json_bytes, make_manifest, make_plan, require, snapshot_documents

ENDPOINT = "https://mcp.mcd.cn"
READ_QUOTE_TOOLS = {"now-time-info", "query-nearby-stores", "query-meals", "query-meal-detail", "list-nutrition-foods", "calculate-price", "available-coupons", "campaign-calendar"}


class MCPError(RuntimeError):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        raise MCPError("官方 MCP 返回重定向，未转发认证信息")


def decode_response(raw: str) -> dict:
    try:
        decoded = json.loads(raw)
        if not isinstance(decoded, dict):
            raise MCPError("MCP 响应不是对象")
        return decoded
    except json.JSONDecodeError:
        events, current = [], []
        for line in raw.splitlines() + [""]:
            if line.startswith("data:"):
                current.append(line[5:].lstrip())
            elif not line and current:
                events.append("\n".join(current))
                current = []
        for event in events:
            try:
                result = json.loads(event)
            except json.JSONDecodeError:
                continue
            if isinstance(result, dict) and ("result" in result or "error" in result):
                return result
    raise MCPError("MCP 响应无法解析")


def business_response(result: dict) -> dict:
    body = result.get("structuredContent")
    if body is None:
        text = "\n".join(c.get("text", "") for c in result.get("content", []) if c.get("type") == "text")
        try:
            body = json.loads(text)
        except json.JSONDecodeError:
            raise MCPError("响应缺少结构化业务数据") from None
    success = isinstance(body, dict) and (body.get("success") is True or ("success" not in body and body.get("code") == 200))
    if not success:
        raise MCPError("业务请求未成功；保留已有数据集")
    return body


class MCPClient:
    def __init__(self, token: str, *, allowed_tools: set[str] | None = None):
        self.headers = {"Authorization": "Bearer " + token, "Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
        self.ids = itertools.count(1)
        self.allowed_tools = frozenset(allowed_tools if allowed_tools is not None else READ_QUOTE_TOOLS)

    def rpc(self, method: str, params: dict, *, notification: bool = False, retry_safe: bool = True) -> dict:
        payload = {"jsonrpc": "2.0", "method": method, "params": params}
        if not notification:
            payload["id"] = next(self.ids)
        request = urllib.request.Request(ENDPOINT, data=json.dumps(payload).encode(), headers=self.headers)
        attempts = 3 if retry_safe else 1
        for attempt in range(attempts):
            try:
                with urllib.request.build_opener(NoRedirect()).open(request, timeout=25) as response:
                    session = response.headers.get("Mcp-Session-Id")
                    if session:
                        self.headers["Mcp-Session-Id"] = session
                    raw = response.read().decode()
                break
            except urllib.error.HTTPError as error:
                if error.code not in {429, 502, 503, 504} or attempt == attempts - 1:
                    raise MCPError(f"官方 MCP 返回 HTTP {error.code}") from None
            except (urllib.error.URLError, TimeoutError) as error:
                if attempt == attempts - 1:
                    reason = type(getattr(error, "reason", error)).__name__
                    raise MCPError(f"无法连接官方 MCP（{reason}），已尝试 {attempts} 次") from None
            time.sleep(attempt + 1)
        if notification and not raw.strip():
            return {}
        decoded = decode_response(raw)
        if decoded.get("error"):
            raise MCPError("MCP 协议请求未成功")
        return decoded.get("result", {})

    def initialize(self) -> None:
        result = self.rpc("initialize", {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "mcd-meal-wheel-dataset", "version": "1.0.0"}})
        require(isinstance(result.get("protocolVersion"), str), "初始化缺少协议版本")
        self.headers["MCP-Protocol-Version"] = result["protocolVersion"]
        self.rpc("notifications/initialized", {}, notification=True)

    def call(self, name: str, arguments: dict) -> dict:
        require(name in self.allowed_tools, "客户端未授权调用该工具")
        result = self.rpc("tools/call", {"name": name, "arguments": arguments}, retry_safe=name != "auto-bind-coupons")
        if result.get("isError"):
            raise MCPError(f"{name} 调用失败；保留已有数据集")
        return business_response(result)


def refresh(args: argparse.Namespace) -> dict:
    data_dir = REPO / "data"
    recipe_path = data_dir / "plan-recipes.json"
    recipe_bytes = recipe_path.read_bytes()
    templates = json.loads(recipe_bytes)
    sample = templates["sampleStore"]
    client = MCPClient(os.environ["MCD_TOKEN"])
    client.initialize()
    tools = client.rpc("tools/list", {}).get("tools", [])
    require(READ_QUOTE_TOOLS <= {t["name"] for t in tools}, "官方工具目录缺少数据刷新所需工具")
    stores = client.call("query-nearby-stores", {"beType": 1, "searchType": 2, "city": args.city or sample["city"], "keyword": args.keyword or sample["keyword"]})["data"]
    store_code = args.store_code or sample["storeCode"]
    matching = [s for s in stores if s["storeCode"] == store_code]
    require(len(matching) == 1, "指定样本门店未出现在检索结果中，请调整城市或关键词")
    context = {"storeCode": store_code, "storeName": matching[0]["storeName"], "orderType": 1, "beType": 1, "timezone": "Asia/Shanghai", "scope": "explicit sample store; not user location"}
    common = {k: context[k] for k in ("storeCode", "orderType", "beType")}
    menu = client.call("query-meals", common)["data"]
    nutrition = client.call("list-nutrition-foods", {})["data"]
    offer_body = client.call("available-coupons", {})
    from mcd_benefits import public_calendar
    from mcd_coupons import date_value
    activity_now = date_value(client.call("now-time-info", {})["data"]["datetime"])
    activity_calendar = client.call("campaign-calendar", {"specifiedDate": activity_now.date().isoformat()})["data"]
    codes = sorted({i["productCode"] for r in templates["recipes"] for i in r["ingredients"]})
    require(set(codes) <= set(menu["meals"]), "部分套餐已不在当前门店菜单中；请先更新餐单模板")
    print(f"已读取 {len(menu['meals'])} 项菜单与 {len(tools)} 个工具定义，继续获取 {len(codes)} 套套餐结构。", flush=True)
    with ThreadPoolExecutor(max_workers=2) as pool:
        details = dict(pool.map(lambda code: (code, client.call("query-meal-detail", {**common, "code": code})["data"]), codes))
    main_codes = set(templates["mainProductCodes"])
    # 先检查全部搭配合法，再发起任何报价请求。
    carts = {r["id"]: build_cart(r, details, main_codes)[0] for r in templates["recipes"]}

    def quote(recipe: dict) -> dict:
        body = client.call("calculate-price", {**common, "items": carts[recipe["id"]]})
        return make_plan(recipe, details, main_codes, body)

    plans = []
    with ThreadPoolExecutor(max_workers=2) as pool:
        for plan in pool.map(quote, templates["recipes"]):
            plans.append(plan)
            if len(plans) % 10 == 0:
                print(f"整单核价完成 {len(plans)}/{len(templates['recipes'])}。", flush=True)
    captured_at = datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(timespec="seconds")
    documents = snapshot_documents(context, captured_at, menu, details, nutrition, tools, plans)
    from mcd_coupons import public_offers
    documents["coupon-offers.json"] = {"schemaVersion": 1, "capturedAt": captured_at, "source": ENDPOINT, "kind": "sanitized-account-targeted-offer-snapshot", "countMeaning": "distinct display offers; not claimable quantity", "offers": public_offers(offer_body["data"])}
    documents["campaigns.json"] = {"schemaVersion": 1, "capturedAt": activity_now.isoformat(timespec="seconds"), "source": ENDPOINT,
                                  "query": {"specifiedDate": activity_now.date().isoformat()}, "kind": "sanitized-campaign-calendar-snapshot",
                                  "events": public_calendar(activity_calendar, activity_now)}
    manifest = make_manifest(documents, templates, recipe_bytes)
    require(recipe_path.read_bytes() == recipe_bytes, "刷新期间模板已改变，请重新刷新")
    # 任一请求或校验失败均不写入；完整生成后替换文件，manifest 最后写入。
    with tempfile.TemporaryDirectory(prefix=".dataset-refresh-", dir=REPO) as temporary:
        staging = Path(temporary)
        for name, document in {**documents, "manifest.json": manifest}.items():
            (staging / name).write_bytes(json_bytes(document))
        for name in [*documents, "manifest.json"]:
            os.replace(staging / name, data_dir / name)
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--store-code", help="显式指定样本门店编码")
    parser.add_argument("--city", help="检索城市，默认使用样本模板中的城市")
    parser.add_argument("--keyword", help="门店检索关键词")
    args = parser.parse_args()
    if not os.environ.get("MCD_TOKEN"):
        print("缺少环境变量 MCD_TOKEN；未修改数据集。", file=sys.stderr)
        return 1
    try:
        manifest = refresh(args)
    except (MCPError, ValueError, KeyError, TypeError, OSError) as error:
        # 不输出响应、请求头或异常对象中的个人数据。
        message = str(error) if isinstance(error, (MCPError, ValueError)) else "数据结构或文件读写失败"
        token = os.environ.get("MCD_TOKEN", "")
        print("刷新失败：" + message.replace(token, "[redacted]") if token else "刷新失败", file=sys.stderr)
        return 1
    print(json.dumps({"capturedAt": manifest["capturedAt"], "counts": manifest["counts"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
