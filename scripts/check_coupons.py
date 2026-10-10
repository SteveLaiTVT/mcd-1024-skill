#!/usr/bin/env python3
"""查看可领/持有/门店券，可按套餐核价。--claim-all 才会一键领取全部可领券。"""

import argparse
from datetime import datetime
from decimal import Decimal, InvalidOperation
import json
import os
from pathlib import Path
import sys
import tempfile
from zoneinfo import ZoneInfo

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "src"))
from mcd_coupons import eligible_coupons, public_offers, quote_best, wallet
from mcd_dataset import SNAPSHOT_FILES, build_cart, json_bytes, make_manifest, require
from refresh_dataset import MCPClient, MCPError
from verify_dataset import verify

READ_TOOLS = {"available-coupons", "query-my-coupons", "query-store-coupons", "query-meal-detail", "calculate-price"}


def refresh_public_offers(offers: list[dict], captured_at: str) -> None:
    data_dir = REPO / "data"
    recipe_bytes = (data_dir / "plan-recipes.json").read_bytes()
    documents = {name: json.loads((data_dir / name).read_text()) for name in SNAPSHOT_FILES if name != "coupon-offers.json"}
    documents["coupon-offers.json"] = {"schemaVersion": 1, "capturedAt": captured_at, "source": "https://mcp.mcd.cn", "kind": "sanitized-account-targeted-offer-snapshot", "countMeaning": "distinct display offers; not claimable quantity", "offers": offers}
    manifest = make_manifest(documents, json.loads(recipe_bytes), recipe_bytes)
    with tempfile.TemporaryDirectory(prefix=".dataset-refresh-", dir=REPO) as temporary:
        staging = Path(temporary)
        for name, document in [("coupon-offers.json", documents["coupon-offers.json"]), ("manifest.json", manifest)]:
            (staging / name).write_bytes(json_bytes(document))
            os.replace(staging / name, data_dir / name)


def check(args) -> dict:
    manifest = verify(REPO / "data")
    try:
        budget_fen = Decimal(args.budget_per_person) * 100
    except InvalidOperation:
        raise ValueError("人均预算不是有效金额") from None
    require(budget_fen.is_finite() and budget_fen >= 0 and budget_fen == budget_fen.to_integral_value(), "人均预算须为非负金额，最多两位小数")
    templates = json.loads((REPO / "data/plan-recipes.json").read_text())
    recipes = [r for r in templates["recipes"] if r["id"] == args.plan_id] if args.plan_id else []
    if args.plan_id:
        require(len(recipes) == 1, "找不到指定餐单模板")
    context = manifest["context"]
    common = {k: context[k] for k in ("storeCode", "orderType", "beType")}
    allowed = READ_TOOLS | ({"auto-bind-coupons"} if args.claim_all else set())
    client = MCPClient(os.environ["MCD_TOKEN"], allowed_tools=allowed)
    client.initialize()
    claim_result = None
    if args.claim_all:
        try:
            data = client.call("auto-bind-coupons", {})["data"]
            claim_result = {"status": "returned", "successCount": data.get("successCount"), "failedCount": data.get("failedCount")}
        except MCPError:
            # 领券请求不自动重试；返回不明确时，以后续券包与门店查询为准。
            claim_result = {"status": "unknown", "message": "领取结果不明确；已重新查询券包与门店，不自动重试领取"}
    offered_body = client.call("available-coupons", {})
    offers = public_offers(offered_body["data"])
    owned, complete = wallet(client)
    store = client.call("query-store-coupons", common)["data"]
    now = datetime.now(ZoneInfo("Asia/Shanghai"))
    usable, skipped = eligible_coupons(owned, store, now)
    report = {"checkedAt": now.isoformat(timespec="seconds"), "offers": offers, "ownedCount": len(owned), "walletCoverageComplete": complete, "storeCouponCount": len(store), "validatedCouponCount": len(usable), "skippedCoupons": skipped}
    if claim_result:
        report["claimResult"] = claim_result
    if args.plan_id:
        recipe = recipes[0]
        codes = {i["productCode"] for i in recipe["ingredients"]}
        details = {code: client.call("query-meal-detail", {**common, "code": code})["data"] for code in codes}
        items, packages, parts = build_cart(recipe, details, set(templates["mainProductCodes"]))
        result = quote_best(client, common, items, usable)
        result.update({"planId": recipe["id"], "people": recipe["people"], "portion": recipe["portion"], "packages": packages, "parts": parts, "totalBudgetFen": int(budget_fen) * recipe["people"], "withinBudget": result["priceFen"] <= int(budget_fen) * recipe["people"]})
        report["quote"] = result
    if args.refresh_offers:
        refresh_public_offers(offers, now.isoformat(timespec="seconds"))
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan-id", help="要实时核价的餐单模板编号")
    parser.add_argument("--budget-per-person", default="30", help="人均预算，单位元，默认 30")
    parser.add_argument("--refresh-offers", action="store_true", help="更新公开券展示样本，不保存个人券编号")
    parser.add_argument("--claim-all", action="store_true", help="明确要求一键领取全部当前可领券，领取后重新查询并核价")
    args = parser.parse_args()
    if not os.environ.get("MCD_TOKEN"):
        print("缺少环境变量 MCD_TOKEN。", file=sys.stderr)
        return 1
    try:
        report = check(args)
    except (MCPError, ValueError, KeyError, TypeError, OSError) as error:
        message = str(error) if isinstance(error, (MCPError, ValueError)) else "券数据结构或文件读写失败"
        print("优惠券检查失败：" + message.replace(os.environ["MCD_TOKEN"], "[redacted]"), file=sys.stderr)
        return 1
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
