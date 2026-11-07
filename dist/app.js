import { AtlasRenderer, CADASTRE_MAX_VIEW_RADIUS_METRES } from './atlas-renderer.js';
import { CadastreLoader } from './cadastre-loader.js';
import { OwnershipLoader } from './ownership-loader.js';
import { SceneMosaic, sampleScene } from './scene-mosaic.js';
import { findWineRegion, groupVillagesByWineRegion, setWineRegions, wineRegionOptions } from './regional-navigation.js';
import { loadRegion, REGION, regionClass, term } from './region.js';
import { aocFactLines, featureIdentity, mergeFeatureFacts, spatialAocMatches } from './aoc-facts.js';
import { areaText, featureArea, renderFeaturePanel, glanceTile, displayPlaceName, placeHeading, displayEntityName, displayRecordDate, element, detailRow, communeDisplayName } from './feature-panel.js';
import { exportMapImage } from './export-map.js';
import { correctionPrompt, openSubmissionDialog } from './feedback.js';
import { initDisplaySettings } from './display-settings.js';
import { initSimulation } from './simulation-panel.js';
import { avifSupported } from './texture-format.js';


const $ = (s) => document.querySelector(s);
const ui = { list: $('#village-list'), search: $('#search'), loading: $('#loading'), loadText: $('#loading-text'), error: $('#error-state'), errorMsg: $('#error-message'), progress: $('#progress-bar') };
let index = null, selected = null, selectedFeature = null, featureFactsCache = new Map(), featureFactsRequest = 0, wineRegion = 'all', regionalGroups = [], regionCollapsed = new Map(), renderer = null, requestSeq = 0, currentAbort = null, sceneCache = new Map();
let mosaic = null, streamAbort = null, streamSeq = 0, streamReady = false, streamViewLast = null, streamViewPending = null, streamViewQueued = null, interactionIdleTimer = 0, interactionActive = false, interactionHeld = false, interactionMode = 'rotate', coverageScene = null;
let streamLoadedIds = null; // villages in the scene now shown, to notice when a nearby one is missing
let textureManifest = {}, communeBoundaries = [], contextTerrain = [], regionalNavigator = null;
let cadastreLoader = null, cadastrePublishQueued = null;
let ownershipLoader = null, ownershipRequest = 0, useAvif = false, assetVersion = '';
// Data payloads are requested with ?v=<assetVersion> so they can be cached long-term and still refresh after a data update.
function dataUrl(path){const url=new URL(path,location.href);if(assetVersion)url.searchParams.set('v',assetVersion);return url;}
const debug = { loadedVillage:null, sceneStats:null, resourceErrors:[] }; window.atlasDebug = debug;
const panDirections = Object.freeze({ArrowUp:'up',ArrowDown:'down',ArrowLeft:'left',ArrowRight:'right'});
function setProgress(n,text,detail){ui.progress.style.width=`${n}%`;if(text)ui.loadText.textContent=text;if(detail)$('#loading-detail').textContent=detail;}
async function fetchJson(url,signal){const res=await fetch(url,{signal});if(!res.ok)throw new Error(`Request failed (${res.status})`);return res.json();}
async function fetchScene(url,signal){const res=await fetch(url,{signal});if(!res.ok)throw new Error(`Request failed (${res.status})`);const bytes=new Uint8Array(await res.arrayBuffer());const gzipped=bytes.length>=2&&bytes[0]===0x1f&&bytes[1]===0x8b;if(!gzipped){try{return JSON.parse(new TextDecoder().decode(bytes));}catch(error){throw new Error(`Scene payload is not valid JSON: ${error.message||error}`);}}if(typeof DecompressionStream!=='function')throw new Error('This browser cannot open compressed scene payloads because DecompressionStream is unavailable. Please use a current browser.');try{return await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).json();}catch(error){if(error.name==='AbortError')throw error;throw new Error(`Unable to decompress scene payload: ${error.message||error}`);}}
async function loadIndex(){setProgress(20,'Reading the atlas…','Loading lieux-dits');const url=new URL('./data/index.json',location.href);const data=await fetchJson(url);if(!Array.isArray(data.villages)||!data.villages.length)throw new Error(`The atlas index contains no ${term('village')} scenes.`);assetVersion=String(data.assetVersion||'');for(const v of data.villages){v.name=communeDisplayName(v.name);for(const key of ['scene','texture','textureAvif'])if(v[key])v[key]=dataUrl(v[key]).href;}data.__url=url.href;return data;}
function villageFromHash(){let id='';try{id=decodeURIComponent(location.hash.slice(1));}catch{}return index?.villages?.find(v=>v.id===id)||null;}
function writeVillageHash(id,mode){const hash=`#${encodeURIComponent(id)}`;if(mode==='none'||location.hash===hash)return;history[mode==='push'?'pushState':'replaceState'](null,'',hash);}
async function loadOptionalPayload(url){try{const res=await fetch(url);if(!res.ok)return null;const bytes=new Uint8Array(await res.arrayBuffer());const gzipped=bytes.length>=2&&bytes[0]===0x1f&&bytes[1]===0x8b;if(!gzipped)return JSON.parse(new TextDecoder().decode(bytes));if(typeof DecompressionStream!=='function')return null;return await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).json();}catch{return null;}}
function setCadastreStatus(message,kind=''){const el=$('#cadastre-status');if(el){el.textContent=message||'';el.dataset.state=kind;el.hidden=!message;}}
function refreshCadastre(view) {
  if (!renderer) return;
  cadastreLoader ||= new CadastreLoader({
    fetchManifest: () => fetchJson(dataUrl('./data/cadastre/manifest.json')),
    fetchCommune: (meta, signal) => fetchScene(dataUrl(meta.url), signal),
    publish: (parcels, meta) => { if (interactionActive) cadastrePublishQueued = { parcels, meta }; else renderer.setCadastralParcels(parcels, meta); },
    status: setCadastreStatus,
    maxRadius: CADASTRE_MAX_VIEW_RADIUS_METRES,
  });
  return cadastreLoader.update(view, document.querySelector('[data-layer="cadastre"]')?.checked === true);
}
async function loadRegionalData(){const [manifest,communes,context]=await Promise.all([fetchJson(new URL('./data/texture-manifest.json',location.href)).catch(()=>({})),loadOptionalPayload(new URL('./data/communes.json.gz',location.href)),loadOptionalPayload(new URL('./data/context-terrain.json.gz',location.href))]);textureManifest=manifest&&typeof manifest==='object'?manifest:{};communeBoundaries=Array.isArray(communes)?communes:(communes?.communes||communes?.features||[]);contextTerrain=Array.isArray(context)?context:(context?.tiles||[]);}
// Scene assembly runs in a background worker (mosaic-worker.js) when the browser allows it: downloading, unpacking and
// assembling villages then never blocks the page. The page keeps its own SceneMosaic for quick lookups (which village a
// point is in, what a view needs), and falls back to assembling on the page if the worker fails.
function useMosaicWorker(target,{index,textureManifest,options}){if(typeof Worker!=='function')return;let worker;try{worker=new Worker(new URL('./mosaic-worker.js',import.meta.url),{type:'module'});}catch{return;}let next=0;const pending=new Map();worker.onmessage=({data})=>{const job=pending.get(data.id);if(!job)return;pending.delete(data.id);if(data.error)job.reject(new Error(data.error));else job.resolve(data.result);};worker.onerror=()=>{for(const job of pending.values())job.reject(new Error('Scene worker failed'));pending.clear();target.compose=pageCompose;};worker.postMessage({type:'init',base:location.href,useAvif,index,textureManifest,textureBase:new URL('./',location.href).href,contextUrl:new URL('./data/context-terrain.json.gz',location.href).href,communesUrl:new URL('./data/communes.json.gz',location.href).href,options});const pageCompose=target.compose.bind(target);target.compose=(view,{focusId=null,signal}={})=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});signal?.addEventListener?.('abort',()=>{if(pending.delete(id))reject(signal.reason||new DOMException('Aborted','AbortError'));},{once:true});worker.postMessage({type:'compose',id,view,focusId});}).catch(error=>{if(error?.name==='AbortError')throw error;return pageCompose(view,{focusId,signal});});}
async function loadScene(v,signal){if(sceneCache.has(v.id)){const cached=sceneCache.get(v.id);sceneCache.delete(v.id);sceneCache.set(v.id,cached);return cached;}const url=new URL(v.scene,location.href);const scene=await fetchScene(url,signal);if(v.texture&&!scene.texture){scene.texture=useAvif&&v.textureAvif?v.textureAvif:v.texture;scene.textureFallback=v.texture;}sceneCache.set(v.id,scene);while(sceneCache.size>12)sceneCache.delete(sceneCache.keys().next().value);return scene;}
async function loadFeatureFacts(villageId){if(!villageId)return null;if(featureFactsCache.has(villageId))return featureFactsCache.get(villageId);const promise=loadOptionalPayload(dataUrl(`./data/feature-facts/${encodeURIComponent(villageId)}.json.gz`));featureFactsCache.set(villageId,promise);return promise;}
// Phone info sheet: peek (classification, name, AOC) -> half -> full, by swipe or by tapping the handle.
// The map shifts so the selected place stays visible above the sheet.
const SHEET_STATES=['peek','half','full'];let sheetFeature=null;
function sheetPanel(){return $('.detail-panel');}
function setSheet(state){const panel=sheetPanel();if(!panel)return;panel.dataset.sheet=state;if(state!=='full')panel.scrollTop=0;const handle=panel.querySelector('.sheet-handle');if(handle)handle.setAttribute('aria-label',state==='full'?'Show less':'Show more details');setTimeout(revealSheetFeature,280);}
function openSheet(feature){sheetFeature=feature||null;setSheet('peek');}
function closeSheet(){const panel=sheetPanel();panel?.classList.remove('mobile-open');delete panel?.dataset.sheet;sheetFeature=null;clearFeatureSelection();}
function stepSheet(dir){const panel=sheetPanel(),i=SHEET_STATES.indexOf(panel?.dataset.sheet||'half'),next=i+dir;if(next<0)return closeSheet();setSheet(SHEET_STATES[Math.min(SHEET_STATES.length-1,next)]);}
function revealSheetFeature(){const panel=sheetPanel(),canvas=$('#terrain-canvas');if(!sheetFeature||!panel?.classList.contains('mobile-open')||panel.dataset.sheet==='full'||!canvas)return;const covered=Math.max(0,canvas.getBoundingClientRect().bottom-panel.getBoundingClientRect().top);renderer?.revealFeature?.(sheetFeature,covered);}
function setupSheet(){
  const panel=sheetPanel();if(!panel||panel.querySelector('.sheet-handle'))return;
  const handle=document.createElement('button');handle.type='button';handle.className='sheet-handle';handle.setAttribute('aria-label','Show more details');panel.prepend(handle);
  handle.addEventListener('click',()=>{const state=panel.dataset.sheet||'half';setSheet(state==='peek'?'half':state==='half'?'full':'peek');});
  // The village-info button opens the sheet without a feature: give it the half height.
  let wasOpen=panel.classList.contains('mobile-open');
  new MutationObserver(()=>{const open=panel.classList.contains('mobile-open');if(open){if(!panel.dataset.sheet)panel.dataset.sheet='half';}else{delete panel.dataset.sheet;
    // Closing the sheet returns the map to where it was before the sheet moved it (unless the user moved it since).
    if(wasOpen){sheetFeature=null;renderer?.restoreRevealedView?.();}}wasOpen=open;}).observe(panel,{attributes:true,attributeFilter:['class']});
  // Dragging the sheet: it follows the finger, then settles on the nearest height (peek, half, full) or closes, taking
  // the flick speed into account. Vertical drags move the sheet unless the details are scrolled (full height, or
  // scrolled down); dragging down from the top of the content moves the sheet again.
  const heights=()=>{const vh=window.innerHeight;return {peek:Math.min(vh*.3,250),half:vh*.58,full:vh-64};};
  let drag=null;
  panel.addEventListener('touchstart',e=>{if(!panel.classList.contains('mobile-open')||e.touches.length!==1){drag=null;return;}const y=e.touches[0].clientY;
    drag={y0:y,y,t:performance.now(),v:0,h0:panel.getBoundingClientRect().height,onHandle:!!e.target.closest?.('.sheet-handle'),active:false,decided:false,top0:panel.scrollTop};},{passive:true});
  panel.addEventListener('touchmove',e=>{if(!drag)return;const y=e.touches[0].clientY,dy=y-drag.y0,state=panel.dataset.sheet||'half';
    if(!drag.decided){if(Math.abs(dy)<6)return;drag.decided=true;
      drag.active=drag.onHandle||state==='peek'||(dy<0&&state!=='full'&&panel.scrollTop<=0)||(dy>0&&panel.scrollTop<=0);
      if(drag.active){panel.style.transition='none';drag.y0=y;}}
    if(!drag.active)return;e.preventDefault();
    const now=performance.now(),dt=Math.max(1,now-drag.t);drag.v=.75*((drag.y-y)/dt)+.25*drag.v;drag.y=y;drag.t=now; // upward speed, px per ms
    const {full}=heights(),h=Math.max(0,Math.min(full,drag.h0-(y-drag.y0)));panel.style.height=`${h}px`;},{passive:false});
  const settle=()=>{if(!drag)return;const d=drag;drag=null;if(!d.active)return;
    const H=heights(),h=panel.getBoundingClientRect().height,projected=h+d.v*180;
    const targets=[['close',0],['peek',H.peek],['half',H.half],['full',H.full]];
    let [name,target]=targets.reduce((best,c)=>Math.abs(c[1]-projected)<Math.abs(best[1]-projected)?c:best);
    if(name==='close'&&h>H.peek*.75&&d.v>-.5)[name,target]=['peek',H.peek]; // only a real downward pull closes from above the peek
    panel.style.transition='height .3s cubic-bezier(.2,.85,.25,1)';panel.style.height=`${target}px`;
    setTimeout(()=>{panel.style.transition='';panel.style.height='';if(name==='close')closeSheet();else setSheet(name);},300);};
  panel.addEventListener('touchend',settle,{passive:true});panel.addEventListener('touchcancel',settle,{passive:true});
}
function clearFeatureSelection(){selectedFeature=null;featureFactsRequest+=1;const card=$('#feature-card');if(card){card.classList.remove('feature-summary');card.replaceChildren();const strong=document.createElement('strong');strong.textContent='Click the terrain';const span=document.createElement('span');span.textContent='Explore a parcel or lieu-dit';card.append(strong,span);}}
function safeUrl(value){const raw=String(value??'').trim();if(!raw||!/^https?:\/\//i.test(raw))return null;try{const url=new URL(raw);return /^https?:$/.test(url.protocol)&&Boolean(url.hostname)?url.href:null;}catch{return null;}}
function elevationFact(feature,meta={}) {
  if(meta.altitude?.status==='estimate' && meta.altitude.valueM!=null && Number.isFinite(Number(meta.altitude.valueM))) return {value:`≈ ${Math.round(meta.altitude.valueM)} m`,caption:'Terrain estimate near the mapped centre'};
  const p=feature?.properties||feature||{};let bounds=p.bounds;
  if(!Array.isArray(bounds)||bounds.length!==4){let count=0;const box=[Infinity,Infinity,-Infinity,-Infinity];const visit=v=>{if(Array.isArray(v)&&v.length>=2&&Number.isFinite(v[0])&&Number.isFinite(v[1])){count++;box[0]=Math.min(box[0],v[0]);box[1]=Math.min(box[1],v[1]);box[2]=Math.max(box[2],v[0]);box[3]=Math.max(box[3],v[1]);}else if(Array.isArray(v))v.forEach(visit);};visit(p.rings);bounds=count?box:null;}
  if(!bounds)return {caption:'No verified elevation for this selection'};
  const x=(bounds[0]+bounds[2])/2,y=(bounds[1]+bounds[3])/2;let best=null;
  for(const scene of sceneCache.values()){const value=sampleScene(scene,x,y);if(value==null||!Number.isFinite(value))continue;const b=scene.bounds,n=scene.gridSize;const spacing=b&&n>1?Math.max(b[2]-b[0],b[3]-b[1])/(n-1):Infinity;if(!best||spacing<best.spacing)best={value,spacing};}
  if(!best&&renderer?.sceneJSON){const scene=renderer.sceneJSON,value=sampleScene(scene,x,y);if(value!=null&&Number.isFinite(value)){const b=scene.bounds,n=scene.gridSize;best={value,spacing:b&&n>1?Math.max(b[2]-b[0],b[3]-b[1])/(n-1):Infinity};}}
  return best?{value:`≈ ${Math.round(best.value)} m`,caption:`Near the mapped centre · IGN terrain${Number.isFinite(best.spacing)?` · ~${Math.round(best.spacing)} m grid`:''}`}:{caption:'No verified elevation for this selection'};
}
function featureVillage(code){return index?.villages?.find(v=>String(v.id).endsWith(`-${code}`))?.name||'';}
function renderFeatureFacts(feature,layer,meta){
  const card=$('#feature-card');if(!card)return;
  const p=feature?.properties||feature||{},facts=mergeFeatureFacts(feature,meta),aoc=facts.aocVerification;
  const identity=featureIdentity(facts, layer);
  const rows=aocFactLines(facts).filter(row=>!['Physical named-vineyard area','Legal AOC eligibility area','Exclusive display area','Mapped lieu-dit area','Declared production area'].includes(row.label)).map(row=>[row.label,row.value]);
  if(aoc){for(const [label,value] of [['Physical vineyard area',aoc.physicalAreaM2],['Legal appellation area',aoc.legalAreaM2],['Display fragment area',aoc.displayAreaM2]])if(value!=null)rows.push([label,areaText(value)]);}
  if(facts.productionAreaHa!=null)rows.push(['Declared production area',`${areaText(Number(facts.productionAreaHa)*10000)}${facts.productionYear?` · ${facts.productionYear}`:''}`]);
  const spatial=facts.spatialAocEligibility;
  const spatialMatches=spatialAocMatches(facts);
  const spatialSource=safeUrl(spatial?.sourceUrl);
  const links=[['Boundary source',safeUrl(aoc?.sourceUrl||facts.sourceUrl)],...(aoc?.evidenceUrls||[]).map((url,i)=>[`Reference ${i+1}`,safeUrl(url)])];
  if(spatialSource)links.push(['Spatial AOC boundary source',spatialSource]);
  if(facts.mappedAreaScope==='full-source-named-place')rows.push(['Full mapped lieu-dit area',areaText(facts.mappedAreaM2)],['Commune attribution',facts.communeBasis]);
  if(Number(facts.aocDelimitedAreaM2)>0){rows.push(['AOC-delimited mapped area',areaText(facts.aocDelimitedAreaM2)],['Area scope','The full mapped lieu-dit can include roads and built-up land. This area is its intersection with the official AOC delimitation; it is not a measurement of currently planted vines.']);}
  const village=Array.isArray(facts.featureCommunes)?facts.featureCommunes.join(' / '):featureVillage(p.insee||p.communeCode);
  if(p.displayName&&fold(p.displayName)!==fold(p.name))rows.unshift(['Cadastre name',p.name],['Name used on this map',p.displayNameBasis||'Official INAO denomination']);
  renderFeaturePanel(card,{title:placeHeading(p.displayName||p.name||p.nom||meta?.name||'Mapped feature',village),subtitle:identity.tier,identity:[['Place type',identity.placeType],['AOC',identity.aocEligibility]],area:featureArea(facts),altitude:elevationFact(feature,facts),rows,links});
  card.append(correctionPrompt({layer:layer==='climat'?'climats':layer,featureName:displayPlaceNameSafe(p.displayName||p.name||p.nom||meta?.name),classification:identity.tier,villageId:selected?.id,villageName:village||selected?.name,featureId:p.id??p.featureId,factsKey:facts.factsKey||p.factsKey,communeCode:p.insee||p.communeCode}));
}
function displayPlaceNameSafe(value){return String(value??'').trim().slice(0,200);}

async function showFeatureFacts(feature,layer,provenance){if(layer==='cadastre'){selectedFeature={feature,layer,provenance};renderCadastreFacts(feature,provenance);appendOwnershipFacts(feature,provenance,++ownershipRequest);appendParcelContext(feature,provenance);const mobile=matchMedia('(max-width:760px)').matches;if(mobile){$('.detail-panel')?.classList.add('mobile-open');openSheet(feature);}else $('.detail-panel')?.classList.add('drawer-open');window.atlasDrawers?.right?.open();return;}if(!feature){clearFeatureSelection();return;}const p=feature.properties||feature||{}, nested=p.facts||p.rawPropertyFacts||p.raw_property_facts||p.rawProperties?.facts||p.raw?.facts||{}, factsKey=provenance?.factsKey||p.factsKey||nested.factsKey||nested.key, villageId=provenance?.factsVillageId||p.factsVillageId||p.facts_village_id||nested.factsVillageId||nested.villageId||nested.village_id||provenance?.sourceVillageId, request=++featureFactsRequest;selectedFeature={feature,layer,provenance};const payload=factsKey&&villageId?await loadFeatureFacts(villageId):null;if(request!==featureFactsRequest||selectedFeature?.feature!==feature)return;const candidates=factsKey?(payload?.features||[]).filter(row=>row.key===factsKey):[];const meta=candidates.length===1?candidates[0]:null;renderFeatureFacts(feature,layer,meta);appendTerroirFacts(feature,layer,request);appendGeologyFacts(feature,layer,request);const mobile=matchMedia('(max-width:760px)').matches;if(mobile){$('.detail-panel')?.classList.add('mobile-open');openSheet(feature);}else $('.detail-panel')?.classList.add('drawer-open');window.atlasDrawers?.right?.open();const toggle=$('.details-toggle');if(toggle){toggle.textContent='Close info';toggle.hidden=true;toggle.setAttribute('aria-expanded','true');toggle.setAttribute('aria-label','Close info');}}
// ---- Terroir: slope, aspect, elevation and modelled sun hours per lieu-dit and AOC area
// (data/terroir/<village>.json, scripts/build_terroir.py) ----
const terroirCache=new Map();let terroirMode='off',terroirRedraw=0;
const ASPECT_WORDS={N:'North',NNE:'North-northeast',NE:'Northeast',ENE:'East-northeast',E:'East',ESE:'East-southeast',SE:'Southeast',SSE:'South-southeast',S:'South',SSW:'South-southwest',SW:'Southwest',WSW:'West-southwest',W:'West',WNW:'West-northwest',NW:'Northwest',NNW:'North-northwest'};
function terroirVillage(feature,layer){const p=feature?.properties||feature||{};const code=layer==='climats'?String(p.id||'').split(':')[0]:String(p.insee||'');if(!code)return null;return index?.villages?.find(v=>String(v.id).split('-').pop()===code)?.id||null;}
function loadTerroir(villageId){if(!villageId)return Promise.resolve(null);if(!terroirCache.has(villageId))terroirCache.set(villageId,fetchJson(dataUrl(`./data/terroir/${encodeURIComponent(villageId)}.json`)).catch(()=>null));return terroirCache.get(villageId);}
function terroirFacts(feature,layer){const v=terroirVillage(feature,layer);const p=feature?.properties||feature||{};return loadTerroir(v).then(d=>d?.features?.[`${layer}:${p.id}`]||null);}
// Terroir in the panel: elevation range, slope and aspect join the at-a-glance tiles; sun gets a meter row.
function compassIcon(deg){return `<svg class="glance-compass" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10.5"/><path class="n" d="M12 1.5v3"/><g style="transform:rotate(${deg}deg);transform-origin:12px 12px"><path class="arrow" d="M12 18.5V6.5M12 5l-3.6 4.6M12 5l3.6 4.6"/></g></svg>`;}
function slopeIcon(pct){const a=Math.min(35,Math.atan(pct/100)*180/Math.PI*1.6);/* drawn 1.6x steeper so gentle slopes still read */const y=20-Math.tan(a*Math.PI/180)*18;return `<svg class="glance-slope" viewBox="0 0 22 22" aria-hidden="true"><path d="M2 20H20V${y.toFixed(1)}Z"/></svg>`;}
function terroirTiles(f){const consistency=f.aspectConsistency>=.85?'mostly one way':f.aspectConsistency>=.6?'fairly even':'mixed directions';
  return [glanceTile('Elevation',`${Math.round(f.elevation.min)}–${Math.round(f.elevation.max)} m`,`average ${Math.round(f.elevation.mean)} m`,{className:'glance-elevation'}),
    glanceTile('Slope',`${f.slopePct.toLocaleString('en',{maximumFractionDigits:1})}%`,`steepest ${Math.round(f.slopeMaxPct)}%`,{className:'glance-slope-tile',icon:slopeIcon(f.slopePct)}),
    glanceTile('Faces',ASPECT_WORDS[f.aspect]||f.aspect,consistency,{className:'glance-faces',icon:compassIcon(f.aspectDeg)})];}
function sunMeter(f){const pct=Math.max(0,Math.min(100,Math.round(f.sunHours/f.sunHoursFlat*100)));const sec=document.createElement('section');sec.className='fact-sun fact-terroir';
  sec.innerHTML=`<div class="sun-row"><span class="terroir-k">Direct sun</span><small>Apr–Sep</small><strong class="terroir-v">${f.sunHours.toLocaleString('en')} h</strong></div><div class="sun-meter" role="img" aria-label="${pct}% of the sun open level ground gets"><i style="width:${pct}%"></i></div><small class="sun-note">${pct}% of what open, level ground gets</small>`;return sec;}
async function appendTerroirFacts(feature,layer,request){if(layer!=='climats'&&layer!=='parcels')return;const f=await terroirFacts(feature,layer);if(request!==featureFactsRequest||selectedFeature?.feature!==feature||!f)return;const card=$('#feature-card');if(!card||card.querySelector('.fact-sun'))return;const glance=card.querySelector('.fact-glance');if(!glance)return;
  const [elev,...rest]=terroirTiles(f);const old=glance.querySelector('.glance-elevation');if(old)old.replaceWith(elev);else glance.append(elev);glance.append(...rest);glance.after(sunMeter(f));}
// shading colours
const mix=(a,b,k)=>a.map((x,i)=>Math.round(x+(b[i]-x)*k));
const ramp=(stops,k)=>{k=Math.max(0,Math.min(1,k));const n=stops.length-1,i=Math.min(n-1,Math.floor(k*n));return `rgb(${mix(stops[i],stops[i+1],k*n-i).join(',')})`;};
const SLOPE_STOPS=[[247,240,205],[240,196,110],[218,120,60],[160,45,45],[90,20,40]];
const SUN_STOPS=[[48,52,110],[110,80,150],[200,110,120],[244,170,80],[252,232,140]];
const TERROIR_SCALES={slope:{min:0,max:30,unit:'%',label:'Average slope',stops:SLOPE_STOPS},sun:{min:1900,max:2600,unit:' h',label:'Direct sun, Apr–Sep (model)',stops:SUN_STOPS}};
function aspectColour(f){const h=(f.aspectDeg+180)%360;/* hue wheel: north blue, east yellow, south red, west purple */const hue=[[0,220],[45,165],[90,50],[135,24],[180,2],[225,330],[270,282],[315,250],[360,220]];let a=hue[0],b=hue[1];for(let i=0;i<hue.length-1;i++)if(f.aspectDeg>=hue[i][0]&&f.aspectDeg<=hue[i+1][0]){a=hue[i];b=hue[i+1];break;}const k=(f.aspectDeg-a[0])/(b[0]-a[0]);let dh=b[1]-a[1];if(dh>180)dh-=360;if(dh<-180)dh+=360;const hh=(a[1]+dh*k+360)%360;const sat=Math.round(25+60*Math.min(1,f.slopePct/12));return `hsl(${hh} ${sat}% 55%)`;}
function terroirTint(feature,layer){const v=terroirVillage(feature,layer);if(!v)return null;const cached=terroirCache.get(v);if(!cached){loadTerroir(v).then(()=>{clearTimeout(terroirRedraw);terroirRedraw=setTimeout(()=>renderer?.drawAocOverlay?.(),60);renderer?.requestRender?.();});return null;}
  if(!cached.__data){cached.then(d=>{cached.__data=d||{features:{}};clearTimeout(terroirRedraw);terroirRedraw=setTimeout(()=>{renderer?.drawAocOverlay?.();renderer?.requestRender?.();},60);});return null;}
  const p=feature?.properties||feature||{},f=cached.__data.features?.[`${layer}:${p.id}`];if(!f)return null;
  if(terroirMode==='aspect')return aspectColour(f);const sc=TERROIR_SCALES[terroirMode],val=terroirMode==='slope'?f.slopePct:f.sunHours;return ramp(sc.stops,(val-sc.min)/(sc.max-sc.min));}
function terroirLegend(){let el=$('#terroir-legend');if(!el){el=document.createElement('div');el.id='terroir-legend';el.className='terroir-legend';$('#canvas-stage')?.append(el);}
  if(terroirMode==='off'){el.hidden=true;return;}el.hidden=false;
  el.classList.toggle('is-geology',terroirMode==='geology');if(terroirMode==='geology'){el.innerHTML=geologyLegendHtml();return;}
  if(terroirMode==='aspect'){el.innerHTML='<span class="tl-title">Aspect: which way it faces</span><div class="tl-wheel" aria-hidden="true"><i style="background:conic-gradient(from 0deg,hsl(220 80% 55%),hsl(165 80% 50%) 12.5%,hsl(50 85% 55%) 25%,hsl(24 85% 55%) 37.5%,hsl(2 85% 55%) 50%,hsl(330 80% 55%) 62.5%,hsl(282 80% 55%) 75%,hsl(250 80% 55%) 87.5%,hsl(220 80% 55%))"></i><b class="n">N</b><b class="e">E</b><b class="s">S</b><b class="w">W</b></div><small>Paler where the ground is flatter.</small>';return;}
  const sc=TERROIR_SCALES[terroirMode];el.innerHTML=`<span class="tl-title">${sc.label}</span><i class="tl-bar" style="background:linear-gradient(90deg,${sc.stops.map(c=>`rgb(${c.join(',')})`).join(',')})"></i><span class="tl-ends"><span>${sc.min.toLocaleString('en')}${sc.unit}</span><span>${sc.max.toLocaleString('en')}${sc.unit}+</span></span>${terroirMode==='sun'?'<small>Clear-sky model with hill shading.</small>':''}`;}
let terroirScaleLoaded=null;function loadTerroirScale(){terroirScaleLoaded||=fetchJson(dataUrl('./data/terroir/scale.json')).then(d=>{if(d?.sunHours){TERROIR_SCALES.sun.min=d.sunHours[0];TERROIR_SCALES.sun.max=d.sunHours[1];}if(d?.slopePct)TERROIR_SCALES.slope.max=Math.max(10,d.slopePct[1]);}).catch(()=>{});return terroirScaleLoaded;}
async function setTerroirMode(mode){await loadTerroirScale();terroirMode=['slope','aspect','sun','geology'].includes(mode)?mode:'off';document.querySelectorAll('input[name="terroir-mode"]').forEach(i=>{i.checked=i.value===terroirMode;});if(terroirMode==='geology')await loadGeologyLegend();renderer?.setTerroirTint?.(terroirMode==='off'||terroirMode==='geology'?null:terroirTint);renderer?.setGeologyLayer?.(terroirMode==='geology'?geologyLayer:null);terroirLegend();syncTerroirControl();}
// ---- Geology: BRGM BD Charm-50, 1:50,000 (data/geology/, scripts/build_geology.py) ----
let geologyLegendPromise=null,geologyLegendData=null;const geologyTiles=new Map();let geologyRedraw=0,geologyLegendTimer=0;
function loadGeologyLegend(){geologyLegendPromise||=fetchJson(dataUrl('./data/geology/legend.json')).then(d=>{geologyLegendData=d;d.tileSet=new Set(d.tiles||[]);return d;}).catch(()=>null);return geologyLegendPromise;}
function geologyTileKeys(b){const L=geologyLegendData;if(!L||!b)return[];const t=L.tileSize||4000,out=[];for(let x=Math.floor(b[0]/t);x<=Math.floor(b[2]/t);x++)for(let y=Math.floor(b[1]/t);y<=Math.floor(b[3]/t);y++){const k=`${x}_${y}`;if(L.tileSet.has(k))out.push(k);}return out;}
function ringArea(f){let a=0;for(let i=0,n=f.length;i<n;i+=2){const j=(i+2)%n;a+=f[i]*f[j+1]-f[j]*f[i+1];}return a/2;}
function loadGeologyTile(k){if(!geologyTiles.has(k)){const pr=fetchJson(dataUrl(`./data/geology/tiles/${k}.json`)).then(d=>{pr.__data=(d?.polygons||[]).map(([u,rings])=>({unit:u,rings,colour:geologyLegendData?.units?.[u]?.colour||'#d9d4c7',bbox:ringsBox(rings)}));return pr.__data;}).catch(()=>{pr.__data=[];return[];});geologyTiles.set(k,pr);}return geologyTiles.get(k);}
function geologyLayer(bounds){const out=[];let missing=false;for(const k of geologyTileKeys(bounds)){const pr=loadGeologyTile(k);if(pr.__data)out.push(...pr.__data);else{missing=true;pr.then(()=>{clearTimeout(geologyRedraw);geologyRedraw=setTimeout(()=>{renderer?.drawAocOverlay?.();renderer?.requestRender?.();if(terroirMode==='geology')terroirLegend();},60);});}}if(!missing&&terroirMode==='geology'){clearTimeout(geologyLegendTimer);geologyLegendTimer=setTimeout(terroirLegend,80);}return out;}
function ringsBox(rings){let a=Infinity,b=Infinity,c=-Infinity,d=-Infinity;for(const f of rings)for(let i=0;i<f.length;i+=2){if(f[i]<a)a=f[i];if(f[i]>c)c=f[i];if(f[i+1]<b)b=f[i+1];if(f[i+1]>d)d=f[i+1];}return[a,b,c,d];}
function insideRings(rings,x,y){let inside=false;for(const f of rings)for(let i=0,n=f.length,j=n-2;i<n;j=i,i+=2){const yi=f[i+1],yj=f[j+1];if((yi>y)!==(yj>y)&&x<(f[j]-f[i])*(y-yi)/(yj-yi)+f[i])inside=!inside;}return inside;}
// formations ranked by how much of the village they cover (sampled on a 40 x 40 grid; later polygons are drawn on top)
function geologyInView(){const b=renderer?.focusBounds||renderer?.bounds;if(!b||!geologyLegendData)return[];const polys=[];for(const k of geologyTileKeys(b)){const d=geologyTiles.get(k)?.__data;if(d)polys.push(...d);}const count=new Map(),N=40;for(let i=0;i<N;i++)for(let j=0;j<N;j++){const x=b[0]+(i+.5)*(b[2]-b[0])/N,y=b[1]+(j+.5)*(b[3]-b[1])/N;let hit=null;for(const p of polys){const q=p.bbox;if(x<q[0]||x>q[2]||y<q[1]||y>q[3])continue;if(insideRings(p.rings,x,y))hit=p.unit;}if(hit!=null&&!geologyLegendData.units[hit]?.water)count.set(hit,(count.get(hit)||0)+1);}return[...count.entries()].sort((a,b)=>b[1]-a[1]).map(([u])=>geologyLegendData.units[u]).filter(Boolean);}
function geologyName(u){return u.en||u.descr;}
function geologyLegendHtml(){const seen=new Set(),units=geologyInView().filter(u=>{const k=`${geologyName(u)}|${u.notation}|${u.age}`;if(seen.has(k))return false;seen.add(k);return true;}),shown=units.slice(0,document.documentElement.classList.contains('phone-ui')?4:8);return `<span class="tl-title">Geology</span><ul class="tl-geo">${shown.map(u=>`<li title="${esc(u.descr)}"><i style="background:${esc(u.colour)}"></i><span>${esc(geologyName(u))}${u.notation?` <b>${esc(u.notation)}</b>`:''}<small>${esc(u.age||'')}</small></span></li>`).join('')}</ul>`;}
const geologyFeatureCache=new Map();
function loadGeologyFeatures(v){if(!v)return Promise.resolve(null);if(!geologyFeatureCache.has(v))geologyFeatureCache.set(v,fetchJson(dataUrl(`./data/geology/${encodeURIComponent(v)}.json`)).catch(()=>null));return geologyFeatureCache.get(v);}
// A cadastral parcel: terrain figures come from the lieu-dit it lies in (computed per lieu-dit), geology is measured
// on the parcel's own outline from the BRGM tiles.
function geologySharesFor(ring,holes){const L=geologyLegendData;if(!L||!ring?.length)return Promise.resolve([]);let b=[Infinity,Infinity,-Infinity,-Infinity];for(const [x,y] of ring){b=[Math.min(b[0],x),Math.min(b[1],y),Math.max(b[2],x),Math.max(b[3],y)];}
  return Promise.all(geologyTileKeys(b).map(loadGeologyTile)).then(parts=>{const polys=parts.flat().filter(q=>!(q.bbox[2]<b[0]||q.bbox[0]>b[2]||q.bbox[3]<b[1]||q.bbox[1]>b[3]));const xy=r=>r.flatMap(q=>[Number(q[0]),Number(q[1])]);const flat=[xy(ring)],holeFlat=(holes||[]).map(xy);const count=new Map();let n=0;const N=24;
    const sample=(x,y)=>{if(!insideRings(flat,x,y)||holeFlat.some(h=>insideRings([h],x,y)))return;let hit=null;for(const q of polys){if(x<q.bbox[0]||x>q.bbox[2]||y<q.bbox[1]||y>q.bbox[3])continue;if(insideRings(q.rings,x,y))hit=q.unit;}if(hit==null)return;n++;count.set(hit,(count.get(hit)||0)+1);};
    for(let i=0;i<N;i++)for(let j=0;j<N;j++)sample(b[0]+(i+.5)*(b[2]-b[0])/N,b[1]+(j+.5)*(b[3]-b[1])/N);
    if(!n)sample((b[0]+b[2])/2,(b[1]+b[3])/2);
    return[...count.entries()].map(([u,c])=>[u,Math.round(c/n*100)]).filter(([,pct])=>pct>=3).sort((a,b)=>b[1]-a[1]).slice(0,4);});}
async function appendParcelContext(parcel,provenance){const card=$('#feature-card');if(!card)return;const current=()=>selectedFeature?.feature===parcel&&card.isConnected;
  const place=provenance?.placeFeature;
  const terroir=place?terroirFacts(place,'climats'):Promise.resolve(null);
  const geology=loadGeologyLegend().then(()=>geologySharesFor(provenance?.parcelRing,provenance?.parcelHoles));
  const f=await terroir;if(current()&&f&&!card.querySelector('.fact-sun')){const glance=card.querySelector('.fact-glance');if(glance){const[elev,...rest]=terroirTiles(f);const old=glance.querySelector('.glance-elevation');if(old)old.replaceWith(elev);else glance.append(elev);glance.append(...rest);const sun=sunMeter(f);glance.after(sun);const pp=place.properties||place;const scope=document.createElement('p');scope.className='glance-scope';scope.textContent=`Terrain and sun: lieu-dit ${displayPlaceName(pp.displayName||pp.name||'')}`;sun.after(scope);}}
  const shares=await geology;if(!current()||!shares.length||card.querySelector('.fact-geology'))return;card.querySelector('.glance-scope,.fact-sun,.fact-glance')&&renderGeologySection(card,shares,geologyLegendData);}
function renderGeologySection(card,shares,L){const sec=document.createElement('section');sec.className='fact-geology';
  const total=shares.reduce((a,[,pct])=>a+pct,0)||1;
  sec.innerHTML=`<h4 class="fact-label">Geology</h4><div class="geo-bar" aria-hidden="true">${shares.map(([u,pct])=>`<i style="flex:${pct/total};background:${esc(L.units[u].colour)}"></i>`).join('')}</div><ul class="geo-list">${shares.map(([u,pct])=>{const x=L.units[u];return `<li><details><summary><i class="geo-swatch" style="background:${esc(x.colour)}"></i><span class="geo-name"><strong>${esc(geologyName(x))}</strong>${x.age?`<small>${esc(x.age)}</small>`:''}</span><span class="geo-pct">${pct}%</span></summary><p class="geo-more"><em lang="fr">${esc(x.descr)}</em>${x.notation?`<span>BRGM map code ${esc(x.notation)}</span>`:''}</p></details></li>`;}).join('')}</ul>`;
  const after=card.querySelector('.glance-scope')||card.querySelector('.fact-sun')||card.querySelector('.fact-glance');if(after)after.after(sec);else card.append(sec);}
async function appendGeologyFacts(feature,layer,request){if(layer!=='climats'&&layer!=='parcels')return;const p=feature?.properties||feature||{};const[L,d]=await Promise.all([loadGeologyLegend(),loadGeologyFeatures(terroirVillage(feature,layer))]);const shares=(d?.features?.[`${layer}:${p.id}`]||[]).filter(([u])=>L?.units?.[u]);if(request!==featureFactsRequest||selectedFeature?.feature!==feature||!shares.length)return;const card=$('#feature-card');if(!card||card.querySelector('.fact-geology'))return;
  renderGeologySection(card,shares,L);}
window.atlasTerroir={setMode:setTerroirMode};
// Terroir shading has its own control in the bottom bar (Layers keeps the line toggles).
const TERROIR_MODES=[{v:'off',name:'Appellations',hint:'AOC classes, as usual',chip:'linear-gradient(90deg,#e3b23c 0 25%,#4d8fd6 0 50%,#7b4051 0 75%,#5f8668 0)'},
  {v:'slope',name:'Slope',hint:'How steep each lieu-dit is',chip:'linear-gradient(90deg,rgb(247,240,205),rgb(240,196,110),rgb(218,120,60),rgb(160,45,45),rgb(90,20,40))'},
  {v:'aspect',name:'Aspect',hint:'Which way it faces',chip:'conic-gradient(hsl(220 80% 55%),hsl(50 85% 55%) 25%,hsl(2 85% 55%) 50%,hsl(282 80% 55%) 75%,hsl(220 80% 55%))'},
  {v:'sun',name:'Sun hours',hint:'Direct sun, April–September',chip:'linear-gradient(90deg,rgb(48,52,110),rgb(110,80,150),rgb(200,110,120),rgb(244,170,80),rgb(252,232,140))'},
  {v:'geology',name:'Geology',hint:'Rocks and soils, BRGM map',chip:'linear-gradient(90deg,#e6bf80 0 22%,#00e6e6 0 44%,#e6994d 0 62%,#bfe6ff 0 80%,#e6ff80 0)'}];
// Layers: a grouped panel of switches, anchored to its pill button, closing on outside click or Esc.
function setupLayersPopover(){const pop=$('#layer-popover'),btn=$('#layers-toggle');if(!pop||!btn||pop.dataset.grouped)return;pop.dataset.grouped='1';
  btn.innerHTML='<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.5 18 7l-8 4.5L2 7Z"/><path d="m2 10.5 8 4.5 8-4.5"/><path d="m2 14 8 4.5 8-4.5"/></svg><span>Layers</span>';btn.setAttribute('aria-haspopup','true');btn.setAttribute('aria-expanded','false');btn.setAttribute('aria-controls','layer-popover');
  const row=k=>{const label=pop.querySelector(`input[data-layer="${k}"]`)?.closest('label');if(!label)return null;const input=label.querySelector('input'),line=label.querySelector('.layer-line')||document.createElement('span');const name=label.textContent.replace(/\s+/g,' ').trim();input.classList.add('layer-switch');input.setAttribute('role','switch');label.className='layer-row';label.removeAttribute('style');label.replaceChildren(line,Object.assign(document.createElement('span'),{className:'layer-name',textContent:name}),input);return label;};
  const status=$('#cadastre-status');const frag=document.createDocumentFragment();
  for(const [title,keys] of [['On the vineyards',['climats','parcels','communes','cadastre']],['Landscape',['buildings','roads','forest','water']]]){const sec=document.createElement('div');sec.className='layer-group';sec.append(Object.assign(document.createElement('span'),{className:'legend-heading',textContent:title}));for(const k of keys){const r=row(k);if(r)sec.append(r);}if(sec.childElementCount>1)frag.append(sec);}
  pop.replaceChildren(frag);if(status)pop.append(status);pop.setAttribute('role','group');pop.setAttribute('aria-label','Map layers');
  const sync=()=>btn.setAttribute('aria-expanded',String(pop.classList.contains('is-open')));new MutationObserver(sync).observe(pop,{attributes:true,attributeFilter:['class']});
  document.addEventListener('pointerdown',e=>{if(pop.classList.contains('is-open')&&!pop.contains(e.target)&&!btn.contains(e.target))pop.classList.remove('is-open');});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&pop.classList.contains('is-open')){pop.classList.remove('is-open');btn.focus();}});
  const place=()=>{if(document.documentElement.classList.contains('phone-ui')){pop.style.left=pop.style.right=pop.style.bottom='';pop.classList.remove('is-anchored');return;}const r=btn.getBoundingClientRect();pop.classList.add('is-anchored');const w=pop.offsetWidth||262;pop.style.left=`${Math.round(Math.max(8,Math.min(r.right-w,window.innerWidth-w-8)))}px`;pop.style.right='auto';pop.style.bottom=`${Math.round(window.innerHeight-r.top+8)}px`;};
  btn.addEventListener('click',()=>{if(pop.classList.contains('is-open')){place();setTimeout(()=>pop.querySelector('input')?.focus({preventScroll:true}),0);}});
  window.addEventListener('resize',()=>{if(pop.classList.contains('is-open'))place();});}
