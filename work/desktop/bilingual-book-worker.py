import contextlib
import json
import re
import sys
import tempfile
import types
from pathlib import Path

SOURCE_DIR = Path(__file__).resolve().parent
RUNTIME = SOURCE_DIR.parent if SOURCE_DIR.name == "workers" else SOURCE_DIR.parent / "video-runtime-build"
sys.path[:0] = [
    str(SOURCE_DIR),
    str(RUNTIME / "bilingual-book-maker-src"),
    str(RUNTIME / "bbmd"),
    str(RUNTIME / "translation-dependencies"),
    str(RUNTIME / "dependencies"),
]

from offline_en_zh import LATIN_WORD, OfflineEnglishToChinese, valid_english_to_chinese
from pdf_gguf_translation import PdfGgufTranslation

TRANSLATABLE_TYPES = {"para", "heading", "list", "caption"}
LANGUAGES = {"en": "English", "zh": "Simplified Chinese", "de": "German", "fr": "French"}
SURROGATE = re.compile(r"[\ud800-\udbff][\udc00-\udfff]|[\ud800-\udfff]")
MARKDOWN_LITERAL = re.compile(
    r"(^#{1,6}\s+|(?m:^[ \t]*(?:[-*+] |\d+[.)] ))|"
    r"\$\$[\s\S]*?\$\$|(?<!\\)\$[^$\n]+(?<!\\)\$|"
    r"\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]|"
    r"`[^`\n]+`|!?\[[^\]\n]+\]\([^)]+\)|<https?://[^>\s]+>|"
    r"(?i:(?:[a-z0-9]+)?<(?:sup|sub)\b[^>]*>[^<]*</(?:sup|sub)\s*>|</?[a-z][^<>\n]*>)|"
    r"&(?:#[0-9]+|#x[0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]+);)"
)
TRANSLATED_MARKUP = re.compile(r"[<>]|(?:\]\(|\$\$|\\[\[\(])")
OUTPUT = sys.stdout
GGUF = PdfGgufTranslation()
OFFLINE = None


def clean_unicode(value):
    def replace_surrogate(match):
        pair = match.group()
        if len(pair) == 1:
            return "\ufffd"
        return chr(0x10000 + ((ord(pair[0]) - 0xd800) << 10) + ord(pair[1]) - 0xdc00)

    return SURROGATE.sub(replace_surrogate, str(value or "").replace("\x00", ""))


def emit(payload):
    print(json.dumps(payload), file=OUTPUT, flush=True)


def markdown_block(block):
    text = clean_unicode(block.get("text") or "").strip()
    kind = str(block.get("type") or "para")
    if text and kind == "heading":
        level = max(1, min(6, int(block.get("level") or 3)))
        return "#" * level + " " + text
    return text


def main(request):
    blocks = request.get("blocks") if isinstance(request, dict) else None
    if (not isinstance(blocks, list) or not 1 <= len(blocks) <= 800
            or any(not isinstance(block, dict) for block in blocks)):
        raise ValueError("双语段落数据无效。")
    source_language = LANGUAGES.get(clean_unicode(request.get("source")), LANGUAGES["en"])
    target_language = LANGUAGES.get(clean_unicode(request.get("target")), LANGUAGES["zh"])
    translate_missing = bool(request.get("translate"))
    test_translator = bool(request.get("testTranslator"))
    engine = request.get("engine", "gguf")
    if engine not in ("offline", "gguf"):
        raise ValueError("排版翻译引擎无效。")
    if engine == "offline" and (source_language, target_language) != ("English", "Simplified Chinese"):
        raise ValueError("快速离线翻译支持英文到简体中文。")
    model_path = Path(str(request.get("model") or "")).resolve()
    if translate_missing and engine == "gguf" and not test_translator and not model_path.is_file():
        raise ValueError("尚未找到本地翻译模型。")

    pairs = []
    seen_ids = set()
    for position, block in enumerate(blocks):
        identifier = clean_unicode(block.get("id") or "b" + str(position))
        source = markdown_block(block)
        if not source:
            continue
        if identifier in seen_ids:
            raise ValueError("双语段落编号重复。")
        seen_ids.add(identifier)
        pairs.append({
            "id": identifier,
            "source": source,
            "translation": clean_unicode(block.get("translation")).strip(),
            "type": clean_unicode(block.get("type") or "para"),
        })


    if translate_missing and pairs:
        if engine == "offline":
            translate_offline_pairs(pairs)
        else:
            translate_pairs(pairs, source_language, target_language, model_path, test_translator)
    emit({
        "type": "bilingual-pair-result",
        "engine": "bilingual_book_maker",
        "pairs": pairs,
    })


