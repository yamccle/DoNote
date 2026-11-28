import ast
import contextlib
import json
import os
import re
import sys
import traceback
from collections import Counter
from pathlib import Path

SOURCE_DIR = Path(__file__).resolve().parent
RUNTIME = SOURCE_DIR.parent if SOURCE_DIR.name == "workers" else SOURCE_DIR.parent / "video-runtime-build"
BABELDOC_CACHE = RUNTIME / "babeldoc-cache"
SYS_PATHS = [
    SOURCE_DIR,
    RUNTIME / "pdfmathtranslate-src",
    RUNTIME / "pdfmathtranslate-dependencies",
    RUNTIME / "mineru-dependencies",
    RUNTIME / "translation-dependencies",
    RUNTIME / "dependencies",
]
sys.path[:0] = [str(path) for path in SYS_PATHS]

from concurrent.futures import ThreadPoolExecutor
from pdf_gguf_translation import PdfGgufTranslation, openai_compatible_chat, parse_batch_json_response
from offline_en_zh import HAN_CHAR, LATIN_WORD, OfflineEnglishToChinese, valid_english_to_chinese

FORMULA = re.compile(r"\{\s*v\s*(\d+(?:\s+\d+)*)\s*\}", re.IGNORECASE)
FORMULA_OR_TEXT = re.compile(r"\{v\d+\}|[^{}]+|[{}]")
OUTPUT = sys.stdout
GGUF = PdfGgufTranslation()
LAYOUT = None
OFFLINE = None


def clean_unicode(value):
    text = str(value or "").replace("\x00", "")
    return text.encode("utf-16-le", errors="surrogatepass").decode("utf-16-le", errors="replace")


def normalise_formula_tokens(text):
    return FORMULA.sub(lambda match: "{v" + "".join(match[1].split()) + "}", text)


def clean_answer(value):
    text = clean_unicode(value).rsplit("</think>", 1)[-1].strip()
    if "<think>" in text:
        return ""
    if text.startswith("```") and text.endswith("```") and "\n" in text:
        text = text.split("\n", 1)[1][:-3].strip()
    for prefix in ("简体中文译文：", "译文：", "Translation:"):
        if text.startswith(prefix):
            text = text[len(prefix):].strip()
            break
    return normalise_formula_tokens(text)


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False), file=OUTPUT, flush=True)


def load_layout_model(model_path):
    from pdf2zh.doclayout import OnnxModel, onnxruntime

    if not model_path.is_file():
        raise ValueError("PDFMathTranslate 版面模型缺失，请更新完整版本。")

    class DoNoteLayoutModel(OnnxModel):
        def __init__(self):
            options = onnxruntime.SessionOptions()
            # NCHWc graph rewrites can produce a channel alignment error on
            # CPU. Always load the portable model, even if an older build
            # wrote a hardware-specific .optimized file next to it.
            options.graph_optimization_level = onnxruntime.GraphOptimizationLevel.ORT_ENABLE_EXTENDED
            self.model_path = str(model_path)
            self.model = onnxruntime.InferenceSession(
                self.model_path, options, providers=["CPUExecutionProvider"]
            )
            metadata = self.model.get_modelmeta().custom_metadata_map
            self._stride = ast.literal_eval(metadata["stride"])
            self._names = ast.literal_eval(metadata["names"])

    return DoNoteLayoutModel()


