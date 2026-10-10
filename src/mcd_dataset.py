"""套餐样本生成与校验；只处理公开餐品信息和脱敏整单报价。"""

from __future__ import annotations

from collections import Counter
from copy import deepcopy
from decimal import Decimal
import hashlib
import json
from typing import Any

from mcd_text_parser import parse_table_text

SCHEMA_VERSION = 1
SNAPSHOT_FILES = ("menu.json", "packages.json", "nutrition.json", "tool-catalog.json", "meal-plans.json", "coupon-offers.json", "campaigns.json")


def json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode("utf-8")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def positive_integer(value: Any) -> bool:
    return type(value) is int and value > 0


def modifications(choice: dict) -> dict | None:
    result = []
    for group in choice.get("modification", {}).get("items", []):
        values = group.get("values", [])
        selected = [v for v in values if v.get("selectedQuantity", 0) > 0]
        require(len(selected) >= group.get("minValues", 0), "特调组选项不足")
        maximum = group.get("maxValues", -1)
        require(maximum < 0 or len(selected) <= maximum, "特调组选项超限")
        for value in values:
            quantity = value.get("selectedQuantity", 0)
            if quantity > 0 or "unselectedKey" in value:
                require(quantity <= 0 or positive_integer(quantity), "特调数量须为正整数")
                result.append({"code": value["code"], "key": value["selectedKey"] if quantity > 0 else value["unselectedKey"], "quantity": quantity if quantity > 0 else 1})
    return {"values": result} if result else None


def build_package(detail: dict, ingredient: dict) -> tuple[dict, list[dict]]:
    """子项数量是每份套餐的数量；展开内容时才乘套餐份数。"""
    quantity = ingredient["quantity"]
    require(positive_integer(quantity), "套餐份数须为正整数")
    require(detail["code"] == ingredient["productCode"], "套餐编码不一致")
    changes = ingredient.get("choices", {})
    rounds = detail.get("rounds", [])
    require(bool(rounds), "候选必须是具有子项的套餐")
    require(set(changes) <= {str(r["id"]) for r in rounds}, "指定了不存在的套餐轮次")
    round_list, parts = [], []
    for round_ in rounds:
        required = round_["quantity"]
        require(positive_integer(required), "套餐轮次数量无效")
        choices = round_["choices"]
        if str(round_["id"]) in changes:
            code = changes[str(round_["id"])]
            matching = [c for c in choices if c["code"] == code]
            require(len(matching) == 1, "替换子项不在本轮选项中")
            selected = [(matching[0], required)]
        else:
            # 多人套餐存在 quantity>0 且 isDefault=0 的已选子项。
            selected = [(c, c["quantity"]) for c in choices if c.get("quantity", 0) > 0]
            if not selected and required == 1:
                defaults = [c for c in choices if c.get("isDefault")]
                require(len(defaults) == 1, "无法确定默认套餐选项")
                selected = [(defaults[0], 1)]
        total = sum(q for _, q in selected)
        require(total == required, "套餐轮次子项数量与要求不一致")
        minimum, maximum = round_.get("minQuantity", required), round_.get("maxQuantity", required)
        require(total >= minimum and (maximum < 0 or total <= maximum), "套餐轮次数量超限")
        children = []
        for choice, child_quantity in selected:
            require(positive_integer(child_quantity), "套餐子项数量须为正整数")
            maximum = choice.get("maxQuantity", -1)
            require(maximum < 0 or child_quantity <= maximum, "套餐子项数量超限")
            child = {"code": choice["code"], "quantity": child_quantity}
            modification = modifications(choice)
            if modification:
                child["modification"] = modification
            children.append(child)
            parts.append({"code": choice["code"], "name": choice["name"], "quantity": child_quantity * quantity})
        round_list.append({"round": str(round_["id"]), "comboItemList": children})
    return {"productCode": detail["code"], "quantity": quantity, "roundList": round_list}, parts


