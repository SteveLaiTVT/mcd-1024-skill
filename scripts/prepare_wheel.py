#!/usr/bin/env python3
"""先获取优惠和活动，再为全部餐单核价，最后生成预算内转盘候选。"""

import argparse
import json
import os
from pathlib import Path
import sys
import tempfile

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "src"))
from mcd_dataset import SNAPSHOT_FILES, json_bytes, make_manifest, require
from mcd_wheel import PREPARE_TOOLS, budget_fen, prepare_wheel
from refresh_dataset import MCPClient, MCPError
from verify_dataset import verify


def prepare(request: dict) -> dict:
    manifest = verify(REPO / "data")
    templates = json.loads((REPO / "data/plan-recipes.json").read_text())
    # 所有输入在连接和核价前校验；不会触发任何领券、购卡或下单操作。
    people, portion = request.get("people", 1), request.get("portion", 7)
    require(type(people) is int and people in (1, 2, 3, 4), "人数须在 1–4 之间")
    require(type(portion) is int and portion in (5, 7, 9), "食量须为 5、7 或 9")
    amount = budget_fen(str(request.get("budgetPerPersonYuan", "30")))
    avoid = request.get("avoidMainCodes", [])
    require(isinstance(avoid, list) and len(avoid) <= 100 and all(isinstance(code, str) and len(code) <= 64 for code in avoid), "最近主食编码无效")
    require(bool(os.environ.get("MCD_TOKEN")), "缺少环境变量 MCD_TOKEN")
    client = MCPClient(os.environ["MCD_TOKEN"], allowed_tools=PREPARE_TOOLS)
    client.initialize()
    return prepare_wheel(client, templates, manifest["context"], people=people, portion=portion,
                         budget_per_person_fen=amount, avoid_main_codes=set(avoid))


def refresh_public_information(report: dict) -> None:
    require(report["calendarQueryComplete"], "活动查询未成功，保留原快照")
    data_dir = REPO / "data"
    verify(data_dir)
    recipe_bytes = (data_dir / "plan-recipes.json").read_bytes()
    documents = {name: json.loads((data_dir / name).read_text()) for name in SNAPSHOT_FILES if name not in ("coupon-offers.json", "campaigns.json")}
    meta = {"schemaVersion": 1, "capturedAt": report["checkedAt"], "source": "https://mcp.mcd.cn"}
    documents["coupon-offers.json"] = {**meta, "kind": "sanitized-account-targeted-offer-snapshot", "countMeaning": "distinct display offers; not claimable quantity", "offers": report["claimableOffers"]}
    documents["campaigns.json"] = {**meta, "kind": "sanitized-campaign-calendar-snapshot", "query": {"specifiedDate": report["checkedAt"][:10]}, "events": report["campaignEntries"]}
    manifest = make_manifest(documents, json.loads(recipe_bytes), recipe_bytes)
    with tempfile.TemporaryDirectory(prefix=".dataset-refresh-", dir=REPO) as temporary:
        staging = Path(temporary)
        for name in ("coupon-offers.json", "campaigns.json", "manifest.json"):
            (staging / name).write_bytes(json_bytes(manifest if name == "manifest.json" else documents[name]))
        for name in ("coupon-offers.json", "campaigns.json", "manifest.json"):
            os.replace(staging / name, data_dir / name)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--people", type=int, default=1)
    parser.add_argument("--portion", type=int, default=7)
    parser.add_argument("--budget-per-person", default="30")
    parser.add_argument("--avoid-main", action="append", default=[], help="要避开的主食编码，可重复传入")
    parser.add_argument("--save-report", action="store_true", help="将脱敏核价报告写入忽略提交的 data/local/prepared-wheel.json")
    parser.add_argument("--refresh-public", action="store_true", help="更新脱敏可领券和活动信息表，不保存个人资产")
    args = parser.parse_args()
    try:
        report = prepare({"people": args.people, "portion": args.portion, "budgetPerPersonYuan": args.budget_per_person, "avoidMainCodes": args.avoid_main})
        if args.refresh_public:
            refresh_public_information(report)
        if args.save_report:
            folder = REPO / "data/local"
            folder.mkdir(parents=True, exist_ok=True)
            (folder / "prepared-wheel.json").write_bytes(json_bytes(report))
    except (MCPError, ValueError, KeyError, TypeError, OSError) as error:
        message = str(error) if isinstance(error, (MCPError, ValueError)) else "实时数据结构或文件读写失败"
        print("转盘准备失败：" + message.replace(os.environ.get("MCD_TOKEN") or "[no-token]", "[redacted]"), file=sys.stderr)
        return 1
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
