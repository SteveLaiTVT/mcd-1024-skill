import json
from pathlib import Path
import sys
import unittest

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "src"))
sys.path.insert(0, str(REPO / "scripts"))
from mcd_dataset import build_package, modifications, select_plans
from refresh_dataset import MCPClient, MCPError, business_response, decode_response


class DatasetTests(unittest.TestCase):
    def test_share_meal_keeps_selected_nondefault_children(self):
        detail = {"code": "combo", "rounds": [{"id": 1, "quantity": 2, "minQuantity": 2, "maxQuantity": 2, "choices": [{"code": "fries", "name": "薯条", "quantity": 1, "maxQuantity": 1, "isDefault": 1}, {"code": "hashbrown", "name": "薯饼", "quantity": 1, "maxQuantity": 1, "isDefault": 0}]}]}
        item, parts = build_package(detail, {"productCode": "combo", "quantity": 2})
        self.assertEqual(item["quantity"], 2)
        self.assertEqual(item["roundList"][0]["comboItemList"], [{"code": "fries", "quantity": 1}, {"code": "hashbrown", "quantity": 1}])
        self.assertEqual([p["quantity"] for p in parts], [2, 2])

    def test_illegal_choice_and_quantity_are_rejected(self):
        detail = {"code": "combo", "rounds": [{"id": 1, "quantity": 2, "choices": [{"code": "main", "name": "汉堡", "quantity": 1, "maxQuantity": 1, "isDefault": 1}]}]}
        for ingredient in [{"productCode": "combo", "quantity": 0}, {"productCode": "combo", "quantity": 1}, {"productCode": "combo", "quantity": 1, "choices": {"1": "missing"}}, {"productCode": "combo", "quantity": 1, "choices": {"1": "main"}}]:
            with self.subTest(ingredient=ingredient), self.assertRaises(ValueError):
                build_package(detail, ingredient)

    def test_unselected_modification_is_explicit(self):
        choice = {"modification": {"items": [{"minValues": 1, "maxValues": 1, "values": [{"code": "cheese", "selectedQuantity": 0, "selectedKey": "1", "unselectedKey": "0"}, {"code": "bun", "selectedQuantity": 1, "selectedKey": "1", "unselectedKey": "0"}]}]}}
        self.assertEqual(modifications(choice), {"values": [{"code": "cheese", "key": "0", "quantity": 1}, {"code": "bun", "key": "1", "quantity": 1}]})

    def test_filter_uses_whole_cart_quote_and_all_main_codes(self):
        plans = [{"id": "single", "people": 1, "portion": 7, "priceFen": 2000, "mainCodes": ["chicken"]}, {"id": "pair", "people": 2, "portion": 7, "priceFen": 4990, "mainCodes": ["chicken", "fish"]}, {"id": "over", "people": 2, "portion": 7, "priceFen": 6001, "mainCodes": ["beef"]}]
        self.assertEqual([p["id"] for p in select_plans(plans, people=2, budget_per_person_fen=3000)], ["pair"])
        self.assertEqual(select_plans(plans, people=2, budget_per_person_fen=3000, avoid_main_codes={"fish"}), [])
        self.assertEqual(select_plans(plans, people=2, budget_per_person_fen=0), [])
        with self.assertRaises(ValueError):
            select_plans(plans, budget_per_person_fen=30.0)

    def test_structured_business_response_precedes_display_text(self):
        structured = {"success": True, "data": {"price": 4990}}
        self.assertEqual(business_response({"structuredContent": structured, "content": [{"type": "text", "text": "展示模板不是 JSON"}]}), structured)
        self.assertEqual(business_response({"content": [{"type": "text", "text": json.dumps(structured)}]}), structured)
        for result in [{"structuredContent": {"success": False}}, {"content": [{"type": "text", "text": "无法解析"}]}]:
            with self.assertRaises(MCPError):
                business_response(result)

    def test_streamable_http_json_and_multiline_sse(self):
        expected = {"jsonrpc": "2.0", "id": 1, "result": {"tools": []}}
        self.assertEqual(decode_response(json.dumps(expected)), expected)
        self.assertEqual(decode_response('event: message\ndata: {"jsonrpc":"2.0","id":1,\ndata: "result":{"tools":[]}}\n\n'), expected)
        with self.assertRaises(MCPError):
            decode_response("[]")

    def test_refresh_cannot_call_business_write_tools(self):
        client = MCPClient("test-placeholder")
        for tool in ["create-order", "auto-bind-coupons", "draw-lottery", "order-list"]:
            with self.subTest(tool=tool), self.assertRaises(ValueError):
                client.call(tool, {})


if __name__ == "__main__":
    unittest.main()
