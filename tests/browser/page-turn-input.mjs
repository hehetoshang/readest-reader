import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { chromium } from 'playwright';

// CLI browser regression, NOT Playwright MCP or Android/native acceptance.
// Production React settings, pagination hook, device store and iframe handlers
// run against explicit host/storage/renderer doubles and an original HTML text
// fixture. No EPUB loader, Foliate renderer or native bridge is exercised here.
const appRoot = fileURLToPath(new URL('../../apps/readest-app/', import.meta.url));
const appRequire = createRequire(path.join(appRoot, 'package.json'));
const viteRequire = createRequire(appRequire.resolve('vite/package.json'));
const { build } = viteRequire('esbuild');
const evidence = process.env.TB496_EVIDENCE_DIR;
const mocks = {
  '@/context/EnvContext': `export const useEnv = () => ({envConfig:{},appService:{isMobileApp:true,isMobile:true}});`,
  '@/utils/bridge': `export async function interceptKeys(value) { window.nativeCalls.push(value); }
    export const getScreenBrightness = async () => ({brightness:1});
    export const setScreenBrightness = async () => {}; export const refreshEinkScreen = async () => {};`,
  '@/store/readerStore': `import {create} from 'zustand';
    export const useReaderStore = create((set,get) => ({
      viewStates:{book:{inited:true,viewSettings:{volumeKeysToFlip:true,disableClick:false,zoomLevel:100,zoomMode:'fit-page'}}},
      hoveredBookKey:null, getViewState:key=>get().viewStates[key],
      getViewSettings:key=>get().viewStates[key]?.viewSettings,
      setHoveredBookKey:key=>set({hoveredBookKey:key})
    }));
    export function update(patch) { const state=useReaderStore.getState(); useReaderStore.setState({viewStates:{book:{...state.viewStates.book,viewSettings:{...state.getViewSettings('book'),...patch}}}}); }`,
  '@/store/bookDataStore': `export const useBookDataStore=()=>({getBookData:()=>({isFixedLayout:false})});`,
  '@/store/settingsStore': `const state={settings:{hardwarePageTurner:{enabled:false,bindings:{}}}};
    export const useSettingsStore=Object.assign(selector=>selector?selector(state):state,{getState:()=>state});`,
  '@/store/sidebarStore': `export const useSidebarStore={getState:()=>({sideBarBookKey:null})};`,
  '@/helpers/settings': `import {update} from '@/store/readerStore';
    export const saveViewSettings=(_env,_key,field,value)=>update({[field]:value}); export const saveSysSettings=()=>{};`,
  '@/hooks/useResetSettings': `export const useResetViewSettings=()=>()=>{};`,
  '@/hooks/useTranslation': `export const useTranslation=()=>text=>text;`,
  '@/utils/window': `export const tauriGetWindowLogicalPosition=async()=>({x:0,y:0});`,
  '@/services/environment': `export const isTauriAppPlatform=()=>true;`,
  '@/app/reader/hooks/useTouchInterceptor': `export const useTouchInterceptor=()=>{};`,
  '@/components/settings/primitives': `import React from 'react';
    export const BoxedList=({children})=><section>{children}</section>;
    export const SettingsRow=({children})=><div>{children}</div>;
    export const SettingsSwitchRow=({label,checked,onChange})=><button aria-pressed={checked} onClick={onChange}>{label}</button>;`,
};
const entry = `import React, {useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {usePagination} from '@/app/reader/hooks/usePagination';
import PageTurnerSettings from '@/components/settings/PageTurnerSettings';
import {useReaderStore,update} from '@/store/readerStore';
import {useDeviceControlStore} from '@/store/deviceStore';
import {eventDispatcher} from '@/utils/event';
import * as handlers from '@/app/reader/utils/iframeEventHandlers';
window.nativeCalls=[]; window.turns=[]; window.eventTrace=[];
window.fixture={update,state:()=>useDeviceControlStore.getState(),settings:()=>useReaderStore.getState().getViewSettings('book')};
function Reader(){
  const container=useRef(null); const [panel,setPanel]=useState(false); const [count,setCount]=useState(0);
  const hovered=useReaderStore(s=>s.hoveredBookKey);
  const settings=useReaderStore(s=>s.getViewSettings('book'));
  const view=useRef({book:{},renderer:{scrolled:false},prev:()=>{window.turns.push('prev');setCount(n=>n+1)},next:()=>{window.turns.push('next');setCount(n=>n+1)}});
  const {handlePageFlip}=usePagination('book',view,container);
  const disabled=useRef(false); disabled.current=!!settings.disableDoubleClick;
  useEffect(()=>{
    const receive=event=>{if(event.data?.type==='iframe-single-click') handlePageFlip(event)};
    window.addEventListener('message',receive);
    return ()=>{window.removeEventListener('message',receive);handlers.clearIframeClickState('book')};
  },[handlePageFlip]);
  const loaded=event=>{
    const doc=event.currentTarget.contentDocument;
    for(const type of ['pointerdown','pointerup','touchstart','touchmove','touchend','mousedown','mouseup','click']){
      doc.addEventListener(type,event=>window.eventTrace.push({type,at:performance.now(),x:event.screenX,y:event.screenY}),true);
    }
    for(const [name,handler] of [['mousedown',handlers.handleMousedown],['mouseup',handlers.handleMouseup],['touchstart',handlers.handleTouchStart],['touchmove',handlers.handleTouchMove],['touchend',handlers.handleTouchEnd],['touchcancel',handlers.handleTouchCancel]]) doc.addEventListener(name,handler.bind(null,'book'));
    doc.addEventListener('click',handlers.handleClickCapture.bind(null,'book'),true);
    doc.addEventListener('click',handlers.handleClick.bind(null,'book',disabled,false));
  };
  return <div ref={container}>
    <button onClick={()=>setPanel(!panel)}>Settings</button>
    <button onClick={()=>update({disableClick:!settings.disableClick})}>Click paging</button>
    <button onClick={()=>update({swapClickArea:!settings.swapClickArea})}>Swap sides</button>
    <output>Turns: {count}; menu: {hovered?'open':'closed'}</output>
    {panel&&<PageTurnerSettings bookKey='book'/>}
    <iframe title='Synthetic reading text' onLoad={loaded} srcDoc={'<!doctype html><html><body style="margin:0;background:#fffdf5;font:22px Georgia;min-height:100vh"><h2 style="text-align:center">Original reading fixture</h2><p style="padding:12px">Left and right tap regions surround the center menu region. This is synthetic text for reader input regression.</p><p style="padding:12px">Long presses, double clicks and swipes must preserve their existing input roles.</p></body></html>'}/>
  </div>;
}
function App(){const [open,setOpen]=useState(true);return <><h1>Reader input regression harness</h1><p>Mock native host, storage and paginator; production input handlers and settings.</p><button onClick={()=>setOpen(!open)}>Leave / reenter reader</button>{open&&<Reader/>}</>}
createRoot(document.getElementById('root')).render(<App/>);`;

