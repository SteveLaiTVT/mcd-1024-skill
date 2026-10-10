"""转盘前的实时优惠准备：收集信息、整单比较、最后按预算入盘。"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from decimal import Decimal, InvalidOperation

from mcd_benefits import benefit_rows, campaign_cutoffs, constrain_coupons, public_calendar
from mcd_coupons import date_value, eligible_coupons, public_offers, quote_best, wallet
from mcd_dataset import build_cart, positive_integer, require

PREPARE_TOOLS = frozenset({"now-time-info", "available-coupons", "query-my-coupons", "query-store-coupons", "campaign-calendar", "query-meals", "query-meal-detail", "calculate-price"})


def budget_fen(value: str) -> int:
    try:
        amount = Decimal(value) * 100
    except (InvalidOperation, TypeError, ValueError):
        raise ValueError("人均预算不是有效金额") from None
    require(amount.is_finite() and amount >= 0 and amount == amount.to_integral_value(), "预算须为非负金额，最多两位小数")
    return int(amount)


def prepare_wheel(client, templates: dict, context: dict, *, people: int = 1, portion: int = 7,
                  budget_per_person_fen: int = 3000, avoid_main_codes: set[str] | None = None,
                  variant_limit: int = 64) -> dict:
    require(type(people) is int and people in (1, 2, 3, 4), "人数须在 1–4 之间")
    require(type(portion) is int and portion in (5, 7, 9), "食量须为 5、7 或 9")
    require(type(budget_per_person_fen) is int and budget_per_person_fen >= 0, "预算须为非负整数分")
    require(positive_integer(variant_limit), "核价方案上限须为正整数")
    require(context.get("beType") == 1 and context.get("orderType") == 1 and bool(context.get("storeCode")), "当前餐单引擎仅接入普通到店取餐")
    avoid = avoid_main_codes or set()
    require(isinstance(avoid, set) and all(isinstance(code, str) for code in avoid), "避开主食须为商品编码集合")
    recipes = [r for r in templates["recipes"] if r["people"] == people and r["portion"] == portion]
    require(bool(recipes), "此人数和食量没有餐单模板")
    common = {k: context[k] for k in ("storeCode", "orderType", "beType")}
    server_time = client.call("now-time-info", {})["data"]
    now = date_value(server_time["datetime"])
    offers = public_offers(client.call("available-coupons", {})["data"])
    owned, wallet_complete = wallet(client)
    store = client.call("query-store-coupons", common)["data"]
    usable, skipped = eligible_coupons(owned, store, now)
    calendar_error = False
    try:
        calendar = client.call("campaign-calendar", {"specifiedDate": now.date().isoformat()})["data"]
    except RuntimeError:
        calendar, calendar_error = {}, True
    usable, outside = constrain_coupons(usable, calendar, now)
    skipped.extend(outside)
    calendar_rows = public_calendar(calendar, now)
    information = benefit_rows(offers, owned, store, usable, skipped, calendar_rows, calendar_error=calendar_error)
    menu = client.call("query-meals", common)["data"]
    codes = sorted({i["productCode"] for r in recipes for i in r["ingredients"]})
    details, unavailable = {}, set()
    for code in codes:
        if code not in menu["meals"]:
            unavailable.add(code)
            continue
        try:
            details[code] = client.call("query-meal-detail", {**common, "code": code})["data"]
        except RuntimeError:
            unavailable.add(code)
    main_codes = set(templates["mainProductCodes"])
    ready, failed, excluded = [], [], []
    for recipe in recipes:
        if unavailable.intersection(i["productCode"] for i in recipe["ingredients"]):
            failed.append({"id": recipe["id"], "title": recipe["title"], "reason": "套餐当前不可售或详情查询失败"})
            continue
        try:
            items, packages, parts = build_cart(recipe, details, main_codes)
        except (KeyError, ValueError, TypeError):
            failed.append({"id": recipe["id"], "title": recipe["title"], "reason": "当前套餐结构与搭配不一致"})
            continue
        mains = [p["code"] for p in parts if p["code"] in main_codes]
        if avoid.intersection(mains):
            excluded.append({"id": recipe["id"], "title": recipe["title"], "reason": "包含需要避开的最近主食"})
            continue
        ready.append((recipe, items, packages, parts, mains))

    def price_candidate(candidate):
        recipe, items, packages, parts, mains = candidate
        try:
            priced = quote_best(client, common, items, usable, limit=variant_limit)
            require(bool(priced["quotedAt"]), "官方报价缺少时间")
            date_value(priced["quotedAt"])
            return {**{k: recipe[k] for k in ("id", "title", "people", "portion", "wheelTitle", "wheelKind")},
                    **priced, "packages": packages, "parts": parts, "mainCodes": mains,
                    "withinBudget": priced["priceFen"] <= people * budget_per_person_fen}
        except (RuntimeError, KeyError, ValueError, TypeError):
            return {"id": recipe["id"], "title": recipe["title"], "reason": "整单核价失败，本次不入盘"}

    # 价格比较可以并行，但只有完成全部报价后才生成转盘。
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(price_candidate, ready))
    quoted = sorted([r for r in results if "priceFen" in r], key=lambda r: (r["priceFen"], r["id"]))
    failed.extend(r for r in results if "priceFen" not in r)
    candidates = [r for r in quoted if r["withinBudget"]]
    complete = wallet_complete and not calendar_error and not failed and all(r["comparisonComplete"] for r in quoted)
    expires = min([now + timedelta(minutes=5)] + [date_value(r["quotedAt"]) + timedelta(minutes=5) for r in quoted] + [c["expiresAt"] for c in usable] + campaign_cutoffs(usable, calendar, now))
    for plan in quoted:
        plan["priceLabel"] = "候选范围内最低核价" if complete and plan["comparisonComplete"] else "最低已核验价"
    completed = date_value(client.call("now-time-info", {})["data"]["datetime"])
    return {"schemaVersion": 1, "source": "https://mcp.mcd.cn", "sourceKind": "official-live-pre-wheel-pricing",
            "checkedAt": now.isoformat(timespec="seconds"), "completedAt": completed.isoformat(timespec="seconds"),
            "expiresAt": expires.isoformat(timespec="seconds"), "validForSeconds": max(0, int((expires - completed).total_seconds())),
            "context": {k: context[k] for k in ("storeCode", "storeName", "orderType", "beType", "scope") if k in context},
            "request": {"people": people, "portion": portion, "budgetPerPersonFen": budget_per_person_fen,
                        "totalBudgetFen": people * budget_per_person_fen, "avoidMainCodes": sorted(avoid)},
            "status": "ready" if candidates else "empty" if quoted or excluded else "unavailable",
            "priceComparisonComplete": complete,
            "optimizationScope": "当前人数/食量模板与已核实持有且适用的券；自动优惠以官方核价为准；不含未领券、购卡或积分兑换",
            "minimumVerifiedPriceFen": min((p["priceFen"] for p in quoted), default=None),
            "counts": {"claimableDisplayOffers": len(offers), "ownedAssets": len(owned), "storeCoupons": len(store),
                       "validatedCoupons": len(usable), "campaignEntries": len(calendar_rows), "templatePlans": len(recipes),
                       "quotedPlans": len(quoted), "wheelCandidates": len(candidates), "failedPlans": len(failed)},
            "walletCoverageComplete": wallet_complete, "calendarQueryComplete": not calendar_error,
            "benefits": information, "quotedPlans": quoted, "candidates": candidates, "failedPlans": failed, "excludedPlans": excluded,
            "claimableOffers": offers, "campaignEntries": calendar_rows}
