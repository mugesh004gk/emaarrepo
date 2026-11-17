import json, math, os, numpy as np, cv2
SP='/private/tmp/claude-501/-Users-mugesh-Downloads-digital-twin-dubai/ef2bd3be-cd3c-4b35-a01e-92e638053d0a/scratchpad/'
D=SP+'eden/'
T=json.load(open(D+'terraces_fixed.json'))
lat,lng,W,Z=25.0143,55.4509,420,18
def px(la,lo):
    n=2**Z*256; x=(lo+180)/360*n; y=(1-math.log(math.tan(math.radians(la))+1/math.cos(math.radians(la)))/math.pi)/2*n; return x,y
mpp=156543.03*math.cos(math.radians(lat))/2**Z; cx,cy=px(lat,lng); h=W/mpp
x0,y0,x1,y1=cx-h,cy-h,cx+h,cy+h
img=np.zeros((int(y1-y0),int(x1-x0),3),np.uint8)
for tx in range(int(x0//256),int(x1//256)+1):
    for ty in range(int(y0//256),int(y1//256)+1):
        t=cv2.imread(SP+f'tiles/{Z}_{tx}_{ty}.jpg'); ox,oy=int(tx*256-x0),int(ty*256-y0)
        xs,ys=max(0,ox),max(0,oy); xe,ye=min(img.shape[1],ox+256),min(img.shape[0],oy+256)
        if xe>xs and ye>ys: img[ys:ye,xs:xe]=t[ys-oy:ye-oy,xs-ox:xe-ox]
hsv=cv2.cvtColor(img,cv2.COLOR_BGR2HSV)
roof=((hsv[...,2]>185)&(hsv[...,1]<45)).astype(np.float32)
roof=cv2.GaussianBlur(roof,(5,5),0)
# plan in plan-px; template drawn in sat pixels for (scale m/px, map-up bearing)
allpts=[]
for t in T:
    c=np.array(t['c']); u=np.array(t['u']); n_=np.array(t['n'])
    allpts.append([c+u*su*t['L']/2+n_*sn*t['T']/2 for su,sn in ((-1,-1),(1,-1),(1,1),(-1,1))])
allpts=np.array(allpts); PM=allpts.reshape(-1,2).mean(0)
def to_m(P,sc,bear):
    th=math.radians(-bear); R=np.array([[math.cos(th),-math.sin(th)],[math.sin(th),math.cos(th)]])
    return (sc*(R@((P-PM)*[1,-1]).reshape(-1,2).T)).T.reshape(P.shape)
def template(sc,bear):
    M=to_m(allpts,sc,bear)/mpp; M[...,1]*=-1  # metres -> sat px (y down)
    mn=M.reshape(-1,2).min(0)-4; M=M-mn; sz=(M.reshape(-1,2).max(0)+4).astype(int)
    tp=np.zeros((sz[1],sz[0]),np.float32)
    for q in M: cv2.fillPoly(tp,[np.round(q).astype(np.int32)],1.0)
    return tp,mn
best=None
for bear in np.arange(318,328,0.5):
    for sc in np.arange(0.108,0.124,0.002):
        tp,mn=template(sc,bear)
        r=cv2.matchTemplate(roof,tp,cv2.TM_CCOEFF_NORMED); _,v,_,loc=cv2.minMaxLoc(r)
        if best is None or v>best[0]: best=(v,bear,sc,loc,mn,tp.shape)
v,bear,sc,loc,mn,shp=best
print('best corr %.3f map-up bearing %.2f scale %.4f m/px'%(v,bear,sc))
# fine search around best
for bear2 in np.arange(bear-0.5,bear+0.51,0.1):
    for sc2 in np.arange(sc-0.002,sc+0.0021,0.0004):
        tp,mn2=template(sc2,bear2)
        r=cv2.matchTemplate(roof,tp,cv2.TM_CCOEFF_NORMED); _,v2,_,loc2=cv2.minMaxLoc(r)
        if v2>v: v,bear,sc,loc,mn=v2,bear2,sc2,loc2,mn2
print('fine corr %.3f map-up bearing %.2f scale %.4f m/px'%(v,bear,sc))
# plan mean point -> sat px -> lat/lng
spx=np.array(loc)-mn   # sat px position of plan mean (M=0 point)
gx,gy=x0+spx[0],y0+spx[1]; n=2**Z*256
lng_c=gx/n*360-180; lat_c=math.degrees(math.atan(math.sinh(math.pi*(1-2*gy/n))))
json.dump(dict(scale=sc,bearing=bear,plan_mean=list(PM),lat=lat_c,lng=lng_c,corr=v),open(D+'georef.json','w'))
print('plan centre at',lat_c,lng_c)
# overlay check
tp,mn=template(sc,bear); vis=img.copy()
M=to_m(allpts,sc,bear)/mpp; M[...,1]*=-1; M=M+spx
for q in M: cv2.polylines(vis,[np.round(q).astype(np.int32)],True,(0,0,255),2)
cv2.imwrite(SP+'eden-fit.png',cv2.resize(vis,(1000,1000)))
