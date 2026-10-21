"""Keep full captured screens and extract the parts used in the feature tour."""
from pathlib import Path
from PIL import Image
import json
import shutil

ROOT=Path(__file__).resolve().parents[1]
source=ROOT/'.build/feature-captures'
assets=ROOT/'assets';assets.mkdir(exist_ok=True)
boxes={
    'tour-plan':(510,70,1415,950),
    'tour-kanban':(502,70,1430,820),
    'tour-timer':(512,396,1408,605),
    'tour-record':(510,70,1428,430),
    'tour-checklist':(510,70,1428,725),
    'tour-dependencies':(510,548,1408,805),
}
for name,box in boxes.items():
    shutil.copyfile(source/(name+'.png'),assets/('source-'+name+'.png'))
    with Image.open(source/(name+'.png')) as image:image.crop(box).save(assets/(name+'.png'))
info=json.loads((source/'capture-info.json').read_text(encoding='utf-8'))
info.update({'crops':boxes,'timer_demo':'The disposable running clock was set 35 minutes earlier to demonstrate timer and log UI. No real work duration is claimed.'})
(assets/'capture-info.json').write_text(json.dumps(info,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print('Saved six actual screens and six crops')
