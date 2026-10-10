"""可领取券展示、个人持券匹配与整单核价；券标识仅在内存中使用。"""

from __future__ import annotations

from copy import deepcopy
from datetime import datetime, time
import json
from zoneinfo import ZoneInfo

from mcd_dataset import positive_integer, require

TIMEZONE = ZoneInfo("Asia/Shanghai")


def wallet(client) -> tuple[list[dict], bool]:
    """分页读取个人资产；覆盖不完整时不能宣称已找到全部券的最低价。"""
    assets, complete = {}, False
    for page in range(1, 6):
        data = client.call("query-my-coupons", {"page": str(page), "pageSize": "200"})["data"]
        require(data["currentPage"] == page, "券包返回页码与请求不一致")
        for coupon in data["coupons"]:
            require(bool(coupon.get("id")), "持有券缺少资产编号")
            assets[coupon["id"]] = coupon
        if page >= data["totalPages"]:
            complete = len(assets) >= data["totalCount"]
            break
    return list(assets.values()), complete


def public_offers(raw: list[dict]) -> list[dict]:
    """展示去重不等于可领张数；同名个人资产不能使用这个函数去重。"""
    result, seen = [], set()
    for offer in raw:
        name, status, label = offer["couponName"], offer["couponStatus"], offer["label"]
        key = (name, status, label)
        if key in seen:
            continue
        seen.add(key)
        result.append({"name": name, "status": status, "label": label, "canClaim": True if status == "CAN_GET" else None, "priceUse": "requires-claim-store-validation-and-live-quote"})
    return result


def date_value(value: str, *, end: bool = False) -> datetime:
    require(isinstance(value, str) and bool(value), "券有效期缺失")
    text = value.strip().replace("/", "-")
    date = datetime.fromisoformat(text)
    if len(text) == 10:
        date = datetime.combine(date.date(), time(23, 59, 59) if end else time.min)
    return date.replace(tzinfo=TIMEZONE) if date.tzinfo is None else date.astimezone(TIMEZONE)


def eligible_coupons(owned: list[dict], store_coupons: list[dict], now: datetime) -> tuple[list[dict], list[dict]]:
    """持有、门店、状态与时间同时校验；不从优惠名称猜适用商品。"""
    require(now.tzinfo is not None, "券时间判断须带时区")
    assets = {c["id"]: c for c in owned if c.get("id")}
    eligible, skipped, seen = [], [], set()
    for coupon in store_coupons:
        asset_id = coupon.get("couponId")
        if asset_id in seen:
            continue
        seen.add(asset_id)
        name = coupon.get("title", "优惠券")
        asset = assets.get(asset_id)
        reason = None
        if not asset:
            reason = "not-verified-in-wallet"
        elif asset.get("enable") != 1:
            reason = "wallet-disabled-or-unknown"
        elif not coupon.get("couponCode") or (asset.get("code") and asset["code"] != coupon["couponCode"]):
            reason = "coupon-code-mismatch-or-missing"
        else:
            try:
                period = coupon.get("tradeDateTime", "").split(" - ")
                if len(period) == 2:
                    start, end = date_value(period[0]), date_value(period[1], end=True)
                else:
                    start, end = date_value(asset.get("tradeStartDate")), date_value(asset.get("tradeEndDate"), end=True)
                if not start <= now <= end:
                    reason = "outside-valid-window"
                products = {p["productCode"] for p in coupon.get("products", []) if p.get("productCode")}
                if not products:
                    reason = "no-explicit-product-mapping"
            except (ValueError, TypeError):
                reason = "unknown-valid-window"
        if reason:
            skipped.append({"name": name, "reason": reason})
        else:
            eligible.append({"couponId": asset_id, "couponCode": coupon["couponCode"], "name": name, "productCodes": products, "expiresAt": end})
    return eligible, skipped


def coupon_variants(items: list[dict], coupons: list[dict], *, limit: int = 16) -> tuple[list[list[dict]], bool]:
    """按券资产逐张分配；数量>1 的套餐拆出一份用券，不重复使用同一资产。"""
    require(positive_integer(limit), "核价候选上限须为正整数")
    require(all(positive_integer(i.get("quantity")) and "couponId" not in i and "couponCode" not in i for i in items), "基础餐单必须是未绑定券的合法套餐")
    variants = [deepcopy(items)]
    signatures = {json.dumps(items, sort_keys=True)}
    truncated = False
    unique = {c["couponId"]: c for c in coupons}
    for coupon in sorted(unique.values(), key=lambda c: c["expiresAt"]):
        additions = []
        for cart in variants:
            for index, item in enumerate(cart):
                if "couponId" in item or item["productCode"] not in coupon["productCodes"]:
                    continue
                candidate = deepcopy(cart)
                target = candidate[index]
                if target["quantity"] > 1:
                    leftover = deepcopy(target)
                    leftover["quantity"] -= 1
                    candidate.insert(index + 1, leftover)
                target.update({"quantity": 1, "couponId": coupon["couponId"], "couponCode": coupon["couponCode"]})
                signature = json.dumps(candidate, sort_keys=True)
                if signature in signatures:
                    continue
                if len(variants) + len(additions) >= limit:
                    truncated = True
                    continue
                signatures.add(signature)
                additions.append(candidate)
        variants.extend(additions)
    return variants, truncated


def quote_best(client, common: dict, items: list[dict], coupons: list[dict], *, limit: int = 16) -> dict:
    """用官方核价比较，不把名称中的价格或未领取优惠当成可成交价。"""
    variants, truncated = coupon_variants(items, coupons, limit=limit)
    baseline = client.call("calculate-price", {**common, "items": variants[0]})
    require(type(baseline["data"].get("price")) is int and baseline["data"]["price"] >= 0, "基础报价无效")
    base_price = baseline["data"]["price"]
    best, best_cart = baseline, variants[0]
    successes = failures = 0
    for cart in variants[1:]:
        try:
            quoted = client.call("calculate-price", {**common, "items": cart})
            require(type(quoted["data"].get("price")) is int and quoted["data"]["price"] >= 0, "券报价无效")
        except (RuntimeError, ValueError, KeyError):
            failures += 1
            continue
        successes += 1
        if quoted["data"]["price"] < best["data"]["price"]:
            best, best_cart = quoted, cart
    names = {c["couponId"]: c["name"] for c in coupons}
    price = best["data"]["price"]
    original = best["data"].get("originalPrice")
    discount = best["data"].get("discount")
    enjoyed = best["data"].get("enjoyed") or {}
    return {"basePriceFen": base_price, "priceFen": price, "savingFen": base_price - price,
            "originalPriceFen": original if type(original) is int and original >= price else None,
            "officialDiscountFen": discount if type(discount) is int and discount >= 0 else None,
            "appliedBenefit": {k: enjoyed[k] for k in ("amountType", "realDiscount", "balance") if k in enjoyed},
            "couponNames": [names[i["couponId"]] for i in best_cart if "couponId" in i], "quotedAt": best.get("datetime"),
            "successfulCouponQuotes": successes, "failedCouponQuotes": failures, "variantLimitReached": truncated,
            "comparisonComplete": not truncated and failures == 0, "source": "official-live-whole-cart-quote"}