def build_cart(recipe: dict, details: dict[str, dict], main_codes: set[str]) -> tuple[list[dict], list[dict], list[dict]]:
    require(recipe["people"] in [1, 2, 3, 4], "当前样本覆盖 1–4 人")
    require(recipe["portion"] in [5, 7, 9], "未知食量档位")
    items, packages, merged = [], [], {}
    for ingredient in recipe["ingredients"]:
        detail = details[ingredient["productCode"]]
        item, parts = build_package(detail, ingredient)
        items.append(item)
        packages.append({"productCode": detail["code"], "name": detail["name"], "quantity": ingredient["quantity"]})
        for part in parts:
            existing = merged.setdefault(part["code"], {**part, "quantity": 0})
            require(existing["name"] == part["name"], "同一子项编码出现不同名称")
            existing["quantity"] += part["quantity"]
    parts = list(merged.values())
    require(sum(p["quantity"] for p in parts if p["code"] in main_codes) >= recipe["people"], "主餐数量不足以覆盖人数")
    return items, packages, parts


def make_plan(recipe: dict, details: dict[str, dict], main_codes: set[str], quote: dict) -> dict:
    _, packages, parts = build_cart(recipe, details, main_codes)
    price = quote["data"]["price"]
    require(positive_integer(price), "报价必须是正整数分")
    require(isinstance(quote.get("datetime"), str) and bool(quote["datetime"]), "报价缺少时间")
    return {**{k: recipe[k] for k in ("id", "people", "portion", "title", "wheelTitle", "wheelKind")}, "packages": packages, "parts": parts, "mainCodes": [p["code"] for p in parts if p["code"] in main_codes], "priceFen": price, "quotedAt": quote["datetime"]}


def select_plans(plans: list[dict], *, people: int = 1, portion: int = 7, budget_per_person_fen: int = 3000, avoid_main_codes: set[str] | None = None) -> list[dict]:
    require(people in [1, 2, 3, 4], "人数须在 1–4 之间")
    require(portion in [5, 7, 9], "未知食量档位")
    require(type(budget_per_person_fen) is int and budget_per_person_fen >= 0, "人均预算须为非负整数分")
    avoid = avoid_main_codes or set()
    return [p for p in plans if p["people"] == people and p["portion"] == portion and p["priceFen"] <= people * budget_per_person_fen and not avoid.intersection(p["mainCodes"])]


def snapshot_documents(context: dict, captured_at: str, menu: dict, details: dict, nutrition_text: str, tools: list[dict], plans: list[dict]) -> dict[str, dict]:
    metadata = {"schemaVersion": SCHEMA_VERSION, "capturedAt": captured_at, "source": "https://mcp.mcd.cn"}
    meals = []
    for code, meal in menu["meals"].items():
        price = meal["currentPrice"]
        require(Decimal(str(price)).is_finite() and Decimal(str(price)) >= 0, "菜单展示价无效")
        meals.append({"productCode": code, "name": meal["name"], "menuPriceYuan": str(price)})
    rows = parse_table_text(nutrition_text)
    require(bool(rows) and not any("__warning__" in r for r in rows), "营养表条数与声明不一致")
    require(all(isinstance(r.get("productName"), str) and type(r.get("energyKcal")) in (int, float) for r in rows), "营养表缺少名称或能量值")
    counts = Counter(r["productName"] for r in rows)
    packages = [{"productCode": code, "name": d["name"], "rounds": deepcopy(d["rounds"])} for code, d in sorted(details.items())]
    # 白名单选取；menu.frequent、账户、订单、核价 URL/标识均不进入公开文件。
    return {
        "menu.json": {**metadata, "context": context, "categories": [{"name": c["name"], "products": [{"productCode": p["code"], "tags": p.get("tags", [])} for p in c["meals"]]} for c in menu["categories"]], "items": meals},
        "packages.json": {**metadata, "context": context, "packages": packages},
        "nutrition.json": {**metadata, "items": rows, "duplicateNames": [{"name": name, "count": count} for name, count in sorted(counts.items()) if count > 1]},
        "tool-catalog.json": {**metadata, "tools": [{k: t[k] for k in ("name", "description", "inputSchema", "outputSchema") if k in t} for t in tools]},
        "meal-plans.json": {**metadata, "kind": "official-whole-cart-quote-snapshot", "context": context, "amountUnit": "fen", "currency": "CNY", "plans": plans},
    }


