import { AtlasRenderer, CADASTRE_MAX_VIEW_RADIUS_METRES } from './atlas-renderer.js';
import { CadastreLoader } from './cadastre-loader.js';
import { OwnershipLoader } from './ownership-loader.js';
import { SceneMosaic, sampleScene } from './scene-mosaic.js';
import { findWineRegion, groupVillagesByWineRegion, setWineRegions, wineRegionOptions } from './regional-navigation.js';
import { loadRegion, REGION, regionClass, term } from './region.js';
import { aocFactLines, featureIdentity, mergeFeatureFacts, spatialAocMatches } from './aoc-facts.js';
import { areaText, featureArea, renderFeaturePanel, glanceTile, displayPlaceName, placeHeading, displayEntityName, displayRecordDate, element, detailRow, communeDisplayName } from './feature-panel.js';
import { exportMapImage, escapeFilename } from './export-map.js';
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
// The address is #<village>?sel=…&owner=…&shade=…&cam=… (see "Shareable links" below); a bare #<village> still works.
function hashParts(){const raw=location.hash.slice(1),q=raw.indexOf('?');let id=q<0?raw:raw.slice(0,q);try{id=decodeURIComponent(id);}catch{}return {id,params:new URLSearchParams(q<0?'':raw.slice(q+1))};}
function villageFromHash(){const {id}=hashParts();return index?.villages?.find(v=>v.id===id)||null;}
function writeVillageHash(id,mode){if(mode==='none'||shareRestoring)return;const hash=shareHash(id);if(location.hash===hash)return;history[mode==='push'&&hashParts().id!==id?'pushState':'replaceState'](null,'',hash);}
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
function clearFeatureSelection(){if(compare&&!compare.flying)endCompare(false);selectedFeature=null;scheduleShareSync();featureFactsRequest+=1;const card=$('#feature-card');if(card){card.classList.remove('feature-summary');card.replaceChildren();const strong=document.createElement('strong');strong.textContent='Click the terrain';const span=document.createElement('span');span.textContent='Explore a parcel or lieu-dit';card.append(strong,span);}}
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

async function showFeatureFacts(feature,layer,provenance){if(compare&&compareIntercept(feature,layer,provenance))return;if(layer==='cadastre'){selectedFeature={feature,layer,provenance};renderCadastreFacts(feature,provenance);appendOwnershipFacts(feature,provenance,++ownershipRequest);appendParcelContext(feature,provenance);addShareButton($('#feature-card'));addParcelCompareButton($('#feature-card'),provenance);scheduleShareSync();const mobile=matchMedia('(max-width:760px)').matches;if(mobile){$('.detail-panel')?.classList.add('mobile-open');openSheet(feature);}else $('.detail-panel')?.classList.add('drawer-open');window.atlasDrawers?.right?.open();return;}if(!feature){clearFeatureSelection();return;}const p=feature.properties||feature||{}, nested=p.facts||p.rawPropertyFacts||p.raw_property_facts||p.rawProperties?.facts||p.raw?.facts||{}, factsKey=provenance?.factsKey||p.factsKey||nested.factsKey||nested.key, villageId=provenance?.factsVillageId||p.factsVillageId||p.facts_village_id||nested.factsVillageId||nested.villageId||nested.village_id||provenance?.sourceVillageId, request=++featureFactsRequest;selectedFeature={feature,layer,provenance};const payload=factsKey&&villageId?await loadFeatureFacts(villageId):null;if(request!==featureFactsRequest||selectedFeature?.feature!==feature)return;const candidates=factsKey?(payload?.features||[]).filter(row=>row.key===factsKey):[];const meta=candidates.length===1?candidates[0]:null;renderFeatureFacts(feature,layer,meta);appendTerroirFacts(feature,layer,request);appendGeologyFacts(feature,layer,request);addShareButton($('#feature-card'));addCompareButton($('#feature-card'),feature,layer,provenance);scheduleShareSync();const mobile=matchMedia('(max-width:760px)').matches;if(mobile){$('.detail-panel')?.classList.add('mobile-open');openSheet(feature);}else $('.detail-panel')?.classList.add('drawer-open');window.atlasDrawers?.right?.open();const toggle=$('.details-toggle');if(toggle){toggle.textContent='Close info';toggle.hidden=true;toggle.setAttribute('aria-expanded','true');toggle.setAttribute('aria-label','Close info');}}
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
async function setTerroirMode(mode){await loadTerroirScale();terroirMode=['slope','aspect','sun','geology'].includes(mode)?mode:'off';document.querySelectorAll('input[name="terroir-mode"]').forEach(i=>{i.checked=i.value===terroirMode;});if(terroirMode==='geology')await loadGeologyLegend();renderer?.setTerroirTint?.(terroirMode==='off'||terroirMode==='geology'?null:terroirTint);renderer?.setGeologyLayer?.(terroirMode==='geology'?geologyLayer:null);terroirLegend();syncTerroirControl();scheduleShareSync();}
// ---- Geology: BRGM BD Charm-50, 1:50,000 (data/geology/, scripts/build_geology.py) ----
let geologyLegendPromise=null,geologyLegendData=null;const geologyTiles=new Map();let geologyLegendTimer=0;
function loadGeologyLegend(){geologyLegendPromise||=fetchJson(dataUrl('./data/geology/legend.json')).then(d=>{geologyLegendData=d;d.tileSet=new Set(d.tiles||[]);return d;}).catch(()=>null);return geologyLegendPromise;}
function geologyTileKeys(b){const L=geologyLegendData;if(!L||!b)return[];const t=L.tileSize||4000,out=[];for(let x=Math.floor(b[0]/t);x<=Math.floor(b[2]/t);x++)for(let y=Math.floor(b[1]/t);y<=Math.floor(b[3]/t);y++){const k=`${x}_${y}`;if(L.tileSet.has(k))out.push(k);}return out;}
function ringArea(f){let a=0;for(let i=0,n=f.length;i<n;i+=2){const j=(i+2)%n;a+=f[i]*f[j+1]-f[j]*f[i+1];}return a/2;}
function loadGeologyTile(k){if(!geologyTiles.has(k)){const pr=fetchJson(dataUrl(`./data/geology/tiles/${k}.json`)).then(d=>{pr.__data=(d?.polygons||[]).map(([u,rings])=>({unit:u,rings,colour:geologyLegendData?.units?.[u]?.colour||'#d9d4c7',get bbox(){return this._b||=ringsBox(rings);}}));/* bounding boxes are worked out only when sampling needs them */return pr.__data;}).catch(()=>{pr.__data=[];return[];});geologyTiles.set(k,pr);}return geologyTiles.get(k);}
// Draws what is loaded now; missing tiles are fetched together and the overlay is redrawn once when the whole batch
// is in (one canvas upload, not one per tile). Tiles one ring beyond the view are prefetched while the browser is idle,
// so panning or zooming out finds them ready.
let geologyBatch=0;
const whenIdle=fn=>window.requestIdleCallback?requestIdleCallback(fn,{timeout:600}):setTimeout(fn,150);
function geologyLayer(bounds){const out=[],missing=[];for(const k of geologyTileKeys(bounds)){const pr=loadGeologyTile(k);if(pr.__data)out.push(...pr.__data);else missing.push(pr);}
  if(missing.length){const batch=++geologyBatch;Promise.all(missing).then(()=>{if(batch!==geologyBatch||terroirMode!=='geology')return;renderer?.drawAocOverlay?.();renderer?.requestRender?.();});}
  else if(terroirMode==='geology')scheduleGeologyLegend();
  prefetchGeology(bounds);return out;}
// one tile per idle moment, and never while a finger or the mouse is moving the map
const geologyPrefetchQueue=[];let geologyPrefetching=false;
function prefetchGeology(b){if(!b||!geologyLegendData)return;const t=geologyLegendData.tileSize||4000;for(const k of geologyTileKeys([b[0]-t,b[1]-t,b[2]+t,b[3]+t]))if(!geologyTiles.has(k)&&!geologyPrefetchQueue.includes(k))geologyPrefetchQueue.push(k);if(!geologyPrefetching)prefetchNextGeology();}
function prefetchNextGeology(){if(terroirMode!=='geology'||!geologyPrefetchQueue.length){geologyPrefetching=false;return;}geologyPrefetching=true;whenIdle(()=>{if(interactionActive){setTimeout(prefetchNextGeology,400);return;}const k=geologyPrefetchQueue.shift();(geologyTiles.has(k)?Promise.resolve():loadGeologyTile(k)).then(()=>setTimeout(prefetchNextGeology,60));});}
function scheduleGeologyLegend(){clearTimeout(geologyLegendTimer);geologyLegendTimer=setTimeout(()=>whenIdle(()=>{if(terroirMode==='geology')terroirLegend();}),120);}
function ringsBox(rings){let a=Infinity,b=Infinity,c=-Infinity,d=-Infinity;for(const f of rings)for(let i=0;i<f.length;i+=2){if(f[i]<a)a=f[i];if(f[i]>c)c=f[i];if(f[i+1]<b)b=f[i+1];if(f[i+1]>d)d=f[i+1];}return[a,b,c,d];}
function insideRings(rings,x,y){let inside=false;for(const f of rings)for(let i=0,n=f.length,j=n-2;i<n;j=i,i+=2){const yi=f[i+1],yj=f[j+1];if((yi>y)!==(yj>y)&&x<(f[j]-f[i])*(y-yi)/(yj-yi)+f[i])inside=!inside;}return inside;}
// formations ranked by how much of the village they cover (sampled on a 28 x 28 grid; later polygons are drawn on top)
function geologyInView(){const b=renderer?.focusBounds||renderer?.bounds;if(!b||!geologyLegendData)return[];const polys=[];for(const k of geologyTileKeys(b)){const d=geologyTiles.get(k)?.__data;if(d)polys.push(...d);}const count=new Map(),N=28;for(let i=0;i<N;i++)for(let j=0;j<N;j++){const x=b[0]+(i+.5)*(b[2]-b[0])/N,y=b[1]+(j+.5)*(b[3]-b[1])/N;let hit=null;for(const p of polys){const q=p.bbox;if(x<q[0]||x>q[2]||y<q[1]||y>q[3])continue;if(insideRings(p.rings,x,y))hit=p.unit;}if(hit!=null&&!geologyLegendData.units[hit]?.water)count.set(hit,(count.get(hit)||0)+1);}return[...count.entries()].sort((a,b)=>b[1]-a[1]).map(([u])=>geologyLegendData.units[u]).filter(Boolean);}
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
  const fillLabel=$('.opacity-control');if(fillLabel&&!fillLabel.querySelector('.opacity-word')){const t=[...fillLabel.childNodes].find(n=>n.nodeType===3&&n.textContent.trim());if(t){const w=document.createElement('span');w.className='opacity-word';w.textContent=t.textContent.trim();t.replaceWith(w);}}
  // phones: keep the shading legend just above the controls sheet, whatever height the sheet wraps to
  const sheet=$('.viewer-bottom');if(sheet&&window.ResizeObserver&&!sheet.dataset.observed){sheet.dataset.observed='1';new ResizeObserver(()=>document.documentElement.style.setProperty('--controls-sheet-h',`${Math.round(sheet.getBoundingClientRect().height)}px`)).observe(sheet);}
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
function showOwner(o){if(!o)return;ownerShown=o;ownerCommuneIndex=0;drawOwnerCard(true);scheduleShareSync();}
// Where an owner's parcels lie (data/ownership/owner-crus.json.gz, scripts/build_owner_crus.py): per parcel the grand
// or premier cru and the lieu-dit it falls in. Loaded with the first owner card.
let ownerCrusPromise=null,ownerCrus=null;
function loadOwnerCrus(){ownerCrusPromise||=loadOptionalPayload(dataUrl('./data/ownership/owner-crus.json.gz')).then(d=>{ownerCrus=d||{parcels:{},crus:{},climats:{}};if(ownerShown)drawOwnerCard();return ownerCrus;});return ownerCrusPromise;}
const CRU_RANK={'grand-cru':0,'premier-cru':1};
function ownerGroups(ids){if(!ownerCrus)return [];const groups=new Map();for(const id of ids){const [cru,climat]=ownerCrus.parcels?.[id]||['',''];const key=cru?`c:${cru}`:climat?`l:${climat}`:'other';let g=groups.get(key);if(!g){g=cru?{kind:'cru',id:cru,name:ownerCrus.crus[cru]?.[0]||cru,cls:ownerCrus.crus[cru]?.[1]||'',village:ownerCrus.crus[cru]?.[2]}:climat?{kind:'lieu-dit',id:climat,name:ownerCrus.climats[climat]||climat,cls:''}:{kind:'other',name:'Other parcels',cls:''};g.ids=[];groups.set(key,g);}g.ids.push(id);}
  return [...groups.values()].sort((a,b)=>((CRU_RANK[a.cls]??(a.kind==='other'?3:2))-(CRU_RANK[b.cls]??(b.kind==='other'?3:2)))||(b.ids.length-a.ids.length)||a.name.localeCompare(b.name));}
