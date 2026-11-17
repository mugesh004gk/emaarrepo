import json, numpy as np
D='/private/tmp/claude-501/-Users-mugesh-Downloads-digital-twin-dubai/ef2bd3be-cd3c-4b35-a01e-92e638053d0a/scratchpad/eden/'
f=json.load(open(D+'ocr_found.json'))
cands={}
for k,v in f.items():
    cl=[]
    for x,y,n in v:
        for c in cl:
            if np.hypot(c[0]-x,c[1]-y)<40: c[2].append((x,y)); break
        else: cl.append([x,y,[(x,y)]])
    cands[int(k)]=[np.mean(c[2],0) for c in cl]
SP=69.0; BREAK=1.5; SKIP=3.0; N=362
def cost(a,b,gap):
    e=np.hypot(*(a-b))/(SP*gap)
    return min((e-1)**2*6, BREAK)
states=[cands.get(i,[]) for i in range(1,N+1)]
best={}
for i in range(N):
    for c,p in enumerate(states[i]):
        bc,bp=(SKIP*i, None)
        for j in range(max(0,i-10),i):
            for c2,p2 in enumerate(states[j]):
                v=best[(j,c2)][0]+cost(p2,p,i-j)+SKIP*(i-j-1)
                if v<bc: bc,bp=v,(j,c2)
        best[(i,c)]=(bc,bp)
end=min(best,key=lambda k:best[k][0]+SKIP*(N-1-k[0]))
chosen={}; k=end
while k: chosen[k[0]+1]=list(map(float,states[k[0]][k[1]])); k=best[k][1]
json.dump(chosen,open(D+'pos.json','w'))
print('chosen',len(chosen),'missing',[i for i in range(1,N+1) if i not in chosen])
d=[np.hypot(*(np.array(chosen[i+1])-chosen[i])) for i in range(1,N) if i in chosen and i+1 in chosen]
print('breaks',[(i,round(float(np.hypot(*(np.array(chosen[i+1])-chosen[i]))))) for i in range(1,N) if i in chosen and i+1 in chosen and np.hypot(*(np.array(chosen[i+1])-chosen[i]))>1.35*SP])
# drop isolated picks (far from both neighbours)
P={int(k):np.array(v) for k,v in chosen.items()}
iso=[]
for i in list(P):
    nb=[j for j in (i-1,i+1) if j in P]
    if nb and all(np.hypot(*(P[j]-P[i]))>1.35*SP for j in nb): iso.append(i)
for i in iso: del P[i]
print('isolated dropped',iso)
# runs: consecutive known numbers with spacing ~SP*gap (gap<=7) and collinear
runs=[]; cur=[]
for i in range(1,N+1):
    if i not in P: continue
    if cur:
        j=cur[-1]; d=np.hypot(*(P[i]-P[j])); g=i-j
        ok=abs(d/(SP*g)-1)<0.25 and g<=7
        if ok and len(cur)>=2:
            u=(P[j]-P[cur[0]])/np.hypot(*(P[j]-P[cur[0]])); v=(P[i]-P[j])/d
            ok=abs(u@v)>0.97
        if not ok: runs.append(cur); cur=[]
    cur.append(i)
runs.append(cur)
print('runs',len(runs)); print([(r[0],r[-1],len(r)) for r in runs])
json.dump({k:list(map(float,v)) for k,v in P.items()},open(D+'pos_clean.json','w'))
json.dump(runs,open(D+'runs.json','w'))
