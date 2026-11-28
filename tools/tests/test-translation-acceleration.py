# [INPUT]: 导入 work/desktop 翻译加速模块并启动本地回环 Mock OpenAI HTTP 服务器。
# [OUTPUT]: 验证 GPU 自适应探测、批量 JSON 解析、OpenAI-Compatible URL 规范化与并发翻译、以及双语排版并发路由。
# [POS]: 文献翻译三级加速（P0 级联/批译、P1 GPU 自适应、P1 OpenAI 并发池）独立自动化回归脚本。
# [PROTOCOL]: Update this header on change, then check AGENTS.md
import http.server
import json
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DESKTOP_DIR = REPO_ROOT / "work" / "desktop"
sys.path.insert(0, str(DESKTOP_DIR))

import pdf_gguf_translation as pgt


class MockOpenAiHandler(http.server.BaseHTTPRequestHandler):
    call_count = 0
    lock = threading.Lock()

    def log_message(self, format, *args):
        return

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or "0")
        body = json.loads(self.rfile.read(length).decode("utf-8"))
        auth = self.headers.get("Authorization") or ""
        assert auth == "Bearer sk-test-token", f"Unexpected auth header: {auth}"
        with MockOpenAiHandler.lock:
            MockOpenAiHandler.call_count += 1
            current_call = MockOpenAiHandler.call_count
        if current_call == 2:
            err_payload = json.dumps({"error": {"message": "Rate limit burst"}}).encode("utf-8")
            self.send_response(429)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(err_payload)))
            self.end_headers()
            self.wfile.write(err_payload)
            return
        user_content = body["messages"][-1]["content"]
        reply = {
            "id": "chatcmpl-test",
            "choices": [
                {
                    "index": 0,
                    "finish_reason": "stop",
                    "message": {
                        "role": "assistant",
                        "content": "译文：" + user_content[:40],
                    },
                }
            ],
        }
        payload = json.dumps(reply, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def main():
    # 1. URL normalization checks
    assert pgt.normalize_chat_completions_url("https://api.deepseek.com") == "https://api.deepseek.com/v1/chat/completions"
    assert pgt.normalize_chat_completions_url("https://api.openai.com/v1") == "https://api.openai.com/v1/chat/completions"
    assert pgt.normalize_chat_completions_url("https://dashscope.aliyuncs.com/compatible-mode/v1") == "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
    assert pgt.normalize_chat_completions_url("http://127.0.0.1:11434/v1/chat/completions") == "http://127.0.0.1:11434/v1/chat/completions"

    # 2. Batch JSON response parser checks (clean JSON + markdown fenced JSON + <think> reasoning + out-of-range filtering)
    mapped = pgt.parse_batch_json_response(
        '<think>Let us draft [{"id": 0, "zh": "草稿"}]</think>\n```json\n[{"id": 0, "zh": "第一段 {v0}"}, {"id": 1, "zh": "第二段"}, {"id": 99, "zh": "越界"}]\n```',
        2,
    )
    assert mapped == {0: "第一段 {v0}", 1: "第二段"}, f"Unexpected parsed batch: {mapped}"

    # 2b. Delimited @@id@@ parser checks (Immersive-Translate style single-pass streaming)
    delim_mapped = pgt.parse_delimited_response(
        "<think>draft @@0@@ ignore</think>\n@@0@@ 金属表面电导率 {v0}\n@@1@@ 图 9.10 表面粗糙度影响\n@@99@@ 越界",
        2,
    )
    assert delim_mapped == {0: "金属表面电导率 {v0}", 1: "图 9.10 表面粗糙度影响"}, f"Unexpected delim: {delim_mapped}"

    # 3. GPU offload detection fallback checks
    class DummyLlamaCppTrue:
        @staticmethod
        def llama_supports_gpu_offload():
            return True

    class DummyLlamaCppFalse:
        @staticmethod
        def llama_supports_gpu_offload():
            return False

    assert pgt.resolve_gpu_layers(DummyLlamaCppTrue) == -1
    assert pgt.resolve_gpu_layers(DummyLlamaCppFalse) == 0

    # 4. Concurrent OpenAI-Compatible loopback test
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), MockOpenAiHandler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        cfg = {
            "baseUrl": f"http://127.0.0.1:{port}",
            "apiKey": "Bearer sk-test-token",
            "model": "deepseek-chat",
            "concurrency": 4,
        }
        prompts = [f"Paragraph {i} with equation {{v0}}." for i in range(8)]
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(
                lambda p: pgt.openai_compatible_chat(cfg, "你是专业译者。", p, 256),
                prompts,
            ))
        assert len(results) == 8
        assert all(content.startswith("译文：") and reason == "stop" for content, reason in results)
        assert MockOpenAiHandler.call_count == 9, f"Expected 8 + 1 retry = 9 calls, got {MockOpenAiHandler.call_count}"
    finally:
        server.shutdown()
        server.server_close()

    print("PASS: test-translation-acceleration (URL norm, batch JSON parse, GPU probe, OpenAI concurrent loopback)")


if __name__ == "__main__":
    main()