def validate_plans(documents: dict[str, dict], templates: dict) -> None:
    require(templates["schemaVersion"] == SCHEMA_VERSION, "不支持的餐单模板版本")
    recipes = templates["recipes"]
    require(bool(recipes) and len({r["id"] for r in recipes}) == len(recipes), "餐单模板编号重复或为空")
    plans = documents["meal-plans.json"]["plans"]
    require(len(plans) == len(recipes) and {p["id"] for p in plans} == {r["id"] for r in recipes}, "核价餐单与模板不完整对应")
    details = {p["productCode"]: {"code": p["productCode"], "name": p["name"], "rounds": p["rounds"]} for p in documents["packages.json"]["packages"]}
    menu_codes = {m["productCode"] for m in documents["menu.json"]["items"]}
    require(set(details) <= menu_codes, "套餐不在当前门店菜单中")
    main_codes = set(templates["mainProductCodes"])
    by_id = {p["id"]: p for p in plans}
    for recipe in recipes:
        plan = by_id[recipe["id"]]
        expected = make_plan(recipe, details, main_codes, {"data": {"price": plan["priceFen"]}, "datetime": plan["quotedAt"]})
        require(plan == expected, "餐单展开结果与套餐结构或模板不一致")
    require({(p["people"], p["portion"]) for p in plans} == {(n, s) for n in [1, 2, 3, 4] for s in [5, 7, 9]}, "缺少人数或食量档位的核价样本")


def make_manifest(documents: dict[str, dict], templates: dict, recipe_bytes: bytes) -> dict:
    validate_plans(documents, templates)
    plans = documents["meal-plans.json"]["plans"]
    nutrition = documents["nutrition.json"]["items"]
    hashes = {name: hashlib.sha256(json_bytes(document)).hexdigest() for name, document in documents.items()}
    hashes["plan-recipes.json"] = hashlib.sha256(recipe_bytes).hexdigest()
    return {"schemaVersion": SCHEMA_VERSION, "datasetVersion": "1.2.0", "capturedAt": documents["meal-plans.json"]["capturedAt"], "couponOffersCapturedAt": documents["coupon-offers.json"]["capturedAt"], "campaignsCapturedAt": documents["campaigns.json"]["capturedAt"], "context": documents["meal-plans.json"]["context"], "defaults": templates["defaults"], "peopleCoverage": [1, 2, 3, 4], "portionValues": [5, 7, 9], "portionMeaning": "per-person preference; not a fullness guarantee", "budgetInput": "per-person", "quoteCouponMode": "no-explicit-coupon-id-or-code", "amountUnit": "fen", "currency": "CNY", "sourceKind": "official-read-and-whole-cart-quote-snapshot", "quoteTimeRange": {"from": min(p["quotedAt"] for p in plans), "to": max(p["quotedAt"] for p in plans), "timezone": "Asia/Shanghai"}, "counts": {"menuItems": len(documents["menu.json"]["items"]), "packages": len(documents["packages.json"]["packages"]), "nutritionRows": len(nutrition), "nutritionDistinctNames": len({r["productName"] for r in nutrition}), "tools": len(documents["tool-catalog.json"]["tools"]), "recipes": len(templates["recipes"]), "quotedPlans": len(plans), "couponDisplayOffers": len(documents["coupon-offers.json"]["offers"]), "campaignEntries": len(documents["campaigns.json"]["events"])}, "sha256": hashes}
