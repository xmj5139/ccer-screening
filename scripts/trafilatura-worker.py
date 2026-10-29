#!/usr/bin/env python3
"""可选 Trafilatura worker（docs/86 第一阶段）。

约束：
  - 单次读取一份 JSON（HTML + URL），向 stdout 输出一行 JSON；
  - 输入/输出有上限，超时由 Node 端进程管理器终止；
  - 未安装 trafilatura 时返回 ok=false 与明确 reason，绝不输出伪造正文；
  - 不访问网络，不解析外部实体（Trafilatura 只做本地 HTML 提取）。
"""
import json
import sys
import time

MAX_INPUT = 1_000_000
MAX_OUTPUT = 200_000


def main() -> None:
    started = time.time()
    try:
        payload = json.load(sys.stdin)
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "reason": "bad_input", "message": str(exc)}, ensure_ascii=False))
        return
    html = str(payload.get("html") or "")
    url = payload.get("url") or None
    max_chars = min(int(payload.get("max_chars") or MAX_OUTPUT), MAX_OUTPUT)
    if not html.strip():
        print(json.dumps({"ok": False, "reason": "empty_input", "message": "HTML 为空"}, ensure_ascii=False))
        return
    if len(html) > MAX_INPUT:
        print(json.dumps({"ok": False, "reason": "input_too_large", "message": "HTML 超过 1,000,000 字符"}, ensure_ascii=False))
        return
    try:
        import trafilatura  # type: ignore
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({
            "ok": False,
            "reason": "not_installed",
            "message": f"未安装 trafilatura（{exc}）；请由 Codex 按固定版本安装，当前回退规则清洗",
        }, ensure_ascii=False))
        return
    try:
        text = trafilatura.extract(
            html,
            url=url,
            include_tables=True,
            include_comments=False,
            include_formatting=False,
            favor_precision=True,
            output_format="txt",
        )
        if not text or not str(text).strip():
            print(json.dumps({"ok": False, "reason": "empty_output", "message": "Trafilatura 未提取到正文"}, ensure_ascii=False))
            return
        text = str(text).strip()[:max_chars]
        print(json.dumps({
            "ok": True,
            "text": text,
            "title": None,
            "version": getattr(trafilatura, "__version__", "unknown"),
            "chars": len(text),
            "latency_ms": int((time.time() - started) * 1000),
        }, ensure_ascii=False))
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "reason": "worker_error", "message": str(exc)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
