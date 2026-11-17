from pathlib import Path
from PIL import Image,ImageDraw,ImageFont
import math

root=Path('assets');root.mkdir(exist_ok=True)
green='#176b51';white='#f3f8f4'
sizes=[16,20,24,32,40,48,64,80,96,100,120,128,140,160,192,200,240,256]
# 保留选定的「回旋」草案比例：四段圆弧围绕中心旋转，图形占图标边长的 5/6。
arm='M395 155H505V275H395A120 120 0 0 0 275 395V505H155V395A240 240 0 0 1 395 155Z'
paths=''.join(f'<path d="{arm}" transform="rotate({angle} 500 500)"/>' for angle in [0,90,180,270])
svg=f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000"><rect width="1000" height="1000" rx="250" fill="{green}"/><g fill="{white}" transform="translate(83.333333 83.333333) scale(.833333333)">{paths}</g></svg>'''
(root/'icon.svg').write_text(svg,encoding='utf-8')

# 与 SVG 共用圆弧几何，以双倍分辨率绘制后降采样，避免小图标边缘锯齿。
size=2048;scale=size/1000
base=Image.new('RGBA',(size,size));draw=ImageDraw.Draw(base)
draw.rounded_rectangle((0,0,size-1,size-1),radius=250*scale,fill=green)
points=[(395,155),(505,155),(505,275),(395,275)]
for i in range(65):
 a=-math.pi/2-math.pi/2*i/64;points.append((395+120*math.cos(a),395+120*math.sin(a)))
points.extend([(275,505),(155,505),(155,395)])
for i in range(65):
 a=math.pi+math.pi/2*i/64;points.append((395+240*math.cos(a),395+240*math.sin(a)))
for angle in [0,90,180,270]:
 a=math.radians(angle);rotated=[]
 for x,y in points:
  x,y=(x-500)*5/6,(y-500)*5/6
  rotated.append(((500+x*math.cos(a)-y*math.sin(a))*scale,(500+x*math.sin(a)+y*math.cos(a))*scale))
 draw.polygon(rotated,fill=white)
base=base.resize((1024,1024),Image.Resampling.LANCZOS)
base.save(root/'icon-1024.png')
base.resize((256,256),Image.Resampling.LANCZOS).save(root/'icon.png')
base.save(root/'icon.ico',sizes=[(n,n) for n in sizes])

preview=Image.new('RGB',(920,440),'#f5f7f9');pd=ImageDraw.Draw(preview);font='C:/Windows/Fonts/msyh.ttc'
thumb=base.resize((256,256),Image.Resampling.LANCZOS);preview.paste(thumb,(70,72),thumb)
pd.text((380,90),'YOTOO 部署中心',font=ImageFont.truetype(font,37),fill='#223041')
pd.text((383,150),'回旋 · 品牌图标',font=ImageFont.truetype(font,20),fill='#58677b')
for i,n in enumerate([16,24,32,48,64]):
 x=390+i*90;thumb=base.resize((n,n),Image.Resampling.LANCZOS);preview.paste(thumb,(x,244-n//2),thumb)
 pd.text((x,296),str(n)+'px',font=ImageFont.truetype(font,13),fill='#58677b')
pd.text((72,378),'统一用于安装程序、开始菜单、桌面、任务栏与窗口',font=ImageFont.truetype(font,17),fill='#58677b')
preview.save(root/'icon-preview.png')

# 安装侧栏和原生控件使用同一墨绿底色，避免透明圆角出现白边。
Image.new('RGB',(164,314),green).save('installer/sidebar.bmp')
brand=Image.new('RGBA',base.size,green);brand.alpha_composite(base)
brand.save('installer/brand.ico',sizes=[(n,n) for n in sizes])