const classLabel=cls=>cls==='grand-cru'?'Grand Cru':cls==='premier-cru'?'Premier Cru':'';
function drawOwnerCard(openFirst=false){const o=ownerShown;if(!o)return;if(!ownerCrus)loadOwnerCrus();const communes=Object.entries(o.communes).map(([code,ids])=>({code,ids:ids.split(','),village:communeVillage(code)})).sort((a,b)=>b.ids.length-a.ids.length);
  ui.list.innerHTML=`<div class="owner-card"><div class="owner-card-top"><button type="button" class="owner-back">← Back to results</button></div><h3>${esc(o.name)}</h3><p class="owner-meta">${esc(ownerSummary(o))}</p>${o.siren&&/^\d{9}$/.test(o.siren)?`<p class="owner-meta">SIREN <a href="https://annuaire-entreprises.data.gouv.fr/entreprise/${o.siren}" target="_blank" rel="noopener">${o.siren}</a></p>`:''}<p class="owner-note">Parcels held by this legal entity in the DGFiP register (2025). Areas are whole parcels, also counted for co-owners. Private individuals are not in this register.</p><div class="owner-communes">${communes.map((c,i)=>`<button type="button" class="village-row owner-commune" data-i="${i}"><strong>${esc(c.village?.name||c.code)}</strong><small>${c.ids.length} parcel${c.ids.length===1?'':'s'}</small></button>${ownerGroups(c.ids).map((g,k)=>`<button type="button" class="village-row owner-cru${g.kind==='other'?' is-other':''}" data-i="${i}" data-g="${k}"><strong>${esc(g.name)}${g.cls?` <em class="cru-class cru-class--${g.cls}">${classLabel(g.cls)}</em>`:''}</strong><small>${g.ids.length}</small></button>`).join('')}`).join('')}</div>${ownerCrus?'<p class="owner-note">Crus and lieux-dits are where each parcel lies, not who farms it or whose label the wine goes under.</p>':'<p class="owner-note owner-loading">Finding crus…</p>'}</div>`;
  addShareButton(ui.list.querySelector('.owner-card-top'));ui.list.querySelector('.owner-back').addEventListener('click',()=>{ownerShown=null;scheduleShareSync();renderer?.showOwnerParcels([]);renderList();ownerSearchInput()?.focus();});
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
// "How to use": one guided tour for web and phones. Each step dims the page around the control it explains and shows a
// card beside it, some with a small illustration (geology shading, comparing two crus). Shown once on a first visit
// (remembered in this browser); "How to use" in the footer (web) or the menu drawer (phone) runs it again, and its
// last card opens the full list of features and controls.
{const KEY='atlas.guideSeen.v3';
 const isPhone=()=>document.documentElement.classList.contains('phone-ui');
 const pick=(web,phone)=>isPhone()?phone:web;
 const visible=sel=>[...document.querySelectorAll(sel)].find(el=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(el).visibility!=='hidden';})||null;
 const CMP_ICON='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4v16M16 4v16M4 8h4M16 16h4"/></svg>';
 const art={
  mouse:'<span class="tour-keys"><span><kbd>Drag</kbd>rotate (Pan in the bar)</span><span><kbd>Shift</kbd>+ drag to pan</span><span><kbd>Scroll</kbd>zoom</span><span><kbd>Double-click</kbd>focus there</span></span>',
  touch:'<span class="gesture-grid"><div class="gesture"><span class="gesture-art g-drag"><i></i><i></i></span><span><b>One finger</b> drag to move</span></div><div class="gesture"><span class="gesture-art g-pinch"><i></i><i></i></span><span><b>Two fingers</b> pinch to zoom</span></div><div class="gesture"><span class="gesture-art g-twist"><i></i><i></i></span><span><b>Two fingers</b> twist to turn</span></div><div class="gesture"><span class="gesture-art g-tilt"><i></i><i></i></span><span><b>Two fingers</b> slide to tilt</span></div></span>',
  panel:'<span class="ta ta-panel"><span class="ta-tiles"><span><small>Area</small><b>6.05 ha</b></span><span><small>Slope</small><b>10.7%</b></span><span><small>Faces</small><b>East</b></span><span><small>Sun</small><b>2,409 h</b></span></span><span class="ta-geo"><i style="flex:68;background:#e6c48a"></i><i style="flex:21;background:#e8994b"></i><i style="flex:11;background:#9b6b4f"></i></span><small class="ta-cap">Geology: the rocks under the plot, by share</small></span>',
  shade:'<span class="ta ta-shade"><span class="ta-modes"><span><i style="background:linear-gradient(90deg,#e3b23c,#5f97d6,#7b4051)"></i>Appellations</span><span><i style="background:linear-gradient(90deg,#f3e3b3,#a8452c)"></i>Slope</span><span><i style="background:conic-gradient(#5f97d6,#e3b23c,#c0532d,#5f97d6)"></i>Aspect</span><span><i style="background:linear-gradient(90deg,#f6e6a9,#d9822b)"></i>Sun hours</span><span class="is-on"><i style="background:linear-gradient(90deg,#e6c48a,#e8994b,#e6ef7a,#9b6b4f)"></i>Geology</span></span><span class="ta-legend"><span><i style="background:#e6c48a"></i>Limestone</span><span><i style="background:#e8994b"></i>Marl</span><span><i style="background:#e6ef7a"></i>Colluvium</span><span><i style="background:#d8d2c4"></i>Scree</span></span></span>',
  start:`<span class="ta ta-flow"><span class="ta-pill">${CMP_ICON}Compare</span><span class="ta-arrow">→</span><span class="ta-chips"><span class="ta-chip ta-a"><b>A</b>Chambertin</span><span class="ta-chip ta-b ta-empty"><b>B</b>Search a cru…</span></span></span>`,
  read:'<span class="ta ta-read"><span class="ta-tabs"><span class="is-on">Parcels</span><span>Geology</span><span>Overlay</span></span><span class="ta-thumbs"><svg viewBox="0 0 60 40"><rect width="60" height="40" fill="#f6efe1"/><path d="M8 30C18 26 30 14 52 10M6 36C20 32 34 22 56 18" fill="none" stroke="#c9a77a" stroke-width=".8"/><path d="M22 8l12-2 3 26-13 2z" fill="#7f77dd44" stroke="#534ab7" stroke-width="1.4"/><path d="M24 14h11M24 20h12M25 26h11" stroke="#534ab7" stroke-width=".5"/></svg><svg viewBox="0 0 60 40"><rect width="60" height="40" fill="#e6ef7a"/><path d="M0 0h60v12C40 16 20 10 0 16z" fill="#e8994b"/><path d="M0 0h60v5C40 8 20 4 0 8z" fill="#9b6b4f"/><path d="M24 10l12-3 3 26-13 2z" fill="none" stroke="#fffdf7" stroke-width="3"/><path d="M24 10l12-3 3 26-13 2z" fill="none" stroke="#0f6e56" stroke-width="1.4"/></svg><svg viewBox="0 0 60 40"><rect width="60" height="40" fill="#fffdf7"/><path d="M14 12h30l2 18H12z" fill="#7f77dd33" stroke="#534ab7" stroke-width="1.3"/><path d="M8 18l40-5 4 9-42 6z" fill="#1d9e7533" stroke="#0f6e56" stroke-width="1.3"/></svg></span><span class="ta-prof"><svg viewBox="0 0 200 54"><path d="M4 8C40 12 90 20 150 30" fill="none" stroke="#534ab7" stroke-width="2.2"/><path d="M4 22C40 24 80 28 120 34" fill="none" stroke="#0f6e56" stroke-width="2.2"/><rect x="4" y="42" width="146" height="4" fill="#e6ef7a"/><rect x="4" y="48" width="80" height="4" fill="#d8d2c4"/><rect x="84" y="48" width="36" height="4" fill="#82bdf6"/></svg><small class="ta-cap">Down the slope: top to bottom, with the rock underneath</small></span></span>'};
 const steps=()=>[
  {target:pick('.topbar .top-search','.phone-chrome .top-search'),title:'Search',text:pick('Find a village or cru. The box beside it searches owners (domaines, GFA, SCI…) and lists the crus they hold.','Find a village or cru. Tap the person icon to search owners instead, and ☰ for the navigator and menu.')},
  {target:'#terrain-canvas',pad:-70,title:'Moving the map',html:pick(art.mouse,art.touch)+pick('The arrow keys move the map too.','')},
  {target:pick('#terrain-canvas','.phone-fab[data-fab=info]'),pad:pick(-70,6),title:pick('Click a vineyard','Tap a vineyard'),html:`${pick('Click','Tap')} any lieu-dit or AOC area${pick('',', then ⓘ,')} for its area, elevation, slope, which way it faces, sun hours and the rock beneath.${art.panel}Turn on <b>Cadastral parcels</b> in Layers to open single parcels and see their recorded owners.`},
  {target:'.terroir-control',title:'Shade by geology',sheet:true,html:`<b>Shade by</b> colours the vineyards by slope, aspect, sun hours or <b>geology</b> instead of appellation.${art.shade}Geology lays the BRGM 1:50,000 map over the slopes, with a legend of the rocks in view.`},
  {target:'#layers-toggle',title:'Layers',sheet:true,text:'Lieux-dits, AOC and commune boundaries, cadastral parcels, buildings, roads, woodland and water. Each one switches on or off.'},
  {target:'#simulate-button',title:'Sun and rain',text:'Watch the sun and shadows move over the hills for any date and hour, or see how a storm’s rain runs off the slopes.'},
  {target:pick('.detail-panel.drawer-open .compare-btn','.detail-panel.mobile-open .compare-btn'),title:'Compare two crus',html:`Open a cru or lieu-dit and press <b>Compare</b> (a parcel’s panel has it too). Then search for the second one, or ${pick('click','tap')} it on the map: it can be anywhere in the region.${art.start}<b>×</b> on a name, or a double-${pick('click','tap')}, picks a different one.`},
  {target:null,title:'Reading a comparison',html:`Switch the two small maps between <b>Parcels</b> (contours and parcels), <b>Geology</b> (the rock map) and <b>Overlay</b> (one laid on the other, downhill pointing down).${art.read}<b>Show both</b> outlines them on the 3D map. <b>Save image</b> keeps the whole comparison as one picture.`},
  {target:pick('.viewer-toolbar .toolbar-actions, .viewer-toolbar .share-link-btn, #share-button','.phone-fab[data-fab=save]'),title:'Share and save',text:pick('Copy link: the address keeps the view, the selection, the shading and any comparison, so it opens the same map for someone else. Save image downloads the map as you see it.','Save the map as an image. Share in any panel sends a link that opens the same view, selection, shading and comparison.')},
  {target:pick('#keyboard-help','.phone-chrome .top-search'),title:'That’s it',all:true,text:pick('Run this tour again from How to use, down here. All features lists everything, with the mouse and keyboard controls.','Run this tour again from ☰ menu → How to use. All features lists everything, with the touch gestures.')}];
 let layer=null,i=0,list=[],openedSheet=false;
 const closeSheet=()=>{if(openedSheet&&document.documentElement.classList.contains('phone-view-open'))document.querySelector('.phone-fab[data-fab=view]')?.click();openedSheet=false;};
 const finish=()=>{closeSheet();layer?.remove();layer=null;document.removeEventListener('keydown',onKey,true);try{localStorage.setItem(KEY,'1');}catch{}};
 const onKey=e=>{if(!layer)return;if(e.key==='Escape'){e.preventDefault();e.stopPropagation();finish();}else if(e.key==='ArrowRight'||e.key==='Enter'){e.preventDefault();e.stopPropagation();next();}else if(e.key==='ArrowLeft'){e.preventDefault();e.stopPropagation();back();}};
 const next=()=>{if(++i>=list.length)finish();else show();};
 const back=()=>{if(i>0){i--;show();}};
 const show=async()=>{const step=list[i],token=Symbol();layer.token=token;
   if(step.sheet&&isPhone()){if(!document.documentElement.classList.contains('phone-view-open')){document.querySelector('.phone-fab[data-fab=view]')?.click();openedSheet=true;await new Promise(r=>setTimeout(r,320));}}else closeSheet();
   if(!layer||layer.token!==token)return;
   const el=step.target?visible(step.target):null,hole=layer.querySelector('.guide-hole'),card=layer.querySelector('.guide-card');
   card.querySelector('.guide-step').textContent=`${i+1} of ${list.length}`;card.querySelector('h3').textContent=step.title;const para=card.querySelector('.guide-body');if(step.html)para.innerHTML=step.html;else para.textContent=step.text;
   card.querySelector('.guide-back').hidden=i===0;card.querySelector('.guide-skip').style.visibility=i===list.length-1?'hidden':'';card.querySelector('.guide-all').hidden=!step.all;card.querySelector('.guide-next').textContent=i===list.length-1?'Start exploring':'Next';
   card.style.cssText='';card.classList.toggle('is-centred',!el);
   if(!el){hole.style.cssText=`left:${innerWidth/2}px;top:${innerHeight/2}px;width:0;height:0`;return;}
   const r=el.getBoundingClientRect(),pad=step.pad??6,box={l:Math.max(4,r.left-pad),t:Math.max(4,r.top-pad),r:Math.min(innerWidth-4,r.right+pad),b:Math.min(innerHeight-4,r.bottom+pad)};
   hole.style.cssText=`left:${box.l}px;top:${box.t}px;width:${box.r-box.l}px;height:${box.b-box.t}px`;
   const h=card.offsetHeight||200,w=card.offsetWidth,below=box.b+12+h<innerHeight-8,above=box.t-12-h>8;
   if(below)card.style.top=`${box.b+12}px`;else if(above)card.style.bottom=`${innerHeight-box.t+12}px`;else card.style.bottom='calc(16px + env(safe-area-inset-bottom))';
   if(!isPhone()){const wide=box.r-box.l>w*1.4,x=wide?(box.l+box.r)/2-w/2:box.l;card.style.left=`${Math.max(16,Math.min(innerWidth-w-16,x))}px`;}};
 const open=()=>{if(layer)return;i=0;list=steps();layer=document.createElement('div');layer.className='phone-guide tour';layer.setAttribute('role','dialog');layer.setAttribute('aria-label','How to use the atlas');
   layer.innerHTML='<div class="guide-hole"></div><div class="guide-card"><span class="guide-step"></span><h3></h3><div class="guide-body"></div><div class="guide-actions"><button type="button" class="guide-skip">Skip</button><span class="guide-right"><button type="button" class="guide-all" hidden>All features</button><button type="button" class="guide-back">Back</button><button type="button" class="guide-next">Next</button></span></div></div>';
   document.body.append(layer);layer.querySelector('.guide-skip').addEventListener('click',finish);layer.querySelector('.guide-next').addEventListener('click',next);layer.querySelector('.guide-back').addEventListener('click',back);
   layer.querySelector('.guide-all').addEventListener('click',()=>{finish();window.atlasHelp?.open();});document.addEventListener('keydown',onKey,true);show();};
 window.atlasGuide={open};
 // "How to use" in the phone drawer's foot
 const foot=document.querySelector('.sidebar-foot');if(foot){const b=document.createElement('button');b.type='button';b.className='phone-guide-link';b.textContent='How to use';b.addEventListener('click',()=>{document.querySelector('.sidebar')?.classList.remove('is-open');setTimeout(open,250);});foot.append(b);}
 let seen=false;try{seen=localStorage.getItem(KEY)==='1';}catch{}
 if(!seen){const wait=()=>{if(!document.querySelector('#loading')?.hidden||!document.querySelector('#terrain-canvas')){setTimeout(wait,400);return;}setTimeout(open,900);};wait();}}
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
async function selectCru(cru){if(compare&&!compare.flying&&(compare.picking||compare.repick)){setCompareFromCru(cru);return;}
  const village=cru&&index.villages.find(v=>v.id===cru.village);if(!village)return;
  $('.sidebar').classList.remove('is-open');// on phones the index covers the map
  if(selected?.id!==village.id)await selectVillage(village);
  await renderer.whenSceneReady?.(); // the scene's features are added over a few frames
  const layer=cru.layer||'parcels',item=renderer.featureIndex?.find(it=>it.key===layer&&String((it.feature?.properties||it.feature)?.id)===String(cru.id));
  if(!item)return;
  renderer.focusFeature(item.feature);renderer.selectFeature(item.feature,layer);
  requestAnimationFrame(()=>requestAnimationFrame(()=>showBestView(item.feature,layer)));/* after the info panel opens, so the cru is centred in what is left visible */
}
// A region page (e.g. /rhone/) declares <meta name="atlas-region" content="data/region.json">: its classes,
// browsing groups and name replace the Burgundy defaults before the atlas starts.
async function applyRegion(){
  const meta=document.querySelector('meta[name="atlas-region"]');if(!meta)return;
  await loadRegion(new URL(meta.content,location.href));
  document.documentElement.toggleAttribute('data-no-owners',REGION.owners===false);/* no owner register in this region */
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
  const helpModal=$('#keyboard-help-popover'),helpButton=$('#keyboard-help');renderHelp(helpModal);const closeHelp=()=>{if(helpModal.hidden)return;helpModal.hidden=true;helpButton?.focus();};
  const openHelp=()=>{helpModal.hidden=false;$('#keyboard-help-close').focus();};window.atlasHelp={open:openHelp};
  helpButton?.addEventListener('click',()=>window.atlasGuide?window.atlasGuide.open():openHelp());$('#keyboard-help-close')?.addEventListener('click',closeHelp);
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
  const mosaicOptions={maxLoadedScenes:12,gridSize:257,coverage:1.8,minHalfSize:REGION.closeViewHalfSize||3000,detailTiles:photoTileIndex};/* a smaller close view and the sharp tiles only where the region has them */
  mosaic=new SceneMosaic({index,loadScene,textureManifest,textureBase:new URL('./',location.href).href,backgroundSources:contextTerrain,boundaries:communeBoundaries,cacheLimit:0,preferAvif:useAvif,...mosaicOptions});
  useMosaicWorker(mosaic,{index,textureManifest,options:mosaicOptions});
  renderer=new AtlasRenderer({canvas:$('#terrain-canvas'),container:$('#canvas-stage'),labels:$('#map-labels'),labelObstacles,progressiveBuild:true,onViewChange:view=>{streamView(view);scheduleShareSync();},onSelect:(feature,layer,provenance)=>{const p=feature?.properties||feature||{};const classification=p.classification||p.category;const title=p.name||p.nom||'Lieu-dit';const source=layer==='parcels'?'INAO':(layer==='climats'||layer==='climat')?'DGFiP / Etalab':layer==='buildings'||layer==='roads'||layer==='forest'?'IGN BD TOPO':'Atlas source';showFeatureFacts(feature,layer,provenance);},onError:(e)=>debug.resourceErrors.push(String(e))});
  if(photoTileIndex&&!matchMedia('(pointer:coarse)').matches&&(renderer.renderer?.capabilities?.maxTextureSize||0)>=4096)renderer.maxRaster=4096;/* desktop: the composed photo at 4096 px, so 0.5 m tiles show */
  renderer.setCommuneBoundaries?.(communeBoundaries);
  if(/[?&]debug\b/.test(location.search))debug.renderer=renderer;
  document.querySelectorAll('.interaction-mode').forEach(button=>button.addEventListener('click',()=>{interactionMode=button.dataset.interaction==='pan'?'pan':'rotate';document.querySelectorAll('.interaction-mode').forEach(item=>{const active=item.dataset.interaction===interactionMode;item.classList.toggle('is-active',active);item.setAttribute('aria-pressed',String(active));});renderer.setInteraction?.(interactionMode);updateInteractionHint();}));
  // Touch screens: one finger drags the map by default, as in map apps (two-finger twist rotates).
  if(matchMedia('(pointer: coarse)').matches)document.querySelector('.interaction-mode[data-interaction="pan"]')?.click();
  renderer.setInteraction?.(interactionMode);
  const aocOpacity=$('#aoc-opacity'),aocOutput=$('#aoc-opacity-value');if(aocOpacity){const syncAocOpacity=()=>{const percent=Math.max(0,Math.min(100,Number(aocOpacity.value)||0));if(aocOutput)aocOutput.textContent=`${percent}%`;renderer.setAocOpacity?.(percent/100);};aocOpacity.addEventListener('input',syncAocOpacity);aocOpacity.addEventListener('change',syncAocOpacity);syncAocOpacity();}
  regionalNavigator=buildRegionalNav();renderList();const panelToggle=$('#panel-toggle');if(panelToggle)panelToggle.addEventListener('click',()=>{const panel=document.querySelector('.sidebar');if(matchMedia('(min-width:761px)').matches){const p=window.atlasDrawers?.left;if(p){syncPin(p.pin,false);p.closeNow();}panel.classList.remove('is-collapsed');syncPanelToggle(panelToggle,false);}else{panel.classList.remove('is-open','is-collapsed','drawer-open');syncPanelToggle(panelToggle,false);}});const linkParams=hashParts().params;shareRestoring=[...linkParams.keys()].length>0;
  Promise.resolve(selectVillage(villageFromHash()||index.villages.find(v=>/vosne/i.test(v.name))||index.villages[0],{history:'replace'})).then(()=>applyShare(linkParams));
  window.addEventListener('hashchange',async()=>{const {params}=hashParts(),v=villageFromHash();if(v&&v.id!==selected?.id){shareRestoring=[...params.keys()].length>0;await selectVillage(v,{history:'none'});}applyShare(params);});
  setupShareButtons();
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
// ---- Compare two crus ----
// "Compare" on a lieu-dit or AOC area makes it A; the next lieu-dit or AOC area picked on the map, in search or on the
// navigator becomes B, wherever it is in the region (B's facts load from its own village files; the map does not move).
// A and B chips fly the camera to each. Owners are the legal entities in the DGFiP register whose parcels lie in the
// cru (data/ownership/owner-crus.json.gz), with each parcel's recorded cadastral area.
let compare=null;
const fprops=f=>f?.properties||f||{};
const sameSide=(s,feature,layer)=>s&&s.layer===layer&&String(s.id)===String(fprops(feature).id);
function openInfoPanel(feature){const mobile=matchMedia('(max-width:760px)').matches;if(mobile){$('.detail-panel')?.classList.add('mobile-open');openSheet(feature);}else $('.detail-panel')?.classList.add('drawer-open');window.atlasDrawers?.right?.open();}
async function compareSide(feature,layer,provenance,villageHint){
  const p=fprops(feature),nested=p.facts||{},factsKey=provenance?.factsKey||p.factsKey||nested.factsKey||nested.key;
  const villageId=provenance?.factsVillageId||p.factsVillageId||provenance?.sourceVillageId||villageHint||terroirVillage(feature,layer);
  const payload=factsKey&&villageId?await loadFeatureFacts(villageId):null,cand=factsKey?(payload?.features||[]).filter(r=>r.key===factsKey):[],meta=cand.length===1?cand[0]:null;
  const facts=mergeFeatureFacts(feature,meta),identity=featureIdentity(facts,layer),area=featureArea(facts);
  const [terroir,geo]=await Promise.all([terroirFacts(feature,layer),Promise.all([loadGeologyLegend(),loadGeologyFeatures(terroirVillage(feature,layer))]).then(([L,d])=>(d?.features?.[`${layer}:${p.id}`]||[]).filter(([u])=>L?.units?.[u]))]);
  const village=Array.isArray(facts.featureCommunes)?facts.featureCommunes.join(' / '):featureVillage(p.insee||p.communeCode||String(p.id||'').split(':')[0])||index.villages.find(v=>v.id===villageId)?.name||'';
  return {feature,layer,id:p.id,villageId,name:displayPlaceName(p.displayName||p.name||p.nom||meta?.name||'Mapped place'),village,tier:identity.tier,area:area?.value,terroir,geo,owners:undefined};}
const cadastreAreaCache=new Map();
function cadastreAreas(code){if(!cadastreAreaCache.has(code))cadastreAreaCache.set(code,fetchScene(dataUrl(`./data/cadastre/${code}.json.gz`)).then(c=>{const m=new Map();for(const f of (c?.parcels||c?.features||[])){const q=fprops(f);if(q.id)m.set(q.id,Number(q.cadastralAreaM2)||Number(q.mappedAreaM2)||0);}return m;}).catch(()=>new Map()));return cadastreAreaCache.get(code);}
let ownersByParcel=null;
async function parcelOwners(){if(ownersByParcel)return ownersByParcel;const list=await loadOwners(),m=new Map();(list||[]).forEach((o,i)=>{for(const ids of Object.values(o.communes||{}))for(const id of String(ids).split(','))if(id){let a=m.get(id);if(!a)m.set(id,a=[]);a.push(i);}});return ownersByParcel=m;}
async function compareOwners(side){await loadOwnerCrus();const oc=ownerCrus;if(!oc?.parcels)return null;
  const ids=Object.entries(oc.parcels).filter(([,v])=>side.layer==='parcels'?String(v[0])===String(side.id):String(v[1])===String(side.id)).map(([k])=>k);
  if(!ids.length)return {total:0,entities:[]};
  const [byParcel,list]=await Promise.all([parcelOwners(),loadOwners()]),areas=new Map();
  for(const code of [...new Set(ids.map(id=>id.slice(0,5)))]){const m=await cadastreAreas(code);for(const id of ids)if(id.startsWith(code)&&m.has(id))areas.set(id,m.get(id));}
  const per=new Map();let total=0;for(const id of ids){const a=areas.get(id)||0;total+=a;for(const i of byParcel.get(id)||[]){const e=per.get(i)||{o:list[i],area:0,parcels:0};e.area+=a;e.parcels++;per.set(i,e);}}
  return {total,entities:[...per.values()].sort((x,y)=>y.area-x.area||x.o.name.localeCompare(y.o.name))};}
async function startCompare(feature,layer,provenance){loadCruIndex();closeSunAndRain();const a=await compareSide(feature,layer,provenance);compare={a,b:null,picking:true,flying:false,expanded:{},viewing:'a'};renderCompare();openInfoPanel(feature);requestAnimationFrame(()=>requestAnimationFrame(()=>showBestView(feature,layer,a.terroir)));scheduleShareSync();loadSideOwners(a);}
async function setCompareB(feature,layer,provenance,villageHint){return setCompareSide(compare?.repick||'b',feature,layer,provenance,villageHint);}
async function setCompareSide(slot,feature,layer,provenance,villageHint){if(!compare||!feature)return;renderer?.setCompareOutlines?.([]);const other=slot==='a'?compare.b:compare.a;if(sameSide(other,feature,layer)||sameSide(compare[slot],feature,layer)){compare.repick=null;renderCompare();return;}
  const token=Symbol();compare.pending=token;compare.picking=false;compare.repick=null;compare.viewing=null;compare[slot]={name:displayPlaceName(fprops(feature).displayName||fprops(feature).name||''),loading:true};renderCompare();
  const side=await compareSide(feature,layer,provenance,villageHint);if(!compare||compare.pending!==token)return;compare[slot]=side;compare.expanded={};compare.geom=null;renderCompare();scheduleShareSync();loadSideOwners(side);}
async function loadSideOwners(side){const o=await compareOwners(side).catch(()=>null);side.owners=o;if(compare?.b&&!compare.b.loading&&!compare.a.loading&&!compare.repick&&(compare.a===side||compare.b===side))renderCompare();/* owners show only once B is chosen; no redraw while B is being typed */}
async function sideFromRef(ref){const m=/^(climats|parcels):(.+)@(.+)$/.exec(ref||'');if(!m)return null;const [,layer,id,villageId]=m,v=index.villages.find(x=>x.id===villageId);if(!v)return null;const scene=await loadScene(v);const feature=(layer==='climats'?scene.climats:scene.parcels||[]).find(f=>String(fprops(f).id)===String(id));return feature?{feature,layer,villageId}:null;}
async function setCompareFromCru(cru){const r=await sideFromRef(`${cru.layer||'parcels'}:${cru.id}@${cru.village}`);window.atlasSearchDrop?.close();if(r)setCompareB(r.feature,r.layer,{factsVillageId:r.villageId},r.villageId);}
async function restoreCompare(cmp,view){const [ra,rb]=String(cmp).split(',');const A=await sideFromRef(ra),B=await sideFromRef(rb);if(!A||!B)return;const a=await compareSide(A.feature,A.layer,{factsVillageId:A.villageId},A.villageId),b=await compareSide(B.feature,B.layer,{factsVillageId:B.villageId},B.villageId);compare={a,b,picking:false,flying:false,expanded:{},mapView:CMP_VIEWS.some(([k])=>k===view)?view:'parcels',viewing:selected?.id===b.villageId&&selected?.id!==a.villageId?'b':'a'};closeSunAndRain();renderCompare();openInfoPanel(A.feature);loadSideOwners(a);loadSideOwners(b);}
function endCompare(rerender=true){if(!compare)return;const a=(compare.viewing==='b'&&compare.b?.feature?compare.b:compare.a);/* Done keeps the cru the map is showing */compare=null;renderer?.setCompareOutlines?.([]);$('.detail-panel')?.classList.remove('is-compare');$('#feature-card')?.classList.remove('is-compare');scheduleShareSync();if(rerender&&a?.feature){const item=renderer?.featureIndex?.find(it=>it.key===a.layer&&String(fprops(it.feature).id)===String(a.id));if(item)renderer.selectFeature(item.feature,a.layer);else showFeatureFacts(a.feature,a.layer,{factsVillageId:a.villageId});}}
function compareIntercept(feature,layer,provenance){
  if(!feature){renderCompare();return true;}
  if(!compare.picking&&!compare.repick&&!compare.flying){renderCompare();return true;}/* both crus chosen: clicks on the map no longer replace them (use × or double-click on a chip) *//* a scene change or an empty click keeps the comparison; Done or closing the panel ends it */
  if(layer==='cadastre'){const host=cruUnderParcel(provenance);if(!host){endCompare(false);return false;}feature=host.feature;layer=host.layer;provenance={};}/* a parcel stands for the grand or premier cru (else the lieu-dit) it lies in */
  if(layer!=='climats'&&layer!=='parcels')return false;
  selectedFeature={feature,layer,provenance};
  if(compare.flying)return true;
  if(sameSide(compare.a,feature,layer)||sameSide(compare.b,feature,layer)){renderCompare();openInfoPanel(feature);return true;}
  setCompareB(feature,layer,provenance);openInfoPanel(feature);return true;}
// The grand or premier cru (smallest one, if several overlap) under a cadastral parcel's centre, else its lieu-dit.
function cruUnderParcel(prov){const ring=prov?.parcelRing;if(!ring?.length||!renderer)return null;const c=[ring.reduce((a,q)=>a+q[0],0)/ring.length,ring.reduce((a,q)=>a+q[1],0)/ring.length];
  const crus=new Map((cruIndex||[]).map(x=>[String(x.id),x]));let best=null;
  for(const it of renderer.featureIndex||[]){if(it.key!=='parcels'||!it.ring||(it.bounds&&(c[0]<it.bounds[0]||c[0]>it.bounds[2]||c[1]<it.bounds[1]||c[1]>it.bounds[3])))continue;if(!renderer.inside(c,it.ring)||(it.holes||[]).some(h=>renderer.inside(c,h)))continue;const cr=crus.get(String(fprops(it.feature).id));if(!cr||!['grand-cru','premier-cru'].includes(cr.class))continue;const area=it.bounds?(it.bounds[2]-it.bounds[0])*(it.bounds[3]-it.bounds[1]):Infinity;if(!best||area<best.area)best={feature:it.feature,layer:'parcels',area};}
  if(best)return best;const place=prov.placeFeature;return place?{feature:place,layer:'climats'}:null;}
// The part of the map the user can actually see: on desktop the info panel covers the right; on a phone the info
// sheet covers the bottom, the search pill the top and the round buttons the right edge.
function visibleMapRect(){const canvas=$('#terrain-canvas');if(!canvas)return null;const cr=canvas.getBoundingClientRect(),panel=$('.detail-panel'),phone=document.documentElement.classList.contains('phone-ui');
  let left=cr.left,right=cr.right,top=cr.top,bottom=cr.bottom;
  if(panel){const pr=panel.getBoundingClientRect();
    if(!phone&&panel.classList.contains('drawer-open')&&pr.width>0&&pr.left<right&&pr.left>left+cr.width/3)right=pr.left;
    if(phone&&panel.classList.contains('mobile-open')&&pr.height>0&&pr.top>top+60&&pr.top<bottom)bottom=pr.top;}
  if(phone){const pill=$('.phone-chrome .top-search')?.getBoundingClientRect();if(pill&&pill.bottom>top&&pill.bottom<top+cr.height/3)top=pill.bottom+6;const fabs=$('.phone-fabs')?.getBoundingClientRect();if(fabs&&fabs.width>0&&fabs.left>left+cr.width/2)right=Math.min(right,fabs.left-4);}
  return {cr,left,right,top,bottom,width:Math.max(1,right-left),height:Math.max(1,bottom-top)};}
// Moves the camera so the point at the centre of the screen appears at the centre of the visible map instead.
function centreInVisible(){const vr=visibleMapRect();if(!renderer||!vr)return;const {cr}=vr,dx=(cr.left+cr.right)/2-(vr.left+vr.right)/2,dy=(cr.top+cr.bottom)/2-(vr.top+vr.bottom)/2;if(Math.abs(dx)<20&&Math.abs(dy)<20)return;
  const v=renderer.captureView();if(!v||!Number.isFinite(v.radiusMetres))return;const d=v.direction||[.7,.62,.7],len=Math.hypot(d[0],d[2])||1,mpp=2*v.radiusMetres*Math.tan(21*Math.PI/180)/Math.max(1,cr.height),sinEl=Math.max(.25,Math.min(1,d[1]));
  /* screen-right and towards-the-camera on the ground, as metres east/north (world z points south) */const right=[d[2]/len,d[0]/len],toward=[d[0]/len,-d[2]/len];
  const sx=dx*mpp,sy=dy*mpp/sinEl;if(renderer.restoreView({...v,easting:v.easting+right[0]*sx+toward[0]*sy,northing:v.northing+right[1]*sx+toward[1]*sy}))renderer.scheduleViewChange?.();}
// The best view of a cru: a three-quarter view up its slope. The camera stands 25° round from straight downhill (so
// the slope is seen at an angle and its relief reads, not flattened head-on), 35° above the horizon, at the distance
// that fits the cru in the visible map. Nearly flat ground keeps the current heading.
const BEST_VIEW={offsetDeg:25,elevationDeg:35,fill:1.35};
function bestViewFor(feature,terroir){const rings=outlineRings(feature);if(!rings.length||!renderer)return null;const b=ringsBounds(rings),v=renderer.captureView();if(!v)return null;
  const span=Math.max(b[2]-b[0],b[3]-b[1],120),vr=visibleMapRect(),shrink=vr?Math.max(1,vr.cr.height/Math.min(vr.width,vr.height*1.3)):1,phone=document.documentElement.classList.contains('phone-ui'),radius=Math.max(350,Math.min(phone?2200:9000,span/(2*Math.tan(21*Math.PI/180))*(phone?1.12:BEST_VIEW.fill)*shrink));/* phones: a tighter fit and a cap, so fewer photo tiles are loaded */
  const el=BEST_VIEW.elevationDeg*Math.PI/180,up=Math.sin(el),flat=Math.cos(el);let az;
  if(terroir&&Number.isFinite(terroir.aspectDeg)&&terroir.slopePct>=2)az=(terroir.aspectDeg+BEST_VIEW.offsetDeg)*Math.PI/180;else{const d=v.direction||[.7,.62,.7];az=Math.atan2(d[0],-d[2]);}
  return {...v,easting:(b[0]+b[2])/2,northing:(b[1]+b[3])/2,radiusMetres:radius,direction:[Math.sin(az)*flat,up,-Math.cos(az)*flat]};/* world x = east, z = south */}
async function showBestView(feature,layer,terroir){const t=terroir||await terroirFacts(feature,layer).catch(()=>null);if(document.documentElement.classList.contains('phone-ui'))await new Promise(r=>setTimeout(r,320));/* let the sheet settle */const view=bestViewFor(feature,t);if(!view)return;if(renderer.restoreView(view))renderer.scheduleViewChange?.();centreInVisible();}
// The comparison panel is wide: a cru already on screen is moved to the middle of the part of the map left visible.
function centreFeatureInVisible(feature,terroir){const rings=outlineRings(feature);if(!rings.length||!renderer)return;const b=ringsBounds(rings),v=renderer.captureView();if(!v)return;
  if(renderer.restoreView({...v,easting:(b[0]+b[2])/2,northing:(b[1]+b[3])/2,direction:slopeFacing(v.direction,terroir)}))renderer.scheduleViewChange?.();centreInVisible();}
// The camera stands downhill of a cru and looks up its slope (aspect = the downhill direction), keeping its tilt.
// Nearly flat ground keeps the current heading.
function slopeFacing(dir,terroir){if(!terroir||!Number.isFinite(terroir.aspectDeg)||!(terroir.slopePct>=2))return dir;const d=dir||[.7,.62,.7],up=Math.max(.35,Math.min(.85,d[1])),flat=Math.sqrt(1-up*up),a=terroir.aspectDeg*Math.PI/180;
  return [Math.sin(a)*flat,up,-Math.cos(a)*flat];/* world x = east, z = south */}
// Sun & rain is hidden while comparing (its bar would sit under the panel); an open simulation is closed first.
function closeSunAndRain(){const bar=document.querySelector('.sim-bar');if(bar&&!bar.hidden)bar.querySelector('.sim-close')?.click();}
async function flyToSide(side){if(!side?.feature||!compare)return;compare.viewing=side===compare.b?'b':'a';compare.flying=true;try{const v=index.villages.find(x=>x.id===side.villageId);if(v&&selected?.id!==v.id&&!renderer?.featureIndex?.some(it=>it.key===side.layer&&String(fprops(it.feature).id)===String(side.id)))await selectVillage(v);await renderer?.whenSceneReady?.();const item=await waitForFeature(side.layer,side.id,8000);if(item){renderer.selectFeature(item.feature,side.layer);await showBestView(item.feature,side.layer,side.terroir);}}finally{if(compare){compare.flying=false;renderCompare();openInfoPanel(side.feature);}}}
function addCompareButton(host,feature,layer,provenance){if(!host||compare||(layer!=='climats'&&layer!=='parcels')||host.querySelector('.compare-btn'))return;const b=document.createElement('button');b.type='button';b.className='share-link-btn compare-btn';b.title='Compare this with another lieu-dit or cru';b.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4v16M16 4v16M4 8h4M16 16h4"/></svg><span class="share-label">Compare</span>';b.addEventListener('click',e=>{e.stopPropagation();startCompare(feature,layer,provenance);});factActions(host).append(b);}
const haText=m2=>m2==null||!Number.isFinite(Number(m2))?'—':`${(Number(m2)/10000).toLocaleString('en',{maximumFractionDigits:Number(m2)>=100000?1:2})} ha`;
function compareRow(label,a,b){return `<div class="cmp-row"><span class="cmp-k">${label}</span><div class="cmp-v cmp-va">${a}</div><div class="cmp-v cmp-vb">${b}</div></div>`;}
function cmpBar(v,max,k){return Number.isFinite(v)&&max>0?`<i class="cmp-bar"><b class="cmp-fill-${k}" style="width:${Math.max(4,Math.round(v/max*100))}%"></b></i>`:'';}
function geoCell(side){const L=geologyLegendData;if(!side.geo?.length||!L)return '<span class="cmp-s">Not mapped</span>';const tot=side.geo.reduce((a,[,p])=>a+p,0)||1;return `<i class="cmp-geo">${side.geo.map(([u,pc])=>`<b style="flex:${pc/tot};background:${esc(L.units[u].colour)}"></b>`).join('')}</i><span class="cmp-s">${side.geo.map(([u,pc])=>`${esc(geologyName(L.units[u]).split(',')[0])} ${pc}%`).join(' · ')}</span>`;}
function ownersCell(side,other,k){const o=side.owners;if(o===undefined)return '<span class="cmp-s">Loading owners…</span>';if(!o)return '<span class="cmp-s">Owner data unavailable</span>';if(!o.entities.length)return '<span class="cmp-s">No legal-entity owner recorded</span>';
  const otherIds=new Set((other?.owners?.entities||[]).map(e=>e.o.siren||e.o.name)),open=compare.expanded[k],shown=open?o.entities:o.entities.slice(0,4);
  return `<span class="cmp-s">${o.entities.length} ${o.entities.length===1?'entity':'entities'} · ${haText(o.total)}${side.area?` of ${haText(side.area)}`:''}</span><ul class="cmp-owners">${shown.map(e=>`<li><span>${esc(displayEntityName(e.o.name))}${otherIds.has(e.o.siren||e.o.name)?'<em class="cmp-both">both</em>':''}</span><span>${haText(e.area)}</span></li>`).join('')}</ul>${o.entities.length>4?`<button type="button" class="cmp-more" data-k="${k}">${open?'Show fewer':`+ ${o.entities.length-4} more`}</button>`:''}`;}
function renderCompare(){const card=$('#feature-card');if(!card||!compare)return;card.classList.add('feature-summary','is-compare');$('.detail-panel')?.classList.add('is-compare');const A=compare.a,B=compare.b;
  const picker=k=>`<label class="cmp-chip cmp-chip-${k} is-empty"><b>${k.toUpperCase()}</b><input class="cmp-b-input" type="search" placeholder="${k==='b'&&!B?'Search a cru, or click the map':'Search a cru, or click the map'}" autocomplete="off" aria-label="Search a cru for ${k.toUpperCase()}, or click a lieu-dit on the map"></label>`;
  const chip=(s,k)=>compare.repick===k||(k==='b'&&!s)?picker(k):`<button type="button" class="cmp-chip cmp-chip-${k}" data-fly="${k}" title="Click: show ${esc(s.name)} on the map. Double-click: change it"><b>${k.toUpperCase()}</b><span>${esc(s.name)}</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0 1 13 0c0 4.8-6.5 11-6.5 11Z"/><circle cx="12" cy="10" r="2.2"/></svg><i class="cmp-x" data-clear="${k}" role="button" tabindex="0" aria-label="Remove ${esc(s.name)} and pick another" title="Remove and pick another">×</i></button>`;
  const ready=B&&!B.loading&&!A.loading,far=compareFar();
  const actions=ready?`<div class="cmp-actions"><button type="button" class="cmp-act cmp-both-btn" title="${far?'Too far apart to frame together: go to the other cru':'Show A and B together on the 3D map'}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0 1 13 0c0 4.8-6.5 11-6.5 11Z"/><circle cx="12" cy="10" r="2.2"/></svg>${far?`Show ${compare.viewing==='b'?'A':'B'}`:'Show both'}</button><button type="button" class="cmp-act cmp-swap" title="Swap A and B"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h11l-3-3M17 17H6l3 3"/></svg>Swap</button><span class="cmp-act-gap"></span></div>`:'';
  let html=`<header class="cmp-head"><div class="cmp-title"><h3>Compare</h3><button type="button" class="cmp-close">Done</button></div><div class="cmp-chips">${chip(A,'a')}${chip(B,'b')}</div>${!B||compare.repick?'<ul class="cmp-results" role="listbox" hidden></ul>':''}${actions}</header>`;
  if((B&&B.loading)||A.loading){html+='<p class="cmp-s cmp-loading">Loading…</p>';}
  else if(B){const ta=A.terroir,tb=B.terroir,maxA=Math.max(A.area||0,B.area||0),maxS=Math.max(ta?.sunHours||0,tb?.sunHours||0);
    const elev=t=>t?`<strong>${Math.round(t.elevation.min)}–${Math.round(t.elevation.max)} m</strong><span class="cmp-s">average ${Math.round(t.elevation.mean)} m</span>`:'<span class="cmp-s">—</span>';
    const slope=t=>t?`<strong>${t.slopePct.toLocaleString('en',{maximumFractionDigits:1})}%</strong><span class="cmp-s">steepest ${Math.round(t.slopeMaxPct)}%</span>`:'<span class="cmp-s">—</span>';
    const faces=t=>t?`<strong class="cmp-face">${compassIcon(t.aspectDeg)}${esc(ASPECT_WORDS[t.aspect]||t.aspect)}</strong><span class="cmp-s">${t.aspectDeg}°</span>`:'<span class="cmp-s">—</span>';
    const sun=(t,k)=>t?`<strong>${t.sunHours.toLocaleString('en')} h</strong>${cmpBar(t.sunHours,maxS,k)}`:'<span class="cmp-s">—</span>';
    html+=compare.shapes?.key===compareKey()?compareFiguresHtml():compareShapes(A,B);
    html+=`<div class="cmp-grid">${compareRow('',`<span class="cmp-s">${esc(A.tier||'')}${A.village?` · ${esc(A.village)}`:''}</span>`,`<span class="cmp-s">${esc(B.tier||'')}${B.village?` · ${esc(B.village)}`:''}</span>`)}
      ${compareRow('Area',`<strong>${haText(A.area)}</strong>${cmpBar(A.area,maxA,'a')}`,`<strong>${haText(B.area)}</strong>${cmpBar(B.area,maxA,'b')}`)}
      ${compareRow('Elevation',elev(ta),elev(tb))}${compareRow('Slope',slope(ta),slope(tb))}${compareRow('Faces',faces(ta),faces(tb))}
      ${compareRow('Direct sun<br><small>Apr–Sep</small>',sun(ta,'a'),sun(tb,'b'))}${compareRow('Geology',geoCell(A),geoCell(B))}
      ${compareRow('Owners<br><small>legal entities</small>',ownersCell(A,B,'a'),ownersCell(B,A,'b'))}</div>`;}
  card.innerHTML=html;
  card.querySelectorAll('[data-fly]').forEach(b=>{let t=0;b.addEventListener('click',()=>{clearTimeout(t);t=setTimeout(()=>flyToSide(compare[b.dataset.fly]),260);});b.addEventListener('dblclick',e=>{e.preventDefault();clearTimeout(t);compare.repick=b.dataset.fly;renderCompare();});
    const x=b.querySelector('.cmp-x');if(x){const clear=e=>{e.preventDefault();e.stopPropagation();clearTimeout(t);compare.repick=x.dataset.clear;renderCompare();};x.addEventListener('click',clear);x.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' ')clear(e);});}});
  card.querySelector('.cmp-close')?.addEventListener('click',()=>endCompare(true));
  card.querySelector('.cmp-both-btn')?.addEventListener('click',()=>showBoth());
  card.querySelector('.cmp-swap')?.addEventListener('click',()=>{[compare.a,compare.b]=[compare.b,compare.a];compare.expanded={};renderCompare();scheduleShareSync();});
  card.querySelectorAll('.cmp-more').forEach(b=>b.addEventListener('click',()=>{compare.expanded[b.dataset.k]=!compare.expanded[b.dataset.k];renderCompare();}));
  setupComparePicker(card);bindCompareFigures(card);
  if(B&&!B.loading&&compare.shapes?.key!==compareKey())buildCompareMaps();
  const row=card.querySelector('.cmp-actions');if(row){addShareButton(row);addCompareSaveButton(row);row.querySelectorAll('.share-link-btn').forEach(b=>b.classList.add('cmp-act'));}}
