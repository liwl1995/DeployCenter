from pathlib import Path
from PIL import Image,ImageDraw,ImageFont,ImageFilter
import math
root=Path('assets');root.mkdir(exist_ok=True)
svg='''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><defs><linearGradient id="bg" x2=".85" y2="1"><stop stop-color="#1c527d"/><stop offset="1" stop-color="#102c50"/></linearGradient><linearGradient id="arrow" x2=".5" y2="1"><stop stop-color="#74ead3"/><stop offset="1" stop-color="#2ac19f"/></linearGradient></defs><rect x="32" y="32" width="960" height="960" rx="220" fill="url(#bg)"/><rect x="33" y="33" width="958" height="958" rx="219" fill="none" stroke="#ffffff" stroke-opacity=".1" stroke-width="4"/><path d="M280 468v202c0 40 32 72 72 72h320c40 0 72-32 72-72V468" fill="none" stroke="#f5fbff" stroke-width="82" stroke-linecap="round" stroke-linejoin="round"/><path d="M512 266v290m-114-108 114 114 114-114" fill="none" stroke="url(#arrow)" stroke-width="82" stroke-linecap="round" stroke-linejoin="round"/></svg>'''
(root/'icon.svg').write_text(svg,encoding='utf-8')
# SVG 的简单几何使用高分辨率绘制，再以 Lanczos 降采样生成各尺寸。
size=1024;image=Image.new('RGBA',(size,size),(0,0,0,0));mask=Image.new('L',(size,size));md=ImageDraw.Draw(mask);md.rounded_rectangle((32,32,992,992),radius=220,fill=255)
grad=Image.new('RGBA',(size,size));pixels=grad.load()
for y in range(size):
 for x in range(size):
  t=min(1,max(0,(x*.3+y*.7)/1024));pixels[x,y]=(round(28*(1-t)+16*t),round(82*(1-t)+44*t),round(125*(1-t)+80*t),255)
image.paste(grad,(0,0),mask);d=ImageDraw.Draw(image)
# 白色开放容器，圆角与圆形端点保持小尺寸识别度。
d.line([(280,468),(280,670)],fill='#f5fbff',width=82);d.line([(352,742),(672,742)],fill='#f5fbff',width=82);d.line([(744,670),(744,468)],fill='#f5fbff',width=82);d.arc((280,598,424,742),90,180,fill='#f5fbff',width=82);d.arc((600,598,744,742),0,90,fill='#f5fbff',width=82)
# 绘制平滑的外弧和内弧，形成连续 U 形容器。
u=Image.new('RGBA',(1024,1024));ud=ImageDraw.Draw(u)
points=[(280,468),(280,670)]
for i in range(41):
 a=math.pi-math.pi/2*i/40;points.append((352+72*math.cos(a),670+72*math.sin(a)))
points.append((672,742))
for i in range(41):
 a=math.pi/2-math.pi/2*i/40;points.append((672+72*math.cos(a),670+72*math.sin(a)))
points.append((744,468));ud.line(points,fill='#f5fbff',width=82,joint='curve')
for x,y in [(280,468),(744,468)]:ud.ellipse((x-41,y-41,x+41,y+41),fill='#f5fbff')
image.alpha_composite(u)
# 箭头为单一实心折线；形状在 16px 图标上也保留足够空隙。
d=ImageDraw.Draw(image);mint='#5bdfc5';d.line([(512,266),(512,556)],fill=mint,width=82);d.line([(398,448),(512,562),(626,448)],fill=mint,width=82,joint='curve')
for x,y in [(512,266),(398,448),(512,562),(626,448)]:d.ellipse((x-41,y-41,x+41,y+41),fill=mint)
# 以 SVG 母版为准，清除重复手绘容器，重新生成光滑版。
base=Image.new('RGBA',(1024,1024));base.paste(grad,(0,0),mask);base.alpha_composite(u);a=ImageDraw.Draw(base);a.line([(512,266),(512,556)],fill=mint,width=82);a.line([(398,448),(512,562),(626,448)],fill=mint,width=82,joint='curve')
for x,y in [(512,266),(398,448),(512,562),(626,448)]:a.ellipse((x-41,y-41,x+41,y+41),fill=mint)
base.save(root/'icon-1024.png');base.resize((256,256),Image.Resampling.LANCZOS).save(root/'icon.png');base.save(root/'icon.ico',sizes=[(16,16),(20,20),(24,24),(32,32),(40,40),(48,48),(64,64),(80,80),(96,96),(100,100),(120,120),(128,128),(140,140),(160,160),(192,192),(200,200),(240,240),(256,256)])
preview=Image.new('RGB',(920,440),'#f3f6fa');pd=ImageDraw.Draw(preview);font='C:/Windows/Fonts/msyh.ttc';preview.paste(base.resize((256,256),Image.Resampling.LANCZOS),(70,72),base.resize((256,256),Image.Resampling.LANCZOS));pd.text((380,90),'YOTOO 部署中心',font=ImageFont.truetype(font,37),fill='#183552');pd.text((383,150),'构建  ·  部署  ·  回滚',font=ImageFont.truetype(font,20),fill='#4c6075')
for i,n in enumerate([16,24,32,48,64]):
 x=390+i*90;thumb=base.resize((n,n),Image.Resampling.LANCZOS);preview.paste(thumb,(x,244-n//2),thumb);pd.text((x,296),str(n)+'px',font=ImageFont.truetype(font,13),fill='#4c6075')
pd.text((72,378),'统一用于安装程序、开始菜单、桌面、任务栏与窗口',font=ImageFont.truetype(font,17),fill='#4c6075');preview.save(root/'icon-preview.png')
# 安装侧栏只保存纯色背景；图标和品牌文字由 NSIS 原生控件绘制，避免缩放变形。
Image.new('RGB',(164,314),'#153b66').save('installer/sidebar.bmp')

# 安装侧栏使用不透明底色，避免原生静态图标控件把透明圆角绘成白色。
brand=Image.new('RGBA',base.size,'#153b66');brand.alpha_composite(base)
brand.save('installer/brand.ico',sizes=[(n,n) for n in [16,20,24,32,40,48,64,80,96,100,120,128,140,160,192,200,240,256]])
