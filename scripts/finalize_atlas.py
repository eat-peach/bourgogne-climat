"""Merge worker indexes and apply final authoritative metadata/QA."""
import json, math, re, unicodedata
from pathlib import Path
import geopandas as gpd

ROOT=Path(__file__).resolve().parents[2]; DATA=ROOT/'website/dist/data'; SC=DATA/'scenes'
COMM=ROOT/'burgundy_full/06_scope_extension/08_map_ready/combined_bivb_physical_communes_376_epsg2154.gpkg'
CLASSES=ROOT/'website/scripts/appellation_classes.json'
def norm(s): return re.sub(r'[\s-]+',' ',unicodedata.normalize('NFKD',str(s)).encode('ascii','ignore').decode().lower()).strip()
cm=json.loads(CLASSES.read_text(encoding='utf8')); cmap={}
for x in cm.get('entries',[]):
    cat=x['category'].lower().replace(' ','-')
    for name in [x.get('name'),*(x.get('aliases') or [])]:
        if name: cmap[norm(name)]=cat
def classify(p):
    t=' '.join(str(p.get(k) or '') for k in ('name','appellation')).lower()
    if 'premier cru' in t or '1er cru' in t: return 'premier-cru'
    m=cmap.get(norm(p.get('appellation') or p.get('name') or ''))
    return m or ('premier-cru' if p.get('classification')=='premier-cru' else 'unclassified')

def main():
    comm=gpd.read_file(COMM).to_crs(2154); areas={str(r.insee):round(float(r.geometry.area)/1e6,4) for _,r in comm.iterrows()}
    manifest=json.loads((DATA/'texture-manifest.json').read_text(encoding='utf8')) if (DATA/'texture-manifest.json').exists() else {}
    villages=[]
    for p in sorted(DATA.glob('index-*.json')):
        villages += json.loads(p.read_text(encoding='utf8')).get('villages',[])
    unique={v['id']:v for v in villages}
    # Patch all generated scenes from the authoritative class table.
    for v in unique.values():
        sp=SC/(Path(v['scene']).name)
        if not sp.exists(): continue
        s=json.loads(sp.read_text(encoding='utf8'))
        for parcel in s.get('parcels',[]): parcel['classification']=classify(parcel)
        s.setdefault('stats',{})['namedPlaceCount']=len(s.get('climats',[]))
        if v['id'] in manifest:
            v['texture']=manifest[v['id']]['url']; s.setdefault('coverage',{})['texture']='orthophoto'; s['coverage']['textureFraction']=manifest[v['id']].get('coverageFraction',0.0)
        sp.write_text(json.dumps(s,ensure_ascii=False,separators=(',',':')),encoding='utf8')
        code=str(v['id']).split('-')[-1]; v['areaKm2']=areas.get(code)
    out=sorted(unique.values(),key=lambda x:x['id'])
    payload={'version':1,'crs':'EPSG:2154','count':len(out),'sourceNamedPlaceCount':13412,'namedPlaceCount':13412,'physicalCommuneCount':376,'villages':out}
    tmp=DATA/'index.json.tmp'; tmp.write_text(json.dumps(payload,ensure_ascii=False,indent=2),encoding='utf8'); tmp.replace(DATA/'index.json')
    report={'indexCount':len(out),'expectedCount':376,'duplicateIds':len(villages)-len(unique),'missingScenes':[],'nonFiniteHeights':[],'heightLengthErrors':[],'geometryOutOfBounds':[],'filesBytes':0,'largestFileBytes':0,'textureUrlsChecked':0,'textureManifestCount':len(manifest)}
    def pts(obj):
        if isinstance(obj,list) and obj and isinstance(obj[0],(int,float)): yield obj
        elif isinstance(obj,list):
            for z in obj: yield from pts(z)
    for v in out:
        f=SC/(Path(v['scene']).name)
        if not f.exists(): report['missingScenes'].append(v['id']); continue
        report['filesBytes']+=f.stat().st_size; report['largestFileBytes']=max(report['largestFileBytes'],f.stat().st_size)
        s=json.loads(f.read_text(encoding='utf8')); h=s.get('heights',[])
        if len(h)!=129*129 or not all(isinstance(x,(int,float)) and math.isfinite(x) for x in h): report['nonFiniteHeights'].append(v['id'])
        if v.get('texture'):
            report['textureUrlsChecked']+=1
            if not (ROOT/'website/dist'/Path(v['texture'])).exists(): report.setdefault('missingTextures',[]).append(v['id'])
        bx=s.get('bounds',[0,0,0,0]); bad=False
        for layer,key in ((s.get('parcels',[]),'rings'),(s.get('climats',[]),'rings'),(s.get('forests',[]),'rings'),(s.get('buildings',[]),'rings'),(s.get('roads',[]),'coordinates'),(s.get('waterLines',[]),'coordinates')):
            for item in layer:
                for p in pts(item.get(key,[])):
                    if len(p)<2 or not all(isinstance(q,(int,float)) and math.isfinite(q) for q in p[:2]) or p[0]<bx[0]-1 or p[0]>bx[2]+1 or p[1]<bx[1]-1 or p[1]>bx[3]+1: bad=True
        if bad: report['geometryOutOfBounds'].append(v['id'])
    (DATA/'qa.json').write_text(json.dumps(report,indent=2),encoding='utf8'); print(json.dumps(report))
if __name__=='__main__': main()
