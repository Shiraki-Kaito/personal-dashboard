"""既存の4分割ブランドマークを、外部ライブラリなしでPWA用PNGへ書き出す。"""
from pathlib import Path
import struct
import zlib

output = Path(__file__).resolve().parent.parent / "public" / "icons"
output.mkdir(exist_ok=True)
background = (16, 21, 29)
accent = (153, 217, 196)


def rounded_rectangle(x, y, left, top, width, radius):
    center_x = max(left + radius, min(x, left + width - radius))
    center_y = max(top + radius, min(y, top + width - radius))
    return (x - center_x) ** 2 + (y - center_y) ** 2 <= radius ** 2


def chunk(kind, data):
    return (struct.pack(">I", len(data)) + kind + data
            + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff))


for size in (192, 512):
    pixels = bytearray()
    for row in range(size):
        pixels.append(0)  # PNG filter: None
        for column in range(size):
            x, y = (column + 0.5) * 512 / size, (row + 0.5) * 512 / size
            color = background
            alpha = 255 if rounded_rectangle(x, y, 0, 0, 512, 96) else 0
            for left, top, opacity in ((120, 120, 1), (272, 120, .6),
                                       (120, 272, .6), (272, 272, 1)):
                if rounded_rectangle(x, y, left, top, 120, 25):
                    color = tuple(round(a * opacity + b * (1 - opacity))
                                  for a, b in zip(accent, background))
            pixels.extend((*color, alpha))
    image = b"\x89PNG\r\n\x1a\n"
    image += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    image += chunk(b"IDAT", zlib.compress(pixels, level=9))
    image += chunk(b"IEND", b"")
    (output / f"dashboard-{size}.png").write_bytes(image)
