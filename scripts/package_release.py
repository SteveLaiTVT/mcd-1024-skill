#!/usr/bin/env python3
"""把小票卡片页打包为发布件，并生成 SHA256SUMS.txt。

只处理 static/receipt-card.html → output/mcd-wheel-static/receipt/index.html
（由 scripts/build_frontend.mjs 生成）。不读取 web/，不访问任何凭证：
本脚本不访问环境变量值、浏览器存储、地址、订单或网络。

产物落在 output/releases/v<版本>/：
  - receipt-card-<版本>.zip   仅含单一 receipt 文件夹
  - SHA256SUMS.txt            sha256sum 兼容格式

校验分三层，任一层失败即拒绝打包：
  1. 版本格式：package.json 版本号必须为 x.y.z；
  2. 逐字节回源：产物必须与 static/receipt-card.html 完全一致；
  3. 凭证扫描：文本产物中的真实凭证特征逐片段判定（整行出现占位词不构成豁免）。

`--check` 只做校验与复验，不写任何文件。
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import re
import sys
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
PACKAGE_JSON = REPO / "package.json"
RECEIPT_SRC = REPO / "static" / "receipt-card.html"
RECEIPT_OUT = REPO / "output" / "mcd-wheel-static" / "receipt" / "index.html"

# 凭证特征：每条正则都必须捕获“密钥值”本身，占位符判定只作用于该捕获片段。
CREDENTIAL_PATTERNS = (
    ("bearer", re.compile(r"(?i)\bbearer\s+([A-Za-z0-9._\-]{16,})")),
    ("github-token", re.compile(r"\bgh[pousr]_([A-Za-z0-9]{16,})")),
    ("deepseek-key", re.compile(r"\bsk-([A-Za-z0-9]{16,})")),
    ("env-secret", re.compile(r"(?i)\b(?:MCD_TOKEN|MCD_MCP_TOKEN|DEEPSEEK_API_KEY|API_KEY|SECRET_KEY)\s*[=:]\s*[\"']?([A-Za-z0-9._\-]{12,})")),
)

# 占位符只在“匹配到的密钥值”以这些词开头时成立；整行含 example 不能豁免同行的真实 key。
PLACEHOLDER_MARKERS = ("your", "example", "sample", "placeholder", "redacted", "dummy", "changeme", "xxxx", "todo")

# 固定时间戳：让同一份产物每次打包得到相同字节与相同哈希，便于复验下载件。
FIXED_ZIP_TIME = (1980, 1, 1, 0, 0, 0)

# SHA256SUMS 行格式：小写十六进制摘要 + 两个空格 + 纯文件名（不允许任何路径分隔）。
SUMS_LINE = re.compile(r"([0-9a-f]{64})  ([^\s/\\][^\n]*)")


class ReleaseError(Exception):
    """校验失败。消息面向使用者，直接可读。"""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ReleaseError(message)


def read_source(path: Path) -> bytes:
    try:
        return path.read_bytes()
    except OSError as error:
        raise ReleaseError(f"无法读取源码文件 {path.relative_to(REPO)}：{error}")


def check_version() -> str:
    try:
        package = json.loads(PACKAGE_JSON.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise ReleaseError(f"无法读取 package.json：{error}")
    version = package.get("version")
    require(isinstance(version, str) and re.fullmatch(r"\d+\.\d+\.\d+", version), "package.json 版本号格式无效")
    return version


def is_placeholder_value(value: str) -> bool:
    """判断“匹配到的密钥值”本身是否为占位符，而不是看整行是否出现占位词。"""
    text = value.strip()
    if not text:
        return True
    if "${" in text or "{{" in text or "<" in text:
        return True
    return text.lower().startswith(PLACEHOLDER_MARKERS)


def check_credentials(text: str, rel: str) -> tuple[int, int]:
    """扫描文本产物的真实凭证特征，返回（占位符跳过数, 已扫描片段数）。"""
    skipped = 0
    scanned = 0
    for number, line in enumerate(text.splitlines(), 1):
        for label, pattern in CREDENTIAL_PATTERNS:
            for match in pattern.finditer(line):
                scanned += 1
                if is_placeholder_value(match.group(1)):
                    skipped += 1
                    continue
                raise ReleaseError(f"产物疑似包含真实凭证（{label}）：{rel}:{number}")
    return skipped, scanned


def verify(verbose: bool = True) -> dict:
    version = check_version()
    try:
        produced = RECEIPT_OUT.read_bytes()
    except OSError as error:
        raise ReleaseError(f"缺少构建产物 {RECEIPT_OUT.relative_to(REPO)}（请先运行 npm run build）：{error}")
    expected = read_source(RECEIPT_SRC)
    require(produced == expected,
            f"产物与当前源码不一致（疑似旧构建混入）：{RECEIPT_OUT.relative_to(REPO)}"
            f"（产物 {len(produced)} 字节，源码 {len(expected)} 字节）")
    try:
        text = produced.decode("utf-8")
    except UnicodeDecodeError:
        raise ReleaseError("产物不是合法的 UTF-8 文本")
    skipped, scanned = check_credentials(text, RECEIPT_OUT.relative_to(REPO).as_posix())
    if verbose:
        print(f"版本校验通过：package.json {version}")
        print(f"  {RECEIPT_OUT.relative_to(REPO)}  {len(produced)} 字节，与源码逐字节一致")
        print(f"  凭证特征扫描 {scanned} 处片段，占位符跳过 {skipped} 处")
    return {"version": version, "bytes": len(produced)}


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def release_name(version: str) -> str:
    return f"receipt-card-{version}.zip"


def verify_sums(out_dir: Path, version: str) -> int | None:
    """复验 SHA256SUMS：只接受预期 ZIP 的纯文件名与合法摘要，不按任意相对路径取文件。"""
    sums = out_dir / "SHA256SUMS.txt"
    if not sums.is_file():
        return None
    expected = release_name(version)
    seen: set[str] = set()
    root = out_dir.resolve()
    for number, line in enumerate(sums.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        match = SUMS_LINE.fullmatch(line)
        require(match is not None,
                f"SHA256SUMS.txt 第 {number} 行格式非法（应为“64位小写摘要 + 两个空格 + 纯文件名”）")
        digest, name = match.group(1), match.group(2)
        require("/" not in name and "\\" not in name and ".." not in name and not Path(name).is_absolute(),
                f"SHA256SUMS.txt 第 {number} 行文件名非法（含路径分隔或相对跳转）：{name}")
        require(name == expected, f"SHA256SUMS.txt 第 {number} 行文件名不在预期内：{name}（预期 {expected}）")
        require(name not in seen, f"SHA256SUMS.txt 第 {number} 行文件名重复：{name}")
        seen.add(name)
        target = (out_dir / name).resolve()
        require(target.parent == root, f"SHA256SUMS.txt 第 {number} 行路径越出发布目录：{name}")
        require(target.is_file(), f"发布目录缺少产物：{name}")
        require(sha256_bytes(target.read_bytes()) == digest, f"发布产物哈希与 SHA256SUMS 不符：{name}")
    require(seen == {expected}, f"SHA256SUMS.txt 缺少条目：{expected}")
    return len(seen)


def write_zip(out_path: Path, version: str) -> dict:
    """写确定性 ZIP：条目有序、时间戳固定，仅含 receipt/index.html。"""
    payload = RECEIPT_OUT.read_bytes()
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        info = zipfile.ZipInfo("receipt/index.html", date_time=FIXED_ZIP_TIME)
        info.compress_type = zipfile.ZIP_DEFLATED
        info.create_system = 3
        info.external_attr = 0o644 << 16
        archive.writestr(info, payload)
    data = buffer.getvalue()
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        require(archive.namelist() == ["receipt/index.html"], "ZIP 条目应仅为 receipt/index.html")
        require(archive.testzip() is None, "ZIP 校验失败")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(data)
    return {"name": out_path.name, "sha256": sha256_bytes(data), "bytes": len(data)}


def package(version: str, verbose: bool = True) -> dict:
    out_dir = REPO / "output" / "releases" / f"v{version}"
    entry = write_zip(out_dir / release_name(version), version)
    (out_dir / "SHA256SUMS.txt").write_text(f"{entry['sha256']}  {entry['name']}\n", encoding="utf-8")
    checked = verify_sums(out_dir, version)
    require(checked == 1, "SHA256SUMS.txt 条目数与发布件数量不一致")
    if verbose:
        print(f"已打包到 {out_dir.relative_to(REPO)}/")
        print(f"  {entry['name']}  {entry['bytes']} 字节  sha256 {entry['sha256'][:16]}…")
        print("  SHA256SUMS.txt  1 行（已按文件名与摘要复验）")
    return {"out_dir": str(out_dir.relative_to(REPO)), "entry": entry}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check", action="store_true", help="只校验与复验，不写入任何文件")
    args = parser.parse_args(argv)
    try:
        report = verify(verbose=not args.check)
        if args.check:
            out_dir = REPO / "output" / "releases" / f"v{report['version']}"
            checked = verify_sums(out_dir, report["version"])
            if checked is None:
                print("校验通过；尚未打包，未发现 SHA256SUMS.txt。")
            else:
                print(f"发布件复验通过：{(out_dir / 'SHA256SUMS.txt').relative_to(REPO)}")
            print(f"版本 {report['version']}")
            return 0
        package(report["version"])
    except ReleaseError as error:
        print("发布校验失败：" + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
