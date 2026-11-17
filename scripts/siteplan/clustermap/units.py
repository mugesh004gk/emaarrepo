import json, math, numpy as np, cv2, collections
D='/private/tmp/claude-501/-Users-mugesh-Downloads-digital-twin-dubai/ef2bd3be-cd3c-4b35-a01e-92e638053d0a/scratchpad/eden/'
T=json.load(open(D+'terraces_fixed.json')); g=json.load(open(D+'georef.json'))
im2=cv2.imread(D+'hi2-02.png'); hsv2=cv2.cvtColor(im2,cv2.COLOR_BGR2HSV)
pages={'Spruce':cv2.imread(D+'hi3-03.png'),'Iris':cv2.imread(D+'hi10-10.png'),'May Bell':cv2.imread(D+'hi16-16.png')}
hsvp={k:cv2.cvtColor(v,cv2.COLOR_BGR2HSV) for k,v in pages.items()}
H,W=im2.shape[:2]
white=(hsv2[...,1]<25)&(hsv2[...,2]>235)
def band(t,side,d0,d1,k0=0,k1=1):
    c=np.array(t['c']); u=np.array(t['u']); n=np.array(t['n'])
    pts=[]
    for a in np.linspace(-t['L']/2+(k0)*t['L'],-t['L']/2+k1*t['L'],40)[1:-1] if False else np.linspace(-t['L']/2+k0*t['L']+3,-t['L']/2+k1*t['L']-3,12):
        for d in np.linspace(d0,d1,8):
            p=c+u*a+n*side*(t['T']/2+d); pts.append((int(round(p[1])),int(round(p[0]))))
    return [(y,x) for y,x in pts if 0<=y<H and 0<=x<W]
# 10/9/8/6-plex templates (TH01..THn) -> (design, beds, plan letter, floor-plan page)
TPL={
 10:[('Iris',4,'A',13),('Iris',3,'A',11),('Spruce',3,'C',6),('Spruce',3,'D',7),('Iris',3,'B',12),('Iris',3,'A',11),('Iris',3,'B',12),('May Bell',3,'A',17),('May Bell',3,'B',18),('Iris',4,'C',15)],
 9:[('May Bell',4,'A',19),('Iris',3,'A',11),('Iris',3,'B',12),('May Bell',3,'A',17),('May Bell',3,'A',17),('Iris',3,'A',11),('Iris',3,'B',12),('Iris',3,'A',11),('May Bell',4,'B',20)],
 8:[('Spruce',4,'A',8)]+[('Spruce',3,'A' if k%2==0 else 'B',4 if k%2==0 else 5) for k in range(6)]+[('Spruce',4,'B',9)],
 6:[('Iris',4,'A',13),('Iris',3,'A',11),('Iris',3,'B',12),('Iris',3,'A',11),('Iris',3,'B',12),('Iris',4,'B',14)],
}
out=[]; agree=tot=0; flips=0; rep=collections.Counter()
for ti,t in enumerate(T):
    n_=t['nunits']; c=np.array(t['c']); u=np.array(t['u']); nv=np.array(t['n'])
    # street side: carport boxes (white) just outside the building
    wp=[sum(white[y,x] for y,x in band(t,s,4,40)) for s in (1,-1)]
    side=1 if wp[0]>=wp[1] else -1
    # observed type per slot along u (slot 0 at -u end): coloured pixels on each type page around the slot
    obs=[]
    for k in range(n_):
        sc={}
        for name,hv in hsvp.items():
            pts=band(t,1,2,30,k/n_,(k+1)/n_)+band(t,-1,2,30,k/n_,(k+1)/n_)
            sc[name]=sum(1 for y,x in pts if hv[y,x,1]>70)
        best=max(sc,key=sc.get); obs.append(best if sc[best]>15 else None)
    # numbers per slot along u
    nums=t['numbers']  # numbers listed from -u end? check: numbering was assigned by slot index along u
    # TH01 is the left end seen from the street: viewer faces -side*n; left of that = rotate
    f=nv*side                 # outward to the street (plan px, y down)
    left_dir=np.array([-f[1],f[0]]) * -1  # placeholder, fixed below
    # In image coords (y down), facing direction g=-f; viewer's left = rotate g by +90deg in screen terms: (gx,gy)->(gy,-gx)
    g=-f; left=np.array([g[1],-g[0]])
    th01_at_minus_u = (left@u) < 0   # left end lies toward -u
    order=list(range(n_)) if th01_at_minus_u else list(range(n_-1,-1,-1))
    tpl=TPL[n_]
    rows=[]
    for th,slot in enumerate(order):
        d,b,l,pg=tpl[th]
        if obs[slot] is not None:
            tot+=1; agree+= (obs[slot]==d)
        rows.append(dict(no=nums[slot],th=th+1,slot=slot,design=d,beds=b,plan=l,page=pg,seen=obs[slot]))
    m=sum(1 for r in rows if r['seen'] and r['seen']!=r['design'])
    rep[(n_,m==0)]+=1
    out.append(dict(ti=ti,plex=n_,side=side,units=rows,mismatch=m))
print('type agreement with the colour maps: %d/%d'%(agree,tot)); print(rep)
bad=[(o['ti'],o['plex'],[(r['no'],r['design'],r['seen']) for r in o['units'] if r['seen']!=r['design']]) for o in out if o['mismatch']]
for b in bad[:12]: print(b)
json.dump(out,open(D+'units.json','w'))
