import os
from pathlib import Path


def uses_non_thinking_prompt(model_path):
    return Path(model_path).name.lower() in (
        "qwen3-0.6b-q8_0.gguf", "qwen3_0_6b-q8_0.gguf", "qwen3-1.7b-q4_k_m.gguf",
    )


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
            from llama_cpp import Llama

            self.close()
            threads = max(1, min(os.cpu_count() or 1, int(os.environ.get("DONOTE_LLM_THREADS", "12"))))
            self.model = Llama(
                model_path=str(model_path),
                n_ctx=8192,
                n_batch=256,
                n_threads=threads,
                n_threads_batch=threads,
                n_gpu_layers=0,
                use_mmap=True,
                verbose=False,
            )
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