def main(request):
    global LAYOUT, OFFLINE
    if not isinstance(request, dict):
        raise ValueError("PDFMathTranslate 请求无效。")
    source = Path(str(request.get("source") or "")).resolve()
    output_dir = Path(str(request.get("output") or "")).resolve()
    model_path = Path(str(request.get("model") or "")).resolve()
    engine = request.get("engine", "gguf")
    openai_config = request.get("openai") if isinstance(request.get("openai"), dict) else None
    cascade_enabled = bool(request.get("cascade", True))
    start = int(request.get("start") or 0)
    end = int(request.get("end") or 0)
    mode = str(request.get("mode") or "full")
    test_translator = bool(request.get("testTranslator"))
    if not source.is_file():
        raise ValueError("找不到待翻译 PDF。")
    if start < 1 or end < start or end - start > 3:
        raise ValueError("PDFMathTranslate 每次只能处理 1–4 页。")
    if mode not in ("fast", "full"):
        raise ValueError("PDFMathTranslate 模式无效。")
    if engine not in ("gguf", "offline", "openai"):
        raise ValueError("PDFMathTranslate 翻译引擎无效。")
    if not test_translator and engine == "gguf" and not model_path.is_file():
        raise ValueError("尚未找到本地翻译模型。")
    if not test_translator and engine == "openai" and not openai_config:
        raise ValueError("尚未配置云端大模型接口。")
    output_dir.mkdir(parents=True, exist_ok=True)

    untranslated_pages = []
    skipped_paragraphs = 0
    with contextlib.redirect_stdout(sys.stderr):
        import pymupdf

        with pymupdf.open(str(source)) as document, pymupdf.open() as selected:
            if end > document.page_count:
                raise ValueError("PDF 页码范围超出文档页数。")
            selected.insert_pdf(document, from_page=start - 1, to_page=end - 1)
            # This copy only feeds the in-process layout engine. Compress and
            # deduplicate the translated output once, instead of doing both twice.
            stream = selected.tobytes()
            source_text = [page.get_text() for page in selected]

        # Leave scans and pages without extractable English text in the output.
        # Passing only text pages also keeps the layout engine from downloading OCR data.
        pages = [index for index, text in enumerate(source_text) if LATIN_WORD.search(text)]
        mono = stream
        if pages:
            import babeldoc.const as babeldoc_const
            import pdf2zh.converter as pdf2zh_converter
            from pdf2zh.config import ConfigManager
            from pdf2zh.high_level import translate_stream
            from pdf2zh.translator import BaseTranslator

            babeldoc_const.CACHE_FOLDER = BABELDOC_CACHE
            babeldoc_const.TIKTOKEN_CACHE_FOLDER = BABELDOC_CACHE / "tiktoken"
            babeldoc_const.TIKTOKEN_CACHE_FOLDER.mkdir(parents=True, exist_ok=True)
            os.environ["TIKTOKEN_CACHE_DIR"] = str(babeldoc_const.TIKTOKEN_CACHE_FOLDER)
            font_path = RUNTIME / "fonts" / "SourceHanSerifCN-Regular.ttf"
            if not font_path.is_file():
                raise ValueError("PDFMathTranslate 中文字体缺失。")
            if ConfigManager.get("NOTO_FONT_PATH") != str(font_path):
                ConfigManager.set("NOTO_FONT_PATH", str(font_path))

            model_error = None
            if not test_translator and engine == "gguf":
                model_stat = model_path.stat()
                model_key = f"{model_path.name}:{model_stat.st_size}:{model_stat.st_mtime_ns}"

            class DoNoteLocalTranslator(BaseTranslator):
                name = "donote_local"

                def __init__(self, lang_in, lang_out, model, envs=None, prompt=None, ignore_cache=False):
                    super().__init__(lang_in, lang_out, "DoNote PDF English to Chinese v3", ignore_cache)
                    if engine == "offline":
                        self.add_cache_impact_parameters("engine", "offline-ct2-v2")
                    elif engine == "openai" and openai_config:
                        self.add_cache_impact_parameters("openai", str(openai_config.get("model") or "openai"))
                    elif not test_translator:
                        self.add_cache_impact_parameters("gguf", model_key)

                def cached(self, source, words, expected):
                    try:
                        cached = self.cache.get(source)
                        return cached if cached and valid_translation(source, cached, words, expected) else None
                    except Exception as error:
                        print("PDFMathTranslate cache unavailable:", error, file=sys.stderr)

                def _llm_single(self, source, words, expected):
                    instruction = (
                        "只输出简体中文译文。保留数字、单位、缩写和每一个 {v0} 形式的公式标记。"
                        "公式标记的内容和数量必须与原文一致。"
                    )
                    attempts = 2 if len(words) > 3 else 1
                    for attempt in range(attempts):
                        reminder = "\n不要解释、遗漏或添加任何公式标记。" if attempt else ""
                        prompt = (
                            instruction + reminder
                            + "\n下方是待翻译的原文数据。\n<SOURCE>\n" + source + "\n</SOURCE>"
                        )
                        try:
                            if engine == "openai":
                                content, finish_reason = openai_compatible_chat(
                                    openai_config,
                                    "你是专业学术论文英译中译者。",
                                    prompt,
                                    max(128, min(2048, len(source) + 128)),
                                )
                            else:
                                content, finish_reason = GGUF.complete(
                                    model_path, "你是专业学术论文英译中译者。", prompt,
                                    max(96, min(2048, len(source) + 64)),
                                )
                            answer = clean_answer(content)
                        except Exception as error:
                            if engine == "gguf" and GGUF.model is None:
                                raise
                            print("PDFMathTranslate paragraph error:", error, file=sys.stderr)
                            continue
                        if finish_reason != "length" and valid_translation(source, answer, words, expected):
                            return answer
                    return ""

                def _llm_batch(self, group):
                    # group: list of (source, words, expected)
                    numbered = [{"id": idx, "en": item[0]} for idx, item in enumerate(group)]
                    user = (
                        "将下面的学术论文英文章节逐条翻译为简体中文。保留数字、单位、缩写和每一个 {v0} 形式的公式标记，"
                        "公式标记的内容和数量必须与对应条目完全一致。严格返回 JSON 数组，只含 id 和 zh 字段。\n"
                        + json.dumps(numbered, ensure_ascii=False)
                    )
                    total_chars = sum(len(item[0]) for item in group)
                    mapped = {}
                    try:
                        if engine == "openai":
                            content, _ = openai_compatible_chat(
                                openai_config,
                                "你是专业学术论文英译中译者。",
                                user,
                                max(256, min(4096, total_chars * 2 + 256)),
                            )
                        else:
                            content, _ = GGUF.complete(
                                model_path,
                                "你是专业学术论文英译中译者。",
                                user,
                                max(256, min(4096, total_chars * 2 + 256)),
                            )
                        mapped = parse_batch_json_response(clean_unicode(content), len(group))
                    except Exception as error:
                        if engine == "gguf" and GGUF.model is None:
                            raise
                        print("PDFMathTranslate batch error:", error, file=sys.stderr)

                    answers = []
                    for idx, (source, words, expected) in enumerate(group):
                        candidate = clean_answer(mapped.get(idx, "")) if idx in mapped else ""
                        if candidate and valid_translation(source, candidate, words, expected):
                            answers.append(candidate)
                        else:
                            answers.append(self._llm_single(source, words, expected))
                    return answers

                def translate_many(self, texts):
                    global OFFLINE
                    nonlocal model_error, skipped_paragraphs
                    if test_translator:
                        return [self.translate(text) for text in texts]
                    if engine == "offline":
                        return self._translate_many_offline(texts)
                    if engine == "openai":
                        return self._translate_many_openai(texts)
                    return self._translate_many_gguf_cascade(texts)

                def _translate_many_offline(self, texts):
                    global OFFLINE
                    nonlocal model_error, skipped_paragraphs
                    results = []
                    pending = []
                    cache_enabled = not (self.ignore_cache or self.no_cache)

                    def flush_pending():
                        global OFFLINE
                        nonlocal model_error, skipped_paragraphs
                        if not pending:
                            return
                        try:
                            if model_error is not None:
                                return
                            if OFFLINE is None:
                                GGUF.close()
                                OFFLINE = OfflineEnglishToChinese(RUNTIME / "translation-en-zh")
                            batch = [(results[index], words, expected) for index, words, expected in pending]
                            answers = offline_answers(OFFLINE, batch)
                            for (index, _, _), answer in zip(pending, answers):
                                if not answer:
                                    skipped_paragraphs += 1
                                    continue
                                if cache_enabled:
                                    self.cache.set(results[index], answer)
                                results[index] = answer
                                emit({"type": "pdf2zh-paragraph", "text": answer})
                        except Exception as error:
                            model_error = error
                        finally:
                            pending.clear()

                    first_batch = True
                    for text in texts:
                        source = normalise_formula_tokens(clean_unicode(text))
                        index = len(results)
                        results.append(source)
                        words = LATIN_WORD.findall(FORMULA.sub("", source))
                        if not words:
                            continue
                        expected = Counter(FORMULA.findall(source))
                        cached = self.cached(source, words, expected) if cache_enabled else None
                        if cached:
                            flush_pending()
                            emit({"type": "pdf2zh-paragraph", "text": cached})
                            results[index] = cached
                            first_batch = False
                            continue
                        pending.append((index, words, expected))
                        if len(pending) >= (1 if first_batch else 8):
                            flush_pending()
                            first_batch = False
                    flush_pending()
                    return results

                def _translate_many_gguf_cascade(self, texts):
                    global OFFLINE
                    nonlocal model_error, skipped_paragraphs
                    results = []
                    fast_items = []
                    llm_items = []
                    cache_enabled = not (self.ignore_cache or self.no_cache)

                    for text in texts:
                        source = normalise_formula_tokens(clean_unicode(text))
                        index = len(results)
                        results.append(source)
                        words = LATIN_WORD.findall(FORMULA.sub("", source))
                        if not words:
                            continue
                        expected = Counter(FORMULA.findall(source))
                        cached = self.cached(source, words, expected) if cache_enabled else None
                        if cached:
                            emit({"type": "pdf2zh-paragraph", "text": cached})
                            results[index] = cached
                            continue
                        # Cascade rule: simple short/medium blocks without formulas go to fast CT2 first.
                        if cascade_enabled and not expected and len(words) <= 18 and (RUNTIME / "translation-en-zh").is_dir():
                            fast_items.append((index, source, words, expected))
                        else:
                            llm_items.append((index, source, words, expected))

                    if fast_items:
                        try:
                            if OFFLINE is None:
                                OFFLINE = OfflineEnglishToChinese(RUNTIME / "translation-en-zh")
                            fast_answers = offline_answers(OFFLINE, [(src, w, exp) for _, src, w, exp in fast_items])
                            for (index, src, w, exp), answer in zip(fast_items, fast_answers):
                                if answer:
                                    if cache_enabled:
                                        self.cache.set(src, answer)
                                    results[index] = answer
                                    emit({"type": "pdf2zh-paragraph", "text": answer})
                                else:
                                    llm_items.append((index, src, w, exp))
                        except Exception as error:
                            print("Cascade offline fallback to GGUF:", error, file=sys.stderr)
                            llm_items.extend(fast_items)

                    if llm_items and model_error is None:
                        llm_items.sort(key=lambda item: item[0])
                        batches = []
                        current = []
                        current_chars = 0
                        for item in llm_items:
                            item_len = len(item[1])
                            if current and (len(current) >= 6 or current_chars + item_len > 1800):
                                batches.append(current)
                                current = []
                                current_chars = 0
                            current.append(item)
                            current_chars += item_len
                        if current:
                            batches.append(current)

                        for batch in batches:
                            if model_error is not None:
                                break
                            try:
                                if len(batch) == 1:
                                    ans_list = [self._llm_single(batch[0][1], batch[0][2], batch[0][3])]
                                else:
                                    ans_list = self._llm_batch([(it[1], it[2], it[3]) for it in batch])
                                for (index, src, _, _), answer in zip(batch, ans_list):
                                    if answer:
                                        if cache_enabled:
                                            self.cache.set(src, answer)
                                        results[index] = answer
                                        emit({"type": "pdf2zh-paragraph", "text": answer})
                                    else:
                                        skipped_paragraphs += 1
                            except Exception as error:
                                if GGUF.model is None:
                                    model_error = error
                                    break
                                skipped_paragraphs += len(batch)
                    return results

                def _translate_many_openai(self, texts):
                    nonlocal model_error, skipped_paragraphs
                    results = []
                    pending = []
                    cache_enabled = not (self.ignore_cache or self.no_cache)
                    for text in texts:
                        source = normalise_formula_tokens(clean_unicode(text))
                        index = len(results)
                        results.append(source)
                        words = LATIN_WORD.findall(FORMULA.sub("", source))
                        if not words:
                            continue
                        expected = Counter(FORMULA.findall(source))
                        cached = self.cached(source, words, expected) if cache_enabled else None
                        if cached:
                            emit({"type": "pdf2zh-paragraph", "text": cached})
                            results[index] = cached
                            continue
                        pending.append((index, source, words, expected))

                    if not pending:
                        return results
                    concurrency = max(1, min(16, int((openai_config or {}).get("concurrency") or 8)))
                    workers = min(concurrency, len(pending))
                    with ThreadPoolExecutor(max_workers=workers) as pool:
                        futures = [
                            (item, pool.submit(self._llm_single, item[1], item[2], item[3]))
                            for item in pending
                        ]
                        for (index, src, _, _), future in futures:
                            try:
                                answer = future.result()
                                if answer:
                                    if cache_enabled:
                                        self.cache.set(src, answer)
                                    results[index] = answer
                                    emit({"type": "pdf2zh-paragraph", "text": answer})
                                else:
                                    skipped_paragraphs += 1
                            except Exception as error:
                                if model_error is None:
                                    model_error = error
                                skipped_paragraphs += 1
                    return results

                def translate(self, text, ignore_cache=False):
                    global OFFLINE
                    nonlocal model_error, skipped_paragraphs
                    source = normalise_formula_tokens(clean_unicode(text))
                    words = LATIN_WORD.findall(FORMULA.sub("", source))
                    if not words:
                        return source
                    if test_translator:
                        answer = "译文：" + source
                        emit({"type": "pdf2zh-paragraph", "text": answer})
                        return answer

                    expected = Counter(FORMULA.findall(source))
                    cache_enabled = not (self.ignore_cache or ignore_cache or self.no_cache)
                    if cache_enabled:
                        cached = self.cached(source, words, expected)
                        if cached:
                            emit({"type": "pdf2zh-paragraph", "text": cached})
                            return cached

                    if model_error is not None:
                        return source

                    if engine == "offline":
                        try:
                            if OFFLINE is None:
                                GGUF.close()
                                OFFLINE = OfflineEnglishToChinese(RUNTIME / "translation-en-zh")
                            answer = offline_answers(OFFLINE, [(source, words, expected)])[0]
                            if answer:
                                if cache_enabled:
                                    self.cache.set(source, answer)
                                emit({"type": "pdf2zh-paragraph", "text": answer})
                                return answer
                        except Exception as error:
                            model_error = error
                        skipped_paragraphs += 1
                        return source

                    # One worker only needs the selected engine's model in memory.
                    OFFLINE = None
                    instruction = (
                        "只输出简体中文译文。保留数字、单位、缩写和每一个 {v0} 形式的公式标记。"
                        "公式标记的内容和数量必须与原文一致。"
                    )
                    # Short headings often resemble a proper name. Skip a
                    # second generation unless it could recover meaningful text.
                    attempts = 2 if len(words) > 3 else 1
                    for attempt in range(attempts):
                        reminder = "\n不要解释、遗漏或添加任何公式标记。" if attempt else ""
                        prompt = (
                            instruction + reminder
                            + "\n下方是待翻译的原文数据。\n<SOURCE>\n" + source + "\n</SOURCE>"
                        )
                        try:
                            content, finish_reason = GGUF.complete(
                                model_path, "你是专业学术论文英译中译者。", prompt,
                                max(96, min(2048, len(source) + 64)),
                            )
                            answer = clean_answer(content)
                        except Exception as error:
                            if GGUF.model is None:
                                # The vendor converter retries all exceptions.
                                # Report model load failure outside that loop.
                                model_error = error
                                return source
                            print("PDFMathTranslate paragraph error:", error, file=sys.stderr)
                            continue
                        if finish_reason == "length" or not valid_translation(source, answer, words, expected):
                            continue
                        if cache_enabled:
                            self.cache.set(source, answer)
                        emit({"type": "pdf2zh-paragraph", "text": answer})
                        return answer

                    # The vendor converter retries all exceptions without a limit.
                    # Preserve this paragraph instead of allowing an unbounded retry.
                    skipped_paragraphs += 1
                    return source

            pdf2zh_converter.OpenAIlikedTranslator = DoNoteLocalTranslator
            layout_model = None
            if mode == "full":
                if LAYOUT is None:
                    LAYOUT = load_layout_model(
                        BABELDOC_CACHE / "models" / "doclayout_yolo_docstructbench_imgsz1024.onnx"
                    )
                layout_model = LAYOUT
            mono, _ = translate_stream(
                stream,
                pages=pages,
                lang_in="en",
                lang_out="zh",
                service="donote_local",
                thread=1,
                model=layout_model,
                ultrafast=mode == "fast",
                mono_only=True,
            )
            if model_error is not None:
                label = "离线快速翻译模型" if engine == "offline" else "本地大模型"
                raise ValueError(f"无法加载{label}：{model_error}") from model_error

        with pymupdf.open(stream=mono, filetype="pdf") as translated:
            if translated.page_count != len(source_text):
                raise ValueError("译文页数与原文不一致。")
            for index, page in enumerate(translated):
                original_han = Counter(HAN_CHAR.findall(source_text[index]))
                translated_han = Counter(HAN_CHAR.findall(page.get_text()))
                if not translated_han - original_han:
                    untranslated_pages.append(start + index)
            if pages and mode == "fast":
                # The upstream fast path skips subsetting. Subset just the PDF
                # sent to the preview to avoid transferring the full CJK font.
                translated.subset_fonts()
                mono = translated.tobytes(deflate=True, garbage=3, use_objstms=1)

    mono_path = output_dir / "translated.pdf"
    mono_path.write_bytes(mono)
    emit({
        "type": "pdf2zh-result",
        "mono": str(mono_path),
        "monoSize": mono_path.stat().st_size,
        "untranslatedPages": untranslated_pages,
        "skippedParagraphs": skipped_paragraphs,
    })


