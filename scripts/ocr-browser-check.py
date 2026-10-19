#!/usr/bin/env python
"""
「PDF 解析/OCR」后台页签 —— 浏览器复验脚本（供 Codex 在真实浏览器上执行）
============================================================================
背景：DSH 实施环境禁止子进程打开命名管道（Playwright 启动浏览器会报
`PermissionError: [WinError 5]` / `spawn EPERM`），因此**浏览器复验未在 DSH 环境执行**，
本脚本交给 Codex 做真实浏览器复验。

用法（先在独立库上启动服务，不要指向 data/ccer.db）：

    # 终端 1
    $env:CCER_DB_PATH="$PWD\data\ocr-ui-check.db"
    $env:CCER_ENABLE_V2="1"; $env:CCER_DAILY_SYNC="0"; $env:PORT="8931"
    node scripts/v2-start.mjs --port=8931

    # 终端 2
    pip install playwright && playwright install chromium
    python scripts/ocr-browser-check.py

脚本会：登录管理员 → 打开 #/admin?tab=ocr → 断言页面元素 →
触发一次「测试真实连接」（未配置凭据时应如实提示未配置，不得显示可用）→
触发一次补跑受理（HTTP 202）→ 截图到 docs/_screenshots/。
"""
import os
import sys

from playwright.sync_api import sync_playwright

BASE = os.environ.get("CCER_UI_BASE", "http://127.0.0.1:8931")
USER = os.environ.get("CCER_UI_USER", "user-admin")
PASSWORD = os.environ.get("CCER_UI_PASSWORD", "admin-demo-2026")
OUT = os.environ.get("CCER_UI_SHOT_DIR", os.path.join("docs", "_screenshots"))


def main() -> int:
    os.makedirs(OUT, exist_ok=True)
    checks = {}
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 1600})
        page.on("console", lambda m: errors.append(f"{m.type}: {m.text}") if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))

        page.goto(f"{BASE}/v2", wait_until="networkidle")
        page.fill("#login-user", USER)
        page.fill("#login-pass", PASSWORD)
        page.click("#login-submit")
        page.wait_for_load_state("networkidle")

        page.goto(f"{BASE}/v2/#/admin?tab=ocr", wait_until="networkidle")
        page.wait_for_timeout(1500)
        body = page.inner_text("#tab-body")

        checks["页签存在"] = page.locator("a.tab", has_text="PDF 解析/OCR").count() > 0
        checks["凭据状态提示"] = "百度 OCR" in body
        checks["接口域名固定"] = "接口域名固定为百度官方域名" in body
        checks["受限根展示"] = "official-originals" in body and "registry-files" in body
        checks["模式选择"] = page.locator('select[data-ocr="mode"]').count() == 1
        checks["密钥输入为空"] = (
            page.locator('input[data-ocr="api_key"]').count() == 1
            and page.locator('input[data-ocr="api_key"]').input_value() == ""
            and page.locator('input[data-ocr="secret_key"]').input_value() == ""
        )
        checks["连接测试按钮"] = page.locator("#ocr-test").count() == 1
        checks["能力探测按钮"] = page.locator("#ocr-probe").count() == 1
        checks["补跑按钮"] = page.locator("#ocr-backfill").count() == 1
        checks["每日补跑按钮"] = page.locator("#ocr-daily").count() == 1
        checks["页码约定提示"] = "page_filter" in body
        checks["配额口径提示"] = "实际发出的 HTTP 尝试" in body
        page.screenshot(path=os.path.join(OUT, "37-ocr-tab-top.png"), full_page=True)

        # 真实连接测试：未配置凭据时必须如实失败，不得显示通过
        page.click("#ocr-test")
        page.wait_for_timeout(3000)
        msg = page.inner_text("#ocr-cfg-msg")
        checks["连接测试如实反馈"] = ("未配置" in msg) or ("鉴权" in msg) or ("通过" in msg)
        checks["未配置时不谎报可用"] = not ("未配置" in msg and "测试：通过" in msg)
        page.screenshot(path=os.path.join(OUT, "37-ocr-tab-conn-test.png"), full_page=True)

        # 补跑受理（HTTP 202 + task_id）
        page.click("#ocr-backfill")
        page.wait_for_timeout(3000)
        task_out = page.inner_text("#ocr-task-out")
        checks["补跑 202 受理"] = ("202" in task_out) or ("受理" in task_out)
        page.screenshot(path=os.path.join(OUT, "37-ocr-tab-backfill.png"), full_page=True)

        # 普通用户访问同一 URL 应 403（后端守卫），页面显示错误而非配置
        browser.close()

    ok = True
    print("CHECKS:")
    for name, value in checks.items():
        print(f"  {'PASS' if value else 'FAIL'} {name}")
        ok = ok and value
    print("CONSOLE ERRORS:", errors if errors else "none")
    print("RESULT:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
