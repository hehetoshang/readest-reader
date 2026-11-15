import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { chromium } from 'playwright';
import ts from 'typescript';

const fixture = `<!doctype html><style>
html,body{margin:0;width:100%;height:100%}foliate-view{display:block;width:100%;height:100%}
</style><foliate-view></foliate-view><script type="module">
import '/view.js';
import { preserveInitialLocation } from '/initialLocation.js';
import { wrappedFoliateView } from '/wrapped-view.js';
const locationOrigin=window.location.href;
const baseStyle='html{font:16px serif}p{line-height:1.4;margin:.6em 0}';
const chapter='<html><head><title>Original chapter</title></head><body><h1>Chapter</h1>'+Array.from({length:100},(_,i)=>'<p id="p'+i+'">Chapter 0, paragraph '+i+'. Independent original QA text records the current page. Reading should stay clear when moving forwards and backwards, with no opacity fade after closing animation.</p>').join('')+'</body></html>';
window.openReader=async(location,fixed=true,earlyTarget)=>{
  window.restore?.cancel();
  window.view?.close();
  document.querySelector('foliate-view')?.remove();
  const view=wrappedFoliateView(document.createElement('foliate-view'));document.body.append(view);window.view=view;
  const urls=[0,1,2].map(()=>URL.createObjectURL(new Blob([chapter],{type:'text/html'})));
  await view.open({metadata:{language:'en'},dir:'ltr',sections:urls.map((url,index)=>({id:String(index),load:async()=>url,unload(){URL.revokeObjectURL(url)}}))});
  const r=view.renderer;r.setAttribute('max-column-count','1');r.setAttribute('no-preload','');
  r.setStyles(baseStyle);
  const sheets=new WeakMap();
  view.addEventListener('load',({detail:{doc}})=>{
    const link=doc.createElement('link');link.rel='stylesheet';link.href=new URL('/fonts.css?'+Math.random(),locationOrigin).href;
    const ready=new Promise(resolve=>{link.onload=resolve;link.onerror=resolve});
    sheets.set(doc,ready);window.stylesReady=ready;
    doc.head.append(link);
  },{once:true});
  if(location&&fixed)window.restore=preserveInitialLocation(view,location,sheets);
  else window.restore=null;
  if(location){
    const initialized=view.init({lastLocation:location});
    if(earlyTarget!==undefined)await view.goTo(earlyTarget);
    else if(fixed)await view.goTo(location); // Moke can repeat restore before iframe load.
    await initialized;
  }else await r.goTo({index:0,anchor:0});
  window.finished=window.restore?.complete()||Promise.resolve();
  return true;
};
window.settle=async()=>{
  window.phase='restore';
  await window.finished;
  window.phase='styles';
  await window.stylesReady;
  window.phase='fonts';
  for(const {doc} of view.renderer.getContents())await doc.fonts.ready;
  window.phase='frame';
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  window.phase='done';
};
window.glyph=cfi=>{
 const {index,anchor}=view.resolveCFI(cfi),doc=view.renderer.getContents().find(c=>c.index===index).doc;
 const range=anchor(doc);let node=range.startContainer,offset=range.startOffset;
 if(node.nodeType!==3){const walker=doc.createTreeWalker(node,NodeFilter.SHOW_TEXT);node=walker.nextNode();offset=0}
 while(offset<node.length&&/\\s/.test(node.textContent[offset]))offset++;
 const q=doc.createRange();q.setStart(node,offset);q.setEnd(node,offset+1);
 const frame=doc.defaultView.frameElement.getBoundingClientRect();
 return [...q.getClientRects()].some(rect=>rect.width>0&&rect.right+frame.x>0&&rect.x+frame.x<innerWidth&&rect.bottom+frame.y>0&&rect.y+frame.y<innerHeight);
};
await openReader();window.ready=true;
</script>`;

