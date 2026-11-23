import json
import re
import sys
from pathlib import Path


SOURCE_DIR = Path(__file__).resolve().parent
RUNTIME = SOURCE_DIR.parent if SOURCE_DIR.name == "workers" else SOURCE_DIR.parent / "video-runtime-build"
sys.path[:0] = [str(SOURCE_DIR), str(RUNTIME / "dependencies"), str(RUNTIME / "translation-dependencies")]

from offline_en_zh import OfflineEnglishToChinese

MAX_PAYLOAD_BYTES = 4 * 1024 * 1024


def clean_unicode(value):
    text = value.replace("\x00", "")
    return re.sub(r"[\ud800-\udfff]", "\ufffd", text)


def emit(**data):
    print(json.dumps(data, ensure_ascii=False), flush=True)


def translate_cues(texts, translator):
    translated = {}
    offset = 0
    while offset < len(texts):
        # Deliver a few cues first, then use full batches for throughput.
        batch = texts[offset:offset + (3 if offset == 0 else 12)]
        missing = list(dict.fromkeys(text for text in batch if text not in translated))
        if missing:
            values = translator.translate(missing)
            if len(values) != len(missing):
                raise ValueError("本地翻译返回的字幕数量不匹配。")
            for source, value in zip(missing, values):
                value = clean_unicode(value).strip()
                if not value:
                    raise ValueError("本地翻译返回了空白译文。")
                translated[source] = value
        values = [translated[text] for text in batch]
        emit(offset=offset, values=values)
        offset += len(batch)


def main():
    payload = sys.stdin.buffer.read(MAX_PAYLOAD_BYTES + 1)
    if len(payload) > MAX_PAYLOAD_BYTES:
        raise ValueError("字幕内容超出本地翻译范围。")
    texts = json.loads(payload)
    if (not isinstance(texts, list) or not 1 <= len(texts) <= 30000
            or any(not isinstance(text, str) or len(text) > 8000 for text in texts)):
        raise ValueError("字幕内容或数量超出本地翻译范围。")
    texts = [clean_unicode(text).strip() for text in texts]
    if not all(texts):
        raise ValueError("待翻译字幕包含空白内容。")

    translate_cues(texts, OfflineEnglishToChinese(RUNTIME / "translation-en-zh"))
    emit(done=True)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    try:
        main()
    except Exception as error:
        emit(error=clean_unicode(str(error))[:450])
        sys.exit(1)
