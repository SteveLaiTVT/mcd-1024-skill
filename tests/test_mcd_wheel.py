from copy import deepcopy
from datetime import datetime
from pathlib import Path
import sys
import unittest
from zoneinfo import ZoneInfo

REPO = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(REPO / "src"), str(REPO / "scripts")]
from mcd_benefits import campaign_cutoffs, constrain_coupons, coupon_time_status, public_calendar
from mcd_wheel import PREPARE_TOOLS, budget_fen, prepare_wheel
from refresh_dataset import MCPError

NOW = datetime(2026, 10, 10, 12, tzinfo=ZoneInfo("Asia/Shanghai"))
CONTEXT = {"storeCode": "sample", "beType": 1, "orderType": 1}


class Client:
    def __init__(self, *, owned=True, base=3500, discounted=2500, calendar=None):
        self.calls, self.base, self.discounted = [], base, discounted
        self.owned = [{"id": "private-asset", "code": "private-rule", "enable": 1, "title": "套餐券"}] if owned else []
        self.store = [{"couponId": "private-asset", "couponCode": "private-rule", "title": "套餐券", "tradeDateTime": "2026-10-01 00:00:00 - 2026-10-31 23:59:59", "products": [{"productCode": "meal", "productName": "套餐"}]}] if owned else []
        self.calendar = calendar or {"dailyList": []}
        self.fail_calendar = self.fail_coupon = self.fail_baseline = False

    def call(self, name, arguments):
        self.calls.append((name, deepcopy(arguments)))
        if name == "now-time-info":
            data = {"datetime": "2026-10-10T12:00:00", "date": "2026-10-10"}
        elif name == "available-coupons":
            data = [{"couponName": "待领取餐券", "couponStatus": "CAN_GET", "label": "可领取"}]
        elif name == "query-my-coupons":
            data = {"coupons": self.owned, "currentPage": 1, "totalPages": 1, "totalCount": len(self.owned)}
        elif name == "query-store-coupons":
            data = self.store
        elif name == "campaign-calendar":
            if self.fail_calendar:
                raise MCPError("暂不可用")
            data = self.calendar
        elif name == "query-meals":
            data = {"meals": {"meal": {}}}
        elif name == "query-meal-detail":
            data = {"code": "meal", "name": "完整套餐", "rounds": [{"id": 1, "quantity": 1, "choices": [{"code": "main", "name": "主餐", "quantity": 1, "maxQuantity": 1, "isDefault": 1}]}]}
        elif name == "calculate-price":
            couponed = any("couponId" in i for i in arguments["items"])
            if (couponed and self.fail_coupon) or (not couponed and self.fail_baseline):
                raise MCPError("核价拒绝")
            data = {"price": self.discounted if couponed else self.base, "originalPrice": 4000, "discount": 1500 if couponed else 500, "enjoyed": {"amountType": "3", "realDiscount": 5}}
        else:
            raise AssertionError("不应调用 " + name)
        return {"data": data, "datetime": "2026-10-10 12:00:01"}


def templates(people=1):
    return {"mainProductCodes": ["main"], "recipes": [{"id": "test", "people": people, "portion": 7, "title": "测试餐", "wheelTitle": "测试", "wheelKind": "套餐", "ingredients": [{"productCode": "meal", "quantity": people}]}]}


