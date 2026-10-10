"""优惠和活动的信息表。展示规则与可成交价分开，删除个人券和订阅标识。"""

from __future__ import annotations

from datetime import datetime, time, timedelta

from mcd_coupons import TIMEZONE, date_value

EVENT_TYPES = {0: "活动", 1: "神秘活动", 2: "活动券", 3: "品鉴会", 4: "活动文章", 5: "麦麦省", 6: "派对"}
REASONS = {
    "not-verified-in-wallet": "未核实持有", "wallet-disabled-or-unknown": "券未启用",
    "coupon-code-mismatch-or-missing": "券码未匹配", "outside-valid-window": "不在有效期",
    "no-explicit-product-mapping": "缺少适用商品", "unknown-valid-window": "有效期未确认",
    "outside-campaign-window": "不在活动用券时段", "unknown-campaign-window": "活动时段未确认",
}


def time_condition(info: dict) -> str:
    pieces = []
    if info.get("tradeStartDate") and info.get("tradeEndDate"):
        pieces.append(str(info["tradeStartDate"]) + " 至 " + str(info["tradeEndDate"]))
    days = {1: "周日", 2: "周一", 3: "周二", 4: "周三", 5: "周四", 6: "周五", 7: "周六"}
    if info.get("weekdays"):
        pieces.append(" / ".join(days.get(day, "星期待确认") for day in info["weekdays"]))
    if info.get("isAllTradeTime") == 1:
        pieces.append("全天")
    elif info.get("tradeTimePeriods"):
        pieces.append(" / ".join(str(p.get("startTime", "?")) + "–" + str(p.get("endTime", "?")) for p in info["tradeTimePeriods"]))
    return "；".join(pieces) or "有效期与可用时段待确认"


def coupon_time_status(info: dict, now: datetime) -> str:
    """日历周日=1；券日期、星期、时段都通过才可用，未给全条件则不推定。"""
    try:
        start = date_value(info.get("tradeStartDate"))
        end = date_value(info.get("tradeEndDate"), end=True)
        if not start <= now <= end:
            return "outside"
        weekdays = info.get("weekdays")
        if weekdays is not None:
            if not isinstance(weekdays, list) or any(type(day) is not int or not 1 <= day <= 7 for day in weekdays):
                return "unknown"
            if weekdays and (now.isoweekday() % 7) + 1 not in weekdays:
                return "outside"
        if info.get("isAllTradeTime") == 1:
            return "valid"
        if info.get("isAllTradeTime") != 0 or not info.get("tradeTimePeriods"):
            return "unknown"
        clock = now.astimezone(TIMEZONE).time().replace(tzinfo=None)
        for period in info["tradeTimePeriods"]:
            lower, upper = time.fromisoformat(period["startTime"]), time.fromisoformat(period["endTime"])
            if (lower <= clock <= upper if lower <= upper else clock >= lower or clock <= upper):
                return "valid"
        return "outside"
    except (ValueError, TypeError, KeyError):
        return "unknown"


def constrain_coupons(coupons: list[dict], calendar: dict, now: datetime) -> tuple[list[dict], list[dict]]:
    """只关联官方券编号/规则码；活动里的券信息不能替代用户持有证明。"""
    rules = []
    for day in calendar.get("dailyList", []):
        rules.extend(e["couponInfo"] for e in day.get("events", []) if e.get("couponInfo"))
    result, skipped = [], []
    for coupon in coupons:
        matching = [r for r in rules if (r.get("couponId") and r["couponId"] == coupon["couponId"]) or (r.get("couponCode") and r["couponCode"] == coupon["couponCode"])]
        statuses = [coupon_time_status(r, now) for r in matching]
        if statuses and "valid" not in statuses:
            reason = "outside-campaign-window" if "outside" in statuses else "unknown-campaign-window"
            skipped.append({"name": coupon["name"], "reason": reason})
        else:
            result.append({**coupon, "conditionTexts": sorted({time_condition(r) for r in matching})} if matching else coupon)
    return result, skipped


def campaign_cutoffs(coupons: list[dict], calendar: dict, now: datetime) -> list[datetime]:
    """报价不能跨过已验证券的日历时段结束，即使五分钟缓存尚未到期。"""
    ends = []
    for coupon in coupons:
        windows = [e["couponInfo"] for d in calendar.get("dailyList", []) for e in d.get("events", [])
                   if e.get("couponInfo") and ((e["couponInfo"].get("couponId") == coupon["couponId"]) or (e["couponInfo"].get("couponCode") == coupon["couponCode"]))]
        valid_ends = []
        for info in windows:
            if coupon_time_status(info, now) != "valid":
                continue
            end = date_value(info["tradeEndDate"], end=True)
            if info.get("isAllTradeTime") == 0:
                active_ends = []
                for period in info["tradeTimePeriods"]:
                    lower, upper = time.fromisoformat(period["startTime"]), time.fromisoformat(period["endTime"])
                    start = datetime.combine(now.date(), lower, TIMEZONE)
                    finish = datetime.combine(now.date(), upper, TIMEZONE)
                    if lower > upper:
                        if now.time().replace(tzinfo=None) >= lower:
                            finish += timedelta(days=1)
                        else:
                            start -= timedelta(days=1)
                    if start <= now <= finish:
                        active_ends.append(finish)
                end = min(end, max(active_ends))
            valid_ends.append(end)
        if valid_ends:
            ends.append(max(valid_ends))
    return ends


