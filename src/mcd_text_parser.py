#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
麦当劳 MCP 文本表格响应解析器
================================

背景
----
麦当劳 MCP 的部分接口（如 ``list-nutrition-foods``）不返回 JSON，
而是返回一段**自描述的类 CSV 文本**：

    [160]{productName,nutritionDescription,energyKj,energyKcal,protein,carbohydrate,sodium,calcium}:
      猪柳麦满分,null,1288,308,16,16,24,781,213
      猪柳蛋麦满分,null,1618,387,23,21,25,846,243
      ...

第一行是 ``[记录数]{字段名列表}:``，其后每行一条记录，逗号分隔。
这段文本不遵守 CSV 标准的引号转义，字段内若出现逗号会造成列错位，
因此需要一个"按字段数从右对齐"的稳健解析器。

用法
----
    from mcd_text_parser import parse_table_text

    rows = parse_table_text(raw_text)
    print(rows[0]["productName"], rows[0]["energyKcal"])

纯 Python 标准库实现，无第三方依赖。

License: MIT
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

__all__ = ["parse_table_text", "ParseError", "coerce_number"]


class ParseError(ValueError):
    """文本表格格式不符合预期时抛出。"""


_HEADER_RE = re.compile(r"^\s*\[(\d+)\]\s*\{(?P<fields>[^}]*)\}\s*:?\s*$")
_NUMBER_RE = re.compile(r"^-?\d+(?:\.\d+)?$")


def coerce_number(value: str) -> Any:
    """把形如 ``"308"`` / ``"33.5"`` 的字符串转成 int / float，其余原样返回。

    MCP 的数值字段普遍以**字符串**形式返回（见项目 README 的"工程坑 2"），
    直接参与算术会出错，因此统一在解析层做一次转换。

    ``"null"`` 与空串会被转换为 ``None``。
    """
    if value is None:
        return None
    text = value.strip()
    if text == "" or text.lower() == "null":
        return None
    if _NUMBER_RE.match(text):
        return float(text) if "." in text else int(text)
    return value


def _split_row(line: str, field_count: int) -> List[str]:
    """把一行拆成 ``field_count`` 列。

    策略：优先直接按逗号切分；若列数多于字段数，说明字段**名称**里含有逗号，
    此时从右侧对齐——把多出来的部分合并回第一个字段。
    """
    cells = [c.strip() for c in line.split(",")]
    if len(cells) == field_count:
        return cells
    if len(cells) > field_count:
        overflow = len(cells) - field_count
        return [",".join(cells[: overflow + 1])] + cells[overflow + 1 :]
    # 列数不足：右侧补 None，保证结构稳定
    return cells + [""] * (field_count - len(cells))


def parse_table_text(raw: str, *, coerce: bool = True) -> List[Dict[str, Any]]:
    """解析麦当劳 MCP 的文本表格响应。

    Args:
        raw: 接口返回的原始文本。
        coerce: 是否把数值字符串转为 int / float（默认 True）。

    Returns:
        记录字典列表，键为表头字段名。解析失败的行会被跳过并在结果中忽略。

    Raises:
        ParseError: 找不到头部 ``[N]{fields}:`` 行，或字段列表为空时。
    """
    if not raw or not raw.strip():
        return []

    lines = [ln for ln in raw.replace("\r\n", "\n").split("\n") if ln.strip()]

    header_idx: Optional[int] = None
    fields: List[str] = []
    declared_count: Optional[int] = None

    for idx, line in enumerate(lines):
        m = _HEADER_RE.match(line)
        if m:
            fields = [f.strip() for f in m.group("fields").split(",") if f.strip()]
            declared_count = int(m.group(1))
            header_idx = idx
            break

    if header_idx is None or not fields:
        raise ParseError("未找到形如 '[N]{field1,field2}:' 的表头行")

    records: List[Dict[str, Any]] = []
    for line in lines[header_idx + 1 :]:
        if line.strip().startswith("["):  # 新的表头，说明有多段
            break
        cells = _split_row(line, len(fields))
        if all(c == "" for c in cells):
            continue
        row: Dict[str, Any] = {}
        for key, cell in zip(fields, cells):
            row[key] = coerce_number(cell) if coerce else cell
        records.append(row)

    if declared_count is not None and declared_count != len(records):
        # 声明条数与实际条数不一致时给出提示，但不视为致命错误
        row = {"__warning__": f"表头声明 {declared_count} 条，实际解析 {len(records)} 条"}
        records.append(row)

    return records


# --------------------------------------------------------------------------- #
# 自检：直接运行本文件即可验证解析器（内置一段来自真实接口的样例）
# --------------------------------------------------------------------------- #
_SAMPLE = """[6]{productName,nutritionDescription,energyKj,energyKcal,protein,fat,carbohydrate,sodium,calcium}:
  猪柳麦满分,null,1288,308,16,16,24,781,213
  巨无霸,null,2146,513,27,26,42,961,171
  中薯条,null,1210,289,4,12,38,165,18
  纯悦,能量约清水1杯,0,0,0,0,0,0,0
  芝士双层安格斯厚牛堡,null,4195,1003,58,65,46,1373,251
  可乐中杯,null,616,147,0,0,36,0,10
"""


def _selftest() -> None:
    rows = parse_table_text(_SAMPLE)
    assert len(rows) == 6, f"应解析出 6 条，实际 {len(rows)}"
    assert rows[0]["productName"] == "猪柳麦满分"
    assert rows[0]["energyKcal"] == 308 and isinstance(rows[0]["energyKcal"], int)
    assert rows[3]["nutritionDescription"] == "能量约清水1杯"
    assert rows[3]["energyKcal"] == 0
    assert rows[4]["protein"] == 58

    # 数值转换
    assert coerce_number("33.5") == 33.5 and isinstance(coerce_number("33.5"), float)
    assert coerce_number("null") is None and coerce_number("") is None
    assert coerce_number("双层吉士汉堡") == "双层吉士汉堡"

    # 字段名里含逗号时的右对齐容错：多出的列应合并回最左侧字段
    messy = "[1]{productName,desc,energyKcal}:\n  巨无霸,招牌,双层,513\n"
    got = parse_table_text(messy)
    assert got[0]["productName"] == "巨无霸,招牌", got[0]
    assert got[0]["desc"] == "双层", got[0]
    assert got[0]["energyKcal"] == 513, got[0]

    # 空输入
    assert parse_table_text("") == []
    assert parse_table_text("   \n  ") == []

    # 非法输入应抛错
    try:
        parse_table_text("这不是表格")
    except ParseError:
        pass
    else:
        raise AssertionError("缺少表头时应抛出 ParseError")

    print("✓ 全部自检通过（6 项断言组）")
    print(f"✓ 样例解析结果：{len(rows)} 条记录，字段 {list(rows[0].keys())}")
    print(f"✓ 首条：{rows[0]}")


if __name__ == "__main__":
    _selftest()
