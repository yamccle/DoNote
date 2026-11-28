# [INPUT]: 读取本地 GGUF 模型或 OpenAI-Compatible API 配置，接收系统提示词与待翻译指令。
# [OUTPUT]: 提供 GPU 自适应的 Llama 实例工厂、GGUF 推理封装、批量 JSON 解析与云端大模型并发请求函数。
# [POS]: 桌面端本地与云端大模型翻译共享引擎，供 local-llm-translate.py、pdfmathtranslate.py 与 bilingual-book-worker.py 复用。
# [PROTOCOL]: Update this header on change, then check AGENTS.md
import inspect
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path


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


def create_llama_instance(model_path, n_ctx=8192):
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
    if not model:
        raise ValueError("未配置云端大模型名称（Model）。")
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": instruction},
        ],
        "temperature": 0.1,
        "max_tokens": max(128, min(8192, int(max_tokens))),
        "stream": False,
    }
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    if api_key:
        headers["Authorization"] = "Bearer " + api_key
    req = urllib.request.Request(
        endpoint,
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as err:
        detail = ""
        try:
            detail = err.read().decode("utf-8", errors="replace")[:300]
        except Exception:
            pass
        raise RuntimeError(f"云端模型接口返回 HTTP {err.code}：{detail or err.reason}")
    except urllib.error.URLError as err:
        raise RuntimeError(f"无法连接云端模型接口：{err.reason}")

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

    def complete(self, model_path, system, instruction, max_tokens):
        info = model_path.stat()
        key = (model_path, info.st_size, info.st_mtime_ns)
        if self.model_key != key:
            self.close()
            self.model = create_llama_instance(model_path, n_ctx=8192)
            self.model_key = key

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
