import ast
import contextlib
import json
import math
import re
import sys
from pathlib import Path


SOURCE_DIR = Path(__file__).resolve().parent
RUNTIME_ROOT = SOURCE_DIR.parent if SOURCE_DIR.name == "workers" else SOURCE_DIR.parent / "video-runtime-build"
sys.path[:0] = [
    str(RUNTIME_ROOT / "mineru-dependencies"),
    str(RUNTIME_ROOT / "dependencies"),
]

PAGE_FURNITURE = {"header", "footer", "page_number"}
FIGURE_TYPES = {"image", "chart"}
BODY_TYPES = {"text", "para", "ref_text"}


def clean_text(value):
    text = str(value or "").replace("\x00", "")
    return re.sub(r"[\ud800-\udfff]", "\ufffd", text)


def clean_payload(value):
    if isinstance(value, str):
        return clean_text(value)
    if isinstance(value, list):
        return [clean_payload(item) for item in value]
    if isinstance(value, tuple):
        return [clean_payload(item) for item in value]
    if isinstance(value, dict):
        return {clean_text(key): clean_payload(item) for key, item in value.items()}
    return value


def emit(payload):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError):
        pass
    print(json.dumps(clean_payload(payload), ensure_ascii=False, separators=(",", ":")), flush=True)


def collect_content(value):
    """Return only natural-language text from string/span/dict content."""
    if isinstance(value, str):
        text = clean_text(value).strip()
        if text[:1] in ("{", "["):
            try:
                parsed = ast.literal_eval(text)
            except (SyntaxError, ValueError):
                parsed = None
            if isinstance(parsed, (dict, list, tuple)):
                parsed_text = collect_content(parsed)
                if parsed_text:
                    return parsed_text
        return text
    if isinstance(value, (list, tuple)):
        parts = []
        for item in value:
            text = collect_content(item)
            if text:
                parts.append(text)
        return "\n".join(parts)
    if isinstance(value, dict):
        for key in ("content", "text", "value", "markdown", "latex"):
            if key in value:
                text = collect_content(value[key])
                if text:
                    return text
    return ""


def text_content(block):
    parts = []
    for key in ("content", "captions", "footnotes"):
        if key not in block:
            continue
        text = collect_content(block.get(key))
        if text and text not in parts:
            parts.append(text)
    return "\n".join(parts).strip()


def block_type(raw, block):
    raw = str(raw or "").lower()
    if raw in ("doc_title", "title", "paragraph_title") or "title" in raw or "heading" in raw:
        return "heading", int(block.get("level") or (2 if raw == "doc_title" else 3))
    if raw in ("table", "table_body"):
        return "table", 3
    if raw in ("equation", "interline_equation"):
        return "equation", 3
    if raw in ("list", "list_item"):
        return "list", 3
    if raw in ("code", "code_block"):
        return "code", 3
    return "para", 3



def normalized_bbox(value):
    if not isinstance(value, (tuple, list)) or len(value) != 4:
        return None
    if any(not isinstance(coordinate, (int, float)) or not math.isfinite(coordinate) for coordinate in value):
        return None
    x0, y0, x1, y1 = (min(1, max(0, coordinate)) for coordinate in value)
    return (x0, y0, x1, y1) if x1 > x0 and y1 > y0 else None


def keep_block(raw):
    kind = raw.get("type")
    if kind in PAGE_FURNITURE:
        return False
    bbox = normalized_bbox(raw.get("bbox"))
    if kind in BODY_TYPES and bbox:
        x0, y0, x1, y1 = bbox
        # Flash occasionally labels a marginal running number as body text.
        if x1 - x0 <= 0.07 and y1 - y0 <= 0.035 and (y1 <= 0.08 or y0 >= 0.92):
            return not re.fullmatch(r"\s*[–—-]?\s*\d{1,4}\s*[–—-]?\s*", collect_content(raw.get("content")))
    return True


def source_order(blocks):
    """Use geometry for figures when the text has one clear vertical flow."""
    body_boxes = [
        bbox for raw in blocks if raw.get("type") in BODY_TYPES
        if (bbox := normalized_bbox(raw.get("bbox"))) and bbox[2] - bbox[0] >= 0.20
    ]
    if not body_boxes:
        return blocks
    common_width = min(box[2] for box in body_boxes) - max(box[0] for box in body_boxes)
    if common_width < 0.15 or any(a[1] > b[1] for a, b in zip(body_boxes, body_boxes[1:])):
        return blocks

    def disjoint_before(first, second):
        return first[3] <= second[1] and max(first[0], second[0]) < min(first[2], second[2])

    ordered = []
    for raw in blocks:
        bbox = normalized_bbox(raw.get("bbox"))
        index = len(ordered)
        while bbox and index:
            previous = ordered[index - 1]
            previous_bbox = normalized_bbox(previous.get("bbox"))
            if not previous_bbox or not disjoint_before(bbox, previous_bbox):
                break
            if raw.get("type") not in FIGURE_TYPES and previous.get("type") not in FIGURE_TYPES:
                break
            index -= 1
        ordered.insert(index, raw)
    return ordered


