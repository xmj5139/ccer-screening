# -*- coding: utf-8 -*-
"""
v2 六模块工作台 · 浏览器渲染检查（开发期工具，非运行时依赖）
============================================================================
作用：
  1. 用 Chromium 打开 http://127.0.0.1:8899/v2，完成登录；
  2. 依次访问六个模块，检查关键元素是否渲染、是否有控制台错误；
  3. 每个模块保存一张截图到 docs/_screenshots/。

依赖：Python playwright（本机已安装）。运行：
    python scripts/v2-browser-check.py [base_url]
"""
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8899"
OUT = Path(__file__).resolve().parent.parent / "docs" / "_screenshots"
OUT.mkdir(parents=True, exist_ok=True)

MODULES = [
    ("overview", "#/", ["总览", "市场走势", "项目进度", "方法学分布", "更新提醒"]),
    ("policies", "#/policies", ["政策库", "方法学库", "目录完整性"]),
    ("methodologies", "#/policies?tab=methodologies", ["正式发布方法学", "领域签字", "暂不支持自动测算"]),
    ("projects", "#/projects", ["公开项目库", "机构内部项目库"]),
    ("trades", "#/trades", ["市场走势", "交易日历", "每日行情明细", "区间成交均价"]),
    ("measure", "#/measure", ["放行状态", "暂不支持自动测算", "领域复核已签字"]),
    ("admin", "#/admin", ["系统状态", "数据来源", "待审核任务"]),
]

console_errors = []
page_errors = []

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1440, "height": 950})

    def on_console(msg):
        if msg.type == "error":
            console_errors.append(f"{msg.location.get('url','')}: {msg.text}")

    page.on("console", on_console)
    page.on("pageerror", lambda e: page_errors.append(str(e)))

    print(f"打开 {BASE}/v2 …")
    page.goto(f"{BASE}/v2", wait_until="networkidle")
    page.wait_for_timeout(800)

    # 登录（演示口令）
    if page.locator("#btn-login").count():
        page.fill("#login-user", "user-admin")
        page.fill("#login-pass", "admin-demo-2026")
        page.click("#btn-login")
        page.wait_for_timeout(1500)
        print("已完成登录")

    failures = []
    for name, route, needles in MODULES:
        page.goto(f"{BASE}/v2{route}", wait_until="networkidle")
        page.wait_for_timeout(1200)
        text = page.inner_text("#module-root")
        missing = [n for n in needles if n not in text]
        title = page.locator(".navitem.active").inner_text() if page.locator(".navitem.active").count() else ""
        shot = OUT / f"v2-{name}.png"
        page.screenshot(path=str(shot), full_page=False)
        status = "OK " if not missing else "缺元素"
        print(f"  [{status}] {name:14s} 导航={title.strip():12s} 截图={shot.name} 文本长度={len(text)}")
        if missing:
            failures.append((name, missing))

    browser.close()

print("")
print(f"控制台错误：{len(console_errors)}")
for e in console_errors[:10]:
    print("   -", e)
print(f"页面异常：{len(page_errors)}")
for e in page_errors[:10]:
    print("   -", e)
if failures:
    print("缺失关键元素：")
    for name, missing in failures:
        print(f"   - {name}: {missing}")
    sys.exit(1)
if console_errors or page_errors:
    sys.exit(2)
print("全部模块渲染检查通过")