// B's own picker: type to search every grand and premier cru in the region (not limited by the region filter), or
// click a lieu-dit or AOC area on the map. Only the result list redraws while typing, so the field keeps focus.
function setupComparePicker(card){const input=card.querySelector('.cmp-b-input'),list=card.querySelector('.cmp-results');if(!input||!list)return;let hits=[];
  const draw=async()=>{const q=fold(input.value).replace(/[^a-z0-9]+/g,'');if(q.length<2){list.hidden=true;list.innerHTML='';hits=[];return;}await loadCruIndex();
    const seen=new Map();for(const c of cruIndex||[]){if(!c.key.includes(q)||String(c.id)===String(compare?.a?.id)||String(c.id)===String(compare?.b?.id))continue;const k=`${c.layer||'parcels'}:${c.id}`;const g=seen.get(k);if(g){g.villages.push(c.village);continue;}seen.set(k,{...c,villages:[c.village]});}
    hits=[...seen.values()].sort((a,b)=>(b.start.startsWith(q)-a.start.startsWith(q))||((b.class==='grand-cru')-(a.class==='grand-cru'))||a.name.localeCompare(b.name,'fr')).slice(0,8);
    list.innerHTML=hits.length?hits.map((c,i)=>`<li><button type="button" role="option" data-i="${i}"><strong>${esc(c.name)}</strong><small>${c.class==='grand-cru'?'Grand Cru':c.class==='premier-cru'?'Premier Cru':''}${c.class?' · ':''}${esc(c.villages.map(v=>index.villages.find(x=>x.id===v)?.name||v).join(' / '))}</small></button></li>`).join(''):'<li class="cmp-none">No cru with that name. You can also click a lieu-dit on the map.</li>';list.hidden=false;
    list.querySelectorAll('button[data-i]').forEach(b=>b.addEventListener('click',()=>setCompareFromCru(hits[Number(b.dataset.i)])));};
  input.addEventListener('input',draw);
  input.addEventListener('keydown',e=>{if(e.key==='Enter'&&hits[0]){e.preventDefault();setCompareFromCru(hits[0]);}else if(e.key==='Escape'){e.preventDefault();e.stopPropagation();e.stopImmediatePropagation();if(compare?.repick){compare.repick=null;renderCompare();return;}input.value='';draw();}});/* Esc cancels the pick only, it does not close the panel */
  if(compare?.repick||!document.documentElement.classList.contains('phone-ui'))setTimeout(()=>input.focus({preventScroll:true}),50);}