def public_calendar(calendar: dict, now: datetime) -> list[dict]:
    """文章价格字段可能为 0；文章从不输出成交价，也不保存文章内容/订阅。"""
    rows, seen = [], set()
    today = now.astimezone(TIMEZONE).date().isoformat()
    for day in calendar.get("dailyList", []):
        date = day.get("date", "")
        for event in day.get("events", []):
            kind = event.get("eventType")
            title = event.get("activityTitle") or event.get("articleDto", {}).get("title") or "活动详情待公布"
            subtitle = event.get("activitySubTitle") or ""
            key = (date, title, subtitle, kind)
            if key in seen:
                continue
            seen.add(key)
            info = event.get("couponInfo") or {}
            window = {k: info[k] for k in ("tradeStartDate", "tradeEndDate", "isAllTradeTime", "weekdays", "tradeTimePeriods") if k in info}
            rows.append({"kind": "campaign", "name": title.strip(), "subtitle": subtitle,
                         "eventType": kind, "eventTypeName": EVENT_TYPES.get(kind, "活动"), "date": date,
                         "status": "today" if date == today else "upcoming" if date > today else "past",
                         "timeWindow": window, "timeStatus": coupon_time_status(info, now) if info else "unknown",
                         "condition": time_condition(info) if info else "活动信息入口；未提供门店或商品折扣规则",
                         "scope": "门店、渠道和适用商品待确认",
                         "priceDisplay": str(event["price"]) if kind in (2, 5) and event.get("price") is not None else None,
                         "priceUse": "display-only-requires-wallet-store-validation-and-quote" if kind in (2, 5) else "information-only-no-price-rule"})
    return rows


def benefit_rows(offers: list[dict], owned: list[dict], store: list[dict], usable: list[dict], skipped: list[dict], calendar_rows: list[dict], *, calendar_error: bool = False) -> list[dict]:
    rows = [{"kind": "claimable-coupon", "name": o["name"], "status": "claimable" if o["canClaim"] else "unknown",
             "scope": "领取后查询当前门店适用商品", "condition": "尚未验证持有；有效期、时段和叠加条件待确认",
             "priceUse": "not-in-price", "priceDisplay": None} for o in offers]
    verified = {c["couponId"]: c for c in usable}
    by_id = {c.get("couponId"): c for c in store}
    reasons = {s["name"]: REASONS.get(s["reason"], "适用性未确认") for s in skipped}
    grouped = {}
    for asset in owned:
        coupon = by_id.get(asset.get("id"), {})
        name = coupon.get("title") or asset.get("title") or "持有券"
        products = [{"productCode": p["productCode"], "name": p.get("productName", p["productCode"])} for p in coupon.get("products", []) if p.get("productCode")]
        status = "eligible" if asset.get("id") in verified else "unavailable"
        period = coupon.get("tradeDateTime") or asset.get("datetimeText") or "有效期未确认"
        condition = period if status == "eligible" else reasons.get(name, "当前门店/取餐方式未返回可用券")
        if status == "eligible" and verified[asset["id"]].get("conditionTexts"):
            condition += "；" + "；".join(verified[asset["id"]]["conditionTexts"])
        key = (name, status, str(products), condition)
        if key in grouped:
            grouped[key]["assetCount"] += 1
        else:
            row = {"kind": "owned-coupon", "name": name, "status": status,
                   "scope": "、".join(p["name"] for p in products) or "当前场景适用范围未确认",
                   "products": products, "condition": condition, "assetCount": 1,
                   "priceUse": "official-quote-required" if status == "eligible" else "not-in-price", "priceDisplay": None}
            grouped[key] = row
            rows.append(row)
    rows.extend(calendar_rows)
    rows.append({"kind": "promotion-source", "name": "企业团餐满减 / 满折", "status": "not-applicable",
                 "scope": "企业团餐外送", "condition": "当前为普通到店取餐；多人用餐也不自动变为企业团餐",
                 "priceUse": "not-in-price", "priceDisplay": None})
    if calendar_error:
        rows.append({"kind": "source-error", "name": "活动日历", "status": "unknown", "scope": "暂未查询成功",
                     "condition": "活动信息未查全，本次只能展示已核验报价", "priceUse": "not-in-price", "priceDisplay": None})
    return rows