// Rotate/Pan, Aerial/Atlas and terrain exaggeration as segmented pills; the AOC fill slider shows its level.
function setupControlPills(){document.querySelectorAll('.scene-controls .control-group').forEach(g=>{if(g.querySelector('.seg'))return;const buttons=[...g.querySelectorAll(':scope>button')];if(!buttons.length)return;const seg=document.createElement('span');seg.className='seg';seg.append(...buttons);g.append(seg);});
  const range=$('#aoc-opacity');if(range&&!range.dataset.fill){range.dataset.fill='1';const fill=()=>range.style.setProperty('--fill',`${(range.value-range.min)/(range.max-range.min)*100}%`);range.addEventListener('input',fill);fill();}}
function setupTerroirControl(){
  const bar=$('#layers-toggle');if(!bar||$('#terroir-toggle'))return;
  $('.terroir-choice')?.remove();// the old radio row inside Layers
  const wrap=document.createElement('div');wrap.className='terroir-control';
  wrap.innerHTML=`<button type="button" class="terroir-toggle" id="terroir-toggle" aria-expanded="false" aria-haspopup="true" aria-controls="terroir-popover"><i class="terroir-chip" aria-hidden="true"></i><span class="terroir-toggle-k">Shade by</span><b class="terroir-toggle-v">Appellations</b></button>
   <div class="terroir-popover" id="terroir-popover" role="radiogroup" aria-label="Shade the vineyards by" hidden><span class="legend-heading">Shade the vineyards by</span>${TERROIR_MODES.map(m=>`<label class="terroir-mode"><input type="radio" name="terroir-mode" value="${m.v}"${m.v==='off'?' checked':''} /><i class="terroir-chip" style="background:${m.chip}" aria-hidden="true"></i><span><strong>${m.name}</strong><small>${m.hint}</small></span></label>`).join('')}</div>`;
  bar.before(wrap);
  const btn=wrap.querySelector('.terroir-toggle'),pop=wrap.querySelector('.terroir-popover');
  const close=(focus)=>{pop.hidden=true;btn.setAttribute('aria-expanded','false');if(focus)btn.focus();};
  btn.addEventListener('click',e=>{e.stopPropagation();const open=pop.hidden;pop.hidden=!open;btn.setAttribute('aria-expanded',String(open));if(open){$('#layer-popover')?.classList.remove('is-open');pop.querySelector('input:checked')?.focus();}});
  pop.addEventListener('change',()=>setTimeout(()=>close(false),120));
  document.addEventListener('pointerdown',e=>{if(!pop.hidden&&!wrap.contains(e.target))close(false);});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!pop.hidden)close(true);});
  bar.addEventListener('click',()=>close(false));
  syncTerroirControl();}