// A and B drawn side by side at one scale, from their own outlines (EPSG:2154 metres), so size and shape compare at a
// glance even when the crus are far apart. North is up in both; the arrow points downhill (the aspect).
function outlineRings(feature){const out=[],visit=v=>{if(!Array.isArray(v)||!v.length)return;if(typeof v[0]?.[0]==='number'){if(v.length>2)out.push(v);return;}v.forEach(visit);};visit(fprops(feature).rings||feature?.rings||feature?.geometry?.coordinates);return out;}
function niceLength(m){const steps=[50,100,200,250,500,1000,2000,5000];return steps.reduce((best,x)=>Math.abs(x-m)<Math.abs(best-m)?x:best,steps[0]);}
function compareShapes(A,B){const sides=[[A,'a'],[B,'b']].map(([side,k])=>{const rings=outlineRings(side.feature);if(!rings.length)return null;let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;for(const r of rings)for(const [x,y] of r){if(x<x0)x0=x;if(x>x1)x1=x;if(y<y0)y0=y;if(y>y1)y1=y;}return {side,k,rings,x0,y0,x1,y1,w:x1-x0,h:y1-y0};});
  if(sides.some(v=>!v))return '';
  const W=240,H=150,PAD=18,scale=Math.min(...sides.map(v=>Math.min((W-PAD*2)/Math.max(v.w,1),(H-PAD*2-14)/Math.max(v.h,1))));
  const bar=niceLength((W*.32)/scale),barPx=bar*scale;
  const panel=v=>{const ox=(W-v.w*scale)/2-v.x0*scale,oy=(H-14+v.h*scale)/2+v.y0*scale;const d=v.rings.map(r=>r.map(([x,y],i)=>`${i?'L':'M'}${(ox+x*scale).toFixed(1)} ${(oy-y*scale).toFixed(1)}`).join('')+'Z').join('');
    const t=v.side.terroir,cx=W/2,cy=(H-14)/2;let arrow='';
    if(t&&Number.isFinite(t.aspectDeg)&&t.slopePct>=2){const a=t.aspectDeg*Math.PI/180,len=Math.min(34,Math.max(18,Math.min(v.w,v.h)*scale*.35)),dx=Math.sin(a)*len,dy=-Math.cos(a)*len,hx=cx+dx/2,hy=cy+dy/2,tx=cx-dx/2,ty=cy-dy/2,ang=Math.atan2(dy,dx),hl=7;
      arrow=`<path class="cmp-shape-arrow" d="M${tx.toFixed(1)} ${ty.toFixed(1)}L${hx.toFixed(1)} ${hy.toFixed(1)}M${hx.toFixed(1)} ${hy.toFixed(1)}L${(hx-hl*Math.cos(ang-.5)).toFixed(1)} ${(hy-hl*Math.sin(ang-.5)).toFixed(1)}M${hx.toFixed(1)} ${hy.toFixed(1)}L${(hx-hl*Math.cos(ang+.5)).toFixed(1)} ${(hy-hl*Math.sin(ang+.5)).toFixed(1)}"/>`;}
    return `<svg class="cmp-shape cmp-shape-${v.k}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(v.side.name)} outline, ${haText(v.side.area)}"><path class="cmp-shape-fill" d="${d}" fill-rule="evenodd"/>${arrow}<g class="cmp-shape-north" transform="translate(${W-14} 16)"><path d="M0 7V-6M0-8l-3.5 5M0-8l3.5 5"/><text y="17" text-anchor="middle">N</text></g><g class="cmp-shape-scale" transform="translate(10 ${H-9})"><path d="M0 0H${barPx.toFixed(1)}M0-3V3M${barPx.toFixed(1)}-3V3"/><text x="${(barPx+6).toFixed(1)}" y="3.5">${bar>=1000?`${bar/1000} km`:`${bar} m`}</text></g></svg>`;};
  return `<div class="cmp-shapes">${sides.map(panel).join('')}<p class="cmp-shapes-note">Same scale, north up. The arrow points downhill.</p></div>`;}