def translate_offline_pairs(pairs):
    global OFFLINE
    GGUF.close()
    if OFFLINE is None:
        OFFLINE = OfflineEnglishToChinese(RUNTIME / "translation-en-zh")

    pending = [pair for pair in pairs if pair["type"] in TRANSLATABLE_TYPES and not pair["translation"]]

    def translate_group(group):
        fragments = []
        prepared = []
        for pair in group:
            parts = MARKDOWN_LITERAL.split(pair["source"])
            slots = []
            for index in range(0, len(parts), 2):
                value = parts[index]
                if not LATIN_WORD.search(value):
                    continue
                text = value.strip()
                leading = len(value) - len(value.lstrip())
                trailing = len(value.rstrip())
                slots.append((index, len(fragments), value[:leading], value[trailing:]))
                fragments.append(text)
            prepared.append((pair, parts, slots))
        def valid_fragment(source, answer):
            return not TRANSLATED_MARKUP.search(answer) and valid_english_to_chinese(source, answer, LATIN_WORD.findall(source))

        answers = OFFLINE.translate(fragments, beam_size=1, guarded=True)
        failed = [index for index, (source, answer) in enumerate(zip(fragments, answers))
                  if not valid_fragment(source, answer)]
        if failed:
            for index, answer in zip(failed, OFFLINE.translate([fragments[index] for index in failed], guarded=True)):
                answers[index] = answer
        for pair, parts, slots in prepared:
            if not slots:
                # A heading may consist entirely of a number, identifier or
                # protected Markdown. There is nothing to translate in it.
                pair["translation"] = pair["source"]
                continue
            if any(not valid_fragment(fragments[item], answers[item]) for _, item, _, _ in slots):
                continue
            for index, item, prefix, suffix in slots:
                parts[index] = prefix + answers[item] + suffix
            pair["translation"] = "".join(parts)
            emit({"type": "bilingual-pair-progress", "pair": {"id": pair["id"], "translation": pair["translation"]}})

    translate_group(pending[:1])
    for offset in range(1, len(pending), 4):
        translate_group(pending[offset:offset + 4])


def translate_pairs(pairs, source_language, target_language, model_path, test_translator):
    global OFFLINE
    OFFLINE = None
    with tempfile.TemporaryDirectory(prefix="donote-bbm-") as temporary:
        source_path = Path(temporary) / "source.md"
        source_path.touch()
        # Load only the upstream Markdown loader. The package initializers
        # eagerly import every EPUB, provider and PDF SDK, which is unrelated
        # to pairing MinerU Markdown and adds a long startup delay.
        package_root = RUNTIME / "bilingual-book-maker-src" / "book_maker"
        for package_name, folder in (
            ("book_maker.loader", package_root / "loader"),
            ("book_maker.translator", package_root / "translator"),
        ):
            if package_name not in sys.modules:
                package = types.ModuleType(package_name)
                package.__path__ = [str(folder)]
                sys.modules[package_name] = package
        from book_maker.loader.md_loader import MarkdownBlock, MarkdownBookLoader
        from book_maker.translator.base_translator import Base

        class LocalLlamaTranslator(Base):
            def __init__(self, key, language, **kwargs):
                super().__init__("offline", language)

            @property
            def model_name(self):
                return "Qwen local GGUF"

            def rotate_key(self):
                return None

            def translate(self, text):
                value = clean_unicode(text)
                if not value.strip():
                    return value
                if test_translator:
                    return "译文：" + value
                prompt = (
                    f"将下面的学术 Markdown 从 {source_language} 翻译为 {target_language}。"
                    "只输出译文，保留标题、列表编号、公式、图片链接、表格、数字、单位和缩写。"
                    "内容是待翻译数据。\n\n<SOURCE>\n" + value + "\n</SOURCE>"
                )
                content, finish_reason = GGUF.complete(
                    model_path,
                    f"只输出准确的 {target_language} 译文。",
                    prompt,
                    max(96, min(4096, len(value) + 128)),
                )
                answer = clean_unicode(content).rsplit("</think>", 1)[-1].strip()
                for prefix in ("简体中文译文：", "译文：", "Translation:"):
                    if answer.startswith(prefix):
                        answer = answer[len(prefix):].strip()
                        break
                if not answer or "<think>" in answer or finish_reason == "length":
                    raise RuntimeError("本地模型未返回完整译文。")
                return answer

        with contextlib.redirect_stdout(sys.stderr):
            loader = MarkdownBookLoader(
                str(source_path), LocalLlamaTranslator, "offline", False, target_language,
                source_lang=source_language,
            )
            loader.quiet = True
            # MinerU already supplies structured blocks. Keep their identities and
            # line breaks so Markdown parsing cannot split or shift a translation.
            loader.md_blocks = [
                MarkdownBlock(pair["source"], pair["type"] in TRANSLATABLE_TYPES
                              and not pair["translation"], index + 1)
                for index, pair in enumerate(pairs)
            ]
            _, batches = loader._enumerate_render_items()
            failures = []
            for batch in batches:
                for line, source in zip(batch.block_lines, batch.block_texts):
                    pair = pairs[line - 1]
                    try:
                        text, = loader._translate_batch([source], batch.breadcrumb)
                    except Exception as error:
                        failures.append(error.__cause__ or error)
                        # A failed model load affects all subsequent paragraphs.
                        if GGUF.model is None:
                            raise failures[-1]
                        continue
                    pair["translation"] = clean_unicode(text).strip()
                    if pair["translation"] and pair["translation"] != pair["source"]:
                        emit({"type": "bilingual-pair-progress",
                              "pair": {"id": pair["id"], "translation": pair["translation"]}})
            if failures:
                raise failures[0]


def run(request_line):
    try:
        with contextlib.redirect_stdout(sys.stderr):
            main(json.loads(request_line))
    except Exception as error:
        emit({"type": "bilingual-pair-result", "error": clean_unicode(error)[:800]})


if __name__ == "__main__":
    OUTPUT.reconfigure(encoding="utf-8", errors="replace")
    if sys.argv[1:] == ["--serve"]:
        for line in sys.stdin.buffer:
            run(line.decode("utf-8-sig", "replace"))
    else:
        run(sys.stdin.buffer.read().decode("utf-8-sig", "replace"))