function syncTerroirControl(){const m=TERROIR_MODES.find(x=>x.v===terroirMode)||TERROIR_MODES[0];const btn=$('#terroir-toggle');if(!btn)return;btn.querySelector('.terroir-toggle-v').textContent=m.name;btn.querySelector('.terroir-chip').style.background=m.chip;btn.classList.toggle('is-active',terroirMode!=='off');}
document.addEventListener('change',e=>{if(e.target?.name==='terroir-mode')setTerroirMode(e.target.value);});
function fold(s){return String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();}
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
// Crus in search: a small index of every grand and premier cru (scripts/build_cru_index.py), loaded on first search.
let cruIndex=null,cruIndexPromise=null;
function loadCruIndex(){return cruIndexPromise||=fetchJson(dataUrl('./data/cru-index.json')).then(data=>{cruIndex=(data.crus||[]).map(c=>({...c,key:fold(`${c.name} ${c.full||''}`).replace(/[^a-z0-9]+/g,''),start:fold(c.name).replace(/[^a-z0-9]+/g,'')}));renderList();}).catch(()=>{cruIndex=[];});}
function cruMatches(query){
  // Spaces, hyphens and apostrophes are ignored: "bonnes mares" finds Bonnes-Mares.
  const q=query.replace(/[^a-z0-9]+/g,'');
  if(q.length<2)return [];
  if(!cruIndex){loadCruIndex();return [];}
  const region=wineRegion==='all'?null:new Set((regionalGroups.find(g=>g.id===wineRegion)?.villages||[]).map(v=>v.id));
  return cruIndex.filter(c=>c.key.includes(q)&&(!region||region.has(c.village)))
    .sort((a,b)=>(b.start.startsWith(q)-a.start.startsWith(q))||((b.class==='grand-cru')-(a.class==='grand-cru'))||a.name.localeCompare(b.name,'fr')).slice(0,30);
}
// ---- Owner search ----------------------------------------------------------------------------------------------
// Legal entities that own parcels (DGFiP personnes morales release, data/ownership/owners.json.gz, built by
// scripts/build_parcel_ownership.py). The index loads on the first search of three letters or more.
let ownerIndex=null,ownerList=null;
function loadOwners(){ownerIndex||=loadOptionalPayload(dataUrl('./data/ownership/owners.json.gz')).then(d=>{ownerList=(d?.owners||[]).map(([name,siren,form,area,vines,communes])=>({name,siren,form,area,vines,communes,key:fold(`${name} ${siren}`)}));if(ownerQuery().length>=3)renderList();return ownerList;});return ownerIndex;}
// Owner search has its own bar (#owner-search); while it holds three letters or more its results replace the list.
// Matches whose name starts with the words come first, then owners with the most vines, then the largest holdings.
const ownerSearchInput=()=>document.querySelector('#owner-search');
const ownerQuery=()=>fold(ownerSearchInput()?.value.trim()||'');
function ownerMatches(q){if(q.length<3)return [];if(!ownerList){loadOwners();return [];}const words=q.split(/\s+/).filter(Boolean);return ownerList.filter(o=>words.every(w=>o.key.includes(w))).map(o=>({o,starts:o.key.startsWith(words[0])})).sort((a,b)=>(b.starts-a.starts)||(b.o.vines-a.o.vines)||(b.o.area-a.o.area)).slice(0,60).map(x=>x.o);}
function renderOwnerResults(){const q=ownerQuery(),owners=ownerMatches(q);ui.list.innerHTML=!ownerList?'<p class="owner-note owner-loading">Loading owners…</p>':owners.length?ownerGroupHtml(owners,q):'<p class="owner-note owner-loading">No owner matches. The register lists legal entities (domaines, GFA, SCI, communes…), not private individuals.</p>';ui.list.querySelectorAll('.owner-row').forEach(b=>b.addEventListener('click',()=>showOwner(owners[Number(b.dataset.owner)])));}
const hectares=m2=>m2>=10000?`${(m2/10000).toFixed(m2>=1e6?0:1)} ha`:`${Math.round(m2)} m²`;
const ownerParcelCount=o=>Object.values(o.communes).reduce((n,ids)=>n+ids.split(',').length,0);
const communeVillage=code=>index.villages.find(v=>String(v.id).endsWith(`-${code}`));
function ownerSummary(o){const n=ownerParcelCount(o),c=Object.keys(o.communes).length;return `${n} parcel${n===1?'':'s'}${o.area?` · ${hectares(o.area)}`:''}${o.vines?` · ${hectares(o.vines)} vines`:''}${c>1?` · ${c} communes`:''}`;} // areas are left out where the region's files have none
function ownerGroupHtml(owners,q){if(!owners.length)return '';return `<div class="region-group cru-group owner-group"><div class="region-heading cru-heading"><strong>Owners</strong><small>${owners.length===60?'60+':owners.length}</small><span></span></div><div class="region-villages"><div class="region-villages-inner">${owners.map((o,i)=>`<button type="button" class="village-row owner-row" data-owner="${i}"><strong>${esc(o.name)}</strong><small>${esc(ownerSummary(o))}</small></button>`).join('')}</div></div></div>`;}
// An owner's card in the index: totals, then the communes where they hold parcels; choosing one outlines them on the map.
// The open owner card survives list refreshes (the map changing village redraws the list) until Back or a new search.
let ownerShown=null,ownerCommuneIndex=0;
function showOwner(o){if(!o)return;ownerShown=o;ownerCommuneIndex=0;drawOwnerCard(true);}
// Where an owner's parcels lie (data/ownership/owner-crus.json.gz, scripts/build_owner_crus.py): per parcel the grand
// or premier cru and the lieu-dit it falls in. Loaded with the first owner card.
let ownerCrusPromise=null,ownerCrus=null;
function loadOwnerCrus(){ownerCrusPromise||=loadOptionalPayload(dataUrl('./data/ownership/owner-crus.json.gz')).then(d=>{ownerCrus=d||{parcels:{},crus:{},climats:{}};if(ownerShown)drawOwnerCard();return ownerCrus;});return ownerCrusPromise;}
const CRU_RANK={'grand-cru':0,'premier-cru':1};
function ownerGroups(ids){if(!ownerCrus)return [];const groups=new Map();for(const id of ids){const [cru,climat]=ownerCrus.parcels?.[id]||['',''];const key=cru?`c:${cru}`:climat?`l:${climat}`:'other';let g=groups.get(key);if(!g){g=cru?{kind:'cru',id:cru,name:ownerCrus.crus[cru]?.[0]||cru,cls:ownerCrus.crus[cru]?.[1]||'',village:ownerCrus.crus[cru]?.[2]}:climat?{kind:'lieu-dit',id:climat,name:ownerCrus.climats[climat]||climat,cls:''}:{kind:'other',name:'Other parcels',cls:''};g.ids=[];groups.set(key,g);}g.ids.push(id);}
  return [...groups.values()].sort((a,b)=>((CRU_RANK[a.cls]??(a.kind==='other'?3:2))-(CRU_RANK[b.cls]??(b.kind==='other'?3:2)))||(b.ids.length-a.ids.length)||a.name.localeCompare(b.name));}