// The detailed version of the two outlines: each box is a small map at the shared scale with the surrounding AOC areas
// (tinted by class) and lieux-dits, 10 m contours from the village terrain (labelled every 50 m), the cadastral parcel
// lines inside the cru, a few neighbouring cru names, north, a scale bar and the downhill arrow. Built once per pair.
// 5 m terrain tiles for grand and premier crus (scripts/build_cru_terrain.py); other places use the village terrain.
let cruTerrainIndex=null;const cruTerrainCache=new Map();
function cruTerrain(id){cruTerrainIndex||=fetchJson(dataUrl('./data/cruterrain/index.json')).catch(()=>({}));
  if(!cruTerrainCache.has(id))cruTerrainCache.set(id,cruTerrainIndex.then(async ix=>{const t=ix?.[id];if(!t)return null;const res=await fetch(dataUrl(`./data/cruterrain/${encodeURIComponent(id)}.png`));if(!res.ok)return null;
    const bmp=await createImageBitmap(await res.blob(),{premultiplyAlpha:'none',colorSpaceConversion:'none'});const c=document.createElement('canvas');c.width=bmp.width;c.height=bmp.height;const g=c.getContext('2d',{willReadFrequently:true});g.drawImage(bmp,0,0);const px=g.getImageData(0,0,c.width,c.height).data;
    const [x0,y1,cell,w,h,lo]=t,z=new Float32Array(w*h);for(let k=0;k<w*h;k++)z[k]=lo+(px[k*4]*256+px[k*4+1])/10;
    return {x0,y1,cell,w,h,z,at(x,y){const fx=(x-x0)/cell-.5,fy=(y1-y)/cell-.5;if(fx<0||fy<0||fx>w-1||fy>h-1)return null;const i=Math.floor(fx),j=Math.floor(fy),i1=Math.min(w-1,i+1),j1=Math.min(h-1,j+1),tx=fx-i,ty=fy-j;return (z[j*w+i]*(1-tx)+z[j*w+i1]*tx)*(1-ty)+(z[j1*w+i]*(1-tx)+z[j1*w+i1]*tx)*ty;},edge(x,y){const fx=(x-x0)/cell,fy=(y1-y)/cell;return Math.max(0,Math.min(1,Math.min(fx,fy,w-fx,h-fy)/12));}};}).catch(()=>null));
  return cruTerrainCache.get(id);}
