"""HTTP client for an assistant authorized by a Yam's ONE user."""

import json
import mimetypes
import os
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class YamsOne:
    def __init__(self, base_url=None, token=None):
        self.base_url = (base_url or os.environ["YAMS_ONE_URL"]).rstrip("/")
        address = urlsplit(self.base_url)
        if (
            not address.hostname or address.username or address.password or address.query or address.fragment
            or (address.scheme != "https" and not (
                address.scheme == "http" and address.hostname in {"localhost", "127.0.0.1", "::1"}
            ))
        ):
            raise ValueError("Use HTTPS for a remote connector or HTTP for a loopback address.")
        self.token = token or os.environ["YAMS_ONE_AGENT_TOKEN"]
        self.opener = build_opener(NoRedirect())

    def _request(self, route, *, method="GET", payload=None, headers=None):
        request = Request(
            self.base_url + route,
            data=payload,
            method=method,
            headers={"Authorization": "Bearer " + self.token, **(headers or {})},
        )
        try:
            with self.opener.open(request, timeout=60) as response:
                return json.load(response)
        except HTTPError as error:
            details = error.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"Yam's ONE returned HTTP {error.code}: {details}") from error

    def workspace(self):
        return self._request("/v1/workspace")

    def records(self, query="", offset=0, limit=50):
        return self._request("/v1/records?" + urlencode({"q": query, "offset": offset, "limit": limit}))

    def submit(self, operation, record, request_id):
        payload = json.dumps({"requestId": request_id, "operation": operation, "record": record}).encode()
        return self._request("/v1/tasks", method="POST", payload=payload, headers={"Content-Type": "application/json"})

    def task_status(self, task_id):
        return self._request("/v1/tasks/" + quote(task_id, safe=""))

    def literature_candidates(self, title="", doi=""):
        return self._request("/v1/literature/search?" + urlencode({"title": title, "doi": doi}))

    def upload(self, filename):
        path = Path(filename)
        return self._request(
            "/v1/files",
            method="POST",
            payload=path.read_bytes(),
            headers={
                "Content-Type": mimetypes.guess_type(path.name)[0] or "application/octet-stream",
                "X-File-Name": quote(path.name, safe=""),
            },
        )


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Yam's ONE assistant connector")
    parser.add_argument("action", choices=["workspace", "records", "submit", "status", "upload"])
    parser.add_argument("value", nargs="?", help="Query, JSON task file, task ID, or attachment path")
    args = parser.parse_args()
    client = YamsOne()
    if args.action == "workspace":
        result = client.workspace()
    elif args.action == "records":
        result = client.records(args.value or "")
    elif args.action == "submit":
        task = json.loads(Path(args.value).read_text(encoding="utf-8-sig"))
        result = client.submit(task["operation"], task["record"], task["requestId"])
    elif args.action == "status":
        result = client.task_status(args.value)
    else:
        result = client.upload(args.value)
    print(json.dumps(result, ensure_ascii=False, indent=2))