test('production input handlers and React settings in desktop/touch browser contexts', async t => {
  const bundle = await build({
    stdin: {contents:entry, loader:'tsx', resolveDir:appRoot}, bundle:true, write:false,
    platform:'browser', format:'iife', define:{'process.env.NODE_ENV':'"production"','process.env':'{}'},
    tsconfig:path.join(appRoot,'tsconfig.json'),
    plugins:[{name:'explicit-host-doubles',setup(api){
      api.onResolve({filter:/^@\//}, args => args.path in mocks ? {path:args.path,namespace:'host-double'} : undefined);
      api.onResolve({filter:/^\.\/primitives$/},args => args.importer.endsWith('PageTurnerSettings.tsx') ? {path:'@/components/settings/primitives',namespace:'host-double'} : undefined);
      api.onLoad({filter:/.*/,namespace:'host-double'}, args => ({contents:mocks[args.path],loader:'tsx',resolveDir:appRoot}));
    }}],
  });
  const server=createServer((request,response)=>{
    if(request.url==='/input.js') response.writeHead(200,{'content-type':'text/javascript'}).end(bundle.outputFiles[0].text);
    else if(request.url==='/favicon.ico') response.writeHead(204).end();
    else response.writeHead(200,{'content-type':'text/html'}).end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font:16px sans-serif;background:#eee}h1,p{margin:12px}button{margin:4px;padding:8px}iframe{display:block;width:100%;height:65vh;border:0}output{display:block;padding:8px}</style><div id="root"></div><script src="/input.js"></script>`);
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const browser=await chromium.launch({headless:true});
  try {
    for(const viewport of [{width:1100,height:800},{width:412,height:915}]) {
      await t.test(`${viewport.width}px`,async()=>{
        const context=await browser.newContext({viewport,hasTouch:true,isMobile:viewport.width<500});
        const page=await context.newPage(); const errors=[];
        page.setDefaultTimeout(5000);
        page.on('pageerror',error=>errors.push(error.message));
        page.on('console',message=>{if(message.type()==='error')errors.push(message.text())});
        page.on('requestfailed',request=>errors.push(request.url()));
        page.on('response',response=>{if(response.status()>=400)errors.push(response.status()+' '+response.url())});
        const url=`http://127.0.0.1:${server.address().port}/`;
        try {
          await page.goto(url); await page.waitForFunction(()=>window.fixture?.state().volumeKeysInterceptionCount===1,null,{timeout:10000});
          const count=()=>page.evaluate(()=>window.turns.length);
          for(let i=0;i<3;i++){await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('button',{name:'Settings',exact:true}).click()}
          assert.equal(await page.evaluate(()=>window.fixture.state().volumeKeysInterceptionCount),1);
          await page.getByRole('button',{name:'Settings',exact:true}).click();
          await page.getByRole('button',{name:'Use Volume Keys',exact:true}).click();
          assert.equal(await page.evaluate(()=>window.fixture.state().volumeKeysInterceptionCount),0);
          await page.getByRole('button',{name:'Use Volume Keys',exact:true}).click();
          await page.getByRole('button',{name:'Settings',exact:true}).click();
          await page.evaluate(async()=>{await window.onNativeKeyDown('VolumeUp',24);await window.onNativeKeyDown('VolumeDown',25)});
          assert.deepEqual(await page.evaluate(()=>window.turns),['prev','next']);
          const frame=page.locator('iframe'); const rect=await frame.boundingBox();
          const tap=async(ratio,hold=0)=>{await page.mouse.click(rect.x+rect.width*ratio,rect.y+rect.height*0.55,{delay:hold});await page.waitForTimeout(300)};
          await tap(.15,300); await tap(.85,300);
          assert.deepEqual(await page.evaluate(()=>window.turns),['prev','next','prev','next']);
          await tap(.5); assert.match(await page.locator('output').innerText(),/menu: open/);
          await tap(.85); assert.equal(await count(),4); // dismiss menu
          await page.getByRole('button',{name:'Swap sides'}).click(); await tap(.15); await tap(.85);
          assert.deepEqual(await page.evaluate(()=>window.turns.slice(-2)),['next','prev']);
          await tap(.85,600); assert.equal(await count(),6);
          await page.mouse.dblclick(rect.x+rect.width*.85,rect.y+rect.height*.55); await page.waitForTimeout(300);
          assert.equal(await count(),6);
          // Actual Chromium touch produces its own compatibility sequence.
          await page.touchscreen.tap(rect.x+rect.width*.15,rect.y+rect.height*.55); await page.waitForTimeout(300);
          assert.equal(await count(),7);
          await page.getByRole('button',{name:'Click paging'}).click(); await tap(.15); assert.equal(await count(),7);
          await page.getByRole('button',{name:'Leave / reenter reader'}).click();
          assert.equal(await page.evaluate(()=>window.fixture.state().volumeKeysInterceptionCount),0);
          await page.getByRole('button',{name:'Leave / reenter reader'}).click();
          assert.equal(await page.evaluate(()=>window.fixture.settings().disableClick),true);
          assert.equal(await page.evaluate(()=>window.fixture.settings().swapClickArea),true);
          assert.equal(await page.evaluate(()=>window.fixture.state().volumeKeysInterceptionCount),1);
          assert.deepEqual(errors,[]);
          if(evidence){
            await mkdir(evidence,{recursive:true});
            await page.screenshot({path:path.join(evidence,`input-${viewport.width}.png`),fullPage:true});
            await writeFile(path.join(evidence,`input-${viewport.width}.json`),JSON.stringify({url,viewport,errors,...await page.evaluate(()=>({turns:window.turns,nativeCalls:window.nativeCalls,eventTrace:window.eventTrace,settings:window.fixture.settings()}))},null,2));
          }
        } catch(error) {
          if(evidence){
            await mkdir(evidence,{recursive:true});
            await writeFile(path.join(evidence,`failure-${viewport.width}.json`),JSON.stringify({url,viewport,errors,...await page.evaluate(()=>({turns:window.turns,eventTrace:window.eventTrace}))},null,2));
          }
          throw new Error(`${error.message}; browser errors: ${JSON.stringify(errors)}`,{cause:error});
        } finally {await context.close()}
      });
    }
  } finally {await browser.close()}
});