const compareKey=()=>compare?.a&&compare?.b?`${compare.a.layer}:${compare.a.id}|${compare.b.layer}:${compare.b.id}`:'';
let cmpManifestPromise=null;const cadastreManifest=()=>cmpManifestPromise||=fetchJson(dataUrl('./data/cadastre/manifest.json')).catch(()=>null);
const cadastreGeomCache=new Map();
function cadastreGeometry(code){if(!cadastreGeomCache.has(code))cadastreGeomCache.set(code,fetchScene(dataUrl(`./data/cadastre/${code}.json.gz`)).then(c=>(c?.parcels||c?.features||[]).map(f=>{const q=fprops(f);return {rings:outlineRings(f),b:q.bounds};})).catch(()=>[]));return cadastreGeomCache.get(code);}
function ringsBounds(rings){let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;for(const r of rings)for(const [x,y] of r){if(x<x0)x0=x;if(x>x1)x1=x;if(y<y0)y0=y;if(y>y1)y1=y;}return [x0,y0,x1,y1];}
const NAV_CLASS={'grand-cru':'#e3b23c','premier-cru':'#5f97d6'};
function sideCommunes(side){const p=fprops(side.feature),codes=new Set();const add=c=>{if(/^\d{5}$/.test(String(c||'')))codes.add(String(c));};add(p.insee);add(p.communeCode);if(side.layer==='climats')add(String(p.id||'').split(':')[0]);let list=p.featureCommuneCodes;if(typeof list==='string'){try{list=JSON.parse(list.replace(/'/g,'"'));}catch{list=[];}}(Array.isArray(list)?list:[]).forEach(add);if(side.layer==='parcels')for(const c of cruIndex||[])if(String(c.id)===String(side.id))add(String(c.village).split('-').pop());/* a cru spanning communes gets every commune's parcels */
  if(!codes.size)add(String(side.villageId||'').split('-').pop());return [...codes];}
function contourPaths(sample,nx,ny,toX,toY){const g=[];let lo=Infinity,hi=-Infinity;for(let j=0;j<=ny;j++){const row=[];for(let i=0;i<=nx;i++){const z=sample(i,j);row.push(z);if(z!=null){if(z<lo)lo=z;if(z>hi)hi=z;}}g.push(row);}
  if(!(hi>lo))return {minor:'',major:'',labels:[]};const step=hi-lo<25?5:10,minor=[],major=[],labels=new Map();
  for(let level=Math.ceil(lo/step)*step;level<=hi;level+=step){const isMajor=level%50===0,out=isMajor?major:minor;
    for(let j=0;j<ny;j++)for(let i=0;i<nx;i++){const a=g[j][i],b=g[j][i+1],c=g[j+1][i+1],d=g[j+1][i];if(a==null||b==null||c==null||d==null)continue;
      const pts=[];const edge=(z1,z2,x1,y1,x2,y2)=>{if((z1<level)!==(z2<level)){const t=(level-z1)/(z2-z1);pts.push([x1+(x2-x1)*t,y1+(y2-y1)*t]);}};
      edge(a,b,i,j,i+1,j);edge(b,c,i+1,j,i+1,j+1);edge(c,d,i+1,j+1,i,j+1);edge(d,a,i,j+1,i,j);
      for(let k=0;k+1<pts.length;k+=2){const [p,q]=[pts[k],pts[k+1]];out.push(`M${toX(p[0]).toFixed(1)} ${toY(p[1]).toFixed(1)}L${toX(q[0]).toFixed(1)} ${toY(q[1]).toFixed(1)}`);
        if(isMajor){const mx=toX((p[0]+q[0])/2),my=toY((p[1]+q[1])/2);if(my>14&&my<toY(ny)-26&&mx>14&&mx<toX(nx)-34){const cur=labels.get(level),score=Math.abs(mx-toX(nx*.82));if(!cur||score<cur.score)labels.set(level,{x:mx,y:my,score,level});}}}}}
  return {minor:minor.join(''),major:major.join(''),labels:[...labels.values()]};}
async function buildCompareMaps(){const key=compareKey();if(!key||compare.building===key)return;compare.building=key;
  try{await loadCruIndex();const cru=new Map((cruIndex||[]).map(c=>[String(c.id),c]));
    const sides=await Promise.all([compare.a,compare.b].map(async(side,n)=>{
      const vids=new Set([side.villageId]);if(side.layer==='parcels')for(const c of cruIndex||[])if(String(c.id)===String(side.id))vids.add(c.village);/* an AOC area split between communes is stored once per village: join the pieces */
      const scenes=(await Promise.all([...vids].map(id=>{const v=index.villages.find(x=>x.id===id);return v?loadScene(v).catch(()=>null):null;}))).filter(Boolean);
      const rings=side.layer==='parcels'&&scenes.length?scenes.flatMap(sc=>(sc.parcels||[]).filter(f=>String(fprops(f).id)===String(side.id)).flatMap(outlineRings)):outlineRings(side.feature);
      const b0=ringsBounds(rings),codes=new Set(sideCommunes(side));for(const [code,m] of Object.entries((await cadastreManifest())?.communes||{})){const cb=m.bounds;if(cb&&cb[2]>=b0[0]&&cb[0]<=b0[2]&&cb[3]>=b0[1]&&cb[1]<=b0[3])codes.add(code);}/* every commune the cru overlaps */
      const parcels=(await Promise.all([...codes].map(cadastreGeometry))).flat();
      let fineId=side.layer==='parcels'?String(side.id):null;
      if(!fineId){const ix=await (cruTerrainIndex||=fetchJson(dataUrl('./data/cruterrain/index.json')).catch(()=>({})));let best=null;for(const [id,[tx0,ty1,cell,w,h]] of Object.entries(ix||{})){if(tx0<=b0[0]&&ty1>=b0[3]&&tx0+cell*w>=b0[2]&&ty1-cell*h<=b0[1]&&(!best||cell<best.cell||(cell===best.cell&&w*h<best.n)))best={id,cell,n:w*h};}fineId=best?.id||null;}/* a lieu-dit borrows the tile of a cru that covers it */
      const fine=fineId?await cruTerrain(fineId):null;
      return {side,k:n?'b':'a',scenes,rings,b:b0,parcels,fine};}));
    if(compareKey()!==key)return;
    compare.geom=sides.map(v=>({rings:v.rings,b:v.b}));
    const fr=compareFrame(sides);await loadGeologyLegend();
    await Promise.all(sides.map(async(v,n)=>{const w=fr.views[n];v.geoPolys=geologyLegendData?(await Promise.all(geologyTileKeys([w.vx0,w.vy0,w.vx1,w.vy1]).map(loadGeologyTile))).flat():[];}));
    if(compareKey()!==key)return;
    for(const v of sides){v.heightAt=sideHeight(v);v.samples=cruSamples(v);v.fall=fallLine(v);v.centroid=v.samples.length?[v.samples.reduce((a,q)=>a+q.x,0)/v.samples.length,v.samples.reduce((a,q)=>a+q.y,0)/v.samples.length]:[(v.b[0]+v.b[2])/2,(v.b[1]+v.b[3])/2];}
    const figs={parcels:renderCompareMaps(sides,cru,fr).join(''),geology:sides.some(v=>v.geoPolys.length)?renderGeologyMaps(sides,fr).join(''):null,overlay:renderOverlay(sides)};
    compare.shapes={key,figs,legend:compareGeoLegend(compare.a,compare.b),profile:renderProfile(sides.map(slopeProfile))};
    if(!compare.repick)renderCompare();else{const host=$('#feature-card .cmp-figures')||$('#feature-card .cmp-shapes');if(host){host.outerHTML=compareFiguresHtml();bindCompareFigures($('#feature-card'));}}
  }catch(e){debug.resourceErrors.push(`compare map: ${e.message}`);}finally{if(compare&&compare.building===key)compare.building=null;}}
// Both small maps share one scale; each is centred on its cru.
function compareFrame(sides){const W=260,H=200,PAD=24,scale=Math.min(...sides.map(v=>Math.min((W-PAD*2)/Math.max(v.b[2]-v.b[0],1),(H-PAD*2-12)/Math.max(v.b[3]-v.b[1],1))));
  return {W,H,scale,views:sides.map(v=>{const cx=(v.b[0]+v.b[2])/2,cy=(v.b[1]+v.b[3])/2;return {cx,cy,vx0:cx-W/2/scale,vx1:cx+W/2/scale,vy1:cy+(H-12)/2/scale,vy0:cy-(H+12)/2/scale};})};}
// Height at a point: the 5 m cru tile, blended into the village terrain near its edge.
function sideHeight(v){const coarseAt=(x,y)=>{for(const sc of v.scenes){const h=sampleScene(sc,x,y);if(h!=null)return h;}return null;};
  const heightAt=(x,y)=>{const f=v.fine?.at(x,y);if(f!=null){const k=v.fine.edge(x,y);if(k>=1)return f;const c=coarseAt(x,y);return c==null?f:c+(f-c)*k;}return coarseAt(x,y);};return heightAt;}
// The cru's overall downhill direction: a plane fitted through its sample heights. Unlike the mean of local aspects,
// it follows the whole slope (a long strip like Montrachet turns square to the page). Falls back to the aspect.
function fallLine(v){const s=(v.samples||[]).filter(q=>q.z!=null&&Number.isFinite(q.z)),t=v.side.terroir,aspect=t&&Number.isFinite(t.aspectDeg)&&t.slopePct>=2?t.aspectDeg:null;if(s.length<8)return aspect;
  const n=s.length,mx=s.reduce((a,q)=>a+q.x,0)/n,my=s.reduce((a,q)=>a+q.y,0)/n,mz=s.reduce((a,q)=>a+q.z,0)/n;let sxx=0,sxy=0,syy=0,sxz=0,syz=0;for(const q of s){const x=q.x-mx,y=q.y-my,z=q.z-mz;sxx+=x*x;sxy+=x*y;syy+=y*y;sxz+=x*z;syz+=y*z;}
  const det=sxx*syy-sxy*sxy;if(!(Math.abs(det)>1e-6))return aspect;const gx=(sxz*syy-syz*sxy)/det,gy=(syz*sxx-sxz*sxy)/det;if(Math.hypot(gx,gy)<.015)return aspect;/* under 1.5%: too flat to say */
  return (Math.atan2(-gx,-gy)*180/Math.PI+360)%360;}
// Points on a grid inside the cru, each with its height and the BRGM unit under it (the profile and the overlay use them).
function cruSamples(v){const b=v.b,span=Math.max(b[2]-b[0],b[3]-b[1]),step=Math.max(4,span/56),flat=v.rings.map(r=>r.flatMap(q=>[Number(q[0]),Number(q[1])])),polys=(v.geoPolys||[]).filter(q=>!(q.bbox[2]<b[0]||q.bbox[0]>b[2]||q.bbox[3]<b[1]||q.bbox[1]>b[3])),out=[];
  for(let x=b[0]+step/2;x<b[2];x+=step)for(let y=b[1]+step/2;y<b[3];y+=step){if(!insideRings(flat,x,y))continue;let unit=null;for(const q of polys){if(x<q.bbox[0]||x>q.bbox[2]||y<q.bbox[1]||y>q.bbox[3])continue;if(insideRings(q.rings,x,y))unit=q.unit;}out.push({x,y,z:v.heightAt(x,y),unit});}
  return out;}
const cmpNorth=W=>`<g class="cmp-shape-north" transform="translate(${W-14} 16)"><path d="M0 7V-6M0-8l-3.5 5M0-8l3.5 5"/><text y="17" text-anchor="middle">N</text></g>`;
const cmpScaleBar=(H,bar,barPx)=>`<g class="cmp-shape-scale" transform="translate(10 ${H-9})"><path d="M0 0H${barPx.toFixed(1)}M0-3V3M${barPx.toFixed(1)}-3V3"/><text x="${(barPx+6).toFixed(1)}" y="3.5">${bar>=1000?`${bar/1000} km`:`${bar} m`}</text></g>`;
function cmpArrow(ax,ay,t,size){if(!t||!Number.isFinite(t.aspectDeg)||!(t.slopePct>=2))return '';const a=t.aspectDeg*Math.PI/180,len=Math.min(36,Math.max(18,size*.4)),dx=Math.sin(a)*len,dy=-Math.cos(a)*len,hx=ax+dx/2,hy=ay+dy/2,ang=Math.atan2(dy,dx);
  return `<path class="cmp-shape-arrow" d="M${(ax-dx/2).toFixed(1)} ${(ay-dy/2).toFixed(1)}L${hx.toFixed(1)} ${hy.toFixed(1)}M${hx.toFixed(1)} ${hy.toFixed(1)}l${(-7*Math.cos(ang-.5)).toFixed(1)} ${(-7*Math.sin(ang-.5)).toFixed(1)}M${hx.toFixed(1)} ${hy.toFixed(1)}l${(-7*Math.cos(ang+.5)).toFixed(1)} ${(-7*Math.sin(ang+.5)).toFixed(1)}"/>`;}
// The same two frames coloured by the BRGM 1:50,000 geological map, with each cru outlined on top.
function renderGeologyMaps(sides,fr){const {W,H,scale}=fr,bar=niceLength((W*.3)/scale),barPx=bar*scale;
  return sides.map((v,n)=>{const {cx,cy,vx0,vx1,vy0,vy1}=fr.views[n],X=x=>(x-vx0)*scale,Y=y=>(vy1-y)*scale;
    const flatPath=f=>{let d='',lx=NaN,ly=NaN;for(let i=0;i<f.length;i+=2){const x=X(f[i]),y=Y(f[i+1]);if(i&&i<f.length-2&&Math.abs(x-lx)<.7&&Math.abs(y-ly)<.7)continue;d+=`${d?'L':'M'}${x.toFixed(1)} ${y.toFixed(1)}`;lx=x;ly=y;}return d?d+'Z':'';};/* points closer than a pixel are dropped */
    const units=v.geoPolys.filter(q=>q.bbox[2]>=vx0&&q.bbox[0]<=vx1&&q.bbox[3]>=vy0&&q.bbox[1]<=vy1).map(q=>`<path d="${q.rings.map(flatPath).join('')}" fill="${esc(q.colour)}" stroke="${esc(q.colour)}" fill-rule="evenodd"/>`).join('');
    const path=rings=>rings.map(r=>r.map(([x,y],k)=>`${k?'L':'M'}${X(x).toFixed(1)} ${Y(y).toFixed(1)}`).join('')+'Z').join(''),seen=new Set(),lieux=[];
    for(const f of v.scenes.flatMap(sc=>sc.climats||[])){const q=fprops(f);if(seen.has(q.id))continue;seen.add(q.id);const rings=outlineRings(f),b=ringsBounds(rings);if(b[2]>=vx0&&b[0]<=vx1&&b[3]>=vy0&&b[1]<=vy1)lieux.push(path(rings));}
    const shape=path(v.rings);
    return `<svg class="cmp-shape cmp-shape-${v.k} cmp-geo-map" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(v.side.name)} on the geological map at the shared scale"><g class="cmp-geo-units">${units}</g><path class="cmp-map-lieux" d="${lieux.join('')}"/><path class="cmp-shape-halo" d="${shape}"/><path class="cmp-shape-line" d="${shape}" fill-rule="evenodd"/>${cmpArrow(X(cx),Y(cy),v.side.terroir,Math.min(v.b[2]-v.b[0],v.b[3]-v.b[1])*scale)}${cmpNorth(W)}${cmpScaleBar(H,bar,barPx)}</svg>`;});}
// The rock units inside A or B, largest first: the geology map's legend.
function compareGeoList(A,B){const L=geologyLegendData;if(!L)return[];const tot=new Map();for(const side of [A,B])for(const [u,pc] of side?.geo||[]){const unit=L.units[u];if(!unit)continue;const name=geologyName(unit).split(',')[0],e=tot.get(name)||{name,colour:unit.colour,pc:0};e.pc+=pc;tot.set(name,e);}return [...tot.values()].sort((a,b)=>b.pc-a.pc).slice(0,6);}
function compareGeoLegend(A,B){const list=compareGeoList(A,B);return list.length?`<ul class="cmp-geo-legend">${list.map(e=>`<li><i style="background:${esc(e.colour)}"></i>${esc(e.name)}</li>`).join('')}</ul>`:'';}
// A and B laid over each other on one drawing: same scale, centred on each other, each turned so its downhill
// direction points down the page (uphill at the top), so width, length down the slope and shape compare directly.
function renderOverlay(sides){const W=520,H=240,PAD=30,COL={a:'#534ab7',b:'#0f6e56'};
  const prep=sides.map(v=>{const turn=Number.isFinite(v.fall)?(180-v.fall)*Math.PI/180:0,[ox,oy]=v.centroid,cs=Math.cos(turn),sn=Math.sin(turn);
    const rings=v.rings.map(r=>r.map(([x,y])=>{const dx=x-ox,dy=y-oy;return [dx*cs+dy*sn,-dx*sn+dy*cs];}));return {v,rings,b:ringsBounds(rings),turned:!!turn};});/* clockwise turn; world y = north */
  const x0=Math.min(...prep.map(q=>q.b[0])),y0=Math.min(...prep.map(q=>q.b[1])),x1=Math.max(...prep.map(q=>q.b[2])),y1=Math.max(...prep.map(q=>q.b[3]));
  const scale=Math.min((W-PAD*2-40)/Math.max(x1-x0,1),(H-PAD*2)/Math.max(y1-y0,1)),mx=(x0+x1)/2,my=(y0+y1)/2,X=x=>W/2+(x-mx)*scale,Y=y=>H/2-(y-my)*scale;
  const path=rings=>rings.map(r=>r.map(([x,y],k)=>`${k?'L':'M'}${X(x).toFixed(1)} ${Y(y).toFixed(1)}`).join('')+'Z').join('');
  const bar=niceLength((W*.16)/scale),barPx=bar*scale,turned=prep.some(q=>q.turned);
  const key=prep.map((q,i)=>`<g transform="translate(12 ${16+i*16})"><rect y="-8" width="10" height="10" rx="2" class="cmp-ov-${q.v.k}"/><text class="cmp-ov-key" x="16" y="1" fill="${COL[q.v.k]}">${q.v.k.toUpperCase()} · ${esc(q.v.side.name)}</text></g>`).join('');
  const dir=turned?`<g class="cmp-ov-dir" transform="translate(${W-22} ${H/2})"><path d="M0 34V-34M0-36l-4 7M0-36l4 7"/><text transform="rotate(-90)" x="0" y="-8" text-anchor="middle">uphill</text></g>`:cmpNorth(W);
  return `<svg class="cmp-shape cmp-overlay" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(prep.map(q=>q.v.side.name).join(' and '))} laid over each other at one scale">${prep.map(q=>`<path class="cmp-ov-${q.v.k}" d="${path(q.rings)}" fill-rule="evenodd"/>`).join('')}${key}${dir}${cmpScaleBar(H,bar,barPx)}</svg>`;}
// Down the slope: the cru's sample points binned by how far downhill they lie (along its aspect), each bin's average
// height and most common rock. Distance starts at the cru's top edge.
function slopeProfile(v){const s=(v.samples||[]).filter(q=>q.z!=null&&Number.isFinite(q.z));if(s.length<8)return null;const a=(Number.isFinite(v.fall)?v.fall:180)*Math.PI/180,dx=Math.sin(a),dy=Math.cos(a);
  const pr=s.map(q=>q.x*dx+q.y*dy);let lo=Infinity,hi=-Infinity;for(const x of pr){if(x<lo)lo=x;if(x>hi)hi=x;}const len=hi-lo;if(len<20)return null;
  const n=Math.max(8,Math.min(48,Math.round(len/12))),bins=Array.from({length:n},()=>({z:0,c:0,units:new Map()}));
  s.forEach((q,i)=>{const bn=bins[Math.min(n-1,Math.floor((pr[i]-lo)/len*n))];bn.z+=q.z;bn.c++;if(q.unit!=null)bn.units.set(q.unit,(bn.units.get(q.unit)||0)+1);});
  const pts=bins.map((bn,k)=>bn.c>=3?{d:(k+.5)/n*len,z:bn.z/bn.c,unit:[...bn.units].sort((x,y)=>y[1]-x[1])[0]?.[0]??null}:null).filter(Boolean);/* edge bins with almost no points are left out */
  return pts.length>=3?{len,pts}:null;}
function renderProfile(profs){if(!profs.length||profs.some(q=>!q))return '';const L=geologyLegendData,W=520,H=228,PL=44,PR=16,PT=38,PB=66,pw=W-PL-PR,ph=H-PT-PB,keys=['a','b'];
  const maxLen=Math.max(...profs.map(q=>q.len));let zl=Infinity,zh=-Infinity;for(const q of profs)for(const r of q.pts){if(r.z<zl)zl=r.z;if(r.z>zh)zh=r.z;}
  const zstep=[2,5,10,20,25,50,100].find(x=>(zh-zl)/x<=5)||100;zl=Math.floor(zl/zstep)*zstep;zh=Math.ceil(zh/zstep)*zstep;if(zh<=zl)zh=zl+zstep;
  const X=d=>PL+d/maxLen*pw,Y=z=>PT+(zh-z)/(zh-zl)*ph;let grid='',ax='';
  for(let z=zl;z<=zh+1e-6;z+=zstep){grid+=`M${PL} ${Y(z).toFixed(1)}H${W-PR}`;ax+=`<text x="${PL-6}" y="${(Y(z)+3).toFixed(1)}" text-anchor="end">${z} m</text>`;}
  const dstep=[25,50,100,200,250,500,1000].find(x=>maxLen/x<=5)||1000;for(let d=0;d<=maxLen+1e-6;d+=dstep)ax+=`<text x="${X(d).toFixed(1)}" y="${PT+ph+13}" text-anchor="middle">${d===0?'0':d>=1000?`${d/1000} km`:`${d} m`}</text>`;
  const lines=profs.map((q,i)=>`<path class="cmp-prof-line cmp-prof-${keys[i]}" d="${q.pts.map((r,j)=>`${j?'L':'M'}${X(r.d).toFixed(1)} ${Y(r.z).toFixed(1)}`).join('')}"/>`).join('');
  const bands=profs.map((q,i)=>{const y=PT+ph+22+i*13;let out=`<text class="cmp-prof-tag cmp-prof-tag-${keys[i]}" x="${PL-6}" y="${y+8}" text-anchor="end">${keys[i].toUpperCase()}</text>`;
    q.pts.forEach((r,j)=>{const a=j?(q.pts[j-1].d+r.d)/2:r.d-q.len/q.pts.length/2,b=j<q.pts.length-1?(r.d+q.pts[j+1].d)/2:r.d+q.len/q.pts.length/2,c=r.unit!=null&&L?.units?.[r.unit]?.colour||'#e4dccd';out+=`<rect x="${X(Math.max(0,a)).toFixed(1)}" y="${y}" width="${(X(Math.min(q.len,b))-X(Math.max(0,a))+.4).toFixed(1)}" height="9" fill="${esc(c)}"/>`;});return out;}).join('');
  const key=profs.map((q,i)=>{const f=q.pts[0],l=q.pts[q.pts.length-1];return `<text class="cmp-prof-key cmp-prof-tag-${keys[i]}" x="${PL}" y="${15+i*15}">${keys[i].toUpperCase()} · ${Math.round(f.z)} m down to ${Math.round(l.z)} m over ${Math.round(l.d-f.d)} m</text>`;}).join('');
  return `<section class="cmp-profile"><h4>Down the slope</h4><svg class="cmp-profile-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Elevation down the slope of A and B, with the rock underneath">${key}<path class="cmp-prof-grid" d="${grid}"/><g class="cmp-prof-axis">${ax}</g>${lines}${bands}<text class="cmp-prof-axis-label" x="${PL}" y="${H-6}">Distance downhill from the top edge of each cru</text></svg><p class="cmp-shapes-note">Elevation averaged across each cru · bands: the rock underneath (BRGM)</p></section>`;}
const CMP_VIEWS=[['parcels','Parcels'],['geology','Geology'],['overlay','Overlay']];
const CMP_NOTES={parcels:'Same scale, north up · lines: parcels · arrow: downhill',geology:'Same scale, north up · BRGM geological map, 1:50,000',overlay:'Same scale, centred on each other, turned so downhill points down'};
function compareFiguresHtml(){const f=compare.shapes,view=f.figs[compare.mapView]?compare.mapView:'parcels';
  return `<div class="cmp-figures"><div class="cmp-view-tabs" role="tablist" aria-label="Map style">${CMP_VIEWS.filter(([k])=>f.figs[k]).map(([k,l])=>`<button type="button" role="tab" data-view="${k}" aria-selected="${k===view}">${l}</button>`).join('')}</div><div class="cmp-shapes${view==='overlay'?' is-overlay':''}">${f.figs[view]}<p class="cmp-shapes-note">${CMP_NOTES[view]}</p>${view==='geology'?f.legend:''}</div>${f.profile}</div>`;}
function bindCompareFigures(root){root?.querySelectorAll('.cmp-view-tabs [data-view]').forEach(b=>b.addEventListener('click',()=>{if(!compare)return;compare.mapView=b.dataset.view;scheduleShareSync();const host=$('#feature-card .cmp-figures');if(host){host.outerHTML=compareFiguresHtml();bindCompareFigures($('#feature-card'));}}));}
// Each cru on a small north-up map at one shared scale: surrounding AOC areas tinted by class with a few names, the
// lieux-dits, contours from the terrain (5 m tiles around grand and premier crus, the village terrain elsewhere), the
// cadastral parcels inside the cru, a scale bar and the downhill arrow. Flat on purpose: a 3D angle foreshortens shape
// and area, which a side-by-side comparison has to show truthfully; the real 3D is one click away ("Show both").
function renderCompareMaps(sides,cru,fr){
  const {W,H,scale}=fr;
  const bar=niceLength((W*.3)/scale),barPx=bar*scale,NX=88,NY=68;
  return sides.map((v,n)=>{
    const {cx,cy,vx0,vx1,vy0,vy1}=fr.views[n];
    const X=x=>(x-vx0)*scale,Y=y=>(vy1-y)*scale,path=rings=>rings.map(r=>r.map(([x,y],k)=>`${k?'L':'M'}${X(x).toFixed(1)} ${Y(y).toFixed(1)}`).join('')+'Z').join('');
    const inView=b=>b&&b[2]>=vx0&&b[0]<=vx1&&b[3]>=vy0&&b[1]<=vy1;
    const heightAt=v.heightAt;
    const own=String(v.side.id),seen=new Set(),aoc=[],lieux=[],names=[];
    for(const f of v.scenes.flatMap(sc=>sc.parcels||[])){const q=fprops(f);if(seen.has(`p:${q.id}`))continue;seen.add(`p:${q.id}`);if(String(q.id)===own&&v.side.layer==='parcels')continue;const rings=outlineRings(f),b=ringsBounds(rings);if(!inView(b))continue;const c=cru.get(String(q.id));aoc.push(`<path d="${path(rings)}" fill="${c?NAV_CLASS[c.class]||'#b9a98f':'#c9bda6'}" fill-opacity="${c?.3:.14}" fill-rule="evenodd"/>`);if(c&&(c.class==='grand-cru'||c.class==='premier-cru'))names.push({name:c.name,x:X((b[0]+b[2])/2),y:Y((b[1]+b[3])/2),area:(b[2]-b[0])*(b[3]-b[1])});}
    for(const f of v.scenes.flatMap(sc=>sc.climats||[])){const q=fprops(f);if(seen.has(`c:${q.id}`))continue;seen.add(`c:${q.id}`);if(String(q.id)===own&&v.side.layer==='climats')continue;const rings=outlineRings(f);if(inView(ringsBounds(rings)))lieux.push(path(rings));}
    const ct=contourPaths((i,j)=>heightAt(vx0+i/NX*(vx1-vx0),vy1-j/NY*(vy1-vy0)),NX,NY,i=>i/NX*W,j=>j/NY*H);
    const cuts=v.parcels.filter(q=>q.b&&q.b[2]>=v.b[0]&&q.b[0]<=v.b[2]&&q.b[3]>=v.b[1]&&q.b[1]<=v.b[3]).map(q=>path(q.rings)).join('');
    const shape=path(v.rings),clip=`cmpclip-${v.k}`,t=v.side.terroir;let arrow='';
    if(t&&Number.isFinite(t.aspectDeg)&&t.slopePct>=2){const ax=X(cx),ay=Y(cy),a=t.aspectDeg*Math.PI/180,len=Math.min(36,Math.max(18,Math.min(v.b[2]-v.b[0],v.b[3]-v.b[1])*scale*.4)),dx=Math.sin(a)*len,dy=-Math.cos(a)*len,hx=ax+dx/2,hy=ay+dy/2,ang=Math.atan2(dy,dx);arrow=`<path class="cmp-shape-arrow" d="M${(ax-dx/2).toFixed(1)} ${(ay-dy/2).toFixed(1)}L${hx.toFixed(1)} ${hy.toFixed(1)}M${hx.toFixed(1)} ${hy.toFixed(1)}l${(-7*Math.cos(ang-.5)).toFixed(1)} ${(-7*Math.sin(ang-.5)).toFixed(1)}M${hx.toFixed(1)} ${hy.toFixed(1)}l${(-7*Math.cos(ang+.5)).toFixed(1)} ${(-7*Math.sin(ang+.5)).toFixed(1)}"/>`;}
    const sx0=X(v.b[0])-4,sx1=X(v.b[2])+4,sy0=Y(v.b[3])-4,sy1=Y(v.b[1])+4,same=fold(v.side.name).replace(/[^a-z0-9]+/g,''),placed=[];
    const labels=names.filter(n=>n.x>16&&n.x<W-16&&n.y>14&&n.y<H-22&&!(n.x>W-80&&n.y<46)&&!(n.x+n.name.length*2.6>sx0&&n.x-n.name.length*2.6<sx1&&n.y+6>sy0&&n.y-6<sy1)&&fold(n.name).replace(/[^a-z0-9]+/g,'')!==same).sort((a,b)=>b.area-a.area).filter(n=>{if(placed.some(p=>Math.abs(p.x-n.x)<70&&Math.abs(p.y-n.y)<14))return false;placed.push(n);return placed.length<=4;});
    return `<svg class="cmp-shape cmp-shape-${v.k}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(v.side.name)} on a small map at the shared scale"><defs><clipPath id="${clip}"><path d="${shape}" clip-rule="evenodd"/></clipPath></defs>
      <g class="cmp-map-aoc">${aoc.join('')}</g><path class="cmp-map-lieux" d="${lieux.join('')}"/>
      <path class="cmp-map-contour" d="${ct.minor}"/><path class="cmp-map-contour is-major" d="${ct.major}"/>
      <path class="cmp-shape-fill" d="${shape}" fill-rule="evenodd"/><path class="cmp-map-parcels" d="${cuts}" clip-path="url(#${clip})"/><path class="cmp-shape-line" d="${shape}" fill-rule="evenodd"/>
      ${ct.labels.map(l=>`<text class="cmp-map-elev" x="${l.x.toFixed(1)}" y="${(l.y-2).toFixed(1)}">${l.level} m</text>`).join('')}
      ${labels.map(n=>`<text class="cmp-map-name" x="${n.x.toFixed(1)}" y="${n.y.toFixed(1)}" text-anchor="middle">${esc(n.name)}</text>`).join('')}
      ${arrow}<g class="cmp-shape-north" transform="translate(${W-14} 16)"><path d="M0 7V-6M0-8l-3.5 5M0-8l3.5 5"/><text y="17" text-anchor="middle">N</text></g><g class="cmp-shape-scale" transform="translate(10 ${H-9})"><path d="M0 0H${barPx.toFixed(1)}M0-3V3M${barPx.toFixed(1)}-3V3"/><text x="${(barPx+6).toFixed(1)}" y="3.5">${bar>=1000?`${bar/1000} km`:`${bar} m`}</text></g></svg>`;});}
// "Show both": both crus outlined on the 3D map in their A and B colours. Near each other, the camera frames the two;
// far apart, it frames A and says so (the A and B chips fly between them).
const COMPARE_NEAR_M=3500;
function compareFar(){const g=compare?.geom;if(!g)return false;const [a,b]=g;return Math.hypot((a.b[0]+a.b[2]-b.b[0]-b.b[2])/2,(a.b[1]+a.b[3]-b.b[1]-b.b[3])/2)>COMPARE_NEAR_M;}
async function showBoth(){if(!compare?.a||!compare?.b)return;if(!compare.geom){await buildCompareMaps();if(!compare?.geom)return;}
  const [ga,gb]=compare.geom;renderer?.setCompareOutlines?.([{rings:ga.rings,color:0xb3abff},{rings:gb.rings,color:0x4fe0a6}]);/* lighter A and B tints: they must read on the aerial photo */
  if(compareFar()){const next=compare.viewing==='b'?'a':'b';await flyToSide(compare[next]);return;}/* too far to frame together: go to the other one */
  const x0=Math.min(ga.b[0],gb.b[0]),y0=Math.min(ga.b[1],gb.b[1]),x1=Math.max(ga.b[2],gb.b[2]),y1=Math.max(ga.b[3],gb.b[3]),view=renderer?.captureView?.();if(!view)return;
  if(renderer.restoreView({...view,easting:(x0+x1)/2,northing:(y0+y1)/2,radiusMetres:Math.max(600,Math.min(6000,Math.max(x1-x0,y1-y0)*1.9))}))renderer.scheduleViewChange?.();centreInVisible();}
function addParcelCompareButton(host,prov){if(!host||compare||host.querySelector('.compare-btn'))return;const b=document.createElement('button');b.type='button';b.className='share-link-btn compare-btn';b.title='Compare the cru this parcel lies in with another';b.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4v16M16 4v16M4 8h4M16 16h4"/></svg><span class="share-label">Compare</span>';
  b.addEventListener('click',async e=>{e.stopPropagation();await loadCruIndex();const cru=cruUnderParcel(prov);if(cru)startCompare(cru.feature,cru.layer,{});else{const l=b.querySelector('.share-label');l.textContent='No cru here';setTimeout(()=>{l.textContent='Compare';},1800);}});
  factActions(host).append(b);}
function addCompareSaveButton(host){if(!host||host.querySelector('.cmp-save-btn'))return;const b=document.createElement('button');b.type='button';b.className='share-link-btn cmp-save-btn';b.title='Save this comparison as an image';b.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 19h14"/></svg><span class="share-label">Save image</span>';
  b.addEventListener('click',async e=>{e.stopPropagation();const l=b.querySelector('.share-label');b.disabled=true;l.textContent='Preparing…';try{await saveCompareImage();l.textContent='Saved';}catch(err){l.textContent='Could not save';debug.resourceErrors.push(`compare image: ${err.message}`);}finally{b.disabled=false;setTimeout(()=>{l.textContent='Save image';},1800);}});
  const share=host.querySelector('.share-link-btn');if(share)share.after(b);else host.append(b);}
// The comparison as one picture: the two names, the two maps (copied from the panel with their styles inlined) and the
// figures, with the sources and the site underneath. Phones get the share sheet when it accepts files.
function svgToImage(svg){const clone=svg.cloneNode(true),src=[svg,...svg.querySelectorAll('*')],dst=[clone,...clone.querySelectorAll('*')];
  const keys=['fill','fill-opacity','stroke','stroke-width','stroke-opacity','opacity','font-family','font-size','font-weight','font-style','paint-order','stroke-linejoin','stroke-linecap'];
  src.forEach((el,i)=>{const cs=getComputedStyle(el);dst[i].setAttribute('style',keys.map(k=>`${k}:${cs.getPropertyValue(k)}`).join(';'));});
  const box=svg.viewBox.baseVal;clone.setAttribute('width',box.width);clone.setAttribute('height',box.height);clone.setAttribute('xmlns','http://www.w3.org/2000/svg');
  const url=URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)],{type:'image/svg+xml'}));
  return new Promise((res,rej)=>{const img=new Image();img.onload=()=>{URL.revokeObjectURL(url);res(img);};img.onerror=()=>{URL.revokeObjectURL(url);rej(new Error('map drawing failed'));};img.src=url;});}
