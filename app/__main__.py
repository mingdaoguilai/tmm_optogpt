from __future__ import annotations

import argparse
import json
import socket
import threading
import time
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen
import webbrowser

import uvicorn

from app import WORKBENCH_VERSION


PROJECT_ROOT = Path(__file__).resolve().parents[1]


def _is_current_server(url: str) -> bool:
    try:
        with urlopen(url + "/api/health", timeout=0.5) as response:
            status = json.load(response)
        return (status.get("application") == "TMM + OptoGPT Workbench"
                and status.get("version") == WORKBENCH_VERSION
                and Path(status.get("project_root", "")).resolve() == PROJECT_ROOT)
    except (URLError, OSError, ValueError):
        return False


def _select_port(preferred: int) -> tuple[int, bool]:
    for port in range(preferred, min(preferred + 20, 65536)):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            try:
                probe.bind(("127.0.0.1", port))
                return port, False
            except OSError:
                if _is_current_server(f"http://127.0.0.1:{port}"):
                    return port, True
    raise RuntimeError("No available local port; close a previous workbench or choose --port.")


def _open_browser(url: str) -> None:
    # Do not open an old page merely because the preferred port is occupied.
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if _is_current_server(url):
            webbrowser.open(url)
            return
        time.sleep(0.2)
    print(f"Browser was not opened: v{WORKBENCH_VERSION} did not become ready at {url}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Start the local OptiForge workbench")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("--port must be between 1 and 65535")
    port, existing = _select_port(args.port)
    url = f"http://127.0.0.1:{port}"
    print(f"OptiForge v{WORKBENCH_VERSION} | {PROJECT_ROOT} | {url}", flush=True)
    if existing:
        if not args.no_browser:
            webbrowser.open(url)
        return
    if not args.no_browser:
        threading.Thread(target=_open_browser, args=(url,), daemon=True).start()
    uvicorn.run("app.main:app", host="127.0.0.1", port=port, reload=False)


if __name__ == "__main__":
    main()
