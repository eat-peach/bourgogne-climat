// Aerial textures are published as AVIF with a JPEG fallback. This resolves once
// per page whether the browser can decode AVIF through createImageBitmap.
const AVIF_PROBE = 'data:image/avif;base64,AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAADrbWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAAAAAAAOcGl0bQAAAAAAAQAAAB5pbG9jAAAAAEQAAAEAAQAAAAEAAAETAAAAJgAAAChpaW5mAAAAAAABAAAAGmluZmUCAAAAAAEAAGF2MDFDb2xvcgAAAABqaXBycAAAAEtpcGNvAAAAFGlzcGUAAAAAAAAAAQAAAAEAAAAQcGl4aQAAAAADCAgIAAAADGF2MUOBAAwAAAAAE2NvbHJuY2x4AAEADQAGgAAAABdpcG1hAAAAAAAAAAEAAQQBAoMEAAAALm1kYXQSAAoIGAAGiAhoNCAyGBlHh4Yhh5555oAAAJBAyRxhREY3INy/QA==';

let probe = null;
export function avifSupported() {
  probe ||= (typeof createImageBitmap !== 'function' || typeof fetch !== 'function')
    ? Promise.resolve(false)
    : fetch(AVIF_PROBE).then(res => res.blob()).then(blob => createImageBitmap(blob)).then(bitmap => { bitmap.close?.(); return true; }, () => false);
  return probe;
}

// Synchronous answer once the probe has settled (false until then).
let known = false;
avifSupported().then(ok => { known = ok; });
export function avifKnownSupported() { return known; }
