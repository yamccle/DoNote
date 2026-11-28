# [INPUT]: 读取本地 GGUF 模型、OpenAI-Compatible API、百度/微软专用翻译 API 配置及学科术语词表。
# [OUTPUT]: 提供 GPU 自适应的 Llama 实例工厂、流式批译解析、百度 QPS 自适应并发/词库请求及保公式术语对齐函数。
# [POS]: 桌面端多引擎翻译与术语对齐共享底座，供 local-llm-translate.py、pdfmathtranslate.py 与 bilingual-book-worker.py 复用。
# [PROTOCOL]: Update this header on change, then check AGENTS.md
import ast
from concurrent.futures import ThreadPoolExecutor
import hashlib
import inspect
import json
import os
import random
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
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


def normalize_glossary_pairs(raw):
    if not isinstance(raw, list):
        return []
    seen = set()
    cleaned = []
    for row in raw[:500]:
        if isinstance(row, (list, tuple)) and len(row) >= 2:
            en, zh = str(row[0] or "").strip(), str(row[1] or "").strip()
        elif isinstance(row, dict):
            en = str(row.get("en") or row.get("source") or "").strip()
            zh = str(row.get("zh") or row.get("target") or "").strip()
        else:
            continue
        key = en.lower()
        if len(en) < 2 or len(en) > 120 or not zh or len(zh) > 120 or key in seen:
            continue
        seen.add(key)
        cleaned.append((en, zh))
    cleaned.sort(key=lambda item: len(item[0]), reverse=True)
    return cleaned


def match_glossary_for_texts(texts, glossary, limit=48):
    if not glossary or not texts:
        return []
    joined = "\n".join(str(t or "") for t in texts)
    matched = []
    for en, zh in glossary:
        pat = re.compile(r"(?<![A-Za-z0-9_-])" + re.escape(en) + r"(?![A-Za-z0-9_-])", re.IGNORECASE)
        if pat.search(joined):
            matched.append((en, zh))
            if len(matched) >= limit:
                break
    return matched


def format_glossary_prompt_hint(texts, glossary, limit=48):
    matched = match_glossary_for_texts(texts, glossary, limit=limit)
    if not matched:
        return ""
    pairs_str = "；".join(f"{en}={zh}" for en, zh in matched)
    return f"\n专业术语约束（若原文出现以下术语，请严格采用指定中文译名）：{pairs_str}。"


_FORMULA_SPLIT_RE = re.compile(r"([｛{]\s*v\s*\d+(?:\s+\d+)*\s*[｝}]|\$\$[\s\S]*?\$\$|(?<!\\)\$[^$\n]+(?<!\\)\$|`[^`\n]+`)")


def apply_glossary_to_text(text, glossary):
    raw = str(text or "")
    if not raw or not glossary:
        return raw
    matched = [pair for pair in match_glossary_for_texts([raw], glossary, limit=64) if len(pair[0]) >= 3]
    if not matched:
        return raw
    compiled = [
        (re.compile(r"(?<![A-Za-z0-9_-])" + re.escape(en) + r"(?![A-Za-z0-9_-])", re.IGNORECASE), zh)
        for en, zh in matched
    ]
    segments = _FORMULA_SPLIT_RE.split(raw)
    for idx in range(0, len(segments), 2):
        seg = segments[idx]
        if not seg:
            continue
        for pat, zh in compiled:
            seg = pat.sub(lambda _, rep=zh: rep, seg)
        segments[idx] = seg
    return "".join(segments)


