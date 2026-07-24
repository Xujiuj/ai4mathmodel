from collections import deque
from pathlib import Path

from PIL import Image


root = Path(__file__).resolve().parents[1]
source = Image.open(root / "build" / "app-icon.png").convert("RGBA")
pixels = source.load()
width, height = source.size
queue = deque([(0, 0), (width - 1, 0), (0, height - 1), (width - 1, height - 1)])
seen = set(queue)

while queue:
    x, y = queue.popleft()
    red, green, blue, _ = pixels[x, y]
    if max(red, green, blue) > 48:
        continue
    pixels[x, y] = (red, green, blue, 0)
    for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
        if 0 <= nx < width and 0 <= ny < height and (nx, ny) not in seen:
            seen.add((nx, ny))
            queue.append((nx, ny))

source.thumbnail((1024, 1024), Image.Resampling.LANCZOS)
source.save(root / "build" / "app-icon-clean.png")
source.save(
    root / "build" / "app-icon.ico",
    sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
)
