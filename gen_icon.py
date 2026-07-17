import os
import PIL.Image

SRC = r"D:\ScreenOff\260714\UI\icon.ico"
OUT_DIR = r"D:\ScreenOff\260714\SleepTimer\src-tauri\icons"
os.makedirs(OUT_DIR, exist_ok=True)

imgs = PIL.Image.open(SRC)
best = None
best_size = 0
try:
    while True:
        sz = imgs.size[0]
        if sz > best_size:
            best_size = sz
            best = imgs.copy().convert("RGBA")
        imgs.seek(imgs.tell() + 1)
except EOFError:
    pass

if best is None:
    best = PIL.Image.open(SRC).convert("RGBA")

best = best.resize((256, 256), PIL.Image.LANCZOS)
src_png = os.path.join(OUT_DIR, "icon_source.png")
best.save(src_png)
print("wrote", src_png, best.size)
