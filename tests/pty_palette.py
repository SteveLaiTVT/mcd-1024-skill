#!/usr/bin/env python3
"""Real-terminal check of the TUI: runs `node tui/main.mjs --demo --no-profile` inside a
pseudo-terminal (stdin/stdout are a real TTY, raw mode, 140x40), types keys the way a terminal
sends them, and asserts on what gets drawn. Piped-input tests cannot prove the '/' palette works;
this does.

    python3 tests/pty_palette.py [path/to/node]

Exit 0 = every check passed, 1 = a check failed (the output tail is printed), 77 = no PTY here.
Demo mode only: no network, no MCP, no order. Standard library only.
"""
import os
import re
import select
import signal
import struct
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = sys.argv[1] if len(sys.argv) > 1 else "node"
COLS, ROWS = 140, 40
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78DEHM]")
PLACEHOLDER = "输入 / 打开命令面板"


class Check(Exception):
    pass


class Term:
    def __init__(self, fd):
        self.fd, self.raw = fd, b""

    def pump(self, timeout):
        ready, _, _ = select.select([self.fd], [], [], timeout)
        if not ready:
            return False
        try:
            data = os.read(self.fd, 65536)
        except OSError:
            data = b""
        if not data:
            raise EOFError
        self.raw += data
        return True

    def mark(self):
        return len(self.raw)

    def text(self, since=0):
        return ANSI.sub("", self.raw[since:].decode("utf-8", "replace"))

    def send(self, keys):
        os.write(self.fd, keys.encode("utf-8"))

    def expect(self, needles, since=0, timeout=10.0):
        deadline = time.time() + timeout
        while True:
            seen = self.text(since)
            missing = [n for n in needles if n not in seen]
            if not missing:
                return seen
            if time.time() > deadline:
                raise Check(f"timed out waiting for {missing!r}")
            try:
                self.pump(0.1)
            except EOFError:
                raise Check(f"the TUI exited while waiting for {missing!r}")

    # Read until the screen has been quiet for `quiet` seconds.
    def settle(self, quiet=0.4, timeout=5.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                if not self.pump(quiet):
                    return
            except EOFError:
                return

    def type(self, keys, quiet=0.3):
        self.send(keys)
        self.settle(quiet)


def run(term, pid, ok):
    # 1. Startup: header in the log, the input box placeholder, the status line.
    term.expect(["麦麦饱饱盘 · 终端版", PLACEHOLDER, "样本模式"], timeout=30)
    term.settle()
    ok("startup draws the header, the input box and the status line")

    # 2. '/' alone: the palette appears on the keystroke itself (no Enter), with descriptions and keywords.
    m = term.mark()
    term.send("/")
    term.expect(["/connect", "用环境变量 MCD_TOKEN 连接麦当劳 MCP", "连接 登录 令牌", "/coupons", "先列可领券", "↑↓ 选择", "共 "], since=m)
    term.settle()
    ok("'/' opens the palette immediately: commands, descriptions, keywords, key hints")

    # Up from the first row wraps to the last command: arrow keys move the selection.
    m = term.mark()
    term.send("\x1b[A")
    term.expect(["/quit · /exit · /q", "❯"], since=m)
    term.settle()
    ok("↑ moves the selection (wraps to /quit)")

    # 3. '/c' then '/ca': the prefix filters; '/ca' is exactly /cart.
    m = term.mark()
    term.send("c")
    term.expect(["/cart", "/clear", "/coupons"], since=m)
    term.settle()
    m = term.mark()
    term.send("a")
    term.expect(["/cart [rm <hash>|clear]", "查看购物车", "购物车 清单"], since=m)
    term.settle()
    frame = term.text(m)
    if "先列可领券" in frame or "/connect" in frame:
        raise Check("'/ca' still lists other commands")
    ok("'/ca' narrows the palette to /cart")

    # 4. Esc dismisses the palette and keeps the typed text.
    m = term.mark()
    term.send("\x1b")
    term.settle(0.6)
    frame = term.text(m)
    if "查看购物车" in frame:
        raise Check("Esc did not dismiss the palette")
    if "/ca" not in frame:
        raise Check("Esc lost the typed text")
    ok("Esc dismisses the palette, the input keeps '/ca'")

    # 5. Backspace as macOS terminals send it (DEL, 0x7f) erases back to the placeholder.
    m = term.mark()
    for _ in range(3):
        term.type("\x7f", 0.2)
    term.expect([PLACEHOLDER], since=m)
    ok("Backspace (0x7f) edits the input")

    # 6. '/cou' narrows to /coupons only.
    term.type("/co")
    m = term.mark()
    term.send("u")
    term.expect(["/coupons", "先列可领券"], since=m)
    term.settle()
    if "用环境变量 MCD_TOKEN" in term.text(m):
        raise Check("'/cou' still lists /connect")
    ok("'/cou' narrows the palette to /coupons")

    # 7. ↓ + Enter runs the highlighted command: '/w' → wheel, why, weather; ↓ selects /why.
    term.type("\x15")  # Ctrl+U clears the input
    term.type("/w")
    term.type("\x1b[B")
    m = term.mark()
    term.send("\r")
    term.expect(["还没有挑选过程"], since=m)
    term.settle()
    ok("↓ Enter runs the highlighted command (/why)")

    # Enter on a typed prefix runs the match: '/he' → /help lists every command.
    term.type("/he")
    m = term.mark()
    term.send("\r")
    term.expect(["显示这份命令表", "/allergy-clear 过敏原", "/radar [recent|year]", "/quit · /exit · /q"], since=m)
    term.settle()
    ok("'/he' + Enter runs /help, which lists every command")

    # 8. A question ends with ONE clear answer; the agents' back-and-forth is not shown.
    term.type("1人 7分饱 人均30")
    m = term.mark()
    term.send("\r")
    term.expect(["这一餐就吃", "理由：", "门店：", "/why 看挑选过程"], since=m, timeout=30)
    term.settle(0.8)
    answer = term.text(m)
    # Strings that only exist in the per-step details (the spinner may show step names, which is fine).
    for noise in ["推荐 Agent →", "优化 Agent →", "也可以考虑", "最近吃了啥 / 喝了啥", "按用券后的实际价格从低到高排"]:
        if noise in answer:
            raise Check(f"the answer view shows process noise: {noise!r}")
    ok("a question ends with one answer card (pick · price · store · reason), no step log")

    # The process is still there, behind /why.
    term.type("/why")
    m = term.mark()
    term.send("\r")
    term.expect(["挑选过程", "1/6 理解需求", "5/6 查券与官方整单核价", "6/6 饭搭子双 Agent 挑选"], since=m)
    term.settle()
    ok("/why shows the full process on request")

    # Info questions (issue #2). A fresh demo pick, then answers that must not
    # reprint the pick card or drop a receipt. '你好' deflection is issue #3.
    term.type("预算30")
    m = term.mark()
    term.send("\r")
    term.expect(["这一餐就吃"], since=m, timeout=30)
    term.settle(0.8)
    ok("'预算30' picks a meal")

    term.type("这个有牛肉吗")
    m = term.mark()
    term.send("\r")
    term.expect(["牛肉", "按产品名判定"], since=m, timeout=20)
    term.settle(0.8)
    frame = term.text(m)
    if "这一餐就吃" in frame:
        raise Check("the beef answer reprinted the pick card")
    if "扫码查看套餐卡片" in frame:
        raise Check("the beef answer dropped a receipt")
    ok("'这个有牛肉吗' answers beef by product name, with no pick card and no receipt")

    term.type("这个套餐里有什么")
    m = term.mark()
    term.send("\r")
    term.expect(["麦香鸡", "无糖可口可乐中杯"], since=m, timeout=20)
    term.settle(0.6)
    ok("'这个套餐里有什么' lists the receipt parts")

    term.type("有什么好吃的")
    m = term.mark()
    term.send("\r")
    term.expect(["这一餐就吃"], since=m, timeout=30)
    term.settle(0.8)
    ok("'有什么好吃的' goes through the meal flow")

    # 9. Buy intent in demo mode is refused; no order.
    term.type("就吃这个了")
    m = term.mark()
    term.send("\r")
    term.expect(["演示模式不下真实订单", "没有调用 create-order"], since=m, timeout=15)
    term.settle()
    ok("'就吃这个了' in demo mode shows the coupons + store question and refuses")

    # 10. /quit exits cleanly.
    term.type("/quit")
    m = term.mark()
    term.send("\r")
    term.expect(["再见"], since=m)
    deadline = time.time() + 10
    while time.time() < deadline:
        try:
            term.pump(0.1)
        except EOFError:
            pass
        done, status = os.waitpid(pid, os.WNOHANG)
        if done:
            if not (os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0):
                raise Check(f"the TUI exited with status {status}")
            ok("/quit exits with status 0")
            return
    raise Check("the TUI did not exit after /quit")


def main():
    try:
        import fcntl
        import pty
        import termios
    except ImportError as e:
        print(f"SKIP: no POSIX pty support ({e})")
        return 77
    try:
        pid, fd = pty.fork()
    except OSError as e:
        print(f"SKIP: cannot open a pty ({e})")
        return 77
    if pid == 0:
        fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
        # No credentials, and no CI flag: Ink renders non-interactively when it thinks it is in CI.
        env = {k: v for k, v in os.environ.items() if k not in ("MCD_TOKEN", "DEEPSEEK_API_KEY", "NO_COLOR", "CI", "CONTINUOUS_INTEGRATION")}
        env.update(TERM="xterm-256color", COLUMNS=str(COLS), LINES=str(ROWS))
        os.chdir(ROOT)
        os.execvpe(NODE, [NODE, "tui/main.mjs", "--demo", "--no-profile"], env)

    term, passed = Term(fd), []

    def ok(name):
        passed.append(name)
        print(f"ok - {name}", flush=True)

    try:
        run(term, pid, ok)
    except Check as e:
        print(f"not ok - {e}")
        print("---- screen output (last 3000 chars, ANSI stripped) ----")
        print(term.text()[-3000:])
        return 1
    finally:
        try:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
        except (ProcessLookupError, ChildProcessError):
            pass
    crashed = [w for w in ("TypeError", "ReferenceError", "SyntaxError", "Unhandled") if w in term.text()]
    if crashed:
        print(f"not ok - error text on screen: {crashed}")
        return 1
    print(f"PASS: {len(passed)} checks in a real PTY ({COLS}x{ROWS})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
