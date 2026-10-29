#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
轻量 PDF 表格 worker（docs/86 第二阶段第 3 节）
============================================================
只用 pdfplumber 读取指定本地 PDF，逐页输出：
  · 真实页码（1 起）、页宽高、文本字符数、是否有文本层；
  · 每张表的页码、表序号、行列数、二维单元格文本、单元格行列；
  · 成功/失败页与处理页数，供 Node 计算真实 coverage/partial。

安全/资源边界由父进程负责（路径根、文件大小、页数、超时、并发）。
本脚本自身也做基本校验，不访问网络、不写除 --out 之外的文件。

依赖：pdfplumber（MIT）。不安装/调用任何重型模型。
"""
import argparse
import json
import os
import sys
import time

MAX_OUTPUT_BYTES = 16 * 1024 * 1024


def clean_cell(value):
    if value is None:
        return ""
    text = str(value).replace("\x00", " ").replace("\r", " ").replace("\n", " ")
    return " ".join(text.split())


def trim_table(rows):
    """去掉尾部全空行、每行尾部全空列；保留真实行列位置（0 起）。"""
    rows = [list(r or []) for r in (rows or [])]
    while rows and not any(clean_cell(c) for c in rows[-1]):
        rows.pop()
    width = 0
    for r in rows:
        for idx, cell in enumerate(r):
            if clean_cell(cell):
                width = max(width, idx + 1)
    trimmed = []
    for r in rows:
        trimmed.append([clean_cell(c) for c in r[:width]] + [""] * max(0, width - len(r)))
    return trimmed, len(trimmed), width


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--file", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--max-pages", type=int, default=200)
    parser.add_argument("--max-tables", type=int, default=2000)
    parser.add_argument("--max-cells", type=int, default=200000)
    parser.add_argument("--timeout-sec", type=float, default=60.0)
    args = parser.parse_args()

    started = time.time()
    file_path = os.path.abspath(args.file)
    out_path = os.path.abspath(args.out)
    result = {
        "ok": False,
        "parser": "pdfplumber",
        "parser_version": None,
        "pages_total": 0,
        "pages_processed": 0,
        "pages_with_tables": 0,
        "pages_failed": 0,
        "table_count": 0,
        "row_count": 0,
        "cell_count": 0,
        "truncated": False,
        "aborted": None,
        "error": None,
        "pages": [],
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }

    if not os.path.isfile(file_path):
        result["error"] = "文件不存在或不是普通文件"
        write_json(out_path, result)
        return 2
    if os.path.getsize(file_path) <= 0:
        result["error"] = "文件为空"
        write_json(out_path, result)
        return 2
    if args.max_pages < 1:
        result["error"] = "max-pages 必须 >= 1"
        write_json(out_path, result)
        return 2

    try:
        import pdfplumber
        result["parser_version"] = getattr(pdfplumber, "__version__", "unknown")
    except Exception as exc:  # noqa: BLE001 - 真实原因返回给父进程
        result["error"] = f"pdfplumber 不可用：{exc}"
        write_json(out_path, result)
        return 3

    try:
        with pdfplumber.open(file_path) as pdf:
            result["pages_total"] = len(pdf.pages)
            limit = min(len(pdf.pages), args.max_pages)
            for index in range(limit):
                if time.time() - started > args.timeout_sec:
                    result["aborted"] = "timeout"
                    result["error"] = "worker 自身时间上限已到，未继续处理剩余页"
                    break
                page = pdf.pages[index]
                page_no = index + 1
                entry = {
                    "page": page_no,
                    "width": round(float(page.width or 0), 2),
                    "height": round(float(page.height or 0), 2),
                    "text_chars": 0,
                    "has_text_layer": False,
                    "table_count": 0,
                    "row_count": 0,
                    "cell_count": 0,
                    "status": "ok",
                    "error": None,
                    "tables": [],
                }
                try:
                    text = page.extract_text() or ""
                    compact = "".join(str(text).split())
                    entry["text_chars"] = len(compact)
                    entry["has_text_layer"] = bool(compact)
                except Exception as exc:  # noqa: BLE001
                    entry["status"] = "failed"
                    entry["error"] = f"extract_text 失败：{exc}"
                    result["pages_failed"] += 1
                    result["pages"].append(entry)
                    result["pages_processed"] += 1
                    continue

                try:
                    raw_tables = page.extract_tables() or []
                except Exception as exc:  # noqa: BLE001
                    entry["status"] = "failed"
                    entry["error"] = f"extract_tables 失败：{exc}"
                    result["pages_failed"] += 1
                    result["pages"].append(entry)
                    result["pages_processed"] += 1
                    continue

                for table_index, raw in enumerate(raw_tables):
                    rows, row_count, col_count = trim_table(raw)
                    if row_count == 0 or col_count == 0:
                        continue
                    if result["table_count"] >= args.max_tables:
                        result["truncated"] = True
                        result["aborted"] = "max_tables"
                        break
                    cells = []
                    for r, row in enumerate(rows):
                        for c, cell in enumerate(row):
                            if cell:
                                cells.append({"row": r, "col": c, "text": cell})
                    if result["cell_count"] + len(cells) > args.max_cells:
                        result["truncated"] = True
                        result["aborted"] = "max_cells"
                        break
                    table = {
                        "table_index": table_index,
                        "rows": row_count,
                        "cols": col_count,
                        "cells": cells,
                        "data": rows,
                    }
                    entry["tables"].append(table)
                    entry["table_count"] += 1
                    entry["row_count"] += row_count
                    entry["cell_count"] += len(cells)
                    result["table_count"] += 1
                    result["row_count"] += row_count
                    result["cell_count"] += len(cells)
                if not entry["has_text_layer"] and entry["table_count"] == 0:
                    entry["status"] = "empty"
                    entry["error"] = "该页没有可提取文本层或表格（扫描/空白页）；不能据此判定企业数为零"
                result["pages_with_tables"] += 1 if entry["table_count"] > 0 else 0
                result["pages_processed"] += 1
                result["pages"].append(entry)
                if result["aborted"] in ("max_tables", "max_cells"):
                    break
    except Exception as exc:  # noqa: BLE001
        result["error"] = f"pdfplumber 打开/解析失败：{exc}"
        write_json(out_path, result)
        return 4

    result["ok"] = result["error"] is None and result["pages_processed"] > 0
    write_json(out_path, result)
    return 0 if result["ok"] else 5


def write_json(path, payload):
    data = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    raw = data.encode("utf-8")
    if len(raw) > MAX_OUTPUT_BYTES:
        payload = {
            "ok": False,
            "parser": "pdfplumber",
            "parser_version": payload.get("parser_version"),
            "pages_total": payload.get("pages_total", 0),
            "pages_processed": payload.get("pages_processed", 0),
            "error": f"worker 输出超过 {MAX_OUTPUT_BYTES} 字节上限，已拒绝写入",
            "aborted": "output_too_large",
            "pages": [],
        }
        raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    with open(path, "wb") as fh:
        fh.write(raw)


if __name__ == "__main__":
    sys.exit(main())
