#!/usr/bin/env python3
"""生成 petfood 的商品图（SVG），由 petsite 自己作为静态资源提供。

为什么不放 S3 / CloudFront：
  上游用 PETFOOD_ASSETS_CDN_URL / PETFOOD_IMAGES_CDN_URL 指向 CloudFront 分发，
  而本项目的硬约束是「ALB 不得新增公网入口」，也不引入新的 CloudFront 分发。
  petsite 的 wwwroot 走的是**现有** internal ALB，没有新增任何入口，
  且相对路径 /images/food/xxx.svg 在浏览器里直接可用，不需要签名。

为什么用 SVG 而不是位图：
  纯矢量、单文件几 KB、无需二进制依赖、可随主题缩放；
  这是 demo 的占位商品图，不需要照片级真实感。

配色与 petsite 主题一致（品牌绿 #0f9d8f，底色 #f1f5f4）。
"""
from pathlib import Path

OUT = Path("/home/ec2-user/works/one-observability-demo/PetAdoptions/petsite/petsite/wwwroot/images/food")

# 8 种 pet_type × food_type 组合，逐一对应线上 seed 数据的实际取值
COMBOS = [
    ("puppy",  "dry"),
    ("puppy",  "wet"),
    ("puppy",  "treats"),
    ("kitten", "dry"),
    ("kitten", "wet"),
    ("kitten", "treats"),
    ("bunny",  "dry"),
    ("bunny",  "wet"),
]

PET_GLYPH = {"puppy": "🐶", "kitten": "🐱", "bunny": "🐰"}
# 每种食物形态用不同的视觉元素，让三张图能一眼区分
TYPE_LABEL = {"dry": "DRY FOOD", "wet": "WET FOOD", "treats": "TREATS"}
TYPE_TINT = {"dry": "#c8862a", "wet": "#3b82a6", "treats": "#c2544a"}


def kibble_pattern(tint: str) -> str:
    """dry：散落的颗粒。"""
    pts = [(96, 150), (128, 138), (160, 152), (112, 176), (146, 172),
           (80, 176), (176, 176), (128, 196)]
    return "".join(
        f'<ellipse cx="{x}" cy="{y}" rx="11" ry="8" fill="{tint}" opacity="0.85" '
        f'transform="rotate({(x + y) % 60 - 30} {x} {y})"/>'
        for x, y in pts
    )


def chunk_pattern(tint: str) -> str:
    """wet：碗里的肉块与汤汁。"""
    return (
        f'<path d="M64 150 h128 a8 8 0 0 1 8 8 v10 a64 34 0 0 1 -144 0 v-10 '
        f'a8 8 0 0 1 8 -8 z" fill="{tint}" opacity="0.28"/>'
        f'<ellipse cx="128" cy="158" rx="60" ry="16" fill="{tint}" opacity="0.55"/>'
        + "".join(
            f'<rect x="{x}" y="{y}" width="20" height="14" rx="4" fill="{tint}" '
            f'transform="rotate({r} {x + 10} {y + 7})"/>'
            for x, y, r in [(98, 146, -12), (124, 140, 8), (150, 150, -6), (112, 158, 15)]
        )
    )


def treat_pattern(tint: str) -> str:
    """treats：骨形/心形小饼。"""
    out = []
    for x, y in [(100, 148), (140, 142), (120, 174), (160, 168), (86, 176)]:
        out.append(
            f'<g transform="translate({x} {y})">'
            f'<circle cx="-7" cy="-5" r="6" fill="{tint}"/>'
            f'<circle cx="-7" cy="5" r="6" fill="{tint}"/>'
            f'<circle cx="9" cy="-5" r="6" fill="{tint}"/>'
            f'<circle cx="9" cy="5" r="6" fill="{tint}"/>'
            f'<rect x="-7" y="-4" width="16" height="8" fill="{tint}"/>'
            f"</g>"
        )
    return "".join(out)


PATTERN = {"dry": kibble_pattern, "wet": chunk_pattern, "treats": treat_pattern}


def svg(pet: str, ftype: str) -> str:
    tint = TYPE_TINT[ftype]
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256" role="img" aria-label="{pet} {ftype} food">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#f7fbfa"/>
      <stop offset="100%" stop-color="#e6efed"/>
    </linearGradient>
  </defs>
  <rect width="256" height="256" fill="url(#bg)"/>
  <circle cx="128" cy="96" r="46" fill="#ffffff" opacity="0.9"/>
  <text x="128" y="114" font-size="52" text-anchor="middle" dominant-baseline="auto">{PET_GLYPH[pet]}</text>
  {PATTERN[ftype](tint)}
  <rect x="0" y="212" width="256" height="44" fill="#0f9d8f"/>
  <text x="128" y="240" font-family="system-ui,-apple-system,Segoe UI,sans-serif" font-size="18"
        font-weight="600" fill="#ffffff" text-anchor="middle" letter-spacing="1.5">{TYPE_LABEL[ftype]}</text>
</svg>
"""


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for pet, ftype in COMBOS:
        p = OUT / f"{pet}-{ftype}.svg"
        p.write_text(svg(pet, ftype), encoding="utf-8")
        print(f"  ✅ {p.name}  {p.stat().st_size}B")
    print(f"\n  共 {len(COMBOS)} 张 -> {OUT}")


if __name__ == "__main__":
    main()
