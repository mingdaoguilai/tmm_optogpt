from __future__ import annotations

import threading
import webbrowser

import uvicorn


def _open_browser() -> None:
    webbrowser.open("http://127.0.0.1:8000")


def main() -> None:
    threading.Timer(1.2, _open_browser).start()
    uvicorn.run("app.main:app", host="127.0.0.1", port=8000, reload=False)


if __name__ == "__main__":
    main()