def valid_translation(source, answer, words, expected):
    return bool(answer) and Counter(FORMULA.findall(answer)) == expected and valid_english_to_chinese(
        FORMULA.sub("", source), FORMULA.sub("", answer), words
    )


def offline_answers(translator, batch):
    sources = [source for source, _, _ in batch]
    primary = translator.translate(sources, beam_size=1, guarded=True)
    answers = [normalise_formula_tokens(clean_unicode(text)) for text in primary]
    retry = []
    formula_jobs = []
    formula_text = []

    for index, (source, words, expected) in enumerate(batch):
        if valid_translation(source, answers[index], words, expected):
            continue
        if not expected:
            retry.append(index)
            continue
        # Decode formula-adjacent fragments in one batch while preserving the
        # exact placeholder sequence and its punctuation in every paragraph.
        parts = FORMULA_OR_TEXT.findall(source)
        replacements = []
        for part_index, part in enumerate(parts):
            if FORMULA.fullmatch(part) or not LATIN_WORD.search(part):
                continue
            prefix, body, suffix = re.fullmatch(r"([\s,;:!?()\[\]]*)(.*?)([\s,;:!?()\[\]]*)", part, re.S).groups()
            replacements.append((part_index, prefix, suffix))
            formula_text.append(body)
        formula_jobs.append((index, parts, replacements, len(formula_text) - len(replacements)))

    if formula_text:
        translated = translator.translate(formula_text, beam_size=1, guarded=True)
        for index, parts, replacements, offset in formula_jobs:
            fragments = translated[offset:offset + len(replacements)]
            if all(fragments):
                for (part_index, prefix, suffix), text in zip(replacements, fragments):
                    parts[part_index] = prefix + text + suffix
                answers[index] = normalise_formula_tokens(clean_unicode("".join(parts)))
    if retry:
        translated = translator.translate([sources[index] for index in retry], beam_size=3, guarded=True)
        for index, text in zip(retry, translated):
            answers[index] = normalise_formula_tokens(clean_unicode(text))
    return [
        answer if valid_translation(source, answer, words, expected) else ""
        for answer, (source, words, expected) in zip(answers, batch)
    ]


def run(request_line):
    try:
        with contextlib.redirect_stdout(sys.stderr):
            main(json.loads(request_line))
    except Exception as error:
        traceback.print_exc(file=sys.stderr)
        emit({"type": "pdf2zh-result", "error": clean_unicode(error)[:800]})


if __name__ == "__main__":
    OUTPUT.reconfigure(encoding="utf-8", errors="replace")
    if sys.argv[1:] == ["--serve"]:
        try:
            with contextlib.redirect_stdout(sys.stderr):
                # The desktop starts the worker before uploading the source.
                # Warm the shared PDF runtime, leaving the requested engine lazy.
                import pymupdf
                import pdf2zh.high_level

                LAYOUT = load_layout_model(
                    BABELDOC_CACHE / "models" / "doclayout_yolo_docstructbench_imgsz1024.onnx"
                )
        except Exception:
            # The actual request can report a focused error if the layout model
            # is unavailable, while scans and fast mode can still proceed.
            traceback.print_exc(file=sys.stderr)
        for line in sys.stdin.buffer:
            run(line.decode("utf-8-sig", "replace"))
    else:
        run(sys.stdin.buffer.read().decode("utf-8-sig", "replace"))
