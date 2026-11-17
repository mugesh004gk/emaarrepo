import cv2, numpy as np, json, math, collections
D='/private/tmp/claude-501/-Users-mugesh-Downloads-digital-twin-dubai/ef2bd3be-cd3c-4b35-a01e-92e638053d0a/scratchpad/eden/'
blds=json.load(open(D+'blds.json')); f=json.load(open(D+'ocr_found.json'))
hits=[(int(k),x,y) for k,v in f.items() for x,y,nn in v]
def frame(b):
    a=math.radians(b['a']); w,h=b['w'],b['h']
    u=np.array([math.cos(a),math.sin(a)]); n=np.array([-math.sin(a),math.cos(a)])
    if h>w: u,n,w,h=n,u,h,w
    return np.array([b['cx'],b['cy']]),u,n,w,h
B=[]
for b in blds:
    c,u,n,w,h=frame(b)
    if not (240<w<620 and 90<h<125): continue
    B.append(dict(c=c,u=u,n=n,L=w,T=h))
# merge collinear, touching pieces into terraces
par=list(range(len(B)))
def fd(i):
    while par[i]!=i: par[i]=par[par[i]]; i=par[i]
    return i
for i in range(len(B)):
    for j in range(i+1,len(B)):
        a,b=B[i],B[j]
        if abs(a['u']@b['u'])<0.995: continue
        d=b['c']-a['c']
        if abs(d@a['n'])>12: continue
        gap=abs(d@a['u'])-(a['L']+b['L'])/2
        if gap<25: par[fd(i)]=fd(j)
groups=collections.defaultdict(list)
for i in range(len(B)): groups[fd(i)].append(B[i])
T=[]
for g in groups.values():
    u=g[0]['u']; n=g[0]['n']
    ends=[p['c']+s*p['u']*p['L']/2 for p in g for s in (-1,1)]
    al=[e@u for e in ends]; c0=np.mean([p['c'] for p in g],0)
    lo,hi=min(al),max(al); cen=c0+u*((lo+hi)/2-c0@u)
    T.append(dict(c=cen,u=u,n=n,L=hi-lo,T=float(np.mean([p['T'] for p in g])),pieces=len(g)))
# numbers inside each terrace
PITCH=69.0
res=[]
for t in T:
    inside=[]
    for k,x,y in hits:
        d=np.array([x,y])-t['c']
        if abs(d@t['u'])<=t['L']/2+5 and abs(d@t['n'])<=t['T']/2+5: inside.append((k,d@t['u']))
    nunits=int(round(t['L']/PITCH))
    t['nunits']=nunits; t['hits']=inside
    res.append(t)
print('terraces',len(T),'units by length',sum(t['nunits'] for t in T))
print(collections.Counter(t['nunits'] for t in T))
# numbering: slot index along axis -> number = a + s*slot ; pick best (a,s) by votes
units={}; bad=[]
for ti,t in enumerate(T):
    n=t['nunits']; slot=lambda al: int(np.clip(np.floor((al+t['L']/2)/t['L']*n),0,n-1))
    votes=collections.Counter()
    for k,al in t['hits']:
        s0=slot(al)
        votes[(k-s0,1)]+=1; votes[(k+s0,-1)]+=1
    if not votes: bad.append((ti,'no numbers')); continue
    (a,sg),v=votes.most_common(1)[0]
    t['first'],t['dir'],t['votes'],t['nhits']=a,sg,v,len(t['hits'])
    nums=[a+sg*s for s in range(n)]
    t['numbers']=nums
    for s,k in enumerate(nums):
        units.setdefault(k,[]).append((ti,s))
dups=[k for k,v in units.items() if len(v)>1]; missing=[k for k in range(1,363) if k not in units]; extra=[k for k in units if not 1<=k<=362]
print('numbered',len(units),'dups',dups,'missing',missing,'out of range',extra,'bad',bad)
print(sorted((min(t['numbers']),max(t['numbers']),t['nunits'],t['votes'],t['nhits']) for t in T if 'numbers' in t))
json.dump([dict(c=list(map(float,t['c'])),u=list(map(float,t['u'])),n=list(map(float,t['n'])),L=float(t['L']),T=float(t['T']),nunits=t['nunits'],numbers=t.get('numbers')) for t in T],open(D+'terraces.json','w'))