test('initial location survives late font styles and yields to subsequent navigation', async (t) => {
  const settle = async page => {
    await page.evaluate(() => {window.settled=false;window.settle().then(()=>window.settled=true)});
    try { await page.waitForFunction(() => window.settled); }
    catch(error) {throw new Error('settle phase: '+await page.evaluate(()=>window.phase),{cause:error})}
  };
  const vendor = new URL('../../vendor/foliate-js/', import.meta.url);
  const helper = ts.transpileModule(await readFile(new URL('../../apps/readest-app/src/app/reader/utils/initialLocation.ts', import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText.replaceAll('foliate-js/paginator.js', '/paginator.js');
  const wrapped = ts.transpileModule(await readFile(new URL('../../apps/readest-app/src/types/view.ts', import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const font = await readFile(new URL('../../apps/readest-app/public/fonts/InterVariable.woff2', import.meta.url));
  const pending = [];
  const fontRequests = [];
  let delayed = false;
  let fontDelayed = false;
  let fontVersion = 0;
  const release = () => { for (const resolve of pending.splice(0)) resolve(); };
  const releaseFonts = () => { for (const resolve of fontRequests.splice(0)) resolve(); };
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/fonts.css') {
      if (delayed) await new Promise(resolve => pending.push(resolve));
      res.writeHead(200, { 'content-type': 'text/css' }).end('@font-face{font-family:Probe;src:url(/font.woff2?v='+(++fontVersion)+');font-display:swap}html{font-family:Probe,Arial}');
    } else if (pathname === '/font.woff2') {
      if(fontDelayed)await new Promise(resolve=>fontRequests.push(resolve));
      res.writeHead(200, { 'content-type': 'font/woff2', 'cache-control':'no-store' }).end(font);
    }
    else if (pathname === '/initialLocation.js') res.writeHead(200, { 'content-type': 'text/javascript' }).end(helper);
    else if (pathname === '/wrapped-view.js') res.writeHead(200, { 'content-type': 'text/javascript' }).end(wrapped);
    else if (pathname.endsWith('.js')) {
      try { res.writeHead(200, { 'content-type': 'text/javascript' }).end(await readFile(new URL('.' + pathname, vendor))); }
      catch { res.writeHead(404).end(); }
    } else if (pathname === '/favicon.ico') res.writeHead(204).end();
    else res.writeHead(200, { 'content-type': 'text/html' }).end(fixture);
  });
  server.listen(0, '127.0.0.1');await once(server, 'listening');
  const browser = await chromium.launch({ headless: true });
  try {
    for (const viewport of [{width:412,height:915},{width:1280,height:800}]) {
      await t.test(`${viewport.width}px`, async () => {
        const context = await browser.newContext({viewport});
        const page = await context.newPage();
        page.setDefaultTimeout(10000);
        const errors = [];page.on('pageerror', error => errors.push(error.message));
        try {
          await page.goto(`http://127.0.0.1:${server.address().port}`);
          await page.waitForFunction(() => window.ready);
          await settle(page);
          // Save real visible ranges (including whitespace at column boundaries),
          // then reconstruct documents just as cold open/reload does.
          const locations = await page.evaluate(async () => {
            const result=[];
            for(let i=0;i<7;i++){await view.next();result.push(view.lastLocation.cfi)}
            const doc=view.renderer.getContents()[0].doc,q=doc.createRange();q.setStart(doc.getElementById('p27').firstChild,50);q.setEnd(q.startContainer,51);
            result.push(view.getCFI(0,q));return result;
          });
          let negativeFailures = 0;
          for (const [index, location] of locations.entries()) {
            delayed = true;
            await page.evaluate(({location}) => openReader(location, false), {location});
            await page.waitForFunction(() => view.renderer.getContents().some(({doc}) => !!doc.body));
            delayed = false;release();await settle(page);
            if (!await page.evaluate(location => glyph(location), location)) negativeFailures++;

            delayed = true;
            await page.evaluate(({location}) => openReader(location), {location});
            await page.waitForFunction(() => view.renderer.getContents().some(({doc}) => !!doc.body));
            // Reflow while pending must not consume the initial intent.
            await page.evaluate(index => {
              document.documentElement.style.background = index%2?'black':'white';
              view.renderer.setAttribute('margin-top', index%2?'34px':'26px');
            }, index);
            delayed = false;release();await settle(page);
            assert.equal(await page.evaluate(location => glyph(location), location), true, `restored glyph ${index}`);
          }
          if(viewport.width===412)assert.ok(negativeFailures>0, 'negative control detects lost reading context');

          delayed=true;fontDelayed=true;
          await page.evaluate(location=>openReader(location),locations[3]);
          delayed=false;release();
          await page.waitForFunction(()=>view.renderer.getContents()[0].doc.fonts.status==='loading');
          assert.equal(await page.evaluate(()=>restore.signal.aborted),false,'restoration waits for font bytes after CSS');
          await page.evaluate(()=>view.renderer.render());
          fontDelayed=false;releaseFonts();await settle(page);
          assert.equal(await page.evaluate(location=>glyph(location),locations[3]),true,'glyph stays visible after separately delayed font and reflow');

          for (const action of ['next','prev','animated','jump','close']) {
            delayed = true;
            await page.evaluate(location => openReader(location), locations[3]);
            await page.waitForFunction(() => view.renderer.getContents().some(({doc}) => !!doc.body));
            await page.evaluate(location => {
              view.goTo(location);
              window.publicScrolls=0;
              const original=view.renderer.scrollToAnchor.bind(view.renderer);
              view.renderer.scrollToAnchor=(...args)=>{window.publicScrolls++;return original(...args)};
            }, locations[3]);
            assert.equal(await page.evaluate(()=>restore.signal.aborted),false,'identical host restore keeps intent');
            const before = await page.evaluate(async action => {
              if(action==='jump'){
                await view.goTo(1);
              }else if(action==='close'){restore.cancel();view.close()}
              else {
                if(action==='animated')view.renderer.setAttribute('animated','');
                const turn=view[action==='animated'?'next':action]();
                if(!restore.signal.aborted)throw new Error('reading intent must cancel before animation completes');
                await turn;
              }
              window.publicScrolls=0;
              return {canceled:restore.signal.aborted,index:view.renderer.primaryIndex};
            }, action);
            assert.equal(before.canceled, true, `${action} cancels restore`);
            delayed = false;release();await page.evaluate(() => window.finished);
            assert.equal(await page.evaluate(()=>window.publicScrolls),0,`${action} is never overwritten by a late restore`);
            if(action==='jump')assert.equal(await page.evaluate(() => view.renderer.primaryIndex),1);
          }
          await page.evaluate(location => openReader(location,true,1),locations[3]);
          await settle(page);
          assert.equal(await page.evaluate(()=>view.renderer.primaryIndex),1,'jump during initial iframe load takes ownership without stranding init');
          assert.deepEqual(errors, []);
        } finally { delayed=false;fontDelayed=false;release();releaseFonts();await context.close(); }
      });
    }
  } finally { release();releaseFonts();await browser.close();await new Promise(resolve => server.close(resolve)); }
});