const classLabel=cls=>cls==='grand-cru'?'Grand Cru':cls==='premier-cru'?'Premier Cru':'';
function drawOwnerCard(openFirst=false){const o=ownerShown;if(!o)return;if(!ownerCrus)loadOwnerCrus();const communes=Object.entries(o.communes).map(([code,ids])=>({code,ids:ids.split(','),village:communeVillage(code)})).sort((a,b)=>b.ids.length-a.ids.length);
  ui.list.innerHTML=`<div class="owner-card"><button type="button" class="owner-back">← Back to results</button><h3>${esc(o.name)}</h3><p class="owner-meta">${esc(ownerSummary(o))}</p>${o.siren&&/^\d{9}$/.test(o.siren)?`<p class="owner-meta">SIREN <a href="https://annuaire-entreprises.data.gouv.fr/entreprise/${o.siren}" target="_blank" rel="noopener">${o.siren}</a></p>`:''}<p class="owner-note">Parcels held by this legal entity in the DGFiP register (2025). Areas are whole parcels, also counted for co-owners. Private individuals are not in this register.</p><div class="owner-communes">${communes.map((c,i)=>`<button type="button" class="village-row owner-commune" data-i="${i}"><strong>${esc(c.village?.name||c.code)}</strong><small>${c.ids.length} parcel${c.ids.length===1?'':'s'}</small></button>${ownerGroups(c.ids).map((g,k)=>`<button type="button" class="village-row owner-cru${g.kind==='other'?' is-other':''}" data-i="${i}" data-g="${k}"><strong>${esc(g.name)}${g.cls?` <em class="cru-class cru-class--${g.cls}">${classLabel(g.cls)}</em>`:''}</strong><small>${g.ids.length}</small></button>`).join('')}`).join('')}</div>${ownerCrus?'<p class="owner-note">Crus and lieux-dits are where each parcel lies, not who farms it or whose label the wine goes under.</p>':'<p class="owner-note owner-loading">Finding crus…</p>'}</div>`;
  ui.list.querySelector('.owner-back').addEventListener('click',()=>{ownerShown=null;renderer?.showOwnerParcels([]);renderList();ownerSearchInput()?.focus();});
  ui.list.querySelectorAll('.owner-commune').forEach(b=>{b.classList.toggle('is-active',Number(b.dataset.i)===ownerCommuneIndex);b.addEventListener('click',()=>{ownerCommuneIndex=Number(b.dataset.i);ui.list.querySelectorAll('.owner-commune').forEach(x=>x.classList.toggle('is-active',x===b));showOwnerCommune(communes[ownerCommuneIndex]);});});
  ui.list.querySelectorAll('.owner-cru:not(.is-other)').forEach(b=>b.addEventListener('click',()=>{const c=communes[Number(b.dataset.i)],g=ownerGroups(c.ids)[Number(b.dataset.g)];ui.list.querySelectorAll('.owner-commune,.owner-cru').forEach(x=>x.classList.toggle('is-active',x===b));goToOwnerGroup(c,g);}));
  if(openFirst)showOwnerCommune(communes[0]);}
// A cru or lieu-dit from an owner card: open it as the cru search does, then outline only this owner's parcels in it.
async function goToOwnerGroup(c,g){if(!g||!renderer)return;const village=index.villages.find(v=>v.id===(g.village||c.village?.id))||c.village;if(!village)return;if(window.matchMedia?.('(max-width: 760px)').matches)$('.sidebar')?.classList.remove('is-open');
  if(selected?.id!==village.id)await selectVillage(village);await renderer.whenSceneReady?.();
  const layer=g.kind==='cru'?'parcels':'climats',item=renderer.featureIndex?.find(it=>it.key===layer&&String((it.feature?.properties||it.feature)?.id)===String(g.id));
  if(item){renderer.focusFeature(item.feature);renderer.selectFeature(item.feature,layer);}
  const parcels=await ownerParcelGeometry(c.code,g.ids);renderer.showOwnerParcels(parcels,{fit:!item});}
