"""Start the engine: `python -m app` (or `ait-engine`)."""
from __future__ import annotations

import argparse
import logging
import socket
from pathlib import Path

from . import __version__
from .config import Settings


def lan_addresses() -> list[str]:
    out: set[str] = set()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        out.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    return sorted(a for a in out if not a.startswith("127."))


def main() -> None:
    parser = argparse.ArgumentParser(description="AI Translate local engine")
    parser.add_argument("--host")
    parser.add_argument("--port", type=int)
    parser.add_argument("--lan", action="store_true", help="accept phones on the local network")
    parser.add_argument("--env", default=".env")
    args = parser.parse_args()

    settings = Settings.from_env(Path(args.env))
    if args.lan:
        settings.lan = True
        settings.host = "0.0.0.0"
    if args.host:
        settings.host = args.host
    if args.port:
        settings.port = args.port
    token = settings.ensure_token()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    print("=" * 64)
    print(f" AI Translate engine {__version__}")
    print(f" URL:   http://127.0.0.1:{settings.port}")
    if settings.lan:
        for ip in lan_addresses():
            print(f" LAN:   http://{ip}:{settings.port}   (enter this in the phone app)")
    print(f" Pairing code: {token}")
    print(" Paste the URL and the pairing code into the extension/app settings.")
    print("=" * 64)

    import uvicorn

    from .api import create_app

    uvicorn.run(create_app(settings), host=settings.host, port=settings.port, log_level="info")


if __name__ == "__main__":
    main()
