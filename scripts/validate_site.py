#!/usr/bin/env python3
"""Validate the static Burgundy atlas index, scenes, and browser modules."""
from __future__ import annotations
import shutil
import gzip, json, math, re, subprocess, sys
from pathlib import Path
from urllib.parse import urlparse

SITE=Path(__file__).resolve().parents[1]; DIST=SITE/'dist'; DATA=DIST/'data'; MAX_ASSET_BYTES=25*1024*1024; MAX_ASSET_FILES=20000; SCENE_COUNT=376
CANONICAL={'grand-cru','premier-cru','beaujolais-cru','village','regional','unclassified','regional/unknown'}
EXTERNAL=re.compile(r'^(?:https?:)?//',re.I)

def fail(errors,msg): errors.append(msg)
def finite(value,path,errors):
    if isinstance(value,float) and not math.isfinite(value): fail(errors,f'non-finite number at {path}')
    elif isinstance(value,(list,tuple)):
        for i,x in enumerate(value): finite(x,f'{path}[{i}]',errors)
    elif isinstance(value,dict):
        for k,x in value.items(): finite(x,f'{path}.{k}',errors)

def load_index(errors):
    path=DATA/'index.json'
    if not path.is_file(): fail(errors,'dist/data/index.json is missing'); return path,{},[]
    try: value=json.loads(path.read_text(encoding='utf-8'))
    except Exception as e: fail(errors,f'index.json is invalid: {e}'); return path,{},[]
    records=value.get('villages',[]) if isinstance(value,dict) else value
    if not isinstance(records,list) or len(records)!=SCENE_COUNT: fail(errors,f'index must contain exactly {SCENE_COUNT} village records')
    return path,value,records if isinstance(records,list) else []

def local_target(ref,base=DIST):
    if not isinstance(ref,str) or EXTERNAL.match(ref) or urlparse(ref).scheme: return None
    return (base/ref.replace('\\','/')).resolve()

def read_scene(path,errors):
    try:
        payload=path.read_bytes()
        if path.suffix=='.gz':
            if payload[:2]!=b'\x1f\x8b':
                fail(errors,f'{path.name} is not a gzip payload')
                return None
            payload=gzip.decompress(payload)
        return json.loads(payload.decode('utf-8'))
    except Exception as e:
        fail(errors,f'{path.name} is invalid scene payload: {e}')
        return None

def validate_scene(record,scene,scene_path,errors):
    if not isinstance(scene,dict): fail(errors,f'{scene_path.name} is not an object'); return
    finite(scene,scene_path.name,errors)
    bounds=scene.get('bounds')
    if not isinstance(bounds,list) or len(bounds)!=4 or not all(isinstance(x,(int,float)) for x in bounds) or not(bounds[0]<bounds[2] and bounds[1]<bounds[3]): fail(errors,f'{scene_path.name} has invalid bounds')
    n=scene.get('gridSize')
    heights=scene.get('heights')
    if n!=129 or not isinstance(heights,list) or len(heights)!=129*129: fail(errors,f'{scene_path.name} must have flat 129x129 heights')
    elif any(not isinstance(x,(int,float)) or not math.isfinite(x) for x in heights): fail(errors,f'{scene_path.name} has invalid height values')
    else:
        mn,mx=scene.get('minElevation'),scene.get('maxElevation')
        if any(float(x)<=0 for x in heights): fail(errors,f'{scene_path.name} contains zero or negative terrain heights')
        if not isinstance(mn,(int,float)) or not isinstance(mx,(int,float)) or mn>mx or abs(min(heights)-float(mn))>0.01 or abs(max(heights)-float(mx))>0.01: fail(errors,f'{scene_path.name} min/max elevation mismatch')
    terrain=(scene.get('stats') or {}).get('terrainSource') or scene.get('terrainSource')
    if not terrain or str(terrain).lower() in {'missing','none','unknown'}: fail(errors,f'{scene_path.name} has missing terrain source')
    for key in ('parcels','climats','forests','roads','buildings'):
        if key in scene and not isinstance(scene[key],list): fail(errors,f'{scene_path.name} {key} is not an array')
    for p in scene.get('parcels',[]):
        cls=(p.get('classification') if isinstance(p,dict) else None)
        if not isinstance(cls,str) or cls.lower() not in CANONICAL: fail(errors,f'{scene_path.name} has non-canonical parcel classification: {cls}')
    texture=scene.get('texture') or record.get('texture')
    if not texture: fail(errors,f'{scene_path.name} has no texture URL')
    else:
        t=local_target(texture)
        if t is None or not t.is_file(): fail(errors,f'{scene_path.name} texture missing: {texture}')
        elif t.stat().st_size>MAX_ASSET_BYTES: fail(errors,f'{scene_path.name} texture exceeds 25 MiB: {texture}')
    manifest_bounds=record.get('bounds2154')
    if isinstance(manifest_bounds,list) and isinstance(bounds,list) and len(manifest_bounds)==4 and len(bounds)==4:
        if any(abs(float(a)-float(b))>0.02 for a,b in zip(manifest_bounds,bounds)): fail(errors,f'{scene_path.name} bounds differ from index manifest')

