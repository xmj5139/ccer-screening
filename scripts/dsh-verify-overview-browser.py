#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
真浏览器实测（Playwright）：登录 http://127.0.0.1:8910/v2，读取总览
「自动运行状态」与「数据缺口与自动补全状态」两张卡片的**实际渲染文本**并断言：

  1. 已结清的旧提醒（数据异常：交易日 2025-03-21 / 2630 吨 vs 单日 500 吨）
     不再作为待关注出现；
  2. 「未读提醒」计数已排除已结清提醒，并显示已结清留痕条数；
  3. 数据缺口标题为实时状态（原件已全部归档 14/14，2 条 JS 渲染页正文暂无法自动提取），
     不再是「部分政策原件（PDF）尚未归档与页码提取」；
  4. 真正未解决的内容仍被诚实提示（自动核验受阻、未核实），且不写成人工待办；
  5. 页面无 JS 异常 / 控制台 error。

只读：不写库、不改配置；截图输出到 docs/_screenshots/。
用法：python scripts/dsh-verify-overview-browser.py [baseUrl]
"""
import json
import os
import re
import sys

from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1].startswith("http") else "http://127.0.0.1:8910"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "docs", "_screenshots")
USER = os.environ.get("CCER_BROWSER_USER", "user-admin")
PASS = os.environ.get("CCER_BROWSER_PASS", "admin-demo-2026")

results = []


def check(name, ok, extra=""):
    results.append((name, bool(ok), extra))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f" | {extra}" if extra else ""))


def card_text(page, title):
    return page.evaluate(
        """(title) => {
            const cards = [...document.querySelectorAll('section.card')];
            const hit = cards.find(c => (c.querySelector('.card-head')?.innerText || '').includes(title));
            return hit ? hit.innerText : null;
        }""",
        title,
    )


def main():
    console_errors = []
    page_errors = []
    with sync_playwright() as p:
        try:
            browser = p.chromium.launch(headless=True)
        except Exception as exc:  # noqa: BLE001
            print(f"内置 chromium 启动失败（{exc}），改用系统 Chrome")
            browser = p.chromium.launch(headless=True, channel="chrome")
        page = browser.new_page(viewport={"width": 1600, "height": 1200})
        page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: page_errors.append(str(e)))

        page.goto(f"{BASE}/v2", wait_until="networkidle")
        if page.locator("#btn-login").count():
            page.fill("#login-user", USER)
            page.fill("#login-pass", PASS)
            page.click("#btn-login")
            page.wait_for_timeout(2500)
        who = page.evaluate("document.querySelector('.who-name')?.textContent || null")
        print(f"登录身份：{who}")
        if not who:
            raise RuntimeError("登录失败，未显示用户身份")

        page.goto(f"{BASE}/v2#/", wait_until="networkidle")
        page.wait_for_timeout(1800)

        feed = card_text(page, "自动运行状态")
        gap = card_text(page, "数据缺口与自动补全状态")
        os.makedirs(OUT_DIR, exist_ok=True)
        shot = os.path.join(OUT_DIR, "v2-overview-feed-fix.png")
        page.screenshot(path=shot, full_page=True)

        print("\n=== 实际渲染：自动运行状态 ===")
        print(feed or "(未找到卡片)")
        print("\n=== 实际渲染：数据缺口与自动补全状态 ===")
        print(gap or "(未找到卡片)")

        api = page.evaluate("fetch('/api/v2/notifications?limit=50').then(r => r.json())")
        print("\n=== /api/v2/notifications 摘要 ===")
        print(json.dumps({
            "unread": api.get("unread"),
            "settled": api.get("settled"),
            "total": len(api.get("notifications") or []),
            "note": api.get("note"),
        }, ensure_ascii=False, indent=1))
        sample = next((n for n in (api.get("notifications") or []) if "2025-03-21" in str(n.get("title"))), None)
        if sample:
            print(f"2025-03-21 提醒：settled={sample.get('settled')} read_at={sample.get('read_at')} resolved_at={sample.get('resolved_at')}")
            print(f"  结清说明：{str(sample.get('resolution'))[:220]}")

        print("\n=== 断言 ===")
        check("总览找到「自动运行状态」卡片", bool(feed))
        check("总览找到「数据缺口与自动补全状态」卡片", bool(gap))
        check(
            "缺口标题不再是「部分政策原件（PDF）尚未归档与页码提取」",
            bool(gap) and "部分政策原件（PDF）尚未归档与页码提取" not in gap,
        )
        check(
            "缺口标题为实时状态（原件已全部归档 14/14 + 2 条正文暂无法自动提取）",
            bool(gap) and "已全部归档（14/14）" in gap and "正文暂无法自动提取" in gap,
        )
        check("缺口自动处理说明写明「自动核验受阻」", bool(gap) and "自动核验受阻" in gap)
        check("缺口未写成人工待办", bool(gap) and "人工待办" not in gap)
        check(
            "未结清缺口不虚报「待归档 N 条」",
            bool(gap) and not re.search(r"待归档\s*\d+", gap),
        )
        check("已结清提醒不再作为待关注（不出现 交易日 2025-03-21）", bool(feed) and "2025-03-21" not in feed)
        check(
            "已结清提醒不再作为待关注（不出现 2630 吨 vs 500 吨错误对比）",
            bool(feed) and not ("2630" in feed and "500 吨" in feed),
        )
        check("未读提醒计数已排除已结清提醒（显示 0）", bool(feed) and re.search(r"未读提醒\s*0", feed) is not None)
        check("显示已结清留痕条数（7，不列为待关注）", bool(feed) and re.search(r"已结清留痕\s*7", feed) is not None)
        check(
            "真正未解决的内容仍被诚实提示（自动核验受阻、未核实）",
            bool(feed) and "自动核验受阻" in feed and "未核实" in feed,
        )
        check("接口层：未读=0 且 2025-03-21 提醒已标 settled", api.get("unread") == 0 and bool(sample and sample.get("settled")))
        check("页面无控制台 error", not console_errors, " | ".join(console_errors[:3]))
        check("页面无 JS 异常", not page_errors, " | ".join(page_errors[:3]))

        print(f"\n截图：{os.path.relpath(shot, ROOT)}")
        browser.close()

    failed = [r for r in results if not r[1]]
    print(f"\n实测：{len(results) - len(failed)}/{len(results)} 通过")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
