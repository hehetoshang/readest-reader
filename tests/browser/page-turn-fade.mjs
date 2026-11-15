import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { chromium } from 'playwright';

// Exercise the pinned paginator and its real shadow/part styling. Synthetic
// chapters avoid a native host, personal library or authenticated server.
const fixture = `<!doctype html><html><head><style>
html,body { margin:0; width:100%; height:100%; }
foliate-view { display:block; width:100%; height:100%; }
</style></head><body><foliate-view></foliate-view><script type="module">
import '/paginator.js';
if (!location.search.includes('baseline')) {
  const link = document.createElement('link');
  link.rel = 'stylesheet'; link.href = '/globals.css';
  document.head.append(link);
  await new Promise(resolve => { link.onload = resolve; });
}
const host = document.querySelector('foliate-view');
const root = host.attachShadow({mode:'open'});
const renderer = document.createElement('foliate-paginator');
renderer.setAttribute('exportparts', 'container');
renderer.setAttribute('max-column-count', '1');
renderer.setAttribute('no-preload', '');
root.append(renderer);
const urls = Array.from({length:3}, (_, chapter) => URL.createObjectURL(new Blob([
  '<!doctype html><html><body><h1>Chapter ' + chapter + '</h1>' +
  Array.from({length:120}, (_, line) => '<p>Chapter ' + chapter + ' line ' + line +
    ': Test reading text for instant page changes without fading.</p>').join('') +
  '</body></html>'
], {type:'text/html'})));
renderer.open({dir:'ltr', sections:urls.map((url, id) => ({
  id, load:async () => url, unload() {}
}))});
await renderer.goTo({index:0, anchor:0});
window.renderer = renderer;
window.container = renderer.shadowRoot.getElementById('container');
window.ready = true;
</script></body></html>`;

test('text never fades while the independent page-turn animation remains available', async (t) => {
  const files = new Map([
    ['/paginator.js', ['text/javascript', await readFile(new URL('../../vendor/foliate-js/paginator.js', import.meta.url))]],
    ['/globals.css', ['text/css', await readFile(new URL('../../apps/readest-app/src/styles/globals.css', import.meta.url))]],
  ]);
  const server = createServer((request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const entry = files.get(pathname);
    if (entry) response.writeHead(200, { 'content-type': entry[0] }).end(entry[1]);
    else if (pathname === '/favicon.ico') response.writeHead(204).end();
    else if (pathname === '/') response.writeHead(200, { 'content-type': 'text/html' }).end(fixture);
    else response.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const browser = await chromium.launch({ headless: true });
  try {
    const url = `http://127.0.0.1:${server.address().port}/`;
    for (const viewport of [{ width: 1100, height: 800 }, { width: 412, height: 915 }]) {
      await t.test(`${viewport.width}px viewport`, async () => {
        const context = await browser.newContext({ viewport });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => {
          if (message.type() === 'error') errors.push(message.text());
        });
        page.on('requestfailed', request => errors.push(request.url()));
        page.on('response', response => {
          if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
        });
        try {
          // Negative control: prove the engine's residual opacity transition
          // exists even though it has no animated attribute.
          await page.goto(`${url}?baseline`);
          await page.waitForFunction(() => window.ready);
          assert.equal(await page.evaluate(() => getComputedStyle(window.container).transitionDuration), '0.05s');
          assert.equal(await page.evaluate(() => window.renderer.hasAttribute('animated')), false);
          const baseline = await page.evaluate(async () => {
            const { container } = window;
            container.style.opacity = '0';
            getComputedStyle(container).opacity;
            await Promise.all(container.getAnimations().map(animation => animation.finished));
            container.style.opacity = '1';
            const opacity = Number(getComputedStyle(container).opacity);
            return { opacity, animations:container.getAnimations().length };
          });
          assert.ok(baseline.opacity < 1, 'baseline text fades in instead of becoming visible immediately');
          assert.ok(baseline.animations > 0, 'baseline has an opacity animation with page turns disabled');

          await page.goto(url);
          await page.waitForFunction(() => window.ready);
          const result = await page.evaluate(async () => {
            const { renderer, container } = window;
            const fades = [];
            const observer = new MutationObserver(() => {
              if (getComputedStyle(container).transitionDuration !== '0s') fades.push('duration');
            });
            observer.observe(container, { attributes:true, attributeFilter:['style'] });
            const start = renderer.containerPosition;
            await renderer.next();
            const next = renderer.containerPosition;
            await renderer.prev();
            const previous = renderer.containerPosition;
            for (let i = 0; i < 5; i++) await renderer.next();
            await renderer.goTo({index:0, anchor:0.5});
            await renderer.goTo({index:1, anchor:0});
            await renderer.goTo({index:0, anchor:0});
            document.documentElement.setAttribute('data-eink', 'true');
            await renderer.next();
            document.documentElement.setAttribute('data-theme', 'dark');
            await renderer.prev();
            // Hide/reveal as the engine does during section display. There
            // must be no intermediate opacity or CSS opacity animation.
            container.style.opacity = '0';
            getComputedStyle(container).opacity;
            await new Promise(requestAnimationFrame);
            container.style.opacity = '1';
            const opacity = getComputedStyle(container).opacity;
            const opacityAnimations = container.getAnimations().filter(animation =>
              animation.effect.getKeyframes().some(frame => 'opacity' in frame)).length;
            // Re-enabling the independent toggle still animates a page turn.
            renderer.setAttribute('animated', '');
            let moving = false;
            const turn = renderer.next();
            await new Promise(requestAnimationFrame);
            moving = container.getAnimations({subtree:true}).length > 0 ||
              [...container.children].some(child => child.style.transform !== '');
            await turn;
            renderer.removeAttribute('animated');
            observer.disconnect();
            return {start, next, previous, fades, opacity, opacityAnimations, moving,
              contents:renderer.getContents().length,
              duration:getComputedStyle(container).transitionDuration};
          });
          assert.ok(result.next > result.start, 'next page moves forward');
          assert.ok(Math.abs(result.previous - result.start) < 1, 'previous page restores the position');
          assert.deepEqual(result.fades, []);
          assert.equal(result.opacity, '1');
          assert.equal(result.opacityAnimations, 0);
          assert.equal(result.duration, '0s');
          assert.ok(result.contents > 0, 'chapter remains rendered');
          assert.ok(result.moving, 'independent animated toggle still enables movement');
          assert.deepEqual(errors, []);
        } finally {
          await context.close();
        }
      });
    }
  } finally {
    await browser.close();
  }
});
