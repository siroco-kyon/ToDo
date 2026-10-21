"""Encode the sought SVG frames as an exactly six-second, looping GIF."""
from pathlib import Path
from hashlib import sha256
import json
from PIL import Image, ImageChops

ROOT = Path(__file__).resolve().parents[1]
frames = [Image.open(ROOT/'.build/frames'/f'{i:03}.png').convert('RGB') for i in range(91)]
same = ImageChops.difference(frames[0], frames[90]).getbbox() is None
moved = ImageChops.difference(frames[0], frames[30]).getbbox() is not None
regions = [(120,135,280,161),(58,186,282,234),(891,134,1060,162),(462,169,638,193),(462,317,638,361)]
static = all(ImageChops.difference(frames[0].crop(box), frame.crop(box)).getbbox() is None
             for box in regions for frame in frames)
assert same and moved and static
palette = Image.new('RGB',(1100,510*6))
for j,i in enumerate([0,15,30,45,60,75]): palette.paste(frames[i],(0,510*j))
palette = palette.quantize(colors=128)
images = [x.quantize(palette=palette,dither=Image.Dither.NONE) for x in frames[:90]]
# GIF durations have 10 ms resolution: these three frames total exactly 200 ms.
images[0].save(ROOT/'team-traffic.gif',save_all=True,append_images=images[1:],
               duration=[70,70,60]*30,loop=0,optimize=False,disposal=2)
gif=Image.open(ROOT/'team-traffic.gif');duration=0
for i in range(gif.n_frames): gif.seek(i);duration+=gif.info['duration']
assert duration==6000
result = {'source_seconds_0_and_6_pixel_identical':same, 'different_frame_at_2_seconds':moved,
          'static_text_regions_pixel_identical':static, 'gif_duration_ms':duration,
          'gif_frames':gif.n_frames, 'gif_loop':gif.info.get('loop'),
          'svg_sha256':sha256((ROOT/'team-traffic.svg').read_bytes()).hexdigest()}
(ROOT/'.build/animation-check.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
print(json.dumps(result,indent=2))
