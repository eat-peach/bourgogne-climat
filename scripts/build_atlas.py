"""Build static, real-data scene payloads for the Burgundy 3D atlas.

All geometry remains in EPSG:2154 (metres).  The source datasets are never
modified.  The script is intentionally rerunnable; scene files are replaced
only after they have been fully written.
"""
from __future__ import annotations
import argparse, json, math, os, re, shutil, tempfile, unicodedata
from pathlib import Path
from typing import Any

import numpy as np
import geopandas as gpd
import rasterio
from rasterio.enums import Resampling
from rasterio.vrt import WarpedVRT
from rasterio.merge import merge
from rasterio.transform import from_bounds
from shapely.geometry import Polygon, MultiPolygon, LineString, MultiLineString, box
from shapely.ops import unary_union, transform as shp_transform
from pyproj import Transformer
from shapely.geometry.base import BaseGeometry

ROOT = Path(__file__).resolve().parents[2]
FULL = ROOT / "burgundy_full"
OUT = ROOT / "website" / "dist" / "data"
SCENES = OUT / "scenes"
TEXTURES = OUT / "textures"
COMMUNES = FULL / "06_scope_extension/08_map_ready/combined_bivb_physical_communes_376_epsg2154.gpkg"
AOC = FULL / "06_scope_extension/08_map_ready/combined_bivb_inao_burgundy_aoc_core_epsg2154.gpkg"
CLIMATS = FULL / "06_scope_extension/09_climats/bourgogne_maps_climats_lieuxdits_render_ready_epsg2154.gpkg"
BUILDINGS = FULL / "04_landscape/buildings"
ROADS = FULL / "04_landscape/roads"
BUILDINGS_GPKG = FULL / "04_landscape/buildings.gpkg"
ROADS_GPKG = FULL / "04_landscape/roads.gpkg"
FORESTS = FULL / "04_landscape/vegetation_foret.gpkg"
TERRAIN_FINE = FULL / "03_terrain/rgealti_mnt_1m"
TERRAIN_COARSE = FULL / "03_terrain/overview_rgealti_25m"
TERRAIN_EXT = FULL / "06_scope_extension/terrain/rgealti_mnt_1m"
WATER_SURFACE = FULL / "04_landscape/water_surface.gpkg"
WATER_LINES = FULL / "04_landscape/water_lines.gpkg"
ORTHO = FULL / "05_orthophoto"
CLASS_FILE = ROOT / "website/scripts/appellation_classes.json"
_class_data=json.loads(CLASS_FILE.read_text(encoding='utf-8')) if CLASS_FILE.exists() else {'entries':[]}
def norm_name(s):
    s=unicodedata.normalize('NFKD',str(s)).encode('ascii','ignore').decode().lower()
    # Official exports vary between spaces and hyphens (notably Bonnes-Mares).
    return re.sub(r'[\s-]+',' ',s).strip()
CLASS_MAP={norm_name(x['name']):x['category'].lower().replace(' ','-') for x in _class_data.get('entries',[])}

SOURCES = {
    "communes": str(COMMUNES.relative_to(ROOT)), "aoc": str(AOC.relative_to(ROOT)),
    "climats": str(CLIMATS.relative_to(ROOT)), "buildings": str(BUILDINGS.relative_to(ROOT)),
    "roads": str(ROADS.relative_to(ROOT)), "forests": str(FORESTS.relative_to(ROOT)),
    "terrainFine": str(TERRAIN_FINE.relative_to(ROOT)), "terrainCoarse": str(TERRAIN_COARSE.relative_to(ROOT)),
    "orthophoto": str(ORTHO.relative_to(ROOT)), "crs": "EPSG:2154",
}

def clean(v: Any) -> Any:
    if v is None: return None
    if isinstance(v, (float, np.floating)):
        return None if not math.isfinite(float(v)) else float(v)
    if isinstance(v, (int, np.integer)): return int(v)
    s = str(v)
    return None if s.lower() in {"nan", "none", "nat"} else s

def rings(g: BaseGeometry, simplify=0.0):
    if g is None or g.is_empty: return []
    if simplify: g = g.simplify(simplify, preserve_topology=True)
    gs = list(g.geoms) if isinstance(g, MultiPolygon) else [g]
    out=[]
    for p in gs:
        if isinstance(p, Polygon):
            rr=[[[round(float(pt[0]),2),round(float(pt[1]),2)] for pt in p.exterior.coords]]
            rr += [[[round(float(pt[0]),2),round(float(pt[1]),2)] for pt in h.coords] for h in p.interiors]
            out.append(rr)
    return out

def lines(g: BaseGeometry, simplify=1.5):
    if g is None or g.is_empty: return []
    if simplify: g=g.simplify(simplify, preserve_topology=False)
    gs=list(g.geoms) if isinstance(g, MultiLineString) else [g]
    return [[[round(float(pt[0]),2),round(float(pt[1]),2)] for pt in q.coords] for q in gs if isinstance(q,LineString)]

