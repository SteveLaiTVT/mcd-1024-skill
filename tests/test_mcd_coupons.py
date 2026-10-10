from datetime import datetime
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
import urllib.error
from zoneinfo import ZoneInfo

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "src"))
sys.path.insert(0, str(REPO / "scripts"))
from mcd_coupons import coupon_variants, eligible_coupons, public_offers, quote_best
from refresh_dataset import MCPClient, MCPError

NOW = datetime(2026, 10, 10, 12, tzinfo=ZoneInfo("Asia/Shanghai"))


class CouponTests(unittest.TestCase):
    def test_public_offer_deduplication_and_unknown_status(self):
        raw = [{"couponName": "免费薯饼", "couponStatus": "CAN_GET", "label": "可领取", "couponId": "private-id"}] * 3
        result = public_offers(raw)
        self.assertEqual(len(result), 1)
        self.assertTrue(result[0]["canClaim"])
        self.assertNotIn("couponId", result[0])
        self.assertIsNone(public_offers([{"couponName": "其他", "couponStatus": "NEW_STATUS", "label": "未知"}])[0]["canClaim"])

    def fixtures(self):
        owned = [{"id": "first", "code": "rule", "enable": 1}, {"id": "second", "code": "rule", "enable": 1}]
        store = [{"couponId": c["id"], "couponCode": c["code"], "title": "同名套餐券", "products": [{"productCode": "meal"}], "tradeDateTime": "2026-10-01 00:00:00 - 2026-10-31 23:59:59"} for c in owned]
        return owned, store

    def test_two_same_name_assets_remain_distinct(self):
        owned, store = self.fixtures()
        usable, skipped = eligible_coupons(owned, store + [store[0]], NOW)
        self.assertEqual(len(usable), 2)
        self.assertEqual(skipped, [])

    def test_wallet_store_and_expiry_are_required(self):
        owned, store = self.fixtures()
        self.assertEqual(eligible_coupons([], store, NOW)[0], [])
        self.assertEqual(eligible_coupons(owned, [], NOW)[0], [])
        owned[0]["enable"] = 0
        store[1]["tradeDateTime"] = "2026-01-01 00:00:00 - 2026-01-02 00:00:00"
        self.assertEqual(eligible_coupons(owned, store, NOW)[0], [])
        owned[0]["enable"] = 1
        store[0]["tradeDateTime"] = "不明确"
        self.assertEqual(eligible_coupons(owned, store, NOW)[0], [])

    def test_quantity_two_uses_two_distinct_coupons_at_most_once(self):
        owned, store = self.fixtures()
        usable, _ = eligible_coupons(owned, store, NOW)
        base = [{"productCode": "meal", "quantity": 2, "roundList": [{"round": "1", "comboItemList": [{"code": "burger", "quantity": 1}]}]}]
        variants, truncated = coupon_variants(base, usable)
        self.assertFalse(truncated)
        self.assertTrue(any(len([i for i in v if "couponId" in i]) == 2 for v in variants))
        for variant in variants:
            self.assertEqual(sum(i["quantity"] for i in variant), 2)
            ids = [i["couponId"] for i in variant if "couponId" in i]
            self.assertEqual(len(ids), len(set(ids)))
            self.assertTrue(all(i["quantity"] == 1 for i in variant if "couponId" in i))
            self.assertTrue(all(i["roundList"] == base[0]["roundList"] for i in variant))
        self.assertNotIn("couponId", base[0])
        self.assertTrue(coupon_variants(base, usable, limit=2)[1])

    def test_coupon_mapping_is_exact_and_unclaimed_offer_is_not_an_asset(self):
        base = [{"productCode": "meal", "quantity": 1}]
        coupon = {"couponId": "owned", "couponCode": "code", "name": "名字像同款", "productCodes": {"different-meal"}, "expiresAt": NOW}
        self.assertEqual(coupon_variants(base, [coupon])[0], [base])
        self.assertEqual(eligible_coupons([], [{"couponId": "unclaimed", "title": "可领取"}], NOW)[0], [])

    def test_failed_or_no_savings_coupon_keeps_baseline_and_free_quote_is_valid(self):
        base = [{"productCode": "meal", "quantity": 1}]
        coupon = {"couponId": "asset", "couponCode": "code", "name": "券", "productCodes": {"meal"}, "expiresAt": NOW}
        class Client:
            outcome = 0
            def call(self, name, arguments):
                couponed = any("couponId" in i for i in arguments["items"])
                if couponed and self.outcome == "fail":
                    raise MCPError("不适用")
                return {"data": {"price": self.outcome if couponed else 2290}, "datetime": "2026-10-10 12:00:00"}
        client = Client()
        result = quote_best(client, {}, base, [coupon])
        self.assertEqual(result["priceFen"], 0)
        self.assertEqual(result["savingFen"], 2290)
        self.assertNotIn("couponId", str(result))
        for outcome in ["fail", 2290, 3000]:
            client.outcome = outcome
            result = quote_best(client, {}, base, [coupon])
            self.assertEqual(result["priceFen"], 2290)
            self.assertEqual(result["couponNames"], [])

    def test_claim_request_is_not_retried_on_network_failure(self):
        client = MCPClient("placeholder", allowed_tools={"auto-bind-coupons"})
        with patch("refresh_dataset.urllib.request.build_opener") as opener:
            opener.return_value.open.side_effect = urllib.error.URLError("timeout")
            with self.assertRaises(MCPError):
                client.call("auto-bind-coupons", {})
            self.assertEqual(opener.return_value.open.call_count, 1)


if __name__ == "__main__":
    unittest.main()
