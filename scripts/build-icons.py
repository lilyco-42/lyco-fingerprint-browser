"""Convert the owner-authorized Lyco source to platform icons inside Actions."""
import hashlib
import os
from pathlib import Path
from PIL import Image

if os.environ.get('GITHUB_ACTIONS') != 'true':
    raise SystemExit('Build icon artifacts only in GitHub Actions')
source = Path('assets/branding/icon-source.png')
if hashlib.sha256(source.read_bytes()).hexdigest() != '668059834636febc2df2fa467d5009c922bd3b973ef61370a3be9e7cf66198e1':
    raise SystemExit('Lyco original icon source changed')
image = Image.open(source).convert('RGBA')
destination = Path('assets/icons')
destination.mkdir(exist_ok=True)
image.save(destination/'icon.png')
image.save(destination/'icon.ico', sizes=[(16,16),(32,32),(48,48),(64,64),(128,128),(256,256)])
image.save(destination/'icon.icns')
