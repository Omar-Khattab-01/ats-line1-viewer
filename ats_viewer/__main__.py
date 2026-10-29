import argparse
import sys
from pathlib import Path


def main():
    if sys.version_info < (3, 10):
        raise SystemExit("Python 3.10 or newer is required")
    parser = argparse.ArgumentParser(description="Local ATS Line 1 viewer. No packages or internet required.")
    parser.add_argument("path", nargs="?", default="", help="Optional folder or ZIP path to prefill in the browser")
    parser.add_argument("--port", type=int, default=8766, help="Local port (default: 8766)")
    parser.add_argument("--open", action="store_true", help="Open the local dashboard in your default browser")
    parser.add_argument("--database", default=str(Path(__file__).resolve().parent.parent / "cache" / "ats-workspace.sqlite"), help="Consolidated SQLite workspace path")
    args = parser.parse_args()
    from .web import serve
    serve(args.database, args.port, args.open, args.path)


if __name__ == "__main__":
    main()
