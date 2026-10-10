#!/usr/bin/env python3
"""离线校验数据集哈希、套餐份数、报价与模板的一致性。"""

import hashlib
import json
from pathlib import Path
import sys

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "src"))
from mcd_dataset import SNAPSHOT_FILES, make_manifest, require


def verify(data_dir: Path) -> dict:
    manifest = json.loads((data_dir / "manifest.json").read_text())
    recipe_bytes = (data_dir / "plan-recipes.json").read_bytes()
    documents = {name: json.loads((data_dir / name).read_text()) for name in SNAPSHOT_FILES}
    require(set(manifest["sha256"]) == {*SNAPSHOT_FILES, "plan-recipes.json"}, "数据清单文件集合不一致")
    for name, digest in manifest["sha256"].items():
        require(hashlib.sha256((data_dir / name).read_bytes()).hexdigest() == digest, "数据文件哈希不匹配：" + name)
    expected = make_manifest(documents, json.loads(recipe_bytes), recipe_bytes)
    require(manifest == expected, "数据清单与样本内容不一致")
    return manifest


if __name__ == "__main__":
    try:
        result = verify(REPO / "data")
    except (OSError, ValueError, KeyError) as error:
        print("数据集校验失败：" + str(error), file=sys.stderr)
        raise SystemExit(1)
    print("数据集校验通过：" + json.dumps(result["counts"], ensure_ascii=False))
