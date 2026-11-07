import json, requests, tempfile
from pathlib import Path
import rasterio
from rasterio.io import MemoryFile
ROOT=Path(__file__).resolve().parents[2]; SC=ROOT/'website/dist/data/scenes'
names='arnas-69013 blac-69023 change-71085 chapelle-vaupelteigne-89081 chitry-89108 couchey-21200 daix-21223 dijon-21231 fixin-21265 lignorelles-89226 lugny-71267 maligny-89242 morey-saint-denis-21442 plombi-res-l-s-dijon-21485 rochepot-21527 saint-cyr-le-chatoux-69192 salles-arbuissonnas-en-beaujolais-69172 serrigny-89393 talant-21617 vaux-en-beaujolais-69257 venoy-89438'.split()
URL='https://data.geopf.fr/wms-r/wms'; LAYER='RGEALTI-MNT_PYR-ZIP_FXX_LAMB93_WMS'
for name in names:
 p=SC/(name+'.json'); s=json.loads(p.read_text(encoding='utf8')); bb=s['bounds']; params={'SERVICE':'WMS','VERSION':'1.3.0','REQUEST':'GetMap','LAYERS':LAYER,'STYLES':'normal','CRS':'EPSG:2154','BBOX':','.join(map(str,bb)),'WIDTH':129,'HEIGHT':129,'FORMAT':'image/geotiff'}
 r=requests.get(URL,params=params,timeout=120); r.raise_for_status()
 with MemoryFile(r.content) as mem:
  with mem.open() as ds:
   if str(ds.crs).upper() not in ('EPSG:2154','EPSG:2154'): raise RuntimeError(f'unexpected CRS {ds.crs} for {name}')
   if max(abs(float(x)-float(y)) for x,y in zip(ds.bounds,bb))>1.0: raise RuntimeError(f'bounds mismatch for {name}: {ds.bounds} vs {bb}')
   if ds.width!=129 or ds.height!=129: raise RuntimeError(f'grid mismatch for {name}')
   a=ds.read(1).astype('float32'); nod=ds.nodata
  if nod is not None: a[a==nod]=float('nan')
 if not (a==a).all(): raise RuntimeError(f'nodata in {name}')
 s['heights']=[round(float(x),2) for x in a.ravel()]; s['minElevation']=round(float(a.min()),2); s['maxElevation']=round(float(a.max()),2); s.setdefault('coverage',{})['terrain']='ign_rgealti_wms_exact_bounds'; s['coverage'].pop('terrainEdgeFillUsed',None); s['coverage'].pop('terrainEdgeFillNote',None); s['coverage']['terrainSourceCoverageFraction']=1.0
 p.write_text(json.dumps(s,ensure_ascii=False,separators=(',',':')),encoding='utf8'); print(name)
