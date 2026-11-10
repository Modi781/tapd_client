#!/usr/bin/env python3
"""Generates the 1024x1024 app icon (plain PNG, no external dependencies)."""

import zlib
import struct
from pathlib import Path

SIZE = 1024
SS = 2
W = SIZE * SS


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def rounded_rect_alpha(x: float, y: float, radius: float) -> float:
    left, top, right, bottom = radius, radius, W - radius, W - radius
    cx = min(max(x, left), right)
    cy = min(max(y, top), bottom)
    dx, dy = x - cx, y - cy
    dist = (dx * dx + dy * dy) ** 0.5
    return 1.0 if dist <= radius else 0.0


def build() -> bytes:
    rows = bytearray()
    radius = W * 0.23
    for y in range(W):
        rows.append(0)  # PNG filter: none
        for x in range(W):
            alpha = rounded_rect_alpha(x + 0.5, y + 0.5, radius)
            t = (x + y) / (2 * W)
            # deep navy -> sky blue diagonal gradient
            r = lerp(11, 14, t)
            g = lerp(30, 165, t)
            b = lerp(49, 233, t)

            # White "T" mark.
            in_bar = 0.30 * W <= y <= 0.375 * W and 0.245 * W <= x <= 0.755 * W
            in_stem = 0.375 * W <= y <= 0.735 * W and 0.445 * W <= x <= 0.555 * W
            if (in_bar or in_stem) and alpha:
                r = g = b = 255

            rows += bytes((int(r), int(g), int(b), int(alpha * 255)))
    return bytes(rows)


def downsample(raw: bytes) -> bytes:
    out = bytearray()
    stride = W * 4
    for y in range(SIZE):
        out.append(0)
        for x in range(SIZE):
            acc = [0, 0, 0, 0]
            for dy in range(SS):
                base = (y * SS + dy) * stride + x * SS * 4
                for dx in range(SS):
                    idx = base + dx * 4
                    for c in range(4):
                        acc[c] += raw[idx + c]
            count = SS * SS
            out += bytes(v // count for v in acc)
    return bytes(out)


def write_png(path: Path, pixels: bytes) -> None:
    def chunk(tag: bytes, data: bytes) -> bytes:
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0)
    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", header)
    png += chunk(b"IDAT", zlib.compress(pixels, 9))
    png += chunk(b"IEND", b"")
    path.write_bytes(png)


if __name__ == "__main__":
    target = Path(__file__).resolve().parent.parent / "assets" / "icon.png"
    target.parent.mkdir(parents=True, exist_ok=True)
    write_png(target, downsample(build()))
    print(target)