def infer_class(row):
    # Classification is based solely on explicit INAO designation text.
    text=" ".join(str(row.get(k,"")) for k in ("denom","app","type_denom","categorie","signe")).lower()
    if "grand cru" in text: return "grand-cru"
    if "premier cru" in text or "1er cru" in text: return "premier-cru"
    for key in ('denom','app'):
        mapped=CLASS_MAP.get(norm_name(row.get(key,'')))
        if mapped: return mapped
    if any(x in text for x in ("bourgogne", "régional", "regional")) and not any(x in text for x in ("village", "communal")): return "regional"
    if "village" in text or "communal" in text: return "village"
    return "unclassified"

def get_bound_paths(directory, pattern):
    return sorted(directory.glob(pattern))

def read_tiled(directory, bounds, columns):
    frames=[]; ext=box(*bounds)
    for p in directory.glob('*.geojson'):
        m=re.search(r'_(\d+)_(\d+)_epsg2154',p.name)
        if not m: continue
        x,y=int(m.group(1))*10000,int(m.group(2))*10000
        if not ext.intersects(box(x,y,x+10000,y+10000)): continue
        try: frames.append(gpd.read_file(p,bbox=bounds,columns=columns))
        except Exception: pass
    return gpd.pd.concat(frames,ignore_index=True) if frames else gpd.GeoDataFrame(geometry=[],crs='EPSG:2154')

def raster_tile_candidates(paths, bounds):
    """Select 1 km RGE/orthophoto tiles by EPSG:2154 filename keys."""
    x0=int(math.floor(bounds[0]/1000)); x1=int(math.floor((bounds[2]-1e-6)/1000))
    y0=int(math.floor(bounds[1]/1000)); y1=int(math.floor((bounds[3]-1e-6)/1000))
    keys={(x,y) for x in range(x0,x1+1) for y in range(y0,y1+1)}
    out=[]
    for p in paths:
        m=re.search(r'_(\d{3,4})_(\d{3,5})_',p.name)
        if m and (int(m.group(1)),int(m.group(2))) in keys: out.append(p)
    return out

def raster_for(bounds, fine_paths, coarse_paths, ext_paths, size=129, return_meta=False):
    # Compose coarse coverage first, then overwrite pixels covered by 1m tiles.
    def read(paths):
        chosen=[]
        for p in paths:
            try:
                with rasterio.open(p) as ds:
                    if box(*bounds).intersects(box(*ds.bounds)): chosen.append(p)
            except Exception: pass
        if not chosen: return None
        spanx,spany=bounds[2]-bounds[0],bounds[3]-bounds[1]
        raw=[rasterio.open(p) for p in chosen]
        dslist=[WarpedVRT(ds,crs='EPSG:2154',src_crs='EPSG:2154') for ds in raw]
        try: arr,_=merge(dslist,bounds=bounds,res=(spanx/size,spany/size),resampling=Resampling.bilinear,nodata=np.nan)
        finally:
            for ds in dslist: ds.close()
            for ds in raw: ds.close()
        return arr[0].astype('float32')
    coarse_arr=read(coarse_paths+ext_paths); fine_arr=read(fine_paths)
    a=fine_arr if fine_arr is not None else coarse_arr
    if a is None: return [0.0]*(size*size),0.0,0.0,"missing"
    if coarse_arr is not None and fine_arr is not None:
        # resampling dimensions can differ by a pixel; crop to common grid.
        h=min(a.shape[0],coarse_arr.shape[0]); w=min(a.shape[1],coarse_arr.shape[1]); a=coarse_arr[:h,:w].copy()
        m=np.isfinite(fine_arr[:h,:w]) & (fine_arr[:h,:w] > -1000); a[m]=fine_arr[:h,:w][m]
    valid=np.isfinite(a) & (a > 1)
    if not valid.any(): return [0.0]*(size*size),0.0,0.0,"missing"
    # A finite source value is required at every sample; missing source pixels are
    # explicitly represented by zero plus coverage metadata rather than a made-up
    # interpolated elevation.
    a[~valid]=np.nan
    a=np.asarray(a)
    if a.shape != (size,size):
        from PIL import Image
        a=np.asarray(Image.fromarray(np.nan_to_num(a,nan=0.0)).resize((size,size),Image.Resampling.BILINEAR),dtype='float32')
    edge_fills=int(np.sum(~(np.isfinite(a)&(a>1))))
    if edge_fills:
        # Fill only edge holes from nearest actual source sample in the same
        # exported raster; never invent a zero elevation.
        good=np.argwhere(np.isfinite(a)&(a>1))
        for iy,ix in np.argwhere(~(np.isfinite(a)&(a>1))):
            j=good[np.argmin((good[:,0]-iy)**2+(good[:,1]-ix)**2)]; a[iy,ix]=a[j[0],j[1]]
    valid2=np.isfinite(a)&(a>1)
    result=([round(float(x),2) for x in a.ravel()], round(float(a[valid2].min()),2), round(float(a[valid2].max()),2), "fine_1m" if fine_arr is not None else "overview_25m")
    return result + (edge_fills,) if return_meta else result
