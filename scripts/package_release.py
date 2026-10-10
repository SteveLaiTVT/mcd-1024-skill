#!/usr/bin/env python3
"""把已构建的扩展与静态页打包为 2.3.0 发布件，并生成 SHA256SUMS.txt。

只读取构建产物目录、package.json、构建脚本与数据清单，不读取任何凭证：
本脚本不访问环境变量值、浏览器存储、地址、订单或网络。

产物落在 output/releases/v<版本>/：
  - mcd-wheel-extension-<版本>.zip   仅含单一 mcd-wheel-extension 文件夹，可解压后直接加载
  - mcd-wheel-static-<版本>.zip      仅含单一 mcd-wheel-static 文件夹
  - SHA256SUMS.txt                   sha256sum 兼容格式

校验分四层，任一层失败即拒绝打包：
  1. 版本一致：package.json / web/manifest.json / 产物 build-info.json 必须同版本；
  2. 文件集合精确：与 scripts/build_frontend.mjs 声明的清单完全相等，多余或缺失都失败；
  3. 逐字节回源：每个前端资源、公开 data JSON、launcher.js、manifest.json 与两份打包说明
     都与当前源码逐字节一致——防止版本号同为 2.3.0 但代码已改、旧构建混入 Release；
  4. 私有文件与凭证：黑名单过滤，并对真实凭证特征逐片段判定（整行出现占位词不构成豁免）。

`--check` 只做校验与复验，不写任何文件；复验 SHA256SUMS 时只接受两份预期 ZIP 文件名。
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
BUILD_ROOT = REPO / "output"
BUILD_SCRIPT = REPO / "scripts" / "build_frontend.mjs"
PACKAGE_JSON = REPO / "package.json"
SOURCE_MANIFEST = REPO / "web" / "manifest.json"
DATASET_MANIFEST = REPO / "data" / "manifest.json"

# 构建目录名即 ZIP 内唯一的顶层文件夹名，解压后可直接用于“加载已解压的扩展程序”。
KINDS = ("extension", "static")
BUILD_DIRS = {kind: BUILD_ROOT / f"mcd-wheel-{kind}" for kind in KINDS}
DIR_NAME = {kind: BUILD_DIRS[kind].name for kind in KINDS}

# 仅扩展目录额外包含的文件；其余文件由 build_frontend.mjs 的数组决定。
EXTENSION_EXTRAS = ("manifest.json", "launcher.js", "接入说明.md", "AI搭子说明.md", "安装说明.txt")
COMMON_EXTRAS = ("build-info.json",)

# 构建脚本把 docs/ 下的说明复制成扩展内的中文文件名；这里按同一映射做逐字节回源比对。
DOC_COPIES = {
    "接入说明.md": ("docs", "frontend-architecture.md"),
    "AI搭子说明.md": ("docs", "meal-agents.md"),
}
INSTALL_NOTE = "安装说明.txt"

# 不允许出现在发布件里的私有文件：目录/文件名、后缀、路径片段。
FORBIDDEN_NAMES = {".env", ".ds_store", "credentials", "secrets", "__pycache__", ".git", "node_modules", ".netrc", "id_rsa"}
FORBIDDEN_SUFFIXES = (".token", ".key", ".pem", ".p12", ".pfx", ".log", ".zip", ".pyc", ".map")
FORBIDDEN_PATH_PARTS = ("data/local", "secrets/", "credentials/", ".dataset-refresh-")

# 凭证特征：每条正则都必须捕获“密钥值”本身，占位符判定只作用于该捕获片段。
CREDENTIAL_PATTERNS = (
    ("bearer", re.compile(r"(?i)\bbearer\s+([A-Za-z0-9._\-]{16,})")),
    ("github-token", re.compile(r"\bgh[pousr]_([A-Za-z0-9]{16,})")),
    ("deepseek-key", re.compile(r"\bsk-([A-Za-z0-9]{16,})")),
    ("env-secret", re.compile(r"(?i)\b(?:MCD_TOKEN|MCD_MCP_TOKEN|DEEPSEEK_API_KEY|API_KEY|SECRET_KEY)\s*[=:]\s*[\"']?([A-Za-z0-9._\-]{12,})")),
)

# 占位符只在“匹配到的密钥值”以这些词开头时成立；整行含 example 不能豁免同行的真实 key。
PLACEHOLDER_MARKERS = ("your", "example", "sample", "placeholder", "redacted", "dummy", "changeme", "xxxx", "todo")

TEXT_SUFFIXES = {".json", ".mjs", ".js", ".html", ".css", ".md", ".txt", ".svg", ".xml", ".csv"}

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


def read_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise ReleaseError(f"缺少必需文件：{path.relative_to(REPO)}")
    except (OSError, ValueError) as error:
        raise ReleaseError(f"无法解析 {path.relative_to(REPO)}：{error}")


def parse_build_manifest() -> tuple[list[str], list[str], str]:
    """从构建脚本解析资源与数据文件清单，避免脚本与产物清单各自维护导致漂移。"""
    try:
        source = BUILD_SCRIPT.read_text(encoding="utf-8")
    except OSError as error:
        raise ReleaseError(f"无法读取构建脚本：{error}")

    def array(name: str) -> list[str]:
        match = re.search(rf"const {name} = \[(.*?)\];", source, re.S)
        require(match is not None, f"构建脚本中找不到 {name} 数组，请先同步 scripts/build_frontend.mjs")
        items = re.findall(r"'([^']+)'", match.group(1))
        require(bool(items), f"构建脚本的 {name} 数组为空")
        return items

    assets, data_files = array("assets"), array("dataFiles")
    require(len(set(assets)) == len(assets), "构建脚本 assets 存在重复项")
    require(len(set(data_files)) == len(data_files), "构建脚本 dataFiles 存在重复项")
    return assets, data_files, source


def install_note_bytes(script_source: str, version: str) -> bytes:
    """从构建脚本提取 安装说明.txt 模板并代入当前版本，用于逐字节回源比对。"""
    match = re.search(r"writeFile\(path\.join\(output,\s*'安装说明\.txt'\),\s*`([\s\S]*?)`\)", script_source)
    require(match is not None, "构建脚本中找不到 安装说明.txt 的模板，无法校验该说明文件")
    return match.group(1).replace("${version}", version).encode("utf-8")


def build_info_bytes(kind: str, version: str, script_source: str) -> bytes:
    """按构建脚本的写法重建 build-info.json，使该文件也能逐字节回源。

    构建脚本使用 JSON.stringify({...}, null, 2) + 换行；Python json.dumps 在 indent 下
    同样输出 ": " 分隔符，配合 ensure_ascii=False 与之逐字节等价。
    """
    require("version, kind, datasetVersion: manifest.datasetVersion, sampleCapturedAt: manifest.capturedAt" in script_source
            and ", null, 2)" in script_source,
            "构建脚本的 build-info.json 写法已变化，请同步 scripts/package_release.py 的重建逻辑")
    dataset = read_json(DATASET_MANIFEST)
    payload = {"version": version, "kind": kind,
               "datasetVersion": dataset.get("datasetVersion"), "sampleCapturedAt": dataset.get("capturedAt")}
    return (json.dumps(payload, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def expected_bytes(assets: list[str], data_files: list[str], version: str, script_source: str) -> dict[str, dict[str, bytes]]:
    """构造“产物路径 → 当前源码字节”映射，供逐字节回源比对。"""
    common: dict[str, bytes] = {}
    for name in assets:
        common[name] = read_source(REPO / "web" / name)
    for name in data_files:
        common[f"data/{name}"] = read_source(REPO / "data" / name)
    built: dict[str, dict[str, bytes]] = {}
    for kind in KINDS:
        mapping = dict(common)
        mapping[COMMON_EXTRAS[0]] = build_info_bytes(kind, version, script_source)
        built[kind] = mapping

    extension = built["extension"]
    for dest, (folder, src) in DOC_COPIES.items():
        require(f"'{folder}', '{src}'" in script_source and f"'{dest}'" in script_source,
                f"构建脚本的说明文件映射与核对表不一致：{dest} ← {folder}/{src}")
        extension[dest] = read_source(REPO / folder / src)
    for name in ("manifest.json", "launcher.js"):
        require(f"'{name}'" in script_source, f"构建脚本未声明扩展文件 {name}，核对表需同步")
        extension[name] = read_source(REPO / "web" / name)
    extension[INSTALL_NOTE] = install_note_bytes(script_source, version)
    return built


def expected_files(assets: list[str], data_files: list[str]) -> dict[str, set[str]]:
    common = set(assets) | {f"data/{name}" for name in data_files} | set(COMMON_EXTRAS)
    return {"extension": common | set(EXTENSION_EXTRAS), "static": set(common)}


def list_build_files(directory: Path) -> set[str]:
    require(directory.is_dir(), f"缺少构建目录：{directory.relative_to(REPO)}（请先运行 npm run build）")
    files: set[str] = set()
    for path in sorted(directory.rglob("*")):
        if path.is_symlink():
            raise ReleaseError(f"构建产物不应包含符号链接：{path.relative_to(directory)}")
        if path.is_dir():
            continue
        if path.name.startswith(".") and path.name not in {".well-known"}:
            raise ReleaseError(f"构建产物不应包含隐藏文件：{path.relative_to(directory)}")
        files.add(path.relative_to(directory).as_posix())
    require(bool(files), f"构建目录为空：{directory.relative_to(REPO)}")
    return files


def check_forbidden(relative_paths: set[str], kind: str) -> None:
    for rel in sorted(relative_paths):
        lowered = rel.lower()
        name = rel.rsplit("/", 1)[-1].lower()
        require(name not in FORBIDDEN_NAMES, f"{kind} 产物包含私有文件：{rel}")
        require(not lowered.startswith(".env"), f"{kind} 产物包含环境变量文件：{rel}")
        require(not any(part in lowered for part in FORBIDDEN_PATH_PARTS), f"{kind} 产物包含私有路径：{rel}")
        require(not lowered.endswith(FORBIDDEN_SUFFIXES), f"{kind} 产物包含不应发布的文件：{rel}")


def is_placeholder_value(value: str) -> bool:
    """判断“匹配到的密钥值”本身是否为占位符，而不是看整行是否出现占位词。"""
    text = value.strip()
    if not text:
        return True
    if "${" in text or "{{" in text or "<" in text:
        return True
    return text.lower().startswith(PLACEHOLDER_MARKERS)


def check_credentials(directory: Path, relative_paths: set[str], kind: str) -> tuple[int, int]:
    """扫描文本产物的真实凭证特征，返回（真实命中前的占位符跳过数, 已扫描片段数）。

    关键点：同一行同时出现占位符与真实 key 时必须拦截——占位符判定只作用于各自片段。
    """
    skipped = 0
    scanned = 0
    for rel in sorted(relative_paths):
        if Path(rel).suffix.lower() not in TEXT_SUFFIXES:
            continue
        try:
            text = (directory / rel).read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        for number, line in enumerate(text.splitlines(), 1):
            for label, pattern in CREDENTIAL_PATTERNS:
                for match in pattern.finditer(line):
                    scanned += 1
                    if is_placeholder_value(match.group(1)):
                        skipped += 1
                        continue
                    raise ReleaseError(f"{kind} 产物疑似包含真实凭证（{label}）：{rel}:{number}")
    return skipped, scanned


def check_versions() -> dict:
    """校验 package / manifest / build-info 的版本一致，并确认数据集版本来自同一份清单。"""
    package = read_json(PACKAGE_JSON)
    version = package.get("version")
    require(isinstance(version, str) and re.fullmatch(r"\d+\.\d+\.\d+", version), "package.json 版本号格式无效")
    for field in ("name", "private", "scripts"):
        require(field in package, f"package.json 缺少字段：{field}")

    source = read_json(SOURCE_MANIFEST)
    require(source.get("manifest_version") == 3, "web/manifest.json 不是 Manifest V3")
    require(source.get("version") == version, f"web/manifest.json 版本 {source.get('version')} 与 package.json {version} 不一致")

    dataset = read_json(DATASET_MANIFEST)
    require(dataset.get("datasetVersion") and dataset.get("capturedAt"), "data/manifest.json 缺少数据集版本或采样时间")

    info: dict[str, dict] = {}
    for kind in KINDS:
        build_info = BUILD_ROOT / f"mcd-wheel-{kind}" / "build-info.json"
        try:
            payload = read_json(build_info)
        except ReleaseError:
            raise ReleaseError(f"缺少 build-info.json：{kind}（请先运行 npm run build）")
        require(payload.get("version") == version, f"build-info.json({kind}) 版本 {payload.get('version')} 与 package.json {version} 不一致")
        require(payload.get("kind") == kind, f"build-info.json({kind}) 的 kind 字段为 {payload.get('kind')}")
        require(payload.get("datasetVersion") == dataset.get("datasetVersion"), f"build-info.json({kind}) 数据集版本与 data/manifest.json 不一致")
        require(payload.get("sampleCapturedAt") == dataset.get("capturedAt"), f"build-info.json({kind}) 采样时间与 data/manifest.json 不一致")
        info[kind] = payload

    extension_manifest = BUILD_ROOT / DIR_NAME["extension"] / "manifest.json"
    require(extension_manifest.is_file(), "扩展产物缺少 manifest.json")
    require(read_json(extension_manifest).get("version") == version, "扩展产物 manifest.json 版本不匹配")
    return {"version": version, "datasetVersion": dataset.get("datasetVersion"), "capturedAt": dataset.get("capturedAt"), "info": info}


def verify(verbose: bool = True) -> dict:
    assets, data_files, script_source = parse_build_manifest()
    versions = check_versions()
    version = versions["version"]
    want = expected_files(assets, data_files)
    sources = expected_bytes(assets, data_files, version, script_source)

    report: dict = {"version": version, "datasetVersion": versions["datasetVersion"],
                    "capturedAt": versions["capturedAt"], "kinds": {}}
    total_placeholders = 0
    for kind in KINDS:
        directory = BUILD_DIRS[kind]
        actual = list_build_files(directory)
        check_forbidden(actual, kind)
        require(actual == want[kind],
                f"{kind} 产物文件集合与构建清单不一致；多余 {sorted(actual - want[kind]) or '无'}；缺失 {sorted(want[kind] - actual) or '无'}")

        # 逐字节回源：产物必须与当前源码完全一致，否则说明用的是旧构建。
        for rel in sorted(actual):
            expected = sources[kind].get(rel)
            require(expected is not None, f"{kind} 产物 {rel} 不在回源核对表中")
            produced = (directory / rel).read_bytes()
            if produced != expected:
                raise ReleaseError(
                    f"{kind} 产物与当前源码不一致（疑似旧构建混入）：{rel}"
                    f"（产物 {len(produced)} 字节，源码 {len(expected)} 字节）")

        skipped, scanned = check_credentials(directory, actual, kind)
        total_placeholders += skipped
        report["kinds"][kind] = {
            "files": len(actual),
            "bytes": sum((directory / rel).stat().st_size for rel in actual),
            "verified_against_source": len(sources[kind]),
            "credential_fragments": scanned,
            "placeholders_skipped": skipped,
        }

    # 产物内部不应残留其他版本号（防旧版本文件混入）。
    other = re.compile(r"\"version\"\s*:\s*\"(\d+\.\d+\.\d+)\"")
    for kind in KINDS:
        payload = read_json(BUILD_ROOT / f"mcd-wheel-{kind}" / "build-info.json")
        match = other.search(json.dumps(payload))
        if match:
            require(match.group(1) == version, f"{kind} build-info.json 残留其他版本号 {match.group(1)}")

    if verbose:
        print(f"版本校验通过：package / manifest / build-info 均为 {version}，数据集 {versions['datasetVersion']}")
        for kind in KINDS:
            stats = report["kinds"][kind]
            print(f"  {DIR_NAME[kind]}/  {stats['files']:>3} 个文件，{stats['bytes']:>8} 字节，"
                  f"{stats['verified_against_source']} 个与当前源码逐字节一致")
            print(f"    无私有文件、无旧版本；凭证特征扫描 {stats['credential_fragments']} 处片段，"
                  f"占位符跳过 {stats['placeholders_skipped']} 处")
    report["placeholders_skipped"] = total_placeholders
    return report


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def release_names(version: str) -> set[str]:
    return {f"{DIR_NAME[kind]}-{version}.zip" for kind in KINDS}


def verify_sums(out_dir: Path, version: str) -> int | None:
    """复验 SHA256SUMS：只接受两份预期 ZIP 的纯文件名与合法摘要，不按任意相对路径取文件。"""
    sums = out_dir / "SHA256SUMS.txt"
    if not sums.is_file():
        return None
    expected = release_names(version)
    seen: set[str] = set()
    root = out_dir.resolve()
    for number, line in enumerate(sums.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        match = SUMS_LINE.fullmatch(line)
        require(match is not None,
                f"SHA256SUMS.txt 第 {number} 行格式非法（应为“64位小写摘要 + 两个空格 + 纯文件名”，文件名不得含路径或多余字符）")
        digest, name = match.group(1), match.group(2)
        # 先做名字与路径判定，再决定是否读取文件：越界名不会触发任何文件读取。
        require("/" not in name and "\\" not in name and ".." not in name and not Path(name).is_absolute(),
                f"SHA256SUMS.txt 第 {number} 行文件名非法（含路径分隔或相对跳转）：{name}")
        require(name in expected, f"SHA256SUMS.txt 第 {number} 行文件名不在预期内：{name}（预期 {sorted(expected)}）")
        require(name not in seen, f"SHA256SUMS.txt 第 {number} 行文件名重复：{name}")
        seen.add(name)
        target = (out_dir / name).resolve()
        require(target.parent == root, f"SHA256SUMS.txt 第 {number} 行路径越出发布目录：{name}")
        require(target.is_file(), f"发布目录缺少产物：{name}")
        require(sha256_bytes(target.read_bytes()) == digest, f"发布产物哈希与 SHA256SUMS 不符：{name}")
    require(seen == expected, f"SHA256SUMS.txt 缺少条目：{sorted(expected - seen)}")
    return len(seen)


def write_zip(kind: str, out_path: Path) -> dict:
    """写确定性 ZIP：条目有序、时间戳固定、仅含构建产物，且只在单一顶层文件夹下。"""
    directory = BUILD_DIRS[kind]
    prefix = DIR_NAME[kind]
    files = sorted(list_build_files(directory))
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for rel in files:
            info = zipfile.ZipInfo(f"{prefix}/{rel}", date_time=FIXED_ZIP_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = 0o644 << 16
            archive.writestr(info, (directory / rel).read_bytes())
    payload = buffer.getvalue()

    # 复验：顶层唯一文件夹、条目集合与构建产物一致、无私有文件。
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        names = archive.namelist()
        require(all(name.startswith(prefix + "/") for name in names), f"{kind} ZIP 存在顶层文件夹以外的条目")
        tops = {name.split("/", 1)[0] for name in names}
        require(tops == {prefix}, f"{kind} ZIP 顶层文件夹应为 {prefix}，实际 {sorted(tops)}")
        entries = {name.split("/", 1)[1] for name in names}
        require(entries == set(files), f"{kind} ZIP 条目与构建产物不一致")
        check_forbidden(entries, f"{kind} ZIP")
        require(archive.testzip() is None, f"{kind} ZIP 校验失败")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(payload)
    return {"kind": kind, "name": out_path.name, "sha256": sha256_bytes(payload), "bytes": len(payload), "files": len(files)}


def package(version: str, verbose: bool = True) -> dict:
    out_dir = BUILD_ROOT / "releases" / f"v{version}"
    entries = [write_zip(kind, out_dir / f"{DIR_NAME[kind]}-{version}.zip") for kind in KINDS]
    lines = [f"{entry['sha256']}  {entry['name']}" for entry in sorted(entries, key=lambda item: item["name"])]
    (out_dir / "SHA256SUMS.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")

    checked = verify_sums(out_dir, version)
    require(checked == len(entries), "SHA256SUMS.txt 条目数与发布件数量不一致")
    if verbose:
        print(f"已打包到 {out_dir.relative_to(REPO)}/")
        for entry in sorted(entries, key=lambda item: item["name"]):
            print(f"  {entry['name']}  {entry['files']} 个文件  {entry['bytes']} 字节  sha256 {entry['sha256'][:16]}…")
        print(f"  SHA256SUMS.txt  {len(lines)} 行（已按文件名与摘要复验）")
    return {"out_dir": str(out_dir.relative_to(REPO)), "entries": entries}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check", action="store_true", help="只校验与复验，不写入任何文件")
    args = parser.parse_args(argv)
    try:
        report = verify(verbose=not args.check)
        if args.check:
            out_dir = BUILD_ROOT / "releases" / f"v{report['version']}"
            checked = verify_sums(out_dir, report["version"])
            if checked is None:
                print("校验通过；尚未打包，未发现 SHA256SUMS.txt。")
            else:
                print(f"发布件复验通过：{(out_dir / 'SHA256SUMS.txt').relative_to(REPO)}（{checked} 条，仅限预期 ZIP 文件名）")
            print(f"版本 {report['version']}，数据集 {report['datasetVersion']}，采样时间 {report['capturedAt']}")
            return 0
        package(report["version"])
    except ReleaseError as error:
        print("发布校验失败：" + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