def baidu_translate_batch(config, texts, source="en", target="zh", timeout=25):
    if not isinstance(config, dict):
        raise ValueError("百度翻译配置无效。")
    app_id = str(config.get("appId") or "").strip()
    secret = str(config.get("secret") or config.get("key") or "").strip()
    qps_mode = "pro" if str(config.get("qpsMode") or "").strip().lower() == "pro" else "standard"
    custom_dict = bool(config.get("customDict"))
    if not app_id or not secret:
        raise ValueError("尚未填写百度翻译 APP ID 或密钥。")
    clean_lines = [re.sub(r"[\r\n]+", " ", str(t or "")).strip() for t in texts]
    if not clean_lines:
        return []
    src_code = "fra" if source == "fr" else source
    tgt_code = target
    outputs = [""] * len(clean_lines)

    groups = []
    cur_indices = []
    cur_bytes = 0
    byte_cap = 5200 if qps_mode == "pro" else 4200
    for idx, line in enumerate(clean_lines):
        if not line:
            continue
        b_len = len(line.encode("utf-8")) + 1
        if cur_indices and (len(cur_indices) >= 22 or cur_bytes + b_len > byte_cap):
            groups.append(cur_indices)
            cur_indices = []
            cur_bytes = 0
        cur_indices.append(idx)
        cur_bytes += b_len
    if cur_indices:
        groups.append(cur_indices)
    if not groups:
        return outputs

    def translate_group(indices):
        query = "\n".join(clean_lines[i] for i in indices)
        for attempt in range(4):
            salt = uuid.uuid4().hex
            sign = hashlib.md5((app_id + query + salt + secret).encode("utf-8")).hexdigest()
            fields = {
                "q": query,
                "from": src_code,
                "to": tgt_code,
                "appid": app_id,
                "salt": salt,
                "sign": sign,
            }
            if custom_dict:
                fields["action"] = "1"
            form_data = urllib.parse.urlencode(fields).encode("utf-8")
            req = urllib.request.Request(
                "https://fanyi-api.baidu.com/api/trans/vip/translate",
                data=form_data,
                headers={"Content-Type": "application/x-www-form-urlencoded", "User-Agent": "DoNote-Desktop/1.0"},
                method="POST",
            )
            try:
                with urllib.request.urlopen(req, timeout=timeout) as resp:
                    payload = json.loads(resp.read().decode("utf-8", errors="replace"))
            except (urllib.error.URLError, TimeoutError, OSError) as err:
                if attempt < 2:
                    time.sleep(0.8 * (attempt + 1))
                    continue
                raise RuntimeError(f"无法连接百度翻译接口：{err}")
            err_code = str(payload.get("error_code") or "")
            if err_code == "54003" and attempt < 3:
                time.sleep(1.1 * (attempt + 1) + random.uniform(0.05, 0.35))
                continue
            if err_code and err_code != "52000":
                err_msg = str(payload.get("error_msg") or "")
                raise RuntimeError(f"百度翻译返回错误 ({err_code})：{err_msg or '请检查 APP ID、密钥或免费额度'}")
            rows = payload.get("trans_result") or []
            mapped = {}
            if len(rows) == len(indices):
                for idx, row in zip(indices, rows):
                    mapped[idx] = str(row.get("dst") or "").strip()
            elif rows and len(indices) == 1:
                mapped[indices[0]] = "\n".join(str(r.get("dst") or "").strip() for r in rows)
            return mapped
        return {}

    if qps_mode == "pro" and len(groups) > 1:
        with ThreadPoolExecutor(max_workers=min(6, len(groups))) as pool:
            for mapped in pool.map(translate_group, groups):
                for idx, val in mapped.items():
                    outputs[idx] = val
    else:
        for g_pos, indices in enumerate(groups):
            if g_pos > 0:
                time.sleep(1.05)
            for idx, val in translate_group(indices).items():
                outputs[idx] = val
    return outputs


def azure_translate_batch(config, texts, source="en", target="zh", timeout=25):
    if not isinstance(config, dict):
        raise ValueError("微软 Translator 配置无效。")
    key = str(config.get("key") or "").strip()
    region = str(config.get("region") or "").strip()
    if not key:
        raise ValueError("尚未填写微软 Translator 密钥。")
    if not texts:
        return []
    src_code = "zh-Hans" if source == "zh" else source
    tgt_code = "zh-Hans" if target == "zh" else target
    endpoint = f"https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&from={src_code}&to={tgt_code}"
    headers = {
        "Content-Type": "application/json; charset=UTF-8",
        "Ocp-Apim-Subscription-Key": key,
        "User-Agent": "DoNote-Desktop/1.0",
    }
    if region:
        headers["Ocp-Apim-Subscription-Region"] = region
    outputs = [""] * len(texts)
    for start in range(0, len(texts), 20):
        chunk = texts[start:start + 20]
        body = json.dumps([{"Text": str(t or "")} for t in chunk], ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(endpoint, data=body, headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            rows = json.loads(resp.read().decode("utf-8", errors="replace"))
        for offset, row in enumerate(rows):
            trans = row.get("translations") or []
            if trans:
                outputs[start + offset] = str(trans[0].get("text") or "").strip()
    return outputs


def load_onnx_doclayout_model(model_path):
    from pdf2zh.doclayout import OnnxModel, onnxruntime

    if not model_path.is_file():
        raise ValueError("PDFMathTranslate 版面模型缺失，请更新完整版本。")

    class DoNoteLayoutModel(OnnxModel):
        def __init__(self):
            options = onnxruntime.SessionOptions()
            options.graph_optimization_level = onnxruntime.GraphOptimizationLevel.ORT_ENABLE_EXTENDED
            options.intra_op_num_threads = max(2, min(8, os.cpu_count() or 4))
            self.model_path = str(model_path)
            self.model = onnxruntime.InferenceSession(
                self.model_path, options, providers=["CPUExecutionProvider"]
            )
            metadata = self.model.get_modelmeta().custom_metadata_map
            self._stride = ast.literal_eval(metadata["stride"])
            self._names = ast.literal_eval(metadata["names"])

    return DoNoteLayoutModel()


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