async function saveCompareImage(){if(!compare?.a||!compare?.b)return;const A=compare.a,B=compare.b,S=2,W=1080,M=44,LBL=150,GAP=24,col=(W-M*2-LBL-GAP)/2,x1=M+LBL,x2=x1+col+GAP;
  const svgs=[...document.querySelectorAll('#feature-card .cmp-shapes svg.cmp-shape')],maps=await Promise.all(svgs.map(svgToImage)),profSvg=document.querySelector('#feature-card .cmp-profile-svg'),prof=profSvg?await svgToImage(profSvg):null,view=compare.shapes?.figs?.[compare.mapView]?compare.mapView:'parcels',legendList=view==='geology'?compareGeoList(A,B):[];
  const serif='Georgia,"Source Serif 4",serif',sans='system-ui,-apple-system,"Segoe UI",sans-serif',ink='#28231f',muted='#7a7064',line='#e1d8c9',paper='#f4efe5',card='#fffdf7',wine='#7b4051';
  const COL={a:{fill:'#7f77dd',dark:'#3c3489'},b:{fill:'#1d9e75',dark:'#085041'}},L=geologyLegendData,ta=A.terroir,tb=B.terroir;
  // measure first: geology and owners can wrap
  const probe=document.createElement('canvas').getContext('2d');const wrap=(text,font,max)=>{probe.font=font;const words=String(text).split(' '),lines=[];let cur='';for(const w of words){const t=cur?`${cur} ${w}`:w;if(probe.measureText(t).width>max&&cur){lines.push(cur);cur=w;}else cur=t;}if(cur)lines.push(cur);return lines;};
  const geoText=x=>x.geo?.length&&L?x.geo.map(([u,pc])=>`${geologyName(L.units[u]).split(',')[0]} ${pc}%`).join(' · '):'Not mapped';
  const geoA=wrap(geoText(A),`13px ${sans}`,col),geoB=wrap(geoText(B),`13px ${sans}`,col);
  const owners=x=>x.owners?.entities?.length?x.owners.entities.slice(0,5):[],oa=owners(A),ob=owners(B),otherIds=x=>new Set((x.owners?.entities||[]).map(e=>e.o.siren||e.o.name));
  const full=col*2+GAP,mapW=maps.length===1?full:col,mapH=maps.length?Math.round(mapW*(maps[0].height/maps[0].width)):0,profH=prof?Math.round(full*(prof.height/prof.width)):0;
  const rows=[{k:'Area',h:52},...(ta||tb?[{k:'Elevation',h:56},{k:'Slope',h:56},{k:'Faces',h:56},{k:'Direct sun',sub:'Apr–Sep',h:52}]:[]),{k:'Geology',h:30+Math.max(geoA.length,geoB.length)*18},{k:'Owners',sub:'legal entities',h:40+Math.max(oa.length,ob.length,1)*22}];
  const top=M+92,chipsH=58,H=top+chipsH+18+(mapH?mapH+34+(legendList.length?22:0):0)+(prof?profH+62:0)+30+rows.reduce((a,r)=>a+r.h,0)+92;
  const c=document.createElement('canvas');c.width=W*S;c.height=H*S;const g=c.getContext('2d');g.scale(S,S);g.textBaseline='alphabetic';
  const rr=(x,y,w,h,r)=>{g.beginPath();g.moveTo(x+r,y);g.arcTo(x+w,y,x+w,y+h,r);g.arcTo(x+w,y+h,x,y+h,r);g.arcTo(x,y+h,x,y,r);g.arcTo(x,y,x+w,y,r);g.closePath();};
  const fit=(text,max)=>{let t=String(text);while(g.measureText(t).width>max&&t.length>3)t=`${t.slice(0,-2)}…`;return t;};
  g.fillStyle=paper;g.fillRect(0,0,W,H);
  // title
  g.fillStyle=wine;g.font=`600 11px ${sans}`;g.fillText(`${REGION.title.toUpperCase()}  ·  COMPARE`,M,M+12);
  g.fillStyle=ink;g.font=`34px ${serif}`;g.fillText(fit(`${A.name} vs ${B.name}`,W-M*2),M,M+56);
  // chips, as in the panel
  const chip=(x,side,k)=>{const col0=COL[k];rr(x,top,col,chipsH,12);g.fillStyle=card;g.fill();g.lineWidth=1.6;g.strokeStyle=col0.fill;g.stroke();g.fillStyle=col0.fill;g.beginPath();g.arc(x+26,top+chipsH/2,12,0,Math.PI*2);g.fill();g.fillStyle='#fff';g.font=`700 12px ${sans}`;g.textAlign='center';g.fillText(k.toUpperCase(),x+26,top+chipsH/2+4);g.textAlign='start';g.fillStyle=col0.dark;g.font=`17px ${serif}`;g.fillText(fit(side.name,col-60),x+48,top+25);g.fillStyle=muted;g.font=`12px ${sans}`;g.fillText(fit([side.tier,side.village].filter(Boolean).join(' · '),col-60),x+48,top+44);};
  chip(x1,A,'a');chip(x2,B,'b');
  let y=top+chipsH+18;
  const box=(img,x,yy,w,h)=>{g.save();rr(x,yy,w,h,12);g.clip();g.drawImage(img,x,yy,w,h);g.restore();rr(x+.5,yy+.5,w-1,h-1,12);g.strokeStyle=line;g.lineWidth=1;g.stroke();};
  if(mapH){if(maps.length===1)box(maps[0],x1,y,mapW,mapH);else{box(maps[0],x1,y,col,mapH);box(maps[1],x2,y,col,mapH);}y+=mapH+20;g.fillStyle=muted;g.font=`12px ${sans}`;g.fillText(CMP_NOTES[view],x1,y);y+=14;
    if(legendList.length){y+=8;let lx=x1;g.font=`12px ${sans}`;for(const e of legendList){const w=g.measureText(e.name).width+28;if(lx+w>W-M)break;g.fillStyle=e.colour;rr(lx,y,11,11,2);g.fill();g.fillStyle=ink;g.fillText(e.name,lx+16,y+10);lx+=w;}y+=14;}}
  if(prof){y+=18;g.fillStyle=muted;g.font=`600 10.5px ${sans}`;g.fillText('DOWN THE SLOPE',x1,y);y+=10;box(prof,x1,y,full,profH);y+=profH+20;g.fillStyle=muted;g.font=`12px ${sans}`;g.fillText('Elevation averaged across each cru · bands: the rock underneath (BRGM)',x1,y);y+=14;}
  y+=16;
  const bar=(x,yy,v,max,k)=>{rr(x,yy,col,6,3);g.fillStyle='#e9e1d3';g.fill();if(Number.isFinite(v)&&max>0){rr(x,yy,Math.max(6,col*v/max),6,3);g.fillStyle=COL[k].fill;g.fill();}};
  const val=(x,yy,big,small)=>{g.fillStyle=ink;g.font=`20px ${serif}`;g.fillText(fit(big,col),x,yy);if(small){g.fillStyle=muted;g.font=`12px ${sans}`;g.fillText(fit(small,col),x,yy+19);}};
  const maxArea=Math.max(A.area||0,B.area||0),maxSun=Math.max(ta?.sunHours||0,tb?.sunHours||0);
  for(const r of rows){g.strokeStyle=line;g.lineWidth=1;g.beginPath();g.moveTo(M,y);g.lineTo(W-M,y);g.stroke();
    g.fillStyle=muted;g.font=`600 10.5px ${sans}`;g.fillText(r.k.toUpperCase(),M,y+24);if(r.sub){g.font=`11px ${sans}`;g.fillText(r.sub,M,y+40);}
    const yy=y+26;
    if(r.k==='Area'){val(x1,yy,haText(A.area));val(x2,yy,haText(B.area));bar(x1,yy+10,A.area,maxArea,'a');bar(x2,yy+10,B.area,maxArea,'b');}
    else if(r.k==='Elevation'){for(const [t,x] of [[ta,x1],[tb,x2]])val(x,yy,t?`${Math.round(t.elevation.min)}–${Math.round(t.elevation.max)} m`:'—',t?`average ${Math.round(t.elevation.mean)} m`:'');}
    else if(r.k==='Slope'){for(const [t,x] of [[ta,x1],[tb,x2]])val(x,yy,t?`${t.slopePct.toFixed(1)}%`:'—',t?`steepest ${Math.round(t.slopeMaxPct)}%`:'');}
    else if(r.k==='Faces'){for(const [t,x] of [[ta,x1],[tb,x2]])val(x,yy,t?(ASPECT_WORDS[t.aspect]||t.aspect):'—',t?`${t.aspectDeg}°`:'');}
    else if(r.k==='Direct sun'){val(x1,yy,ta?`${ta.sunHours.toLocaleString('en')} h`:'—');val(x2,yy,tb?`${tb.sunHours.toLocaleString('en')} h`:'—');bar(x1,yy+10,ta?.sunHours,maxSun,'a');bar(x2,yy+10,tb?.sunHours,maxSun,'b');}
    else if(r.k==='Geology'){for(const [side,x,lines] of [[A,x1,geoA],[B,x2,geoB]]){if(side.geo?.length&&L){const tot=side.geo.reduce((a,[,pc])=>a+pc,0)||1;let gx=x;g.save();rr(x,y+14,col,10,5);g.clip();for(const [u,pc] of side.geo){const w=col*pc/tot;g.fillStyle=L.units[u].colour;g.fillRect(gx,y+14,w+.5,10);gx+=w;}g.restore();}g.fillStyle=muted;g.font=`13px ${sans}`;lines.forEach((ln,k)=>g.fillText(ln,x,y+42+k*18));}}
    else if(r.k==='Owners'){for(const [side,other,x,list] of [[A,B,x1,oa],[B,A,x2,ob]]){const o=side.owners,ids=otherIds(other);g.fillStyle=muted;g.font=`12px ${sans}`;g.fillText(o?.entities?.length?`${o.entities.length} entities · ${haText(o.total)}${side.area?` of ${haText(side.area)}`:''}${o.entities.length>5?' · largest 5':''}`:'No legal-entity owner recorded',x,y+24);
      list.forEach((e,k)=>{const yy2=y+48+k*22,both=ids.has(e.o.siren||e.o.name);g.font=`13px ${sans}`;g.fillStyle=ink;const ha=haText(e.area),haW=g.measureText(ha).width,tagW=both?38:0;g.fillText(fit(displayEntityName(e.o.name),col-haW-tagW-14),x,yy2);if(both){const nw=g.measureText(fit(displayEntityName(e.o.name),col-haW-tagW-14)).width;rr(x+nw+6,yy2-11,32,15,4);g.fillStyle='#f6e3b4';g.fill();g.fillStyle='#6b4a07';g.font=`600 9.5px ${sans}`;g.fillText('both',x+nw+12,yy2);g.font=`13px ${sans}`;}g.fillStyle=muted;g.textAlign='right';g.fillText(ha,x+col,yy2);g.textAlign='start';});
}}
    y+=r.h;}
  g.strokeStyle=line;g.beginPath();g.moveTo(M,y);g.lineTo(W-M,y);g.stroke();
  g.fillStyle=muted;g.font=`11px ${sans}`;g.fillText('Sources: IGN RGE ALTI · INAO · DGFiP / Etalab · BRGM BD Charm-50 (Licence Ouverte 2.0). Owners: legal entities in the DGFiP register only.',M,y+28);
  g.fillStyle=wine;g.font=`600 12px ${sans}`;g.fillText('climat.daoyizhang.com',M,y+52);g.textAlign='right';g.fillStyle=muted;g.font=`12px ${sans}`;g.fillText('Created by Daoyi Zhang',W-M,y+52);g.textAlign='start';
  const blob=await new Promise((res,rej)=>c.toBlob(b=>b?res(b):rej(new Error('encode failed')),'image/png')),name=`${escapeFilename(`${A.name}-vs-${B.name}`)}.png`;
  const file=typeof File==='function'?new File([blob],name,{type:'image/png'}):null;
  if(document.documentElement.classList.contains('phone-ui')&&file&&navigator.canShare?.({files:[file]})){try{await navigator.share({files:[file],title:`${A.name} vs ${B.name}`});return;}catch(e){if(e?.name==='AbortError')return;}}
  const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}
