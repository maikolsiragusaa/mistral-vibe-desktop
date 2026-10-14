"""Generate the Windows icon from the project's original stepped signal mark."""
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parent.parent
image = Image.new("RGBA", (256, 256), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((0, 0, 255, 255), radius=44, fill="#fff3e4")
for box, color in [((44,136,99,191),"#ffab63"),((156,136,211,191),"#ffab63"),((100,136,155,191),"#e95b21"),((100,80,155,135),"#ffbd84")]:
    draw.rectangle(box, fill=color)
image.save(root / "assets" / "icon.ico", sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
