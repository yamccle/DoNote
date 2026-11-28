# [INPUT]: 读取本地 GGUF 模型或 OpenAI-Compatible API 配置，接收系统提示词与待翻译指令。
# [OUTPUT]: 提供 GPU 自适应的 Llama 实例工厂、GGUF 推理封装、批量 JSON 解析与云端大模型并发请求函数。
# [POS]: 桌面端本地与云端大模型翻译共享引擎，供 local-llm-translate.py、pdfmathtranslate.py 与 bilingual-book-worker.py 复用。
# [PROTOCOL]: Update this header on change, then check AGENTS.md
import inspect
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

DELIM_PATTERN = re.compile(r"@@(\d+)@@")


def _prefer_vulkan_runtime():
    source_dir = Path(__file__).resolve().parent
    runtime_root = source_dir.parent if source_dir.name == "workers" else source_dir.parent / "video-runtime-build"
    vulkan_dir = os.environ.get("DONOTE_VULKAN_DEPS", "").strip()
    candidates = [Path(vulkan_dir)] if vulkan_dir else [runtime_root / "vulkan-dependencies"]
    for candidate in candidates:
        if candidate.is_dir():
            text = str(candidate)
            if text not in sys.path:
                sys.path.insert(0, text)


def uses_non_thinking_prompt(model_path):
    return Path(model_path).name.lower() in (
        "qwen3-0.6b-q8_0.gguf", "qwen3_0_6b-q8_0.gguf", "qwen3-1.7b-q4_k_m.gguf",
    )


def resolve_gpu_layers(llama_cpp_module):
    override = os.environ.get("DONOTE_LLM_GPU_LAYERS", "").strip()
    if override:
        try:
            return int(override)
        except ValueError:
            pass
    probe = getattr(llama_cpp_module, "llama_supports_gpu_offload", None)
    if callable(probe):
        try:
            if probe():
                return -1
        except Exception:
            pass
    return 0


def create_llama_instance(model_path, n_ctx=2048):
    _prefer_vulkan_runtime()
    import llama_cpp
    from llama_cpp import Llama

    threads = max(1, min(os.cpu_count() or 1, int(os.environ.get("DONOTE_LLM_THREADS", "12"))))
    gpu_layers = resolve_gpu_layers(llama_cpp)
    kwargs = {
        "model_path": str(model_path),
        "n_ctx": n_ctx,
        "n_batch": 512,
        "n_threads": threads,
        "n_threads_batch": threads,
        "n_gpu_layers": gpu_layers,
        "use_mmap": True,
        "verbose": False,
    }
    if gpu_layers != 0:
        try:
            params = inspect.signature(Llama.__init__).parameters
            if "flash_attn" in params:
                kwargs["flash_attn"] = True
        except Exception:
            pass
    return Llama(**kwargs)


def build_delimited_prompt(items, header):
    # items: list of strings; uses lightweight @@id@@ markers instead of JSON to save ~30% tokens & avoid {} collisions
    lines = [header, "严格保留每一段开头的 @@编号@@ 标记，不要合并、遗漏或解释，直接输出对应中文译文："]
    for idx, text in enumerate(items):
        lines.append(f"@@{idx}@@ {text}")
    return "\n".join(lines)


def parse_delimited_response(answer, count):
    text = str(answer or "").rsplit("</think>", 1)[-1].strip()
    matches = list(DELIM_PATTERN.finditer(text))
    mapped = {}
    for pos, match in enumerate(matches):
        idx = int(match.group(1))
        if 0 <= idx < count:
            start = match.end()
            end = matches[pos + 1].start() if pos + 1 < len(matches) else len(text)
            val = text[start:end].strip()
            if val:
                mapped[idx] = val
    return mapped


def parse_batch_json_response(answer, count):
    text = str(answer or "").rsplit("</think>", 1)[-1].strip()
    parsed = None
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        try:
            parsed = json.loads(text[text.index("["):text.rindex("]") + 1])
        except (ValueError, json.JSONDecodeError):
            parsed = None
    mapped = {}
    if isinstance(parsed, list):
        for item in parsed:
            if (isinstance(item, dict) and isinstance(item.get("id"), int)
                    and 0 <= item["id"] < count
                    and isinstance(item.get("zh"), str) and item["zh"].strip()):
                mapped[item["id"]] = item["zh"].strip()
    return mapped


def normalize_chat_completions_url(base_url):
    url = str(base_url or "").strip().rstrip("/")
    if not url:
        raise ValueError("未配置云端大模型接口地址（Base URL）。")
    if url.endswith("/chat/completions"):
        return url
    if url.endswith("/v1") or url.endswith("/compatible-mode/v1"):
        return url + "/chat/completions"
    return url + "/v1/chat/completions"


