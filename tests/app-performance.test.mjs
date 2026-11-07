import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const app = readFileSync('dist/app.js', 'utf8');

test('navigator keeps static geometry and village marker listeners between view updates', () => {
  const navigator = app.match(/function buildRegionalNav\(\)\{[\s\S]*?function updateDetails/)[0];
  assert.match(navigator, /const key=`\$\{state\.mode\}\|\$\{selected\?\.id\|\|''\}\|\$\{W\}\|\$\{H\}\|\$\{state\.dataVersion\}\|\$\{Math\.round\(cX\)\}\|\$\{Math\.round\(cY\)\}\|\$\{state\.zoom\.toFixed\(3\)\}`/);
  // a drag or zoom moves the drawn map with a transform and redraws once, when the gesture ends
  assert.match(navigator, /world\.setAttribute\('transform'/);
  // map data arriving redraws the static layer once, coalesced to one frame
  assert.match(navigator, /requestAnimationFrame\(\(\)=>\{redrawQueued=false;state\.dataVersion\+\+;draw\(\);\}\)/);
  assert.match(navigator, /if\(key!==state\.staticKey\)\{/);
  assert.match(navigator, /points\.replaceChildren\(\)/);
  assert.match(navigator, /const vb=state\.view\?\.easting/);
  assert.match(navigator, /cross\.replaceChildren\(/);
});

test('scene stream updates are coalesced until pointer and wheel interaction goes idle', () => {
  assert.match(app, /let mosaic = null,[\s\S]*streamViewQueued = null, interactionIdleTimer = 0, interactionActive = false, interactionHeld = false/);
  assert.match(app, /async function streamView\(view\)\{/);
  assert.match(app, /if\(interactionActive\)\{streamViewQueued=view;if\(!interactionHeld\)scheduleInteractionFlush\(\);return;\}/);
  assert.match(app, /function scheduleInteractionFlush\(\)\{/);
  assert.match(app, /if\(renderer\?\.isPanAnimating\?\.\(\)\)\{scheduleInteractionFlush\(\);return;\}/);
  assert.doesNotMatch(app, /streamViewOptimized|__streamInteractionGuard/);
  assert.match(app, /if\(!interactionActive&&streamAbort\)\{streamAbort\.abort\(\);streamSeq\+\+;streamViewPending=null;\}/);
  assert.match(app, /window\.addEventListener\('pointerup'/);
  assert.match(app, /window\.addEventListener\('wheel'/);
  assert.match(app, /window\.addEventListener\('blur'/);
  assert.match(app, /cadastrePublishQueued = \{ parcels, meta \}/);
  assert.match(app, /if\(cadastre\)renderer\?\.setCadastralParcels\(cadastre\.parcels,cadastre\.meta\)/);
  assert.doesNotMatch(app, /buildRegionalNav=|streamView=/);
});

test('stream race guard queues held gestures before compose and checks abort after compose', () => {
  const stream = app.match(/async function streamView\(view\)\{[\s\S]*?\nfunction scheduleInteractionFlush/)[0];
  assert.ok(stream.indexOf('if(interactionActive){streamViewQueued=view;if(!interactionHeld)scheduleInteractionFlush();return;}') < stream.indexOf('mosaic.compose('));
  assert.match(stream, /if\(seq!==streamSeq\|\|controller\.signal\.aborted\)return;[\s\S]*?await renderer\.setVillage/);
});
