"""Native picker runs in its own process so Tk owns its main thread."""
import json
import sys


def main():
    import tkinter as tk
    from tkinter import filedialog
    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    try:
        if sys.argv[1] == "folder":
            path = filedialog.askdirectory(parent=root, title="Choose the folder containing ATS XML snapshots or ZIPs")
        else:
            path = filedialog.askopenfilename(parent=root, title="Choose an ATS ZIP archive", filetypes=[("ZIP archives", "*.zip")])
        print(json.dumps({"path": path}))
    finally:
        root.destroy()


if __name__ == "__main__":
    main()
