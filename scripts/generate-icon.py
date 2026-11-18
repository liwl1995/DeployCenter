from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ASSETS = Path('assets')
INSTALLER = Path('installer')
ORANGE = '#c2410c'
WHITE = '#ffffff'
SIDEBAR = '#f5f4f2'
SIZES = [16, 20, 24, 32, 40, 48, 64, 80, 96, 100, 120, 128, 140, 160, 192, 200, 240, 256]
# 同一条完整轮廓生成 SVG、位图和 ICO，避免小尺寸下出现拼接缝。
MARK_INSET = 140.625
MARK_EDGE = 718.75
MARK_RADIUS = 234.375
MARK_WIDTH = 109.375


def svg(background=None):
    plate = (
        f'<rect width="1000" height="1000" rx="236" fill="{background}"/>'
        if background
        else ''
    )
    color = WHITE if background else ORANGE
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">'
        f'{plate}<rect x="{MARK_INSET}" y="{MARK_INSET}" width="{MARK_EDGE}" '
        f'height="{MARK_EDGE}" rx="{MARK_RADIUS}" fill="none" stroke="{color}" '
        f'stroke-width="{MARK_WIDTH}"/></svg>\n'
    )


def icon():
    # 位图在高分辨率绘制，再降采样；内外圆角与 SVG 的居中描边一致。
    size = 2048
    scale = size / 1000
    image = Image.new('RGBA', (size, size))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=236 * scale, fill=ORANGE)
    for offset, color in ((-MARK_WIDTH / 2, WHITE), (MARK_WIDTH / 2, ORANGE)):
        start = (MARK_INSET + offset) * scale
        end = (MARK_INSET + MARK_EDGE - offset) * scale
        draw.rounded_rectangle((start, start, end, end),
                               radius=(MARK_RADIUS - offset) * scale, fill=color)
    return image.resize((1024, 1024), Image.Resampling.LANCZOS)


def main():
    ASSETS.mkdir(exist_ok=True)
    (ASSETS / 'icon.svg').write_text(svg(ORANGE), encoding='utf-8')
    (ASSETS / 'brand-mark.svg').write_text(svg(), encoding='utf-8')
    base = icon()
    base.save(ASSETS / 'icon-1024.png')
    base.resize((256, 256), Image.Resampling.LANCZOS).save(ASSETS / 'icon.png')
    ico_sizes = [(n, n) for n in SIZES]
    base.save(ASSETS / 'icon.ico', sizes=ico_sizes)

    preview = Image.new('RGB', (920, 400), SIDEBAR)
    draw = ImageDraw.Draw(preview)
    font = 'C:/Windows/Fonts/msyh.ttc'
    hero = base.resize((224, 224), Image.Resampling.LANCZOS)
    preview.paste(hero, (64, 76), hero)
    draw.text((340, 101), 'YOTOO 部署中心', font=ImageFont.truetype(font, 34), fill='#211f1e')
    draw.text((343, 158), '回旋标识', font=ImageFont.truetype(font, 18), fill='#605a56')
    for index, size in enumerate([16, 24, 32, 48, 64]):
        x = 346 + index * 86
        thumb = base.resize((size, size), Image.Resampling.LANCZOS)
        preview.paste(thumb, (x, 245 - size // 2), thumb)
        draw.text((x, 288), f'{size} px', font=ImageFont.truetype(font, 13), fill='#605a56')
    preview.save(ASSETS / 'icon-preview.png')

    # 欢迎页按 DPI 加载原生图标，透明圆角与窗口底色衔接。
    base.save(INSTALLER / 'brand.ico', sizes=ico_sizes)


if __name__ == '__main__':
    main()