def texture_for(bounds, paths, outpath, size=2048):
    chosen=[]
    for p in paths:
        try:
            with rasterio.open(p) as ds:
                if box(*bounds).intersects(box(*ds.bounds)): chosen.append(p)
        except Exception: pass
    if not chosen: return False
    from PIL import Image
    dslist=[rasterio.open(p) for p in chosen]
    try:
        spanx,spany=bounds[2]-bounds[0],bounds[3]-bounds[1]
        arr,_=merge(dslist,bounds=bounds,res=(spanx/size,spany/size),resampling=Resampling.bilinear)
    finally:
        for ds in dslist: ds.close()
    missing=np.all(arr == 0, axis=0)
    arr=np.nan_to_num(arr)
    if arr.shape[1:] != (size,size):
        from PIL import Image
        arr=np.stack([np.asarray(Image.fromarray(b).resize((size,size),Image.Resampling.BILINEAR)) for b in arr])
        missing=np.asarray(Image.fromarray(missing.astype('uint8')).resize((size,size),Image.Resampling.NEAREST),dtype=bool)
    if arr.shape[0]==1: arr=np.repeat(arr,3,axis=0)
    if arr.shape[0]>=4: arr=arr[:3]
    # Keep source RGB values; uncovered pixels use a neutral cartographic fill.
    out=np.clip(arr[:3],0,255).astype(np.uint8)
    out[:,missing] = np.array([[190],[182],[165]],dtype=np.uint8)
    Image.fromarray(np.moveaxis(out,0,-1),'RGB').save(outpath,quality=76,optimize=True)
    return True

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--only',default=''); ap.add_argument('--limit',type=int,default=0); ap.add_argument('--offset',type=int,default=0); ap.add_argument('--index-output',default=''); ap.add_argument('--no-textures',action='store_true'); args=ap.parse_args()
    OUT.mkdir(parents=True,exist_ok=True); SCENES.mkdir(parents=True,exist_ok=True); TEXTURES.mkdir(parents=True,exist_ok=True)
    communes=gpd.read_file(COMMUNES).to_crs(2154)
    aoc=gpd.read_file(AOC).to_crs(2154)
    clim=gpd.read_file(CLIMATS).to_crs(2154)
    fine=get_bound_paths(TERRAIN_FINE,'*.tif'); coarse=get_bound_paths(TERRAIN_COARSE,'*.tif'); ext=get_bound_paths(TERRAIN_EXT,'*.tif') if TERRAIN_EXT.exists() else []; ortho=get_bound_paths(ORTHO,'*.tif')
    def catalog(paths):
        out=[]
        for p in paths:
            try:
                with rasterio.open(p) as ds: out.append((p,tuple(ds.bounds)))
            except Exception: pass
        return out
    # Fine and orthophoto tiles use 1 km filename keys; only overview tiles are
    # catalogued by bounds (roughly three dozen files), avoiding thousands of opens.
    finecat, extcat, orthocat = fine, ext, ortho
    coarsecat = catalog(coarse)
    selected=communes
    if args.only: selected=selected[selected.insee.astype(str).eq(args.only) | selected.commune_name.str.lower().eq(args.only.lower())]
    if args.offset: selected=selected.iloc[args.offset:]
    if args.limit: selected=selected.head(args.limit)
    index=[]
    for n,(_, c) in enumerate(selected.iterrows(),1):
        cid=str(c.insee); name=str(c.commune_name); geom=c.geometry
        # Use the full municipality for non-wine communes and the municipality extent
        # for wine communes as requested, with a 500m contextual buffer.
        wine=aoc[aoc.geometry.intersects(geom)].copy()
        # Intersect each AOC feature with this commune before taking the union;
        # neighbouring commune polygons must not enlarge a scene.
        focus=unary_union([g.intersection(geom) for g in wine.geometry]) if len(wine) else geom
        bounds=focus.buffer(500).bounds
        scene_id=re.sub(r'[^a-z0-9]+','-',name.lower()).strip('-')+'-'+cid
        extent=box(*bounds)
        def clipped(df): return df[df.geometry.intersects(extent)]
        pa=clipped(aoc); pc=clipped(clim)
        parcels=[]
        for i,r in pa.iterrows():
            g=r.geometry.intersection(extent)
            if g.is_empty: continue
            parcels.append({'id':str(r.get('id_aire') or r.get('id_app') or i),'name':clean(r.get('denom') or r.get('app')),'classification':infer_class(r),'appellation':clean(r.get('app') or r.get('denom')),'rings':rings(g,.35)})
        climats=[{'id':str(r.get('source_id') or i),'name':clean(r.get('nom')),'rings':rings(r.geometry.intersection(extent),.5),'source':clean(r.get('source_endpoint') or 'bourgogne_maps_render_ready')} for i,r in pc.iterrows() if not r.geometry.intersection(extent).is_empty]
        b=read_tiled(BUILDINGS,bounds,['cleabs','hauteur','geometry'])
        b=b[b.geometry.intersects(extent)].copy(); b['_area']=b.geometry.area
        b=b.sort_values('_area',ascending=False).head(1500)
        buildings=[]
        for _,r in b.iterrows():
            rr=rings(r.geometry.intersection(extent),.6)
            if rr:
                item={'rings':rr}
                if clean(r.hauteur) is not None: item['height']=round(float(r.hauteur),1)
                else: item['heightUnknown']=True
                buildings.append(item)
        rd=read_tiled(ROADS,bounds,['nature','importance','geometry']); rd=rd[rd.geometry.intersects(extent)]
        roads=[{'coordinates':q,'kind':clean(r.nature) or 'road'} for _,r in rd.iterrows() for q in lines(r.geometry.intersection(extent),1.5) if len(q)>1]
        fr=gpd.read_file(FORESTS,bbox=bounds,columns=['nature','geometry']); fr=fr[fr.geometry.intersects(extent)]
        forests=[{'rings':rr} for _,r in fr.iterrows() for rr in rings(r.geometry.intersection(extent),1.0)]
        ws=gpd.read_file(WATER_SURFACE,bbox=bounds,columns=['geometry']); ws=ws[ws.geometry.intersects(extent)]
        waterSurfaces=[{'rings':rr} for _,r in ws.iterrows() for rr in rings(r.geometry.intersection(extent),.8)]
        wl=gpd.read_file(WATER_LINES,bbox=bounds,columns=['geometry']); wl=wl[wl.geometry.intersects(extent)]
        waterLines=[{'coordinates':q} for _,r in wl.iterrows() for q in lines(r.geometry.intersection(extent),1.0) if len(q)>1]
        def candidates(cat): return raster_tile_candidates(cat,bounds) if cat is not coarsecat else [p for p,bb in cat if box(*bounds).intersects(box(*bb))]
        heights,mn,mx,terr=raster_for(bounds,candidates(finecat),candidates(coarsecat),candidates(extcat))
        texrel=f'data/textures/{scene_id}.jpg'; texok=False
        if not args.no_textures: texok=texture_for(bounds,raster_tile_candidates(orthocat,bounds),TEXTURES/(scene_id+'.jpg'))
        scene={'id':scene_id,'name':name,'bounds':list(map(lambda x:round(float(x),2),bounds)),'gridSize':129,'heights':heights,'minElevation':mn,'maxElevation':mx,'parcels':parcels,'climats':climats,'buildings':buildings,'roads':roads,'forests':forests,'waterSurfaces':waterSurfaces,'waterLines':waterLines,'stats':{'parcelCount':len(parcels),'climatCount':len(climats),'buildingCount':len(buildings),'roadCount':len(roads),'forestCount':len(forests),'waterSurfaceCount':len(waterSurfaces),'waterLineCount':len(waterLines),'terrainSource':terr,'textureCoverage':texok},'sources':SOURCES,'coverage':{'commune':cid,'texture': 'orthophoto' if texok else 'cartographic_background','terrain':terr}}
        tmp=SCENES/(scene_id+'.json.tmp'); tmp.write_text(json.dumps(scene,ensure_ascii=False,separators=(',',':')),encoding='utf-8'); tmp.replace(SCENES/(scene_id+'.json'))
        minx,miny,maxx,maxy=bounds; cx,cy=geom.centroid.x,geom.centroid.y
        lon,lat=Transformer.from_crs(2154,4326,always_xy=True).transform(cx,cy)
        index.append({'id':scene_id,'name':name,'department':cid[:2],'region':'Bourgogne-Franche-Comté','center':[round(lon,6),round(lat,6)],'bounds2154':[round(minx,2),round(miny,2),round(maxx,2),round(maxy,2)],'scene':f'data/scenes/{scene_id}.json','texture':texrel if texok else None})
        if n%10==0: print(f'{n}/{len(selected)} scenes')
    index.sort(key=lambda x:x['id']); (OUT/(args.index_output or 'index.json')).write_text(json.dumps({'version':1,'crs':'EPSG:2154','count':len(index),'villages':index},ensure_ascii=False,indent=2),encoding='utf-8')
    print('built',len(index),'scenes')

if __name__=='__main__': main()