let cadastreManifestPromise=null;
const communeCadastre=new Map();
async function ownerParcelGeometry(code,ids){try{cadastreManifestPromise||=fetchJson(dataUrl('./data/cadastre/manifest.json'));const meta=(await cadastreManifestPromise)?.communes?.[code];if(!meta)return [];if(!communeCadastre.has(code)){communeCadastre.set(code,fetchScene(dataUrl(meta.url)));while(communeCadastre.size>6)communeCadastre.delete(communeCadastre.keys().next().value);}const payload=await communeCadastre.get(code),wanted=new Set(ids);return (payload?.parcels||[]).filter(p=>wanted.has(String(p.id)));}catch(error){debug.resourceErrors.push(String(error?.message||error));return [];}}
async function showOwnerCommune(c){if(!c||!renderer)return;const parcels=await ownerParcelGeometry(c.code,c.ids);if(window.matchMedia?.('(max-width: 760px)').matches)$('.sidebar')?.classList.remove('is-open');renderer.showOwnerParcels(parcels,{fit:true});}
// Phones: the map fills the screen. A search pill floats at the top (menu button, place/owner switch, one search at a
// time), the village name sits under it, round buttons run down the right edge (view settings, info, home, save
// image), and the header's atlas switch, Feedback, Sources and display settings move into the menu drawer.
{const phone=window.matchMedia('(max-width: 760px)'),stage=document.querySelector('#canvas-stage');
 const chrome=document.createElement('div');chrome.className='phone-chrome';stage?.append(chrome);
 const placeLabel=document.createElement('div');placeLabel.className='phone-place';chrome.append(placeLabel);
 const icon=d=>`<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
 const fabs=document.createElement('div');fabs.className='phone-fabs';
 fabs.innerHTML=[['view','View settings',icon('<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>')],['info','Details',icon('<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.6h.01"/>')],['home','Reset view',icon('<path d="M4 11.5 12 5l8 6.5M6.5 10v9h11v-9"/>')],['save','Save map image',icon('<path d="M12 4v11m0 0 4-4m-4 4-4-4M5 19.5h14"/>')]].map(([k,label,svg])=>`<button type="button" class="phone-fab" data-fab="${k}" aria-label="${label}" title="${label}">${svg}</button>`).join('');
 chrome.append(fabs);
 const root=document.documentElement;
 fabs.addEventListener('click',e=>{const b=e.target.closest('[data-fab]');if(!b)return;const k=b.dataset.fab;
   if(k==='view'){const open=!root.classList.contains('phone-view-open');root.classList.toggle('phone-view-open',open);b.classList.toggle('is-active',open);if(!open)document.querySelector('#layer-popover')?.classList.remove('is-open');}
   else if(k==='info')document.querySelector('.details-toggle')?.click();
   else if(k==='home')document.querySelector('#home-button')?.click();
   else if(k==='save')document.querySelector('#share-button')?.click();});
 // the search pill's own buttons: open the menu drawer, and switch between place and owner search
 const menuBtn=document.createElement('button');menuBtn.type='button';menuBtn.className='phone-menu-btn';menuBtn.setAttribute('aria-label','Open menu');menuBtn.innerHTML=icon('<path d="M4 7h16M4 12h16M4 17h16"/>');
 menuBtn.addEventListener('click',()=>document.querySelector('#mobile-menu')?.click());
 const modeBtn=document.createElement('button');modeBtn.type='button';modeBtn.className='phone-mode-btn';
 const setMode=mode=>{const top=document.querySelector('.top-search');if(!top)return;top.dataset.mode=mode;modeBtn.setAttribute('aria-label',mode==='owner'?'Search places instead':'Search owners instead');modeBtn.title=modeBtn.getAttribute('aria-label');modeBtn.innerHTML=mode==='owner'?icon('<path d="M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0 1 13 0c0 4.8-6.5 11-6.5 11Z"/><circle cx="12" cy="10" r="2.3"/>'):icon('<circle cx="12" cy="8" r="3.6"/><path d="M5 20c.8-3.8 3.6-6 7-6s6.2 2.2 7 6"/>');};
 modeBtn.addEventListener('click',()=>{const top=document.querySelector('.top-search');const next=top?.dataset.mode==='owner'?'place':'owner';setMode(next);window.atlasSearchDrop?.close();(next==='owner'?document.querySelector('#owner-search'):document.querySelector('#search'))?.focus();});
 // the village name follows the breadcrumb
 const crumb=document.querySelector('#crumb-village');const syncPlace=()=>{placeLabel.textContent=crumb?.textContent||'';};if(crumb){new MutationObserver(syncPlace).observe(crumb,{childList:true,characterData:true,subtree:true});syncPlace();}
 const topbar=document.querySelector('.topbar'),atlasSwitch=document.querySelector('#atlas-switch'),meta=document.querySelector('.top-meta');
 const menuHead=document.createElement('div');menuHead.className='phone-menu-head';
 const gear=document.querySelector('#display-button'),feedback=document.querySelector('#feedback-button'),sources=document.querySelector('#source-button');
 const footLinks=document.querySelector('.footer .footer-link')?.parentElement,sideFoot=document.querySelector('.sidebar-foot'),legal=sideFoot?.querySelector('.sidebar-legal');
 const sep=()=>{const i=document.createElement('i');i.className='footer-sep';i.textContent='·';return i;};
 const apply=()=>{const on=phone.matches;root.classList.toggle('phone-ui',on);if(!on){root.classList.remove('phone-view-open');fabs.querySelector('[data-fab=view]')?.classList.remove('is-active');}
   const top=document.querySelector('.top-search');
   document.querySelectorAll('.footer-sep').forEach(i=>i.remove());
   if(on){if(top){top.prepend(modeBtn);top.prepend(menuBtn);if(!top.dataset.mode)setMode('place');}const sidebar=document.querySelector('.sidebar');if(sidebar&&atlasSwitch){menuHead.append(atlasSwitch);sidebar.prepend(menuHead);}
     if(gear){gear.classList.add('phone-fab');fabs.append(gear);}
     if(sideFoot&&feedback&&sources)sideFoot.insertBefore(feedback,legal||null),sideFoot.insertBefore(sources,legal||null);}
   else{menuBtn.remove();modeBtn.remove();if(topbar&&atlasSwitch&&meta){topbar.prepend(atlasSwitch);topbar.append(meta);}menuHead.remove();
     if(gear&&meta){gear.classList.remove('phone-fab');meta.append(gear);}
     if(footLinks&&feedback&&sources){footLinks.prepend(feedback,sep(),sources,sep());}}};
 window.atlasPhoneUI={apply,setMode};phone.addEventListener?.('change',()=>setTimeout(apply,0));}
{const top=document.createElement('div');top.className='top-search';top.setAttribute('role','search');document.querySelector('.topbar')?.insertBefore(top,document.querySelector('.top-meta'));
 const wraps=()=>[ui.search?.closest('.search-wrap'),ownerSearchInput()?.closest('.search-wrap')].filter(Boolean);
 const wide=window.matchMedia('(min-width: 761px)');
 const place=()=>{top.append(...wraps());if(wide.matches){const bar=document.querySelector('.topbar'),meta=document.querySelector('.top-meta');if(meta?.parentElement===bar)bar.insertBefore(top,meta);else bar?.append(top);}else document.querySelector('.phone-chrome')?.prepend(top);};
 // the owner bar's full hint fits on wide screens only
 const ownerHint=ownerSearchInput()?.placeholder||'',roomy=window.matchMedia('(min-width: 1280px), (max-width: 760px)'),hint=()=>{const i=ownerSearchInput();if(i)i.placeholder=roomy.matches?ownerHint:'Search owners…';};
 place();hint();wide.addEventListener?.('change',place);roomy.addEventListener?.('change',hint);
 // Results drop down under the header bars: while a bar holds a query the result list (#village-list) moves into the
 // dropdown, and goes back to the sidebar when the dropdown closes. Picking a place, clicking outside or Escape closes it;
 // focusing a bar that still holds a query opens it again.
 const drop=document.createElement('div');drop.className='search-drop';drop.hidden=true;top.append(drop);
 let listHome=null;
 const closeDrop=()=>{if(drop.hidden)return;drop.hidden=true;if(listHome&&ui.list.parentElement===drop)listHome.parent.insertBefore(ui.list,listHome.next&&listHome.next.parentElement===listHome.parent?listHome.next:null);};
 const openDrop=input=>{if(!input?.value.trim()){closeDrop();return;}
   if(ui.list.parentElement!==drop){listHome={parent:ui.list.parentElement,next:ui.list.nextSibling};drop.append(ui.list);}
   const wrap=input.closest('.search-wrap'),tb=top.getBoundingClientRect(),wb=wrap.getBoundingClientRect();
   if(wide.matches){drop.style.left=`${wb.left-tb.left}px`;drop.style.width=`${Math.max(wb.width,380)}px`;}else{drop.style.left='0px';drop.style.width='100%';}drop.hidden=false;ui.list.scrollTop=0;};
 window.atlasSearchDrop={open:openDrop,close:closeDrop};
 for(const input of [ui.search,ownerSearchInput()])if(input){input.addEventListener('input',()=>openDrop(input));input.addEventListener('focus',()=>openDrop(input));}
 document.addEventListener('pointerdown',e=>{if(!drop.hidden&&!e.target.closest?.('.top-search'))closeDrop();},true);
 window.addEventListener('keydown',e=>{if(e.key==='Escape')closeDrop();});
 drop.addEventListener('click',e=>{const row=e.target.closest?.('.village-row');if(row&&!row.matches('.owner-row,.is-other'))setTimeout(closeDrop,0);});
 wide.addEventListener?.('change',closeDrop);}
window.atlasPhoneUI?.apply();
// Phones, first visit: a short guide that points at the search pill, the round buttons, the map and Sun & rain.
// Shown once (remembered in this browser); "How to use" in the menu drawer shows it again.
{const KEY='atlas.phoneGuideSeen';
 const steps=[
  {target:'.phone-chrome .top-search',title:'Search',text:'Find a village or cru here. Tap the person icon to search owners instead, and ☰ for the navigator and menu.'},
  {target:'.phone-fabs',title:'Map buttons',text:'View settings (layers, terrain, Aerial or Atlas), details of what you selected, home, save an image, and display settings.'},
  {target:'#terrain-canvas',title:'Moving the map',html:'<span class="gesture-grid"><div class="gesture"><span class="gesture-art g-drag"><i></i><i></i></span><span><b>One finger</b> drag to move the map</span></div><div class="gesture"><span class="gesture-art g-pinch"><i></i><i></i></span><span><b>Two fingers</b> pinch to zoom</span></div><div class="gesture"><span class="gesture-art g-twist"><i></i><i></i></span><span><b>Two fingers</b> twist to turn</span></div><div class="gesture"><span class="gesture-art g-tilt"><i></i><i></i></span><span><b>Two fingers</b> slide up or down to tilt</span></div></span>Tap a vineyard or parcel to see its details.',pad:-70},
  {target:'#simulate-button',title:'Sun and rain',text:'See where the sun falls through the day, or how rain runs down the slopes.'}];
 let layer=null,i=0;
 const finish=()=>{layer?.remove();layer=null;try{localStorage.setItem(KEY,'1');}catch{}};
 const show=()=>{const step=steps[i],el=document.querySelector(step.target);if(!el){finish();return;}
   const r=el.getBoundingClientRect(),pad=step.pad??6,box={l:Math.max(4,r.left-pad),t:Math.max(4,r.top-pad),r:Math.min(innerWidth-4,r.right+pad),b:Math.min(innerHeight-4,r.bottom+pad)};
   layer.querySelector('.guide-hole').style.cssText=`left:${box.l}px;top:${box.t}px;width:${box.r-box.l}px;height:${box.b-box.t}px`;
   const card=layer.querySelector('.guide-card');card.querySelector('.guide-step').textContent=`${i+1} of ${steps.length}`;card.querySelector('h3').textContent=step.title;const para=card.querySelector('p');if(step.html)para.innerHTML=step.html;else para.textContent=step.text;card.querySelector('.guide-next').textContent=i===steps.length-1?'Start exploring':'Next';
   const h=card.offsetHeight||170,below=box.b+12+h<innerHeight-8,above=box.t-12-h>8;card.style.top=below?`${box.b+12}px`:'';card.style.bottom=below?'':above?`${innerHeight-box.t+12}px`:`calc(16px + env(safe-area-inset-bottom))`;};
 const open=()=>{if(layer)return;i=0;layer=document.createElement('div');layer.className='phone-guide';layer.setAttribute('role','dialog');layer.setAttribute('aria-label','How to use the atlas');
   layer.innerHTML='<div class="guide-hole"></div><div class="guide-card"><span class="guide-step"></span><h3></h3><p></p><div class="guide-actions"><button type="button" class="guide-skip">Skip</button><button type="button" class="guide-next">Next</button></div></div>';
   document.body.append(layer);layer.querySelector('.guide-skip').addEventListener('click',finish);layer.querySelector('.guide-next').addEventListener('click',()=>{if(++i>=steps.length)finish();else show();});show();};
 window.atlasGuide={open};
 // "How to use" in the drawer's foot
 const foot=document.querySelector('.sidebar-foot');if(foot){const b=document.createElement('button');b.type='button';b.className='phone-guide-link';b.textContent='How to use';b.addEventListener('click',()=>{document.querySelector('.sidebar')?.classList.remove('is-open');setTimeout(open,250);});foot.append(b);}
 let seen=false;try{seen=localStorage.getItem(KEY)==='1';}catch{}
 if(!seen){const wait=()=>{if(!document.documentElement.classList.contains('phone-ui'))return;if(!document.querySelector('#loading')?.hidden){setTimeout(wait,400);return;}setTimeout(open,900);};wait();}}
// Phones: while the menu drawer is open, a scrim covers the map. The first tap (or a swipe) outside the drawer closes
// it and does nothing else, so it can't select a cru by accident; swiping the drawer left closes it too.
{const shell=document.querySelector('.atlas-shell'),sidebar=document.querySelector('.sidebar');
 if(shell&&sidebar){const scrim=document.createElement('div');scrim.className='phone-scrim';scrim.setAttribute('aria-hidden','true');shell.append(scrim);
  const close=()=>{sidebar.style.transition='';sidebar.style.transform='';sidebar.classList.remove('is-open');};
  scrim.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();close();});
  let sx=null,sy=null;scrim.addEventListener('pointerdown',e=>{sx=e.clientX;sy=e.clientY;});
  scrim.addEventListener('pointermove',e=>{if(sx!==null&&Math.abs(e.clientX-sx)+Math.abs(e.clientY-sy)>30){sx=null;close();}});
  scrim.addEventListener('pointerup',()=>{sx=null;});
  // swipe the drawer itself to the left: it follows the finger, and closes past a third of its width or on a quick flick
  let start=null;
  sidebar.addEventListener('touchstart',e=>{if(!document.documentElement.classList.contains('phone-ui')||!sidebar.classList.contains('is-open')||e.touches.length!==1||e.target.closest?.('.nav-map,input,select,.search-drop'))return;start={x:e.touches[0].clientX,y:e.touches[0].clientY,t:performance.now(),dx:0,dragging:false};},{passive:true});
  sidebar.addEventListener('touchmove',e=>{if(!start)return;const dx=e.touches[0].clientX-start.x,dy=e.touches[0].clientY-start.y;
    if(!start.dragging){if(Math.abs(dy)>12&&Math.abs(dy)>Math.abs(dx)){start=null;return;}if(dx<-12&&Math.abs(dx)>Math.abs(dy))start.dragging=true;else return;}
    start.dx=Math.min(0,dx);sidebar.style.transition='none';sidebar.style.transform=`translateX(${start.dx}px)`;},{passive:true});
  const end=()=>{if(!start)return;const s=start;start=null;if(!s.dragging)return;const w=sidebar.getBoundingClientRect().width||300,fast=s.dx<-40&&performance.now()-s.t<250;
    sidebar.style.transition='';if(s.dx<-w/3||fast)close();else sidebar.style.transform='';};
  sidebar.addEventListener('touchend',end);sidebar.addEventListener('touchcancel',end);}}
// The atlas is a map app: pinches and double taps belong to the map, not the page. Safari still lets the page itself
// zoom, and a zoomed page can't be zoomed back (the next pinch zooms the map), so page zoom is blocked and, if it
// happens anyway, undone.
{const meta=document.querySelector('meta[name="viewport"]'),fixed='width=device-width, initial-scale=1, maximum-scale=1';
 for(const type of ['gesturestart','gesturechange','gestureend'])document.addEventListener(type,e=>e.preventDefault(),{passive:false});
 document.addEventListener('touchmove',e=>{if(e.touches.length>1&&!e.target.closest?.('#terrain-canvas,.nav-map svg'))e.preventDefault();},{passive:false});
 const unzoom=()=>{if(!meta||!window.visualViewport||visualViewport.scale<=1.01)return;meta.setAttribute('content',fixed+', user-scalable=no');requestAnimationFrame(()=>setTimeout(()=>meta.setAttribute('content',fixed),300));};
 window.visualViewport?.addEventListener('resize',()=>{clearTimeout(unzoom.t);unzoom.t=setTimeout(unzoom,250);});}
ui.search?.addEventListener('input',()=>{if(ownerShown||ownerSearchInput()?.value){ownerShown=null;renderer?.showOwnerParcels([]);if(ownerSearchInput())ownerSearchInput().value='';}});
ownerSearchInput()?.addEventListener('input',()=>{ownerShown=null;renderer?.showOwnerParcels([]);if(ui.search.value){ui.search.value='';}if(ownerQuery().length>=3)loadOwners();renderList();});

function cruGroupHtml(crus,q){
  if(!crus.length)return '';
  const villageName=id=>index.villages.find(v=>v.id===id)?.name||'';
  return `<div class="region-group cru-group"><div class="region-heading cru-heading"><strong>${esc(term('searchGroup'))}</strong><small>${crus.length}</small><span></span></div><div class="region-villages"><div class="region-villages-inner">${crus.map((c,i)=>`<button type="button" class="village-row cru-row" data-cru="${i}"><strong>${esc(c.name)}</strong><small>${esc(regionClass(c.class)?.label||(c.class==='grand-cru'?'Grand Cru':'Premier Cru'))} · ${esc(villageName(c.village))}</small></button>`).join('')}</div></div></div>`;
}
async function selectCru(cru){
  const village=cru&&index.villages.find(v=>v.id===cru.village);if(!village)return;
  $('.sidebar').classList.remove('is-open');// on phones the index covers the map
  if(selected?.id!==village.id)await selectVillage(village);
  await renderer.whenSceneReady?.(); // the scene's features are added over a few frames
  const layer=cru.layer||'parcels',item=renderer.featureIndex?.find(it=>it.key===layer&&String((it.feature?.properties||it.feature)?.id)===String(cru.id));
  if(!item)return;
  renderer.focusFeature(item.feature);renderer.selectFeature(item.feature,layer);
}
// A region page (e.g. /rhone/) declares <meta name="atlas-region" content="data/region.json">: its classes,
// browsing groups and name replace the Burgundy defaults before the atlas starts.
async function applyRegion(){
  const meta=document.querySelector('meta[name="atlas-region"]');if(!meta)return;
  await loadRegion(new URL(meta.content,location.href));
  if(REGION.groups)setWineRegions(REGION.groups);
  if(!REGION.classes.length)return;
  const dots=$('.classification-dots');if(dots)dots.innerHTML=REGION.classes.slice(0,5).map(c=>`<i style="background:${esc(c.colour)}"></i>`).join('');
  const label=$('#classification-toggle span:last-child');if(label)label.textContent='Appellations';
  const popover=$('#classification-popover');
  if(popover){popover.setAttribute('aria-label','Appellations shown on mapped areas');popover.innerHTML='<span class="legend-heading">Appellations</span>'+REGION.classes.map(c=>`<label title="${esc(c.label)}"><input type="checkbox" data-classification="${esc(c.key)}" checked /><i style="background:${esc(c.colour)}"></i>${esc(c.label)}</label>`).join('');}
}
// The header's atlas list closes on a tap elsewhere or Escape. Capture phase: the map stops touches reaching the page.
function setupAtlasSwitch(){
  const menu=$('#atlas-switch');if(!menu)return;
  document.addEventListener('pointerdown',event=>{if(menu.open&&!menu.contains(event.target))menu.open=false;},true);
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&menu.open){menu.open=false;menu.querySelector('summary')?.focus();}});
}
function renderList(){if(ownerShown){drawOwnerCard();return;}if(ownerQuery().length>=3){renderOwnerResults();return;}if(!regionCollapsed.size&&regionalGroups.length)regionCollapsed=new Map(regionalGroups.map(group=>[group.id,true]));const q=fold(ui.search.value.trim()),groups=regionalGroups.filter(group=>wineRegion==='all'||group.id===wineRegion).map(group=>({...group,villages:group.villages.filter(v=>(!q||fold(`${v.name} ${v.commune||''} ${group.label}`).includes(q)))})).filter(group=>group.villages.length);const crus=cruMatches(q);ui.list.innerHTML=cruGroupHtml(crus,q)+groups.map((group,i)=>{const regionId=`region-villages-${i}`;const collapsed=!q&&regionCollapsed.get(group.id)===true;const chevron='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';return `<div class="region-group" data-region="${esc(group.id)}"><button type="button" class="region-heading" aria-expanded="${!collapsed}" aria-controls="${regionId}"><strong>${esc(group.label)}</strong><small>${group.villages.length}</small><span class="region-chevron" aria-hidden="true">${chevron}</span></button><div class="region-villages${collapsed?' is-collapsed':''}" id="${regionId}"${collapsed?' inert':''}><div class="region-villages-inner">${group.villages.map(v=>`<button type="button" class="village-row ${selected?.id===v.id?'is-active':''}" data-id="${esc(v.id)}"><strong>${esc(v.name)}</strong><small>${esc(v.department||'')}</small></button>`).join('')}</div></div></div>`;}).join('');ui.list.querySelectorAll('.cru-row').forEach(b=>b.addEventListener('click',()=>selectCru(crus[Number(b.dataset.cru)])));ui.list.querySelectorAll('.region-heading:not(.cru-heading)').forEach(heading=>heading.addEventListener('click',()=>{const group=heading.closest('.region-group'),key=group.dataset.region,open=heading.getAttribute('aria-expanded')!=='true',villages=group.querySelector('.region-villages');regionCollapsed.set(key,!open);heading.setAttribute('aria-expanded',String(open));villages.classList.toggle('is-collapsed',!open);villages.toggleAttribute('inert',!open);}));ui.list.querySelectorAll('.village-row:not(.cru-row)').forEach(b=>b.addEventListener('click',()=>selectVillage(index.villages.find(v=>v.id===b.dataset.id))));}
/* Keep navigator geometry stable while the renderer emits view updates.  The
 * original implementation rebuilt 376 circles, titles, listeners, and every
 * boundary path for each 80 ms view callback. */
function buildRegionalNav(){
  const nav=document.createElement('section');nav.className='regional-nav';
  nav.innerHTML='<div class="regional-nav-head"><strong>Navigator</strong><small id="nav-mode-label">Local view</small></div><svg viewBox="0 0 320 220" role="img" aria-label="Local commune navigator"></svg><div class="nav-readout" id="nav-readout">View · —</div><div class="view-switch"><button data-orient="local" class="is-active">Local</button><button data-orient="region">'+esc(REGION.overview)+'</button></div>';
  $('.sidebar').insertBefore(nav,ui.list);
  // The panel's own title and wine-region row are gone (search lives in the header); its collapse and pin buttons sit
  // in the navigator heading so the navigator gets the room.
  {const actions=document.querySelector('.sidebar-head-actions');if(actions)nav.querySelector('.regional-nav-head').append(actions);}
  const mapBox=document.createElement('div');mapBox.className='nav-map';nav.querySelector('svg[role=img]').replaceWith(mapBox);
  const zoomControls=document.createElement('div');zoomControls.className='nav-zoom';zoomControls.innerHTML='<button type="button" data-zoom="in" aria-label="Zoom navigator in" title="Zoom in">+</button><button type="button" data-zoom="out" aria-label="Zoom navigator out" title="Zoom out">−</button><button type="button" data-zoom="reset" class="nav-zoom-reset" aria-label="Recentre navigator" title="Recentre">⌖</button>';
  const svgEl=document.createElementNS('http://www.w3.org/2000/svg','svg');svgEl.setAttribute('viewBox','0 0 320 220');svgEl.setAttribute('role','img');svgEl.setAttribute('aria-label','Local commune navigator');mapBox.append(svgEl,zoomControls);
  const svg=nav.querySelector('svg[role=img]'),NS='http://www.w3.org/2000/svg',make=(tag,attrs={})=>{const el=document.createElementNS(NS,tag);for(const [k,v] of Object.entries(attrs))el.setAttribute(k,v);return el;};
  // Drawn like a printed wine map: pale land, forests, AOC areas tinted by class, white roads, dashed commune
  // boundaries and serif place names (data/navigator/, scripts/build_navigator_map.py).
  const g=cls=>make('g',{class:cls}),land=g('nav-land'),forest=g('nav-forest'),aocLayer=g('nav-aoc'),roads=g('nav-roads'),layer=g('nav-boundaries'),labels=g('nav-labels'),hits=g('nav-hits'),points=g('nav-points'),frame=make('rect',{class:'nav-view-frame',x:0,y:0,width:0,height:0,visibility:'hidden'}),cross=make('g',{class:'nav-crosshair',visibility:'hidden'});
  const world=g('nav-world');world.append(land,forest,hits,aocLayer,roads,layer,labels,points,frame,cross);
  svg.append(make('rect',{class:'nav-sea',x:0,y:0,width:'100%',height:'100%'}),world);
  const state={mode:'local',view:null,staticKey:'',dataVersion:0,anchor:'',center:null,zoom:1,mapping:null};
  const all=index.villages.filter(v=>Array.isArray(v.center)&&v.center.length>=2);
  const villageByCode=new Map(index.villages.map(v=>[String(v.id).split('-').pop(),v]));
  const navData=new Map();let overview=null,overviewPromise=null,redrawQueued=false;
  const redraw=()=>{if(redrawQueued)return;redrawQueued=true;requestAnimationFrame(()=>{redrawQueued=false;state.dataVersion++;draw();});};
  const loadLocal=id=>{if(!navData.has(id)){navData.set(id,null);fetchJson(dataUrl(`./data/navigator/${id}.json`)).then(d=>{navData.set(id,d);redraw();}).catch(()=>{});}return navData.get(id);};
  const loadOverview=()=>{overviewPromise||=fetchJson(dataUrl('./data/navigator/overview.json')).then(d=>{overview=d?.best||{};redraw();}).catch(()=>{overview={};});return overview;};
  const BASE_CLASSES=['regional','village','premier-cru','grand-cru'];
  const classColour=cls=>(REGION.classes||[]).find(c=>c.key===cls)?.colour;
  const globalBounds=(()=>{const bs=communeBoundaries.map(c=>c.bounds||c.bounds2154).filter(b=>Array.isArray(b)&&b.length>=4);if(bs.length)return [Math.min(...bs.map(b=>+b[0])),Math.min(...bs.map(b=>+b[1])),Math.max(...bs.map(b=>+b[2])),Math.max(...bs.map(b=>+b[3]))];const bs2=all.map(v=>v.bounds2154).filter(b=>Array.isArray(b));return [Math.min(...bs2.map(b=>+b[0])),Math.min(...bs2.map(b=>+b[1])),Math.max(...bs2.map(b=>+b[2])),Math.max(...bs2.map(b=>+b[3]))]})();
  function draw(){
    const v=selected||all[0],localB=v?.bounds2154||globalBounds,b=state.mode==='local'?localB:globalBounds,pad=state.mode==='local'?Math.max(250,(b[2]-b[0])*.2):Math.max(5000,(b[2]-b[0])*.04),W=Math.max(1,svg.getBoundingClientRect().width),H=Math.max(1,svg.getBoundingClientRect().height);
    // fitted to the village (or the whole region), then moved and zoomed by the reader; a new village or mode refits
    const x0=b[0]-pad,x1=b[2]+pad,y0=b[1]-pad,y1=b[3]+pad,fit=Math.min((W-20)/(x1-x0),(H-20)/(y1-y0));
    // switching mode refits; a new village keeps a map the reader has moved or zoomed: same scale, and the same centre
    // while the village is in sight (else centred on it)
    const anchor=`${state.mode}|${selected?.id||''}`;if(anchor!==state.anchor){const prev=state.mapping,sameMode=state.anchor.split('|')[0]===state.mode,moved=state.zoom!==1||!!state.center;state.anchor=anchor;
      if(sameMode&&moved&&prev&&v?.bounds2154){const vx=(+v.bounds2154[0]+ +v.bounds2154[2])/2,vy=(+v.bounds2154[1]+ +v.bounds2154[3])/2,inSight=Math.abs(vx-prev.cX)<prev.W/2/prev.scale&&Math.abs(vy-prev.cY)<prev.H/2/prev.scale;state.zoom=prev.scale/fit;state.center=inSight?[prev.cX,prev.cY]:[vx,vy];}
      else{state.center=null;state.zoom=1;}}
    const scale=fit*state.zoom,cX=state.center?.[0]??(x0+x1)/2,cY=state.center?.[1]??(y0+y1)/2,sx=x=>W/2+(x-cX)*scale,sy=y=>H/2-(y-cY)*scale;
    state.mapping={W,H,scale,cX,cY};nav.classList.toggle('is-overview',state.mode!=='local');zoomControls.classList.toggle('is-moved',state.zoom!==1||!!state.center);
    // the area actually visible, to choose what to draw
    const vx0=cX-W/2/scale,vx1=cX+W/2/scale,vy0=cY-H/2/scale,vy1=cY+H/2/scale,inView=bb=>Array.isArray(bb)&&+bb[2]>=vx0&&+bb[0]<=vx1&&+bb[3]>=vy0&&+bb[1]<=vy1;
    svg.setAttribute('viewBox',`0 0 ${W} ${H}`);
    const key=`${state.mode}|${selected?.id||''}|${W}|${H}|${state.dataVersion}|${Math.round(cX)}|${Math.round(cY)}|${state.zoom.toFixed(3)}`;
    if(key!==state.staticKey){
      state.staticKey=key;
      const ringD=ring=>ring.map((p,i)=>`${i?'L':'M'}${sx(+p[0]).toFixed(1)},${sy(+p[1]).toFixed(1)}`).join('')+'Z';
      const ringsD=rings=>rings.map(ringD).join('');
      const outer=c=>{const rings=c.rings||c.geometry?.coordinates||[];return Array.isArray(rings[0]?.[0]?.[0])?rings.map(p=>p[0]):Array.isArray(rings[0]?.[0])?[rings[0]]:[];};
      const communes=state.mode==='local'?communeBoundaries.filter(c=>inView(c.bounds||c.bounds2154)):communeBoundaries;
      // land, then an outer dashed edge: every commune is stroked thick and dashed, then filled on top, so only the
      // outer half of edges that no other commune shares stays visible
      const landD=communes.map(c=>ringsD(outer(c))).join('');
      land.replaceChildren(make('path',{d:landD,class:'nav-edge'}),make('path',{d:landD,class:'nav-land-fill'}));
      forest.replaceChildren();aocLayer.replaceChildren();roads.replaceChildren();labels.replaceChildren();
      if(state.mode==='local'){
        const ids=selected?index.villages.filter(x=>inView(x.bounds2154)).map(x=>x.id):[],seenCru=new Set(),fd=[],major=[],minor=[],byClass=new Map();
        for(const id of ids){const d=loadLocal(id);if(!d)continue;for(const r of d.forest||[])fd.push(ringD(r));for(const [cls,rings,fid,flayer,fname] of d.aoc||[]){const k=fid?`${flayer}:${fid}`:'';if(k&&seenCru.has(k))continue;if(k)seenCru.add(k);if(!byClass.has(cls))byClass.set(cls,[]);byClass.get(cls).push({d:ringsD(rings),id:fid,layer:flayer,name:fname,village:id});}for(const [kind,line] of d.roads||[]){const p=line.map((q,i)=>`${i?'L':'M'}${sx(q[0]).toFixed(1)},${sy(q[1]).toFixed(1)}`).join('');(kind==='major'?major:minor).push(p);}}
        if(fd.length)forest.append(make('path',{d:fd.join(''),class:'nav-forest-fill'}));
        for(const cls of [...BASE_CLASSES,...[...byClass.keys()].filter(k=>!BASE_CLASSES.includes(k))]){const ds=byClass.get(cls);if(!ds)continue;const colour=!BASE_CLASSES.includes(cls)&&classColour(cls);const group=make('g',{class:`nav-aoc-fill nav-aoc--${cls}`});if(colour){group.style.fill=colour;group.style.fillOpacity='.8';}const clickable=cls!=='village'&&cls!=='regional';
          for(const f of ds){const path=make('path',{d:f.d,'fill-rule':'evenodd'});
            // grand and premier crus (and Rhône appellations) open on the big map, as the cru search does
            if(clickable&&f.id){path.setAttribute('class','nav-cru');path.setAttribute('tabindex','0');path.setAttribute('role','button');path.setAttribute('aria-label',`Show ${f.name}`);const title=make('title');title.textContent=f.name;path.append(title);const go=()=>selectCru({village:f.village,id:f.id,layer:f.layer,name:f.name});path.addEventListener('click',go);path.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();go();}});}
            group.append(path);}
          aocLayer.append(group);} // one shape per area: overlapping areas (a lieu-dit inside its AOC) must not cancel out
        if(minor.length)roads.append(make('path',{d:minor.join(''),class:'nav-road-minor'}));
        if(major.length)roads.append(make('path',{d:major.join(''),class:'nav-road-casing'}),make('path',{d:major.join(''),class:'nav-road-major'}));
      }else{
        const best=loadOverview()||{},byClass=new Map();
        for(const c of communes){const vill=villageByCode.get(String(c.code)),cls=vill&&best[vill.id];if(!cls)continue;if(!byClass.has(cls))byClass.set(cls,[]);byClass.get(cls).push(ringsD(outer(c)));}
        for(const cls of [...BASE_CLASSES,...[...byClass.keys()].filter(k=>!BASE_CLASSES.includes(k))]){const ds=byClass.get(cls);if(!ds)continue;const path=make('path',{d:ds.join(''),class:`nav-overview nav-overview--${BASE_CLASSES.includes(cls)?cls:'other'}`});const colour=!BASE_CLASSES.includes(cls)&&classColour(cls);if(colour)path.style.fill=colour;aocLayer.append(path);}
      }
      // commune boundaries: thin and dashed; the selected commune solid
      layer.replaceChildren(make('path',{d:landD,class:'nav-boundary'}));
      const own=communeBoundaries.find(c=>String(c.code)===String(selected?.id||'').split('-').pop());if(own&&state.mode==='local')layer.append(make('path',{d:ringsD(outer(own)),class:'nav-boundary-selected'}));
      // names: communes on the local map, wine regions on the overview
      const label=(x,y,text,cls)=>{const el=make('text',{x:x.toFixed(1),y:y.toFixed(1),class:cls,'text-anchor':'middle'});el.textContent=text;labels.append(el);};
      if(state.mode==='local'){const taken=[];const ordered=[...communes].sort((p,q)=>(villageByCode.get(String(q.code))?.id===selected?.id)-(villageByCode.get(String(p.code))?.id===selected?.id));
        for(const c of ordered){const cb=c.bounds||c.bounds2154,cen=c.centroid||[(+cb[0]+ +cb[2])/2,(+cb[1]+ +cb[3])/2];const x=sx(+cen[0]),vill=villageByCode.get(String(c.code)),isSel=vill&&vill.id===selected?.id,text=vill?.name||c.name||'',y=sy(+cen[1])-(isSel?8:5),w=text.length*(isSel?6.6:5.1),h=isSel?13:11,box={l:x-w/2-2,r:x+w/2+2,t:y-h,b:y+3};
          if(box.l<2||box.r>W-2||box.t<2||box.b>H-2||(box.r>W-38&&box.t<96)||taken.some(o=>box.l<o.r&&box.r>o.l&&box.t<o.b&&box.b>o.t))continue;taken.push(box);label(x,y,text,isSel?'nav-label nav-label--selected':'nav-label');}}
      else{
        // each wine region's name goes beside its band: left, right, above or below, whichever first clears the other
        // bands, the names already placed and the edges
        const boxes=regionalGroups.map(group=>{const vs=group.villages.filter(x=>Array.isArray(x.bounds2154));if(!vs.length)return null;return {group,l:sx(Math.min(...vs.map(x=>+x.bounds2154[0]))),r:sx(Math.max(...vs.map(x=>+x.bounds2154[2]))),t:sy(Math.max(...vs.map(x=>+x.bounds2154[3]))),b:sy(Math.min(...vs.map(x=>+x.bounds2154[1])))};}).filter(Boolean);
        const placed=[{l:W-38,r:W,t:0,b:96}],hitsBox=(a,b)=>a.l<b.r&&a.r>b.l&&a.t<b.b&&a.b>b.t;
        for(const box of boxes){const text=String(box.group.short||box.group.label).split(/\s*&\s*/)[0],w=text.length*5.6+4,h=11,cy=(box.t+box.b)/2,cx=(box.l+box.r)/2;
          const options=[{x:box.l-6,y:cy,anchor:'end',l:box.l-6-w,r:box.l-6},{x:box.r+6,y:cy,anchor:'start',l:box.r+6,r:box.r+6+w},{x:cx,y:box.t-5,anchor:'middle',l:cx-w/2,r:cx+w/2,above:true},{x:cx,y:box.b+12,anchor:'middle',l:cx-w/2,r:cx+w/2,below:true}];
          const fit=o=>{const rect={l:o.l,r:o.r,t:(o.above?o.y-h:o.below?o.y-h+2:o.y-h/2)-1,b:(o.above?o.y:o.below?o.y+2:o.y+h/2)+1};if(rect.l<3||rect.r>W-3||rect.t<3||rect.b>H-3)return null;if(boxes.some(other=>other!==box&&hitsBox(rect,other))||placed.some(p=>hitsBox(rect,p)))return null;return rect;};
          let choice=null,rect=null;for(const o of options){rect=fit(o);if(rect){choice=o;break;}}if(!choice){choice=options[0];rect={l:choice.l,r:choice.r,t:cy-h/2,b:cy+h/2};}
          placed.push(rect);const el=make('text',{x:choice.x.toFixed(1),y:(choice.above||choice.below?choice.y:choice.y+3.5).toFixed(1),class:'nav-label nav-label--region','text-anchor':choice.anchor});el.textContent=text;labels.append(el);}
      }
      hits.replaceChildren();for(const c of communes){const vill=villageByCode.get(String(c.code));if(!vill)continue;const hit=make('path',{d:ringsD(outer(c)),class:'nav-hit',tabindex:'0',role:'button','aria-label':`Show ${vill.name}`});const title=make('title');title.textContent=vill.name;hit.append(title);hit.addEventListener('click',()=>selectVillage(vill));hit.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();selectVillage(vill);}});hits.append(hit);}
      points.replaceChildren();const sel=all.find(item=>item.id===selected?.id);if(sel){const x=sx(+sel.bounds2154[0]+(+sel.bounds2154[2]-+sel.bounds2154[0])/2),y=sy(+sel.bounds2154[1]+(+sel.bounds2154[3]-+sel.bounds2154[1])/2);if(Number.isFinite(x+y))points.append(make('circle',{cx:x,cy:y,r:state.mode==='local'?3.6:3.2,class:'nav-selected'}));}
    }
    const vb=state.view?.easting!=null?[state.view.easting-state.view.radiusMetres,state.view.northing-state.view.radiusMetres,state.view.easting+state.view.radiusMetres,state.view.northing+state.view.radiusMetres]:null;if(vb){frame.setAttribute('x',sx(vb[0]));frame.setAttribute('y',sy(vb[3]));frame.setAttribute('width',Math.max(2,sx(vb[2])-sx(vb[0])));frame.setAttribute('height',Math.max(2,sy(vb[1])-sy(vb[3])));frame.setAttribute('visibility','visible');cross.replaceChildren(make('line',{x1:sx(state.view.easting)-6,y1:sy(state.view.northing),x2:sx(state.view.easting)+6,y2:sy(state.view.northing)}),make('line',{x1:sx(state.view.easting),y1:sy(state.view.northing)-6,x2:sx(state.view.easting),y2:sy(state.view.northing)+6}));cross.setAttribute('visibility','visible');}else{frame.setAttribute('visibility','hidden');cross.setAttribute('visibility','hidden');}
    nav.querySelector('#nav-mode-label').textContent=state.mode==='local'?(selected?.name||'Local view'):`${REGION.overview} overview`;nav.querySelector('#nav-readout').textContent=state.view?`Current view · ${selected?.name||REGION.overview} · ${Math.round(state.view.radiusMetres)} m`:'View · —';
  }
  function setView(view){if(view&&Number.isFinite(+view.easting)){state.view={easting:+view.easting,northing:+view.northing,radiusMetres:Math.max(100,+view.radiusMetres||1800)};draw();}}
  {let k=1,tx=0,ty=0,commitTimer=0,dragged=false;const pointers=new Map();let last=null;
   const local=e=>{const r=svg.getBoundingClientRect();return [e.clientX-r.left,e.clientY-r.top];};
   const apply=()=>world.setAttribute('transform',`translate(${tx.toFixed(1)},${ty.toFixed(1)}) scale(${k.toFixed(4)})`);
   const limits=()=>state.mode==='local'?[.4,14]:[.8,24];
   const commit=()=>{clearTimeout(commitTimer);const m=state.mapping;if(!m||(k===1&&!tx&&!ty))return;const qx=(m.W/2-tx)/k,qy=(m.H/2-ty)/k;state.center=[m.cX+(qx-m.W/2)/m.scale,m.cY-(qy-m.H/2)/m.scale];state.zoom*=k;k=1;tx=ty=0;world.removeAttribute('transform');draw();};
   const later=()=>{clearTimeout(commitTimer);commitTimer=setTimeout(commit,160);};
   const zoomAt=(f,px,py)=>{const [lo,hi]=limits(),total=state.zoom*k,next=Math.min(hi,Math.max(lo,total*f));f=next/total;if(f===1)return;k*=f;tx=f*tx+(1-f)*px;ty=f*ty+(1-f)*py;apply();};
   svg.addEventListener('wheel',e=>{e.preventDefault();const [px,py]=local(e);zoomAt(Math.exp(-e.deltaY*.0018),px,py);later();},{passive:false});
   svg.addEventListener('pointerdown',e=>{pointers.set(e.pointerId,local(e));dragged=false;last=null;});
   svg.addEventListener('pointermove',e=>{if(!pointers.has(e.pointerId))return;const prev=pointers.get(e.pointerId),now=local(e);pointers.set(e.pointerId,now);
     if(pointers.size===1){const dx=now[0]-prev[0],dy=now[1]-prev[1];if(!dragged&&Math.hypot(dx,dy)<1)return;if(!dragged)svg.setPointerCapture?.(e.pointerId);dragged=true;svg.classList.add('is-dragging');tx+=dx;ty+=dy;apply();}
     else if(pointers.size===2){const [p,q]=[...pointers.values()],dist=Math.hypot(p[0]-q[0],p[1]-q[1]),mid=[(p[0]+q[0])/2,(p[1]+q[1])/2];if(!dragged)for(const id of pointers.keys())svg.setPointerCapture?.(id);dragged=true;if(last){tx+=mid[0]-last.mid[0];ty+=mid[1]-last.mid[1];zoomAt(dist/last.dist,mid[0],mid[1]);apply();}last={dist,mid};}});
   const up=e=>{pointers.delete(e.pointerId);last=null;if(!pointers.size){svg.classList.remove('is-dragging');if(dragged)commit();}};
   svg.addEventListener('pointerup',up);svg.addEventListener('pointercancel',up);
   svg.addEventListener('click',e=>{if(dragged){e.stopPropagation();e.preventDefault();dragged=false;}},true);
   zoomControls.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;const m=state.mapping;if(b.dataset.zoom==='reset'){state.center=null;state.zoom=1;k=1;tx=ty=0;world.removeAttribute('transform');draw();return;}if(m){zoomAt(b.dataset.zoom==='in'?1.6:1/1.6,m.W/2,m.H/2);commit();}});}
  state.setView=setView;state.setSelected=()=>{state.staticKey='';draw();};if(typeof ResizeObserver==='function')new ResizeObserver(()=>{state.staticKey='';draw();}).observe(svg);
  nav.querySelectorAll('[data-orient]').forEach(b=>b.addEventListener('click',()=>{state.mode=b.dataset.orient;nav.querySelectorAll('[data-orient]').forEach(x=>x.classList.toggle('is-active',x===b));state.staticKey='';draw();}));nav._navState=state;draw();return nav;
}

function updateDetails(v,scene,viewScene=scene){const stats=scene.stats||{};const wineRegion=findWineRegion(v)?.label;const department=({'21':"Côte-d’Or",'71':"Saône-et-Loire",'69':'Rhône','89':'Yonne','07':'Ardèche','26':'Drôme','42':'Loire'}[String(v.department)]||v.region||'Bourgogne');const region=wineRegion||v.departmentName||department;const spacing=scene.bounds&&scene.gridSize?Math.max(scene.bounds[2]-scene.bounds[0],scene.bounds[3]-scene.bounds[1])/(scene.gridSize-1):null;const contextUsed=Boolean(viewScene?.coverage?.contextTerrainUsed);const displaySpacing=contextUsed?(viewScene.coverage.contextSamplingMetres||200):spacing;const terrainSource=contextUsed?`Context terrain beyond the village grid uses a coarse IGN source at approximately ${Math.round(displaySpacing)} m.`:spacing?`Ground elevation from IGN, displayed on a ${Math.round(spacing)} m grid.`:'Ground elevation from IGN.';const edge=scene.coverage?.terrainEdgeFillUsed?` Small terrain edge gaps use nearest source elevations${scene.coverage.terrainEdgeFillCount?` (${scene.coverage.terrainEdgeFillCount} cells)`:''}.`:'';$('#crumb-village').textContent=v.name;$('#crumb-dept').textContent=region;$('#detail-name').textContent=v.name;$('#detail-sub').textContent=`${region} · ${department} · ${v.name}`;$('#detail-code').textContent=v.code||v.id;$('#stat-elevation').textContent=scene.minElevation!=null&&scene.maxElevation!=null?`${Math.round(scene.minElevation)}–${Math.round(scene.maxElevation)} m`:'—';const area=v.areaKm2??v.area;const areaEl=$('#stat-area').parentElement;areaEl.hidden=area==null;$('#stat-area').textContent=area!=null?areaText(Number(area)*1000000):'';$('#stat-climats').textContent=stats.climatCount??(scene.climats?.length||'—');$('#stat-sample').textContent=displaySpacing?`${Math.round(displaySpacing)} m`:'—';$('#stat-sample').previousElementSibling.textContent=contextUsed?'Context display grid':'Display grid';$('#source-note').textContent=contextUsed?'RGE ALTI® · coarse context terrain · IGN BD TOPO® · DGFiP / Etalab':'RGE ALTI® · IGN BD TOPO® · DGFiP / Etalab';$('#detail-description').textContent=`${terrainSource} ${stats.climatCount||scene.climats?.length||0} lieux-dits in this view.${edge}`;}
function activeFromView(view){return mosaic?.findVillage(Number(view?.easting),Number(view?.northing))||selected;}
// Re-assemble when a village near the view is not in the assembled scene, when the view no longer fits inside the area already assembled (it is built wider than the view, see
// SceneMosaic coverage), or when zooming in has made that area far bigger than needed, so its terrain is too coarse.
function streamIsMeaningful(view){if(!view||!Number.isFinite(Number(view.easting))||!Number.isFinite(Number(view.northing)))return false;const baseline=streamViewPending||streamViewLast;if(!baseline)return true;const radius=Math.max(100,Number(view.radiusMetres)||1800);const moved=Math.hypot(Number(view.easting)-baseline.easting,Number(view.northing)-baseline.northing);const covered=mosaic?.coveredView?mosaic.coveredView(baseline).radiusMetres:baseline.radiusMetres;if(moved+radius*1.15>covered)return true;if(streamLoadedIds&&mosaic?.nearestIds&&mosaic.nearestIds(view).some(id=>!streamLoadedIds.has(id)))return true;const wanted=mosaic?.coveredView?mosaic.coveredView(view).radiusMetres:radius;return covered>wanted*2.5;}
function updateInteractionHint(scene=coverageScene){const hint=document.querySelector('.canvas-hint');if(!hint)return;const left=interactionMode==='pan'?'Left-drag to pan':'Left-drag to rotate';const shift=interactionMode==='pan'?'Shift-drag to rotate':'Shift-drag to pan';hint.textContent=`${left} · ${shift} · Arrow keys or Move/Pan pad · Scroll to zoom${scene?.coverage?.contextTerrainUsed?' · Context terrain beyond aerial coverage':''}`;}
function updateCoverageHint(scene){coverageScene=scene||null;updateInteractionHint();}
function panMap(direction){if(!['up','down','left','right'].includes(direction)||!renderer?.panByDirection)return;renderer.panByDirection(direction);}
function mapKeyIsIgnored(event){if(event.altKey||event.ctrlKey||event.metaKey||document.querySelector('.source-modal:not([hidden])'))return true;const target=event.target;return !(target instanceof Element)||Boolean(target.closest('input,textarea,select,[contenteditable]'));}
function handleMapKeydown(event){const direction=panDirections[event.key];if(!direction||mapKeyIsIgnored(event))return;event.preventDefault();panMap(direction);}
async function streamView(view){regionalNavigator?._navState?.setView(view);if(interactionActive){streamViewQueued=view;if(!interactionHeld)scheduleInteractionFlush();return;}refreshCadastre(view);if(!streamReady||!mosaic||!renderer||!streamIsMeaningful(view))return;const nextView={easting:Number(view.easting),northing:Number(view.northing),radiusMetres:Math.max(100,Number(view.radiusMetres)||1800)};const focus=activeFromView(nextView);if(!focus)return;const seq=++streamSeq;if(streamAbort)streamAbort.abort();const controller=new AbortController();streamAbort=controller;streamViewPending=nextView;try{const result=await mosaic.compose(nextView,{focusId:focus.id,signal:controller.signal});if(seq!==streamSeq||controller.signal.aborted)return;if(!result){streamViewPending=null;return;}if(renderer.isPanAnimating?.()){if(seq===streamSeq)streamViewPending=null;return;}await renderer.setVillage(focus,result.scene,{preserveView:true});if(seq!==streamSeq||controller.signal.aborted)return;streamViewLast=nextView;streamViewPending=null;streamLoadedIds=new Set((result.sources||[]).map(source=>source.id||source.entry?.id).filter(Boolean));if(selected?.id!==focus.id){selected=focus;regionalNavigator?._navState?.setSelected();renderList();writeVillageHash(focus.id,'replace');}const original=sceneCache.get(focus.id);if(original)updateDetails(focus,original,result.scene);updateCoverageHint(result.scene);debug.loadedVillage=focus.id;debug.sceneStats=renderer.getDebug?.()||{bounds:result.scene.bounds,gridSize:result.scene.gridSize};}catch(error){if(seq!==streamSeq||controller.signal.aborted||error?.name==='AbortError')return;streamViewPending=null;debug.resourceErrors.push(String(error?.message||error));}}
function scheduleInteractionFlush(){clearTimeout(interactionIdleTimer);if(interactionHeld)return;interactionIdleTimer=setTimeout(()=>{if(interactionHeld){interactionIdleTimer=0;return;}if(renderer?.isPanAnimating?.()){scheduleInteractionFlush();return;}interactionActive=false;const cadastre=cadastrePublishQueued;cadastrePublishQueued=null;if(cadastre)renderer?.setCadastralParcels(cadastre.parcels,cadastre.meta);const view=streamViewQueued;streamViewQueued=null;if(view)streamView(view);},350);} // waits 350 ms after the last scroll or drag, so a short pause between a scroll and a drag does not land a scene rebuild mid-movement
function markInteraction(active){if(active){if(!interactionActive&&streamAbort){streamAbort.abort();streamSeq++;streamViewPending=null;}interactionActive=true;clearTimeout(interactionIdleTimer);}else scheduleInteractionFlush();}

async function selectVillage(v,{history:historyMode='push'}={}){if(!v)return;clearFeatureSelection();const seq=++requestSeq;streamReady=false;streamViewLast=null;streamViewPending=null;streamViewQueued=null;cadastrePublishQueued=null;if(streamAbort)streamAbort.abort();if(currentAbort)currentAbort.abort();currentAbort=new AbortController();selected=v;renderList();ui.loading.hidden=false;ui.error.hidden=true;setProgress(45,`Loading ${term('village')} scene…`,v.name);try{const scene=await loadScene(v,currentAbort.signal);if(seq!==requestSeq)return;setProgress(78,'Building terrain…','Draping mapped features');await renderer.setVillage(v,scene,{preserveView:false});if(seq!==requestSeq)return;updateDetails(v,scene);debug.loadedVillage=v.id;debug.sceneStats=renderer.getDebug?.()||{bounds:scene.bounds,gridSize:scene.gridSize};writeVillageHash(v.id,historyMode);setProgress(100,'Ready to explore','');setTimeout(()=>ui.loading.hidden=true,250);streamReady=true;const b=scene.bounds||v.bounds2154;const initialView=renderer.getViewState?.()||renderer.getView?.()||(b?{easting:(b[0]+b[2])/2,northing:(b[1]+b[3])/2,radiusMetres:Math.max(b[2]-b[0],b[3]-b[1])*.7}:null);if(initialView)streamView(initialView);}catch(e){if(e.name==='AbortError')return;debug.resourceErrors.push(String(e.message));ui.loading.hidden=true;ui.error.hidden=false;ui.errorMsg.textContent=e.message;}}
// Screen areas that overlay the map; labels are not placed underneath them.
const LABEL_OBSTACLES='.phone-chrome .top-search,.phone-fabs,.phone-place,.viewer-toolbar,.viewer-bottom,.drawer-edge-left,.details-toggle,.pan-pad,.north-mark,.sidebar.drawer-open,.detail-panel.drawer-open,.detail-panel.mobile-open,.classification-popover:not([hidden]),.layer-popover.is-open';
// The panels labels must avoid hardly move, so their boxes are measured at most every 250 ms instead of every frame.
let obstacleCache=null,obstacleTime=-1e9;function labelObstacles(){const now=performance.now();if(obstacleCache&&now-obstacleTime<250)return obstacleCache;obstacleTime=now;return obstacleCache=measureLabelObstacles();}
function measureLabelObstacles(){const stage=$('#canvas-stage')?.getBoundingClientRect();if(!stage)return [];const boxes=[];for(const el of document.querySelectorAll(LABEL_OBSTACLES)){if(el.hidden)continue;const r=el.getBoundingClientRect();if(r.width<1||r.height<1||r.right<=stage.left||r.left>=stage.right||r.bottom<=stage.top||r.top>=stage.bottom)continue;boxes.push({left:r.left-stage.left,right:r.right-stage.left,top:r.top-stage.top,bottom:r.bottom-stage.top});}return boxes;}
const PIN_ICON='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 3l1 7 3 3v4H5v-4l3-3 1-7z"/><path d="M12 17v5M5 17h14"/></svg>';
const PANEL_ICON='<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="1"/><path d="M8 4v16M15 9l-3 3 3 3"/></svg>';
const CHEVRON_ICON='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
function syncPin(pin,pinned){if(!pin)return;pin.innerHTML=PIN_ICON;pin.setAttribute('aria-pressed',String(pinned));pin.setAttribute('aria-label',pinned?`Unpin ${term('village')} index`:`Pin ${term('village')} index`);pin.title=pinned?'Release panel pin':'Keep panel open';}
function syncPanelToggle(toggle,open){if(!toggle)return;toggle.innerHTML=PANEL_ICON;toggle.setAttribute('aria-expanded',String(open));toggle.setAttribute('aria-label',open?`Collapse ${term('village')} index`:`Expand ${term('village')} index`);}
function setup(){
  const interactionCanvas=()=>$('#terrain-canvas');
  window.addEventListener('pointerdown',event=>{if(event.target===interactionCanvas()){interactionHeld=true;markInteraction(true);}},true);
  window.addEventListener('pointerup',()=>{if(interactionActive){interactionHeld=false;markInteraction(false);}},true);
  window.addEventListener('pointercancel',()=>{if(interactionActive){interactionHeld=false;markInteraction(false);}},true);
  window.addEventListener('wheel',event=>{if(event.target===interactionCanvas()){markInteraction(true);scheduleInteractionFlush();}},true);
  window.addEventListener('blur',()=>{if(interactionActive){interactionHeld=false;markInteraction(false);}},true);
  document.addEventListener('click',event=>{const panelToggle=event.target.closest?.('#panel-toggle');if(panelToggle)syncPanelToggle(panelToggle,panelToggle.getAttribute('aria-expanded')==='true');});
  const shell=document.querySelector('.atlas-shell'),sidebar=document.querySelector('.sidebar'),details=document.querySelector('.detail-panel');
const drawer=(panel,side,label)=>{if(!panel)return;const isLeft=side==='left';const edge=isLeft?document.createElement('button'):null;const railIcon=isLeft?'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16M4 9h16M4 13h10M4 17h10"/><path d="M17 14l3 3-3 3"/></svg>':'<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 10v6M12 7h.01"/></svg>';if(edge){edge.className='drawer-edge drawer-edge-left';edge.type='button';edge.innerHTML=`<span>${railIcon}</span>`;edge.setAttribute('aria-label',`Open ${label}`);edge.title=`${term('Village')} index`;shell.append(edge);}const pin=isLeft?document.createElement('button'):null;if(pin){pin.className='drawer-pin';pin.type='button';syncPin(pin,false);panel.append(pin);}let timer;const syncRightToggle=open=>{if(!isLeft){const toggle=document.querySelector('.details-toggle');if(toggle){toggle.innerHTML=railIcon;toggle.hidden=open;toggle.setAttribute('aria-expanded',String(open));toggle.setAttribute('aria-label',open?'Close info':'Open info');}}};const open=()=>{clearTimeout(timer);panel.classList.add('drawer-open');if(isLeft){panel.classList.remove('is-collapsed');syncPanelToggle(document.querySelector('#panel-toggle'),true);edge.setAttribute('aria-expanded','true');}else syncRightToggle(true);};const closeNow=()=>{if(isLeft&&pin.getAttribute('aria-pressed')==='true')return;panel.classList.remove('drawer-open','mobile-open');if(isLeft){syncPanelToggle(document.querySelector('#panel-toggle'),false);edge.setAttribute('aria-expanded','false');}else syncRightToggle(false);};const close=()=>{if(!isLeft||pin.getAttribute('aria-pressed')==='true')return;clearTimeout(timer);timer=setTimeout(()=>{if(!panel.matches(':hover')&&!(document.activeElement&&panel.contains(document.activeElement)&&document.activeElement.matches(':focus-visible'))&&!(isLeft&&document.activeElement?.closest?.('.top-search')&&document.activeElement.value))closeNow();},300)};if(isLeft){edge.addEventListener('pointerenter',open);edge.addEventListener('focus',open);edge.addEventListener('click',open);panel.addEventListener('pointerenter',open);panel.addEventListener('pointerleave',close);edge.addEventListener('pointerleave',close);pin.addEventListener('click',()=>{const pinned=pin.getAttribute('aria-pressed')!=='true';syncPin(pin,pinned);if(pinned)open();else close()});}return {open,close,closeNow,panel,pin};};
const leftDrawer=drawer(sidebar,'left',`${term('village')} index`),rightDrawer=drawer(details,'right',`${term('village')} details`);if(leftDrawer?.pin){document.querySelector('.sidebar-head-actions')?.append(leftDrawer.pin);}window.atlasDrawers={left:leftDrawer,right:rightDrawer};
  const detailBtn=document.createElement('button');detailBtn.className='mobile-menu details-toggle';detailBtn.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 10v6M12 7h.01"/></svg>';detailBtn.setAttribute('aria-label','Open info');detailBtn.setAttribute('aria-expanded','false');shell.append(detailBtn);const setDetailsToggleState=open=>{detailBtn.hidden=open;detailBtn.setAttribute('aria-expanded',String(open));detailBtn.setAttribute('aria-label',open?'Close info':'Open info');};detailBtn.addEventListener('click',()=>{if(matchMedia('(min-width:761px)').matches){const p=window.atlasDrawers?.right;if(p?.panel.classList.contains('drawer-open'))p.closeNow();else{p?.open();setDetailsToggleState(true);}}else setDetailsToggleState($('.detail-panel').classList.toggle('mobile-open'));});const closeDetail=document.createElement('button');closeDetail.className='drawer-close detail-close';closeDetail.textContent='×';closeDetail.setAttribute('aria-label',`Close selected ${term('village')} details`);$('.detail-panel').prepend(closeDetail);closeDetail.addEventListener('click',()=>{const p=window.atlasDrawers?.right;if(p)p.closeNow();$('.detail-panel').classList.remove('mobile-open','drawer-open');setDetailsToggleState(false);});
  const controls=document.querySelector('.viewer-bottom');if(controls&&typeof ResizeObserver==='function'){const syncControls=()=>document.documentElement.style.setProperty('--controls-height',`${Math.ceil(controls.getBoundingClientRect().height)}px`);new ResizeObserver(syncControls).observe(controls);syncControls();}
  updateInteractionHint();
  window.addEventListener('keydown',e=>{if(e.key==='Escape'&&!document.querySelector('dialog[open]')){if(classificationPopover&&!classificationPopover.hidden)closeClassification({restoreFocus:true});window.atlasDrawers?.left?.closeNow();window.atlasDrawers?.right?.closeNow();$('.detail-panel').classList.remove('mobile-open','drawer-open');}});
  const helpModal=$('#keyboard-help-popover'),helpButton=$('#keyboard-help');const closeHelp=()=>{if(helpModal.hidden)return;helpModal.hidden=true;helpButton?.focus();};
  helpButton?.addEventListener('click',()=>{helpModal.hidden=false;$('#keyboard-help-close').focus();});$('#keyboard-help-close')?.addEventListener('click',closeHelp);
  for(const modal of [helpModal,$('#source-modal')])modal?.addEventListener('click',event=>{if(event.target===modal){modal.hidden=true;}});
  window.addEventListener('keydown',e=>{if(e.key==='Escape')closeHelp();});
  document.querySelectorAll('[data-pan-direction]').forEach(button=>button.addEventListener('click',()=>panMap(button.dataset.panDirection)));
  $('#layers-toggle')?.addEventListener('click',()=>$('#layer-popover').classList.toggle('is-open'));setupTerroirControl();
  const water=document.querySelector('.static-water-layer');if(water){$('#layer-popover')?.append(water);water.style.display='flex';water.querySelector('input').addEventListener('change',e=>renderer.setLayer('water',e.target.checked));}setupLayersPopover();setupControlPills();
   const classificationToggle=$('#classification-toggle'),classificationPopover=$('#classification-popover');
   const positionClassification=()=>{if(!classificationPopover||classificationPopover.hidden)return;classificationPopover.style.transform='';const viewer=document.querySelector('.viewer-wrap')?.getBoundingClientRect(),move=document.querySelector('.pan-pad')?.getBoundingClientRect(),popup=classificationPopover.getBoundingClientRect();let shift=0;if(move&&popup.bottom>move.top&&popup.top<move.bottom&&popup.right>move.left-12)shift=move.left-12-popup.right;if(viewer&&popup.left+shift<viewer.left+12)shift+=viewer.left+12-(popup.left+shift);if(shift)classificationPopover.style.transform=`translateX(${Math.round(shift)}px)`;};
   const closeClassification=({restoreFocus=false}={})=>{if(!classificationPopover||!classificationToggle)return;classificationPopover.hidden=true;classificationPopover.classList.remove('is-open');classificationPopover.style.transform='';classificationToggle.setAttribute('aria-expanded','false');if(restoreFocus)classificationToggle.focus();};
   const openClassification=()=>{if(!classificationPopover||!classificationToggle)return;classificationPopover.hidden=false;classificationPopover.classList.add('is-open');classificationToggle.setAttribute('aria-expanded','true');positionClassification();};
   classificationToggle?.addEventListener('click',()=>classificationPopover?.hidden?openClassification():closeClassification());
   classificationPopover?.addEventListener('change',event=>{const checkbox=event.target.closest?.('[data-classification]');if(!checkbox)return;renderer.setClassification?.(checkbox.dataset.classification,checkbox.checked);closeClassification({restoreFocus:true});});
   document.addEventListener('click',event=>{if(classificationPopover?.hidden)return;if(!event.target.closest?.('.classification-control'))closeClassification();});
   window.addEventListener('resize',positionClassification);
  regionalGroups=groupVillagesByWineRegion(index.villages);regionCollapsed=new Map(regionalGroups.map(group=>[group.id,true]));const regionSelect=$('#wine-region-select');if(regionSelect){regionSelect.replaceChildren(new Option(term('allWineRegions'),'all'),...wineRegionOptions().map(region=>new Option(region.label,region.id)));regionSelect.addEventListener('change',()=>{wineRegion=regionSelect.value;ui.list.scrollTop=0;renderList();});}
  const mosaicOptions={maxLoadedScenes:12,gridSize:257,coverage:1.8,minHalfSize:3000};
  mosaic=new SceneMosaic({index,loadScene,textureManifest,textureBase:new URL('./',location.href).href,backgroundSources:contextTerrain,boundaries:communeBoundaries,cacheLimit:0,preferAvif:useAvif,...mosaicOptions});
  useMosaicWorker(mosaic,{index,textureManifest,options:mosaicOptions});
  renderer=new AtlasRenderer({canvas:$('#terrain-canvas'),container:$('#canvas-stage'),labels:$('#map-labels'),labelObstacles,progressiveBuild:true,onViewChange:view=>streamView(view),onSelect:(feature,layer,provenance)=>{const p=feature?.properties||feature||{};const classification=p.classification||p.category;const title=p.name||p.nom||'Lieu-dit';const source=layer==='parcels'?'INAO':(layer==='climats'||layer==='climat')?'DGFiP / Etalab':layer==='buildings'||layer==='roads'||layer==='forest'?'IGN BD TOPO':'Atlas source';showFeatureFacts(feature,layer,provenance);},onError:(e)=>debug.resourceErrors.push(String(e))});
  renderer.setCommuneBoundaries?.(communeBoundaries);
  if(/[?&]debug\b/.test(location.search))debug.renderer=renderer;
  document.querySelectorAll('.interaction-mode').forEach(button=>button.addEventListener('click',()=>{interactionMode=button.dataset.interaction==='pan'?'pan':'rotate';document.querySelectorAll('.interaction-mode').forEach(item=>{const active=item.dataset.interaction===interactionMode;item.classList.toggle('is-active',active);item.setAttribute('aria-pressed',String(active));});renderer.setInteraction?.(interactionMode);updateInteractionHint();}));
  // Touch screens: one finger drags the map by default, as in map apps (two-finger twist rotates).
  if(matchMedia('(pointer: coarse)').matches)document.querySelector('.interaction-mode[data-interaction="pan"]')?.click();
  renderer.setInteraction?.(interactionMode);
  const aocOpacity=$('#aoc-opacity'),aocOutput=$('#aoc-opacity-value');if(aocOpacity){const syncAocOpacity=()=>{const percent=Math.max(0,Math.min(100,Number(aocOpacity.value)||0));if(aocOutput)aocOutput.textContent=`${percent}%`;renderer.setAocOpacity?.(percent/100);};aocOpacity.addEventListener('input',syncAocOpacity);aocOpacity.addEventListener('change',syncAocOpacity);syncAocOpacity();}
  regionalNavigator=buildRegionalNav();renderList();const panelToggle=$('#panel-toggle');if(panelToggle)panelToggle.addEventListener('click',()=>{const panel=document.querySelector('.sidebar');if(matchMedia('(min-width:761px)').matches){const p=window.atlasDrawers?.left;if(p){syncPin(p.pin,false);p.closeNow();}panel.classList.remove('is-collapsed');syncPanelToggle(panelToggle,false);}else{panel.classList.remove('is-open','is-collapsed','drawer-open');syncPanelToggle(panelToggle,false);}});selectVillage(villageFromHash()||index.villages.find(v=>/vosne/i.test(v.name))||index.villages[0],{history:'replace'});window.addEventListener('hashchange',()=>{const v=villageFromHash();if(v&&v.id!==selected?.id)selectVillage(v,{history:'none'});});
  ui.search.addEventListener('input',renderList);setupSheet();setupAtlasSwitch();
  document.querySelectorAll('.exag').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('.exag').forEach(x=>x.classList.remove('is-active'));b.classList.add('is-active');renderer.setExaggeration(Number(b.dataset.exag));}));
  // A region can open at its own terrain exaggeration (the Northern Rhône slopes are steep enough at 2x).
  initDisplaySettings(renderer,$('#display-button'));
  // Rain streams precomputed from the 1 m terrain (build_streams.py), fetched only for villages listed in its index.
  // 10 m rain fields (build_streams.py): two images per village, decoded without premultiplying so every channel stays exact.
  let fieldIndex=null;renderer.fieldLoader=async id=>{fieldIndex||=loadOptionalPayload(dataUrl('./data/rainfields/index.json')).then(d=>d?.villages||{});const bounds=(await fieldIndex)[id];if(!bounds)return null;const decode=async key=>{const res=await fetch(dataUrl(`./data/rainfields/${encodeURIComponent(id)}-${key}.webp`));if(!res.ok)throw new Error(`Rain field request failed (${res.status})`);return createImageBitmap(await res.blob(),{premultiplyAlpha:'none',colorSpaceConversion:'none'});};const [fa,fb]=await Promise.all([decode('a'),decode('b')]);return {bounds,a:fa,b:fb};};
  let streamIndex=null;renderer.streamLoader=async id=>{streamIndex||=loadOptionalPayload(dataUrl('./data/streams/index.json')).then(d=>new Set(d?.villages||[]));return (await streamIndex).has(id)?loadOptionalPayload(dataUrl(`./data/streams/${encodeURIComponent(id)}.json.gz`)):null;};
  initSimulation(renderer,$('#simulate-button'));
  if(REGION.terrainExaggeration)document.querySelector(`.exag[data-exag="${REGION.terrainExaggeration}"]`)?.click();
  document.querySelectorAll('.view-mode').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('.view-mode').forEach(x=>x.classList.remove('is-active'));b.classList.add('is-active');renderer.setMode(b.dataset.view);}));document.querySelectorAll('[data-layer]').forEach(c=>c.addEventListener('change',()=>renderer.setLayer(c.dataset.layer,c.checked)));$('#home-button').addEventListener('click',()=>renderer.resetView());const saveButton=$('#share-button'),saveStatus=$('#share-status'),saveLink=$('#share-download-link');saveButton.addEventListener('click',async()=>{if(saveButton.disabled)return;saveButton.disabled=true;saveButton.setAttribute('aria-busy','true');saveStatus.textContent='Preparing image…';try{const result=await exportMapImage(renderer);saveLink.href=result.url;saveLink.hidden=false;saveStatus.textContent='Download started';setTimeout(()=>{saveStatus.textContent='';},4000);}catch(error){saveStatus.textContent=error?.message||'Could not save the map image.';}finally{saveButton.disabled=false;saveButton.removeAttribute('aria-busy');}});$('#mobile-menu').addEventListener('click',()=>{$('.sidebar').classList.remove('is-collapsed');$('.sidebar').classList.add('is-open');});$('#drawer-close').addEventListener('click',()=>{$('.sidebar').classList.remove('is-open','is-collapsed');});['source-button','mobile-source','source-detail'].forEach(id=>$('#'+id)?.addEventListener('click',()=>$('#source-modal').hidden=false));$('#modal-close').addEventListener('click',()=>$('#source-modal').hidden=true);$('#feedback-button')?.addEventListener('click',()=>openSubmissionDialog('feedback'));window.addEventListener('keydown',e=>{if(document.querySelector('dialog[open]'))return;if(e.key==='/'&&document.activeElement!==ui.search&&!e.target?.closest?.('input,textarea,select,[contenteditable]')){e.preventDefault();ui.search.focus()}if(e.key==='Escape'){$('#source-modal').hidden=true;$('.sidebar').classList.remove('is-open')}handleMapKeydown(e)});
}
// Classification of a cadastral parcel = the coloured AOC areas under it, with the lieu-dit panel's
// wording: one class when it covers (nearly) all of the parcel's AOC land, otherwise the split.
const TIER_RANK={'Grand Cru':4,'Premier Cru':3,Cru:3,'Village appellation':2,'Regional appellation':1};
function cadastreAoc(under){
  if(!Array.isArray(under))return{tier:null,aoc:null};
  const parts=(under||[]).map(u=>({share:u.share,...featureIdentity(u.feature?.properties||u.feature||{},'parcels')})).filter(u=>u.tier);
  const land=parts.reduce((sum,u)=>sum+u.share,0);
  if(!land)return{tier:null,aoc:'Outside the mapped AOC areas'};
  const byName=[];for(const u of parts){const same=byName.find(x=>x.aocEligibility===u.aocEligibility);same?same.share+=u.share:byName.push({...u});}
  byName.sort((a,b)=>b.share-a.share);
  if(byName[0].share/land>=.98)return{tier:byName[0].tier,aoc:byName[0].aocEligibility,land};
  const tiers=[...new Set(byName.map(u=>u.tier))].sort((a,b)=>(TIER_RANK[b]||0)-(TIER_RANK[a]||0));
  const named=byName.slice(0,-1).map(u=>`${u.aocEligibility} on ${Math.round(u.share/land*100)}%`);
  return{tier:tiers.join(' / '),aoc:`${named.join('; ')} of the vineyard land; ${byName.at(-1).aocEligibility} on the rest`,land};
}
function renderCadastreFacts(feature,provenance){
  const card=$('#feature-card');if(!card)return;
  const p=feature?.properties||feature||{},m=feature?.__cadastreMeta||p.__cadastreMeta||provenance||{};
  const recorded=p.cadastralAreaM2,mapped=p.mappedAreaM2;
  const hasRecorded=recorded!=null&&recorded!==''&&Number.isFinite(Number(recorded))&&Number(recorded)>=0;
  const reference=`${p.section||'—'} ${p.number||'—'}`,aoc=cadastreAoc(provenance?.aocUnder);
  renderFeaturePanel(card,{title:placeHeading(provenance?.placeName||`Parcel ${reference}`,featureVillage(p.communeCode||m.communeCode)),subtitle:aoc.tier,identity:[['Place type',provenance?.placeName?`Cadastral parcel ${reference}`:'Cadastral parcel'],['AOC',aoc.aoc],['AOC land',aoc.land&&aoc.land<.98?`About ${Math.round(aoc.land*100)}% of the parcel; the classification covers that part only`:null]],
    area:{value:hasRecorded?recorded:mapped,label:hasRecorded?'Recorded cadastral area':'Mapped polygon area · recorded area unavailable'},
    altitude:elevationFact(feature),ownershipPrompt:'Loading recorded rights…',
    rows:[['Parcel reference',reference],['Lieu-dit at selected point',provenance?.placeName],['Place scope',provenance?.placeName?'Context at the selected map point; this does not classify the entire cadastral parcel.':null],['Parcel ID',p.id],['Commune code',p.communeCode||m.communeCode],['Recorded cadastral area',areaText(recorded)],['Mapped polygon area',areaText(mapped)],['Cadastre release',m.sourceDate||'Not available']],
    links:[['Cadastral source',safeUrl(m.sourceUrl)]]});
  card.append(correctionPrompt({layer:'cadastre',parcelRef:reference,featureName:provenance?.placeName,featureId:p.id,communeCode:p.communeCode||m.communeCode,villageId:selected?.id,villageName:featureVillage(p.communeCode||m.communeCode)||selected?.name}));
}
async function appendOwnershipFacts(feature,provenance,request){
  const card=$('#feature-card');if(!card)return;
  ownershipLoader ||= new OwnershipLoader({fetchManifest:()=>fetchJson(dataUrl('./data/ownership/manifest.json')),fetchPayload:meta=>loadOptionalPayload(dataUrl(meta.path)),maxCache:8});
  const result=await ownershipLoader.loadForParcel(feature);
  if(request!==ownershipRequest||selectedFeature?.feature!==feature)return;
  const section=card.querySelector('[data-ownership]');if(!section)return;
  section.replaceChildren(element('h4','fact-label','Ownership'));
  const messages={unavailable:'Rights data could not load',unsupported:'No published data for this commune',unknown:'Owner not identified in this public release'};
  if(result.status!=='ok')section.append(element('p','fact-value is-unavailable',messages[result.status]||'Not available'));
  else for(const row of result.rows){const holder=element('div','fact-holder');holder.append(element('p','fact-value',displayEntityName(row.entityName)||'Recorded legal entity'),element('p','fact-caption',row.rightsCode==='P'?'Recorded owner':row.rightLabel||row.rightsCode||'Recorded right'));section.append(holder);}
  if(result.meta?.sourceAsOf)section.append(element('p','fact-caption',`As of ${displayRecordDate(result.meta.sourceAsOf)||result.meta.sourceAsOf}`));
  if(result.status==='unknown')section.append(element('p','fact-caption','An absent record does not identify the owner.'));
  const list=card.querySelector('.fact-details-list'),body=card.querySelector('.fact-details-body');
  if(result.meta?.sourceAsOf)detailRow(list,'Rights release',result.meta.sourceAsOf);
  for(const row of result.rows){detailRow(list,row.entityName||'Legal entity',row.siren?`${/^\d{9}$/.test(row.siren)?'SIREN':'DGFiP identifier'} ${row.siren}`:'Identifier not available');detailRow(list,'Recorded right',[row.rightsCode,row.rightLabel].filter(Boolean).join(' · '));}
  body.append(element('p','fact-caption','This dated public release excludes individuals and certain company types. Recorded rights do not establish current ownership or vineyard operation.'));
  const url=safeUrl(result.meta?.sourceUrl);if(url){const link=element('a','','Legal-entity source ↗');link.href=url;link.target='_blank';link.rel='noopener';card.querySelector('.fact-sources').append(link);}
}

document.addEventListener('change',event=>{
  if(event.target.matches?.('[data-layer="cadastre"]') && renderer) refreshCadastre(renderer.getView());
});
async function boot(){try{await applyRegion();[index,,useAvif]=await Promise.all([loadIndex(),loadRegionalData(),avifSupported()]);for(const tile of Object.values(textureManifest))for(const key of ['url','urlAvif'])if(tile?.[key])tile[key]=dataUrl(tile[key]).href;setup()}catch(e){debug.resourceErrors.push(String(e.message));ui.loading.hidden=true;ui.error.hidden=false;ui.errorMsg.textContent=e.message;}}
boot();