// "How to use": what the atlas can do (exploring, comparing, sharing) beside the mouse and keyboard controls.
// Phones get the same dialog from "All features" in the menu, with touch gestures instead of keys.
function renderHelp(modal){const card=modal?.querySelector('.keyboard-card');if(!card)return;const v=term('village'),phone=document.documentElement.classList.contains('phone-ui')||matchMedia('(pointer:coarse)').matches;
  const tap=phone?'Tap':'Click',tapl=tap.toLowerCase(),row=(k,d)=>`<dt>${k}</dt><dd>${d}</dd>`;
  const sections=[
    ['Explore',[row(`${tap} a vineyard`,'Area, elevation, slope, which way it faces, hours of sun and the rock beneath'),row('Parcels',`Turn on Cadastral parcels in Layers, then ${tapl} one for its cru and recorded owners`),row('Shade by','Colour the vineyards by appellation, slope, aspect, sun hours or geology'),row('Sun &amp; rain','Sun and shadows for any date and hour, and how a storm runs off the slopes'),row('Search',`${v.charAt(0).toUpperCase()+v.slice(1)}s and crus, or owners (domaines, GFA, SCI…) and the crus they hold`)]],
    ['Compare two crus',[row('Compare',`In a cru’s panel, or a parcel’s; then search or ${tapl} the second one, anywhere in the region`),row('Show both','Both outlined on the 3D map; when far apart, Show A / Show B jumps between them'),row('Parcels · Geology · Overlay','Same-scale maps; Overlay lays one on the other, each turned so downhill points down'),row('Down the slope','Elevation from the top of each cru to the bottom, with the rock underneath'),row('× on a name','Pick a different cru (or double-click the name)')]],
    ['Share and save',[row('Copy link · Share','The address keeps the view, the selection, the shading and any comparison'),row('Save image','The map as you see it, or the comparison as one picture')]]];
  const keys=phone?[row('One finger','Drag to move the map'),row('Two fingers','Pinch to zoom, twist to turn, slide up or down to tilt'),row('Tap','Select a vineyard or parcel'),row('Info sheet','Drag its handle up for everything, down for the map')]
    :[row('<kbd>Left-drag</kbd>','Rotate the view (switch to Pan in the controls)'),row('<kbd>Shift</kbd> + drag','Pan across communes'),row('<kbd>Right-drag</kbd>','Rotate'),row('<kbd>Scroll</kbd>','Zoom'),row('<kbd>Double-click</kbd>','Focus the terrain under the cursor'),row('<kbd>←</kbd> <kbd>↑</kbd> <kbd>→</kbd> <kbd>↓</kbd>','Move the map, relative to the screen'),row('<kbd>/</kbd>',`Search ${v}s and crus`),row('<kbd>Esc</kbd>','Close panels and dialogs')];
  const close=card.querySelector('.modal-close');close?.setAttribute('aria-label','Close all features');
  card.classList.add('help-card');
  card.innerHTML='';if(close)card.append(close);
  card.insertAdjacentHTML('beforeend',`<h2 id="keyboard-help-title">All features</h2><div class="help-cols"><div class="help-col">${sections.slice(0,2).map(([h,rows])=>`<section class="help-sec"><h3>${h}</h3><dl>${rows.join('')}</dl></section>`).join('')}</div><div class="help-col">${sections.slice(2).map(([h,rows])=>`<section class="help-sec"><h3>${h}</h3><dl>${rows.join('')}</dl></section>`).join('')}<section class="help-sec"><h3>${phone?'Touch':'Moving around'}</h3><dl class="help-keys">${keys.join('')}</dl></section><p class="modal-note">Boundaries are informative, not a legal survey. Sun hours are a clear-sky model for comparing places. Sources are listed under Sources and About.</p></div></div>`);}
// ---- Shareable links ----
// The address records what is on screen: #<village>?sel=<layer>:<feature id>&owner=<SIREN>&shade=<mode>&cam=<easting>,
// <northing>,<distance m>,<heading°>,<tilt°>. It is rewritten quietly (no history entry) as you move, select or open a
// card, so the browser's own share button and "Copy link" both give a link that reopens the same view.
let shareRestoring=false,shareTimer=0;
function shareState(){const p=new URLSearchParams(),sf=selectedFeature;
  if(sf?.feature&&['climats','parcels','cadastre'].includes(sf.layer)){const f=sf.feature.properties||sf.feature,id=f.id??f.featureId;if(id!=null)p.set('sel',`${sf.layer}:${id}`);}
  if(ownerShown)p.set('owner',ownerShown.siren||ownerShown.name);
  if(compare?.a?.id!=null&&compare?.b?.id!=null&&!compare.a.loading&&!compare.b.loading){p.delete('sel');p.set('cmp',[compare.a,compare.b].map(x=>`${x.layer}:${x.id}@${x.villageId}`).join(','));if(compare.mapView&&compare.mapView!=='parcels')p.set('cmpv',compare.mapView);else p.delete('cmpv');}else p.delete('cmpv');
  if(terroirMode&&terroirMode!=='off')p.set('shade',terroirMode);
  const v=renderer?.captureView?.();if(v&&Number.isFinite(v.easting)&&Number.isFinite(v.radiusMetres)){const [dx,dy,dz]=v.direction||[.7,.62,.7],deg=180/Math.PI;p.set('cam',[Math.round(v.easting),Math.round(v.northing),Math.round(v.radiusMetres),Math.round((Math.atan2(dx,dz)*deg+360)%360),Math.round(Math.acos(Math.max(-1,Math.min(1,dy)))*deg)].join(','));}
  return p;}
function shareHash(id){const q=shareState().toString().replace(/%2C/g,',').replace(/%3A/g,':');return `#${encodeURIComponent(id)}${q?`?${q}`:''}`;}
function shareUrl(){return `${location.origin}${location.pathname}${shareHash(hashParts().id||selected?.id||'')}`;}
function scheduleShareSync(){if(shareRestoring||!selected)return;clearTimeout(shareTimer);shareTimer=setTimeout(()=>{if(shareRestoring||!selected)return;const hash=shareHash(hashParts().id||selected.id);if(location.hash!==hash)history.replaceState(null,'',hash);},450);}
function waitForFeature(layer,id,ms=12000){const t0=performance.now();return new Promise(res=>{const look=()=>{const item=renderer?.featureIndex?.find(it=>it.key===layer&&String((it.feature?.properties||it.feature)?.id)===String(id));if(item||performance.now()-t0>ms)return res(item||null);setTimeout(look,300);};look();});}
async function applyShare(params){if(!params||![...params.keys()].length){shareRestoring=false;return;}shareRestoring=true;
  try{await renderer?.whenSceneReady?.();
    const shade=params.get('shade');if(shade&&shade!==terroirMode)await setTerroirMode(shade);
    const cam=(params.get('cam')||'').split(',').map(Number),hasCam=cam.length>=3&&cam.slice(0,3).every(Number.isFinite);
    if(hasCam){const r=Math.PI/180,az=(Number.isFinite(cam[3])?cam[3]:45)*r,tilt=(Number.isFinite(cam[4])?cam[4]:50)*r;renderer.restoreView({easting:cam[0],northing:cam[1],radiusMetres:cam[2],direction:[Math.sin(tilt)*Math.sin(az),Math.cos(tilt),Math.sin(tilt)*Math.cos(az)]});renderer.requestRender?.();}
    const sel=params.get('sel'),cut=sel?sel.indexOf(':'):-1;
    if(cut>0){const layer=sel.slice(0,cut),id=sel.slice(cut+1),item=await waitForFeature(layer,id);
      if(item){if(!hasCam)renderer.focusFeature(item.feature);let prov={};if(layer==='cadastre'){const ring=item.ring||[],c=[ring.reduce((a,q)=>a+q[0],0)/(ring.length||1),ring.reduce((a,q)=>a+q[1],0)/(ring.length||1)];prov={placeName:renderer.placeAt?.(c),placeFeature:renderer.placeFeatureAt?.(c),parcelRing:ring,parcelHoles:item.holes||[],placeScope:'selected-map-point',aocUnder:renderer.aocUnder?.(item.feature)};}renderer.selectFeature(item.feature,layer,prov);}}
    const cmp=params.get('cmp');if(cmp)await restoreCompare(cmp,params.get('cmpv'));
    const owner=params.get('owner');
    if(owner){const list=await loadOwners(),o=(list||[]).find(x=>x.siren===owner)||(list||[]).find(x=>x.name===owner);
      if(o){const input=ownerSearchInput();if(document.documentElement.classList.contains('phone-ui'))window.atlasPhoneUI?.setMode?.('owner');if(input)input.value=o.name;showOwner(o);window.atlasSearchDrop?.open(input);}}
  }finally{shareRestoring=false;scheduleShareSync();}}
async function copyShareLink(btn){const url=shareUrl(),label=btn?.querySelector('.share-label');
  const done=text=>{if(!label)return;const was=label.dataset.idle||label.textContent;label.dataset.idle=was;label.textContent=text;clearTimeout(btn._t);btn._t=setTimeout(()=>{label.textContent=was;},1800);};
  if(document.documentElement.classList.contains('phone-ui')&&navigator.share){try{await navigator.share({title:document.title,url});return;}catch(e){if(e?.name==='AbortError')return;}}
  try{await navigator.clipboard.writeText(url);done('Link copied');}catch{window.prompt('Copy this link',url);}}
const LINK_ICON='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/></svg>';
function addShareButton(host){if(!host||host.querySelector('.share-link-btn'))return;const b=document.createElement('button');b.type='button';b.className='share-link-btn';b.title='Copy a link that opens this view';b.innerHTML=`${LINK_ICON}<span class="share-label">Share</span>`;b.addEventListener('click',e=>{e.stopPropagation();copyShareLink(b);});factActions(host).append(b);}
// Share and Compare sit together in one group at the end of the panel head, so they wrap as a pair.
function factActions(host){const head=host.querySelector?.('.fact-heading');if(!head)return host;let row=head.querySelector(':scope>.fact-actions');if(!row){row=document.createElement('div');row.className='fact-actions';head.append(row);}return row;}
function setupShareButtons(){const save=$('#share-button');if(save&&!$('#copy-link-button')){const b=document.createElement('button');b.id='copy-link-button';b.type='button';b.title='Copy a link that opens this view';b.innerHTML=`${LINK_ICON}<span class="button-label share-label">Copy link</span>`;b.addEventListener('click',()=>copyShareLink(b));save.after(b);}}
let photoTileIndex=null;/* sharp close-view photos (region.json photoTiles): data/photo-tiles/index.json */
async function boot(){try{await applyRegion();if(REGION.photoTiles)photoTileIndex=await fetchJson(dataUrl('./data/photo-tiles/index.json')).catch(()=>null);[index,,useAvif]=await Promise.all([loadIndex(),loadRegionalData(),avifSupported()]);for(const tile of Object.values(textureManifest))for(const key of ['url','urlAvif'])if(tile?.[key])tile[key]=dataUrl(tile[key]).href;setup()}catch(e){debug.resourceErrors.push(String(e.message));ui.loading.hidden=true;ui.error.hidden=false;ui.errorMsg.textContent=e.message;}}
boot();