def page_blocks(page):
    blocks = []
    kept = [raw for raw in page.get("blocks", []) if keep_block(raw)]
    has_text = any(raw.get("type") in BODY_TYPES | {"doc_title", "paragraph_title", "list"} for raw in kept)
    for raw in source_order(kept):
        kind = str(raw.get("type") or "").lower()
        if kind in FIGURE_TYPES:
            bbox = normalized_bbox(raw.get("bbox"))
            captions = raw.get("captions") or []
            caption = text_content({key: raw.get(key) for key in ("captions", "footnotes")})
            if bbox is None:
                if caption:
                    blocks.append({"type": "caption", "level": 3, "text": caption})
                continue
            x0, y0, x1, y1 = bbox
            if has_text and not caption and (x1 - x0) * (y1 - y0) >= 0.9:
                continue
            caption_above = bool(captions) and not raw.get("footnotes") and all(
                isinstance(item, dict) and (box := normalized_bbox(item.get("bbox"))) and box[3] <= y0
                for item in captions
            )
            blocks.append({
                "type": "image",
                "level": 3,
                "text": caption,
                "bbox": bbox,
                "captionAbove": caption_above,
            })
            continue
        body = collect_content(raw.get("content")).strip()
        if body:
            block_kind, level = block_type(kind, raw)
            blocks.append({"type": block_kind, "level": level, "text": body})
        caption = text_content({key: raw.get(key) for key in ("captions", "footnotes")})
        if caption and caption != body:
            blocks.append({"type": "caption", "level": 3, "text": caption})
    return blocks


def parse_pages(pdf, start_page, end_page, tier):
    if tier not in ("flash", "basic", "standard", "advanced"):
        raise ValueError("MinerU 解析档位无效。")
    start_page, end_page = int(start_page), int(end_page)
    if start_page < 1 or end_page < start_page or end_page - start_page > 20:
        raise ValueError("MinerU 页码范围无效。")

    # Auto OCR can initialize models for an empty PDF page. Skip only pages
    # with neither PDF page objects nor annotations.
    if start_page == end_page:
        from pypdfium2 import PdfDocument, raw

        with PdfDocument(pdf) as document:
            if start_page > len(document):
                raise ValueError("MinerU 页码超出 PDF 范围。")
            with contextlib.closing(document[start_page - 1]) as page:
                if raw.FPDFPage_CountObjects(page) == 0 and raw.FPDFPage_GetAnnotCount(page) == 0:
                    return {
                        "type": "mineru-reflow-result",
                        "pages": [{"page": start_page, "blocks": [], "blank": True}],
                        "tier": tier,
                        "source": "PDF",
                    }

    # MinerU and its backends are chatty; keep JSON on the original stdout.
    with contextlib.redirect_stdout(sys.stderr):
        from mineru.parser import parse
        result = parse(pdf, tier=tier, page_range=f"{start_page}-{end_page}")
        structured = result.structured_content()

    pages = [
        {"page": int(page.get("page_idx", 0)) + 1, "blocks": page_blocks(page)}
        for page in structured.get("pages", [])
        if start_page <= int(page.get("page_idx", 0)) + 1 <= end_page
    ]
    if not pages:
        raise ValueError("MinerU 未返回请求页的结构。")
    return {
        "type": "mineru-reflow-result",
        "pages": pages,
        "tier": tier,
        "source": "MinerU",
    }


def serve(pdf):
    for line in sys.stdin:
        try:
            request = json.loads(line)
            result = parse_pages(pdf, request["start"], request["end"], request["tier"])
        except Exception as error:
            result = {"type": "mineru-reflow-result", "error": str(error)[:600]}
        emit(result)


def main():
    if len(sys.argv) == 3 and sys.argv[1] == "--serve":
        serve(sys.argv[2])
        return
    if len(sys.argv) != 5:
        raise ValueError("MinerU 参数无效。")
    emit(parse_pages(*sys.argv[1:5]))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        emit({"type": "mineru-reflow-result", "error": str(error)[:600]})
        sys.exit(1)