def validate():
    errors=[]; index_path,index,records=load_index(errors)
    if not (DIST/'index.html').is_file(): fail(errors,'dist/index.html is missing')
    if not DATA.is_dir(): fail(errors,'dist/data is missing')
    seen=set()
    for i,r in enumerate(records):
        if not isinstance(r,dict): fail(errors,f'index record {i} is not an object'); continue
        ident=r.get('id') or r.get('name')
        if not ident: fail(errors,f'index record {i} has no id/name')
        if ident in seen: fail(errors,f'duplicate village id: {ident}')
        seen.add(ident)
        ref=r.get('scene')
        target=local_target(ref) if ref else None
        if target is None or not target.is_file(): fail(errors,f'village {ident} scene URL missing: {ref}'); continue
        if not isinstance(ref,str) or not ref.endswith('.json.gz'): fail(errors,f'village {ident} scene URL is not gzip-compressed: {ref}')
        scene=read_scene(target,errors)
        if scene is None: continue
        validate_scene(r,scene,target,errors)
    raw_scene_files=sorted((DATA/'scenes').glob('*.json'))
    if raw_scene_files: fail(errors,f'dist/data/scenes still contains {len(raw_scene_files)} uncompressed scene JSON files')
    gzip_scene_files=sorted((DATA/'scenes').glob('*.json.gz'))
    if len(gzip_scene_files)!=SCENE_COUNT: fail(errors,f'dist/data/scenes must contain exactly {SCENE_COUNT} gzip scene payloads')
    for p in DIST.rglob('*'):
        if p.is_file() and p.stat().st_size>MAX_ASSET_BYTES: fail(errors,f'asset exceeds 25 MiB: {p.relative_to(DIST)}')
    # Cloudflare Workers static assets: 25 MiB per file and 20,000 files on the free plan.
    asset_files=sum(1 for p in DIST.rglob('*') if p.is_file())
    if asset_files>MAX_ASSET_FILES: fail(errors,f'dist contains {asset_files} files; the static asset limit is {MAX_ASSET_FILES}')
    node=Path(r'C:\Users\Eat_Peach\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe')
    if not node.exists() and shutil.which('node'): node=Path(shutil.which('node'))
    for name in ('app.js','atlas-renderer.js'):
        f=DIST/name
        if f.is_file() and node.is_file():
            res=subprocess.run([str(node),'--check',str(f)],capture_output=True,text=True,encoding='utf-8',errors='replace')
            if res.returncode: fail(errors,f'node --check {name} failed: {(res.stderr or res.stdout).strip()}')
    return errors

if __name__=='__main__':
    problems=validate()
    if problems:
        print('SITE VALIDATION FAILED'); print('\n'.join(f'- {p}' for p in problems)); sys.exit(1)
    print(f'SITE VALIDATION PASSED: {SCENE_COUNT} scenes, {sum(p.stat().st_size for p in DIST.rglob("*") if p.is_file())} stored bytes')