class WheelTests(unittest.TestCase):
    def test_budget_is_applied_after_coupon_and_calendar_fetch(self):
        client = Client()
        report = prepare_wheel(client, templates(), CONTEXT, budget_per_person_fen=3000)
        self.assertEqual(report["status"], "ready")
        self.assertEqual(report["candidates"][0]["basePriceFen"], 3500)
        self.assertEqual(report["candidates"][0]["priceFen"], 2500)
        self.assertEqual(report["candidates"][0]["savingFen"], 1000)
        names = [n for n, _ in client.calls]
        self.assertLess(names.index("campaign-calendar"), names.index("calculate-price"))
        for private in ["private-asset", "private-rule", "couponId", "couponCode"]:
            self.assertNotIn(private, str(report))
        self.assertTrue(report["priceComparisonComplete"])

    def test_unclaimed_offer_and_automatic_discount_are_not_subtracted_again(self):
        client = Client(owned=False, base=1800)
        report = prepare_wheel(client, templates(), CONTEXT)
        plan = report["candidates"][0]
        self.assertEqual(plan["priceFen"], 1800)
        self.assertEqual(plan["savingFen"], 0)
        self.assertEqual(plan["couponNames"], [])
        self.assertEqual(plan["officialDiscountFen"], 500)
        self.assertEqual(sum(n == "calculate-price" for n, _ in client.calls), 1)

    def test_failed_coupon_and_truncated_search_do_not_claim_complete_minimum(self):
        client = Client(base=2800)
        client.fail_coupon = True
        report = prepare_wheel(client, templates(), CONTEXT)
        self.assertFalse(report["priceComparisonComplete"])
        self.assertEqual(report["candidates"][0]["priceLabel"], "最低已核验价")
        client = Client(base=2800)
        report = prepare_wheel(client, templates(), CONTEXT, variant_limit=1)
        self.assertFalse(report["priceComparisonComplete"])
        self.assertTrue(report["candidates"][0]["variantLimitReached"])

    def test_failed_baseline_never_uses_snapshot_and_history_is_main_only(self):
        client = Client(owned=False)
        client.fail_baseline = True
        report = prepare_wheel(client, templates(), CONTEXT)
        self.assertEqual(report["candidates"], [])
        self.assertEqual(report["counts"]["failedPlans"], 1)
        client = Client()
        report = prepare_wheel(client, templates(), CONTEXT, avoid_main_codes={"main"})
        self.assertEqual(report["candidates"], [])
        self.assertFalse(any(n == "calculate-price" for n, _ in client.calls))

    def test_group_is_still_ordinary_pickup_and_prepare_is_read_only(self):
        client = Client(owned=False, base=4000)
        report = prepare_wheel(client, templates(2), CONTEXT, people=2)
        self.assertEqual(report["request"]["totalBudgetFen"], 6000)
        self.assertEqual(report["benefits"][-1]["status"], "not-applicable")
        self.assertTrue({name for name, _ in client.calls} <= PREPARE_TOOLS)
        self.assertNotIn("auto-bind-coupons", PREPARE_TOOLS)
        self.assertNotIn("query-promotions", PREPARE_TOOLS)

    def test_calendar_failure_is_reported_as_incomplete(self):
        client = Client(owned=False, base=2000)
        client.fail_calendar = True
        report = prepare_wheel(client, templates(), CONTEXT)
        self.assertFalse(report["calendarQueryComplete"])
        self.assertFalse(report["priceComparisonComplete"])
        self.assertEqual(report["benefits"][-1]["kind"], "source-error")

    def test_article_zero_and_personal_subscription_are_not_price_or_public_data(self):
        calendar = {"subscribedEvents": [{"couponId": "private-asset"}], "dailyList": [{"date": "2026-10-10", "events": [{"eventType": 4, "activityTitle": "", "price": "0", "articleDto": {"title": "新品活动", "content": "内容不公开"}, "couponInfo": {"couponId": "private-asset"}}]}]}
        rows = public_calendar(calendar, NOW)
        self.assertEqual(rows[0]["name"], "新品活动")
        self.assertIsNone(rows[0]["priceDisplay"])
        self.assertEqual(rows[0]["priceUse"], "information-only-no-price-rule")
        self.assertNotIn("private-asset", str(rows))
        self.assertNotIn("内容不公开", str(rows))

    def test_weekday_time_window_and_quote_cutoff(self):
        info = {"couponCode": "rule", "tradeStartDate": "2026-10-01", "tradeEndDate": "2026-10-31", "weekdays": [7], "isAllTradeTime": 0, "tradeTimePeriods": [{"startTime": "11:00", "endTime": "12:01"}]}
        self.assertEqual(coupon_time_status(info, NOW), "valid")
        self.assertEqual(coupon_time_status({**info, "weekdays": [6]}, NOW), "outside")
        self.assertEqual(coupon_time_status({**info, "tradeTimePeriods": []}, NOW), "unknown")
        calendar = {"dailyList": [{"date": "2026-10-10", "events": [{"couponInfo": info}]}]}
        coupon = {"couponId": "asset", "couponCode": "rule", "name": "券"}
        self.assertEqual(campaign_cutoffs([coupon], calendar, NOW)[0].minute, 1)
        self.assertEqual(constrain_coupons([coupon], calendar, NOW)[0][0]["couponId"], "asset")
        wrong = deepcopy(calendar)
        wrong["dailyList"][0]["events"][0]["couponInfo"]["weekdays"] = [6]
        self.assertEqual(constrain_coupons([coupon], wrong, NOW)[0], [])

    def test_invalid_budget_and_inputs_fail_before_network(self):
        self.assertEqual(budget_fen("9.99"), 999)
        for value in ["NaN", "Infinity", "-1", "1.001", "bad"]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                budget_fen(value)
        client = Client()
        with self.assertRaises(ValueError):
            prepare_wheel(client, templates(), CONTEXT, people=True)
        self.assertEqual(client.calls, [])


if __name__ == "__main__":
    unittest.main()
