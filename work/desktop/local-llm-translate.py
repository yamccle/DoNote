import json
import os
import re
import sys
from pathlib import Path

SOURCE_DIR = Path(__file__).resolve().parent
RUNTIME_ROOT = SOURCE_DIR.parent if SOURCE_DIR.name == "workers" else SOURCE_DIR.parent / "video-runtime-build"
APP_ROOT = RUNTIME_ROOT.parent
DEPENDENCIES = RUNTIME_ROOT / "translation-dependencies"
sys.path[:0] = [str(SOURCE_DIR), str(DEPENDENCIES)]

from pdf_gguf_translation import PdfGgufTranslation, uses_non_thinking_prompt

SYSTEM_PROMPT = """你是专业的英译中技术翻译，服务对象是模拟集成电路、电子工程和学术论文读者。
只输出简体中文译文，不解释、不总结、不添加原文没有的信息，不使用 Markdown 代码块。
准确保留公式、符号、缩写、数字、单位、型号及专有名词；结合 CONTEXT 消歧，但不要翻译或复述 CONTEXT。
技术术语优先采用中文集成电路领域通行译法；没有稳定译法的缩写保留英文。"""

LANG_NAMES = {
    "en": "英语",
    "zh": "简体中文",
    "de": "德语",
    "fr": "法语",
}

llama_model = None
model_path = None
gguf = PdfGgufTranslation()


def clean_unicode(value):
    text = str(value or "").replace("\x00", "")
    return re.sub(r"[\ud800-\udfff]", "\ufffd", text)


def clean_payload(value):
    if isinstance(value, str):
        return clean_unicode(value)
    if isinstance(value, list):
        return [clean_payload(item) for item in value]
    if isinstance(value, dict):
        return {clean_unicode(key): clean_payload(item) for key, item in value.items()}
    return value


def emit(payload):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError):
        pass
    print(json.dumps(clean_payload(payload), ensure_ascii=False), flush=True)


def clean_answer(value):
    text = clean_unicode(value).strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else text[3:]
        if text.rstrip().endswith("```"):
            text = text.rstrip()[:-3].rstrip()
    for prefix in ("简体中文译文：", "译文：", "Translation:"):
        if text.startswith(prefix):
            text = text[len(prefix):].strip()
    return text.replace("<|im_end|>", "").strip()


def complete(messages, maximum):
    if uses_non_thinking_prompt(model_path):
        content, reason = gguf.complete(
            Path(model_path), messages[0]["content"], messages[1]["content"], max(256, min(4096, maximum))
        )
        if reason == "length":
            raise RuntimeError("本地模型未返回完整译文。")
        return clean_answer(content)
    result = llama_model.create_chat_completion(
        messages=messages,
        temperature=0.15,
        top_p=0.85,
        repeat_penalty=1.04,
        max_tokens=max(256, min(6144, maximum)),
        stream=False,
    )
    content = result.get("choices", [{}])[0].get("message", {}).get("content", "")
    return clean_answer(content)


def load_model():
    global llama_model
    if llama_model is not None:
        return
    if not model_path:
        raise RuntimeError("未找到本地翻译模型。")
    if not os.path.isfile(model_path):
        raise RuntimeError("未找到本地翻译模型：" + os.path.basename(model_path))
    if uses_non_thinking_prompt(model_path):
        return
    from llama_cpp import Llama
    threads = max(2, min(12, int(os.environ.get("DONOTE_LLM_THREADS", "12"))))
    llama_model = Llama(
        model_path=model_path,
        n_ctx=16384,
        n_batch=256,
        n_threads=threads,
        n_threads_batch=threads,
        n_gpu_layers=0,
        use_mmap=True,
        verbose=False,
    )


def translate_text(text, context, source, target):
    load_model()
    source_name = LANG_NAMES.get(source, source)
    target_name = LANG_NAMES.get(target, target)
    prompt = f"把以下{source_name}原文翻译成{target_name}，只输出译文。"
    extra = str(context or "").replace(text, "", 1).strip()
    choices = [prompt]
    if extra and not uses_non_thinking_prompt(model_path):
        choices.insert(0, prompt + "\n术语参考（仅供理解）：" + extra[:3600])
    for instruction in choices:
        value = complete(
            [{"role": "system", "content": f"你是专业技术翻译。准确保留数字、单位、公式和缩写。只输出{target_name}译文。"},
             {"role": "user", "content": instruction + "\n原文：\n" + text}],
            max(256, len(text) * 2 + 128),
        )
        needs_chinese = target == "zh" and len(re.findall(r"[A-Za-z]{2,}", text)) > 3
        if value and (not needs_chinese or re.search(r"[\u3400-\u9fff]", value)):
            return value
    raise RuntimeError("本地模型未返回有效译文。")


def translate_batch(texts, target):
    load_model()
    target_name = LANG_NAMES.get(target, target)
    values = []
    for offset in range(0, len(texts), 10):
        group = texts[offset:offset + 10]
        numbered = [{"id": index, "en": text} for index, text in enumerate(group)]
        user = (
            "将下面的学术视频英文字幕逐条翻译为" + target_name + "。"
            "结合相邻条目理解上下文，保留缩写、数字和单位；不要合并、遗漏或增加条目。"
            "严格返回 JSON 数组，只含 id 和 zh 字段。字幕数据如下：\n"
            + json.dumps(numbered, ensure_ascii=False)
        )
        answer = complete(
            [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": user}],
            max(512, sum(len(text) for text in group) * 2 + 256),
        )
        parsed = None
        try:
            parsed = json.loads(answer)
        except json.JSONDecodeError:
            try:
                parsed = json.loads(answer[answer.index("["):answer.rindex("]") + 1])
            except (ValueError, json.JSONDecodeError):
                pass
        mapped = {}
        if isinstance(parsed, list):
            for item in parsed:
                if (isinstance(item, dict) and isinstance(item.get("id"), int)
                        and 0 <= item["id"] < len(group)
                        and isinstance(item.get("zh"), str) and item["zh"].strip()):
                    mapped[item["id"]] = item["zh"].strip()
        translated = []
        for index, text in enumerate(group):
            value = mapped.get(index)
            if not value:
                context = "\n".join(group[max(0, index - 2):index + 3])
                value = translate_text(text, context, "en", target)
            translated.append(value)
        values.extend(translated)
    return values


def main():
    if len(sys.argv) < 2:
        raise RuntimeError("缺少本地翻译模型路径。")
    global model_path
    model_path = os.path.abspath(sys.argv[1])
    for line in sys.stdin:
        request_id = ""
        try:
            request = json.loads(line)
            request_id = str(request.get("request") or "")
            mode = request.get("mode")
            if mode == "batch":
                texts = request.get("texts")
                if (not isinstance(texts, list) or not 1 <= len(texts) <= 30000
                        or any(not isinstance(text, str) or not text.strip() for text in texts)):
                    raise ValueError("字幕内容无效。")
                emit({"request": request_id, "values": translate_batch(texts, request.get("target", "zh"))})
            else:
                text = request.get("text")
                if not isinstance(text, str) or not text.strip() or len(text) > 14000:
                    raise ValueError("翻译内容无效或过长。")
                emit({
                    "request": request_id,
                    "text": translate_text(
                        text,
                        request.get("context", ""),
                        request.get("source", "en"),
                        request.get("target", "zh"),
                    ),
                })
        except Exception as error:
            emit({"request": request_id, "error": str(error)[:450]})


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        emit({"request": "", "error": str(error)[:450]})
        sys.exit(1)
