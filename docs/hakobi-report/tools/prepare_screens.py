"""Crop the demo screenshots to the parts each figure explains.

The sources are the dark-mode demo captures in docs/hakobi-introduction/assets-current
(1759 x 1244, fictional members and tasks only). The crops are written to
assets/screens/, which is under version control.

Usage:
    python docs/hakobi-report/tools/prepare_screens.py
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT.parent / "hakobi-introduction" / "assets-current"
TARGET = ROOT / "assets" / "screens"

# Fractions of the source image, in left/top/right/bottom order.
CROPS = {
    "gantt": (0.0, 0.0450161, 0.704946, 0.5916399),
    "team": (0.0085276, 0.0956592, 0.5025583, 0.4863344),
    "progress": (0.2615122, 0.1366559, 0.7305287, 0.5747588),
    "report": (0.1051734, 0.0522508, 0.8857305, 0.4823151),
    "meeting": (0.0, 0.0, 0.9977260, 0.3054662),
    "plan": (0.0085276, 0.0602894, 0.6139852, 0.4340836),
    "checklist": (0.1080159, 0.0522508, 0.8897101, 0.3697749),
}


def main() -> None:
    TARGET.mkdir(parents=True, exist_ok=True)
    for name, (a, b, c, d) in CROPS.items():
        with Image.open(SOURCE / f"{name}.png") as image:
            width, height = image.size
            box = (round(width * a), round(height * b), round(width * c), round(height * d))
            image.crop(box).convert("RGB").save(TARGET / f"{name}.png", optimize=True)
        print(name, box)


if __name__ == "__main__":
    main()