def openai_compatible_chat(config, system, instruction, max_tokens=2048, timeout=90):
    if not isinstance(config, dict):
        raise ValueError("云端大模型配置无效。")
    endpoint = normalize_chat_completions_url(config.get("baseUrl"))
    model = str(config.get("model") or "").strip()
    api_key = str(config.get("apiKey") or "").strip()
    if api_key.lower().startswith("bearer "):
        api_key = api_key[7:].strip()
    if not model:
        raise ValueError("未配置云端大模型名称（Model）。")
    body_bytes = json.dumps({
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": instruction},
        ],
        "temperature": 0.1,
        "max_tokens": max(128, min(8192, int(max_tokens))),
        "stream": False,
    }, ensure_ascii=False).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "DoNote-Desktop/1.0",
    }
    if api_key and api_key != "local":
        headers["Authorization"] = "Bearer " + api_key

    raw = None
    for attempt in range(3):
        req = urllib.request.Request(endpoint, data=body_bytes, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read().decode("utf-8", errors="replace")
            break
        except urllib.error.HTTPError as err:
            detail = ""
            try:
                err_body = err.read().decode("utf-8", errors="replace")
                parsed_err = json.loads(err_body)
                if isinstance(parsed_err, dict) and isinstance(parsed_err.get("error"), dict):
                    detail = str(parsed_err["error"].get("message") or "")[:240]
                else:
                    detail = err_body[:240]
            except Exception:
                pass
            if err.code in (408, 429, 500, 502, 503, 504) and attempt < 2:
                time.sleep(0.6 * (attempt + 1))
                continue
            if err.code in (401, 403):
                raise RuntimeError(f"云端模型 API 密钥无效或无权限 (HTTP {err.code})：{detail or err.reason}")
            if err.code == 402:
                raise RuntimeError(f"云端模型账户余额不足 (HTTP 402)：{detail or err.reason}")
            raise RuntimeError(f"云端模型接口返回 HTTP {err.code}：{detail or err.reason}")
        except (urllib.error.URLError, TimeoutError, OSError) as err:
            if attempt < 2:
                time.sleep(0.6 * (attempt + 1))
                continue
            reason = getattr(err, "reason", None) or err
            raise RuntimeError(f"无法连接云端模型接口：{reason}")

    payload = json.loads(raw)
    choices = payload.get("choices") or []
    if not choices:
        raise RuntimeError("云端模型未返回任何结果。")
    message = choices[0].get("message") or {}
    content = message.get("content") or ""
    finish_reason = choices[0].get("finish_reason") or "stop"
    return content, finish_reason


class PdfGgufTranslation:
    def __init__(self):
        self.model = None
        self.model_key = None

    def close(self):
        if self.model is not None:
            self.model.close()
            self.model = None
        self.model_key = None

    def warmup(self, model_path):
        info = model_path.stat()
        key = (model_path, info.st_size, info.st_mtime_ns)
        if self.model_key != key:
            self.close()
            self.model = create_llama_instance(model_path, n_ctx=3072)
            self.model_key = key

    def complete(self, model_path, system, instruction, max_tokens):
        self.warmup(model_path)

        options = {
            "temperature": 0.1,
            "top_p": 0.85,
            "repeat_penalty": 1.04,
            "max_tokens": max_tokens,
        }
        if uses_non_thinking_prompt(model_path):
            # Match Qwen3's ChatML template with enable_thinking=False.
            # An empty reasoning prefix avoids spending CPU time generating it.
            prompt = (
                "<|im_start|>system\n" + system + "<|im_end|>\n"
                "<|im_start|>user\n" + instruction + "<|im_end|>\n"
                "<|im_start|>assistant\n<think>\n\n</think>\n\n"
            )
            tokens = self.model.tokenize(prompt.encode("utf-8"), add_bos=False, special=True)
            choice = self.model.create_completion(tokens, stop=["<|im_end|>"], **options)["choices"][0]
            return choice["text"], choice["finish_reason"]
        choice = self.model.create_chat_completion(
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": instruction},
            ],
            **options,
        )["choices"][0]
        return choice["message"].get("content"), choice["finish_reason"]

    def complete_delimited_stream(self, model_path, system, items, header, max_tokens, on_item=None, is_cancelled=None):
        self.warmup(model_path)
        instruction = build_delimited_prompt(items, header)
        options = {
            "temperature": 0.1,
            "top_p": 0.85,
            "repeat_penalty": 1.04,
            "max_tokens": max_tokens,
            "stream": True,
        }
        if uses_non_thinking_prompt(model_path):
            prompt = (
                "<|im_start|>system\n" + system + "<|im_end|>\n"
                "<|im_start|>user\n" + instruction + "<|im_end|>\n"
                "<|im_start|>assistant\n<think>\n\n</think>\n\n@@0@@ "
            )
            tokens = self.model.tokenize(prompt.encode("utf-8"), add_bos=False, special=True)
            stream_iter = self.model.create_completion(tokens, stop=["<|im_end|>"], **options)
            prefix_seed = "@@0@@ "
        else:
            stream_iter = self.model.create_chat_completion(
                messages=[
                    {"role": "system", "content": system},
                    {"role": "user", "content": instruction},
                ],
                **options,
            )
            prefix_seed = ""

        buf = prefix_seed
        emitted = set()
        for chunk in stream_iter:
            if is_cancelled and is_cancelled():
                break
            choices = chunk.get("choices") or []
            if not choices:
                continue
            delta = choices[0].get("text") if "text" in choices[0] else (choices[0].get("delta") or {}).get("content")
            if not delta:
                continue
            buf += delta
            if on_item and "</think>" not in delta:
                visible = buf.rsplit("</think>", 1)[-1]
                matches = list(DELIM_PATTERN.finditer(visible))
                # Whenever marker k+1 appears, item at matches[k] is 100% complete!
                for pos in range(len(matches) - 1):
                    idx = int(matches[pos].group(1))
                    if 0 <= idx < len(items) and idx not in emitted:
                        seg = visible[matches[pos].end():matches[pos + 1].start()].strip()
                        emitted.add(idx)
                        if seg:
                            on_item(idx, seg)

        mapped = parse_delimited_response(buf, len(items))
        if on_item:
            for idx, val in mapped.items():
                if idx not in emitted and val:
                    emitted.add(idx)
                    on_item(idx, val)
        return mapped
