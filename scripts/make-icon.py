#!/usr/bin/env python3
"""
make-icon.py —— 生成 QuantDesk 应用图标（macOS .icns）

设计：深色终端底 + 蓝紫渐变上升折线 + 面积填充 + 底部红涨绿跌小蜡烛，
      呼应"美股量化终端"的定位（国内习惯：涨红跌绿）。

用法：python3 scripts/make-icon.py
"""
import os
import subprocess
import math
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, 'assets')
SIZE = 1024
SS = 4  # 超采样倍数，保证缩放后边缘平滑

BG_TOP = (23, 31, 48)
BG_BOTTOM = (11, 14, 20)
LINE_A = (74, 158, 255)    # #4a9eff
LINE_B = (167, 139, 250)   # #a78bfa
UP = (246, 70, 93)         # 涨：红
DOWN = (14, 203, 129)      # 跌：绿
GRID = (255, 255, 255, 18)


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def rounded_mask(size, radius_ratio=0.2237):
    """macOS Big Sur 风格圆角矩形遮罩"""
    m = Image.new('L', (size, size), 0)
    d = ImageDraw.Draw(m)
    r = int(size * radius_ratio)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=255)
    return m


def draw_background(img, size):
    d = ImageDraw.Draw(img)
    for y in range(size):
        t = y / max(1, size - 1)
        d.line([(0, y), (size, y)], fill=lerp(BG_TOP, BG_BOTTOM, t))


def draw_grid(d, size):
    """淡淡的水平网格，暗示行情终端"""
    top, bottom = int(size * 0.24), int(size * 0.76)
    n = 4
    for i in range(1, n):
        y = top + (bottom - top) * i / n
        d.line([(int(size * 0.14), y), (int(size * 0.86), y)], fill=(255, 255, 255, 14), width=2)


def trend_points(size):
    """一条带波动的上升折线：起点低，终点高，中间有回撤"""
    xs = [0.16, 0.29, 0.40, 0.51, 0.62, 0.73, 0.86]
    ys = [0.66, 0.58, 0.61, 0.47, 0.50, 0.38, 0.28]
    return [(int(size * x), int(size * y)) for x, y in zip(xs, ys)]


def draw_chart(img, size):
    """折线 + 渐变面积 + 端点光点"""
    pts = trend_points(size)
    base_y = int(size * 0.80)

    # 渐变面积（逐列绘制，按 x 在线段上插值）
    area = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    ad = ImageDraw.Draw(area)
    poly = pts + [(pts[-1][0], base_y), (pts[0][0], base_y)]
    # 先铺一层半透明渐变底
    grad = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    gd = ImageDraw.Draw(grad)
    for y in range(int(size * 0.24), base_y):
        t = (y - size * 0.24) / max(1, base_y - size * 0.24)
        alpha = int(90 * (1 - t) + 8)
        gd.line([(0, y), (size, y)], fill=LINE_A + (alpha,))
    # 用多边形裁剪渐变
    mask = Image.new('L', (size, size), 0)
    ImageDraw.Draw(mask).polygon(poly, fill=255)
    img.paste(Image.alpha_composite(img.convert('RGBA'), grad).convert('RGB'), (0, 0))
    del ad

    d = ImageDraw.Draw(img)
    # 渐变折线：分段上色
    w = max(6, int(size * 0.028))
    for i in range(len(pts) - 1):
        t0 = i / (len(pts) - 1)
        t1 = (i + 1) / (len(pts) - 1)
        col = lerp(LINE_A, LINE_B, (t0 + t1) / 2)
        d.line([pts[i], pts[i + 1]], fill=col, width=w, joint='curve')
        # 节点小圆
        r = w * 0.42
        d.ellipse([pts[i][0] - r, pts[i][1] - r, pts[i][0] + r, pts[i][1] + r], fill=col)

    # 末端发光点
    ex, ey = pts[-1]
    glow = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse([ex - w * 2.2, ey - w * 2.2, ex + w * 2.2, ey + w * 2.2], fill=LINE_B + (70,))
    glow = glow.filter(ImageFilter.GaussianBlur(size * 0.02))
    img.paste(Image.alpha_composite(img.convert('RGBA'), glow).convert('RGB'), (0, 0))
    d = ImageDraw.Draw(img)
    d.ellipse([ex - w * 0.75, ey - w * 0.75, ex + w * 0.75, ey + w * 0.75], fill=(255, 255, 255))


def draw_candles(img, size):
    """底部一排迷你蜡烛，涨红跌绿"""
    d = ImageDraw.Draw(img)
    base = int(size * 0.80)
    top = int(size * 0.68)
    xs = [0.20, 0.29, 0.38, 0.47, 0.56, 0.65, 0.74, 0.83]
    data = [(0.62, 0.78, True), (0.55, 0.70, True), (0.60, 0.74, False), (0.48, 0.62, True),
            (0.42, 0.56, True), (0.46, 0.60, False), (0.30, 0.44, True), (0.18, 0.32, True)]
    cw = int(size * 0.026)
    for x, (h0, h1, is_up) in zip(xs, data):
        cx = int(size * x)
        y0 = int(top + (base - top) * (1 - h1))
        y1 = int(top + (base - top) * (1 - h0))
        col = UP if is_up else DOWN
        d.line([(cx, y0), (cx, y1)], fill=col, width=max(3, int(size * 0.008)))
        d.rectangle([cx - cw // 2, y0, cx + cw // 2, max(y0 + 4, y1)], fill=col)


def make_icon(size=SIZE):
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw_background(img, size)
    d = ImageDraw.Draw(img)
    draw_grid(d, size)
    draw_chart(img, size)
    draw_candles(img, size)
    # 圆角裁剪
    mask = rounded_mask(size)
    out = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out


def main():
    os.makedirs(ASSETS, exist_ok=True)
    # 4x 超采样后缩小，得到平滑边缘
    big = make_icon(SIZE * SS // 2)
    icon = big.resize((SIZE, SIZE), Image.LANCZOS)
    png_path = os.path.join(ASSETS, 'icon.png')
    icon.save(png_path, 'PNG')
    print('生成 icon.png:', png_path)

    # iconset
    iconset = os.path.join(ASSETS, 'icon.iconset')
    os.makedirs(iconset, exist_ok=True)
    specs = [
        (16, 'icon_16x16.png'), (32, 'icon_16x16@2x.png'),
        (32, 'icon_32x32.png'), (64, 'icon_32x32@2x.png'),
        (128, 'icon_128x128.png'), (256, 'icon_128x128@2x.png'),
        (256, 'icon_256x256.png'), (512, 'icon_256x256@2x.png'),
        (512, 'icon_512x512.png'), (1024, 'icon_512x512@2x.png'),
    ]
    for s, name in specs:
        icon.resize((s, s), Image.LANCZOS).save(os.path.join(iconset, name), 'PNG')

    icns = os.path.join(ASSETS, 'icon.icns')
    r = subprocess.run(['iconutil', '-c', 'icns', iconset, '-o', icns],
                       capture_output=True, text=True)
    if r.returncode == 0 and os.path.exists(icns):
        print('生成 icon.icns:', icns, f'({os.path.getsize(icns)} bytes)')
    else:
        print('iconutil 失败:', r.stderr)


if __name__ == '__main__':
    main()
