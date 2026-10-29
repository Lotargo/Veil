import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../app/static/js/features/simple-mode-v2.js', import.meta.url), 'utf8');

function harness(available = [], delayed = []) {
    const requests = [];
    const pending = new Map();
    const timers = new Map();
    let nextTimer = 0;
    const storage = () => {
        const values = new Map();
        return {
            getItem: key => values.get(key) ?? null,
            setItem: (key, value) => values.set(key, String(value)),
            removeItem: key => values.delete(key),
        };
    };
    const element = () => {
        const classes = new Set();
        return {
            hidden: true, dataset: {}, style: { removeProperty() {} }, innerHTML: '',
            classList: {
                add: name => classes.add(name), remove: name => classes.delete(name),
                contains: name => classes.has(name),
            },
            querySelectorAll: () => [],
        };
    };
    const elements = new Map(['studio-layout', 'result', 'generating', 'ambient-a', 'ambient-b',
        'ambient-backdrop-a', 'ambient-backdrop-b', 'result-thumbnails', 'result-compare', 'result-img'].map(id => [id, element()]));
    elements.get('studio-layout').dataset.view = 'idle';
    const ambient = element();
    const artwork = element();
    const context = vm.createContext({
        localStorage: storage(), sessionStorage: storage(),
        document: {
            readyState: 'loading', addEventListener() {}, getElementById: id => elements.get(id),
            createElement: () => ({
                textContent: '',
                get innerHTML() { return this.textContent.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'); },
            }),
            querySelector: selector => selector === '.ambient-container' ? ambient
                : selector === '.ambient-container.has-ambient' ? (ambient.classList.contains('has-ambient') ? ambient : null)
                    : selector === '.canvas-artwork-wrap' ? artwork : null,
        },
        URL,
        Image: class {
            set src(url) {
                requests.push(url);
                const settle = () => {
                    this.naturalWidth = available.includes(url) ? 100 : 0;
                    if (this.naturalWidth) this.onload?.(); else this.onerror?.();
                };
                if (delayed.includes(url)) pending.set(url, settle); else queueMicrotask(settle);
            }
        },
        setInterval: (callback, interval) => {
            const id = ++nextTimer;
            timers.set(id, {callback, interval});
            return id;
        },
        clearInterval: id => timers.delete(id), requestAnimationFrame() {},
    });
    vm.runInContext(source, context);
    // Keep layout measurement out of this image-loading integration seam.
    vm.runInContext(`resizePrompt = () => {}; syncCanvasAspect = () => {}; paintRefs = () => {}; animateLayout = mutate => mutate();`, context);
    return {
        context, elements, ambient, artwork, requests, pending, timers,
        run: code => vm.runInContext(code, context),
        cache(outputs) {
            context.localStorage.setItem('mediastudio_simple_last_result', JSON.stringify({ data: { outputs } }));
        },
    };
}

test('a missing saved result is cleared without displaying a broken image', async () => {
    const h = harness();
    h.cache([{ preview_url: '/missing', thumbnail_url: '/missing-thumb' }]);
    await h.run('restoreLastResult()');
    assert.equal(h.elements.get('studio-layout').dataset.view, 'idle');
    assert.equal(h.elements.get('result').hidden, true);
    assert.equal(h.context.localStorage.getItem('mediastudio_simple_last_result'), null);
    assert.equal(h.run('state.last'), null);
});

test('a missing saved background falls through to a working library image', async () => {
    const h = harness(['/working']);
    h.context.localStorage.setItem('mediastudio_simple_ambient_last', '/missing');
    h.context.localStorage.setItem('mediastudio_simple_ambient_items', JSON.stringify([{ id: 2, preview_url: '/working' }]));
    await h.run('hydrateAmbient()');
    assert.equal(h.ambient.classList.contains('has-ambient'), true);
    assert.equal(h.context.localStorage.getItem('mediastudio_simple_ambient_last'), '/working');
    assert.match(h.elements.get('ambient-b').style.backgroundImage, /working/);
});

test('background selection skips unavailable items and uses the thumbnail fallback', async () => {
    const h = harness(['/thumb']);
    h.run(`state.ambient = [
        {id: 1, original_url: '/gone', preview_url: '/gone-preview'},
        {id: 2, original_url: '/original', preview_url: '/preview', thumbnail_url: '/thumb'}
    ]; state.ambientDeck = [...state.ambient];`);
    await h.run('ambientPick()');
    assert.equal(h.context.localStorage.getItem('mediastudio_simple_ambient_last'), '/thumb');
    assert.equal(h.run('state.ambientCurrent'), 2);
});

test('restoration retains available results and removes missing batch entries', async () => {
    const h = harness(['/thumb']);
    h.cache([{ id: 1, preview_url: '/gone' }, { id: 2, preview_url: '/preview', thumbnail_url: '/thumb' }]);
    await h.run('restoreLastResult()');
    assert.equal(h.elements.get('studio-layout').dataset.view, 'result');
    assert.equal(h.run('state.last.id'), 2);
    assert.equal(h.run('state.lastOutputs.length'), 1);
    assert.equal(h.elements.get('result-img').src, '/thumb');
    assert.equal(JSON.parse(h.context.localStorage.getItem('mediastudio_simple_last_result')).data.outputs.length, 1);
});

test('a result deleted in the library is not restored from the browser cache', async () => {
    const h = harness(['/deleted', '/kept']);
    h.context.fetch = async url => ({ status: url.endsWith('/7') ? 404 : 200 });
    h.cache([{ id: 7, preview_url: '/deleted' }, { id: 8, preview_url: '/kept' }]);
    await h.run('restoreLastResult()');
    assert.equal(h.run('state.lastOutputs.length'), 1);
    assert.equal(h.run('state.last.id'), 8);
    assert.equal(h.requests.includes('/deleted'), false);
});

test('a late restored result cannot replace a new generation', async () => {
    const h = harness(['/slow'], ['/slow']);
    h.cache([{ preview_url: '/slow' }]);
    const restored = h.run('restoreLastResult()');
    h.run("clearLastResult(); canvas('generating');");
    h.pending.get('/slow')?.();
    await restored;
    assert.equal(h.elements.get('studio-layout').dataset.view, 'generating');
    assert.equal(h.run('state.last'), null);
});

test('an earlier slow background cannot overwrite the latest selection', async () => {
    const h = harness(['/slow', '/fast'], ['/slow']);
    const old = h.run("setAmbient('/slow')");
    await h.run("setAmbient('/fast')");
    h.pending.get('/slow')?.();
    await old;
    assert.equal(h.context.localStorage.getItem('mediastudio_simple_ambient_last'), '/fast');
});

test('an exhausted background pool keeps the neutral fallback and stops retrying', async () => {
    const h = harness();
    h.run("state.ambient = [{id: 1, preview_url: '/gone'}]; state.ambientDeck = [...state.ambient];");
    await h.run('ambientPick()');
    assert.equal(h.ambient.classList.contains('has-ambient'), false);
    assert.equal(h.run('state.ambient.length'), 0);
    assert.equal(h.requests.length, 1);
});

test('restoring a session result migrates its surviving entries to local storage', async () => {
    const h = harness(['/good']);
    h.context.sessionStorage.setItem('mediastudio_simple_last_result', JSON.stringify({ outputs: [{preview_url: '/gone'}, {preview_url: '/good'}] }));
    await h.run('restoreLastResult()');
    assert.equal(h.context.sessionStorage.getItem('mediastudio_simple_last_result'), null);
    const cached = JSON.parse(h.context.localStorage.getItem('mediastudio_simple_last_result')).data;
    assert.equal(cached.outputs.length, 1);
    assert.equal(cached.outputs[0].preview_url, '/good');
});

test('an authoritative empty library never restores old cached backgrounds', async () => {
    const h = harness(['/old']);
    h.elements.set('simple-ambient-initial', { textContent: '[]' });
    h.context.localStorage.setItem('mediastudio_simple_ambient_last', '/old');
    h.context.localStorage.setItem('mediastudio_simple_ambient_items', JSON.stringify([{id: 1, preview_url: '/old'}]));
    await h.run('hydrateAmbient()');
    assert.equal(h.ambient.classList.contains('has-ambient'), false);
    assert.equal(h.requests.length, 0);
    assert.equal(h.context.localStorage.getItem('mediastudio_simple_ambient_last'), null);
});

test('removing the last library image clears the visible background and pending loads', async () => {
    const h = harness(['/old', '/slow'], ['/slow']);
    await h.run("setAmbient('/old')");
    const pending = h.run("setAmbient('/slow')");
    h.context.fetch = async () => ({ok: true, json: async () => ({items: []})});
    await h.run('loadAmbient()');
    h.pending.get('/slow')();
    await pending;
    assert.equal(h.ambient.classList.contains('has-ambient'), false);
    assert.equal(h.context.localStorage.getItem('mediastudio_simple_ambient_last'), null);
    assert.equal(h.elements.get('ambient-b').style.backgroundImage, '');
});

test('generation results do not replace the background chosen from library sources', async () => {
    const h = harness(['/library', '/generated']);
    await h.run("setAmbient('/library')");
    await h.run("renderResult([{preview_url: '/generated'}])");
    assert.equal(h.context.localStorage.getItem('mediastudio_simple_ambient_last'), '/library');
});

test('source changes refresh the ambient pool through the existing folder event stream', async () => {
    const h = harness(['/new']);
    let events;
    let refreshes = 0;
    h.context.EventSource = class {
        constructor(url) { assert.equal(url, '/api/folders/events'); events = this; }
    };
    h.context.fetch = async () => {
        refreshes += 1;
        return {ok: true, json: async () => ({items: [{id: 2, preview_url: '/new'}]})};
    };
    h.run('watchAmbientSources()');
    events.onmessage({data: JSON.stringify({})});
    events.onmessage({data: JSON.stringify({2: {image_count: 1, enabled: true, source_status: 'available', revision: 0}})});
    await new Promise(setImmediate);
    assert.ok(refreshes > 0);
    assert.equal(h.context.localStorage.getItem('mediastudio_simple_ambient_last'), '/new');
    const settled = refreshes;
    events.onmessage({data: JSON.stringify({2: {image_count: 1, enabled: true, source_status: 'available', revision: 0}})});
    await new Promise(setImmediate);
    assert.equal(refreshes, settled);
});

test('a source refresh cancels a pending image outside the new pool', async () => {
    const h = harness(['/current', '/removed'], ['/removed']);
    await h.run("setAmbient({id: 1, preview_url: '/current'})");
    const pending = h.run("setAmbient({id: 2, preview_url: '/removed'})");
    h.context.fetch = async () => ({ok: true, json: async () => ({items: [{id: 1, preview_url: '/current'}]})});
    await h.run('loadAmbient()');
    h.pending.get('/removed')();
    await pending;
    assert.equal(h.context.localStorage.getItem('mediastudio_simple_ambient_last'), '/current');
});

test('refreshing a source pool preserves the selected interval timer', async () => {
    const h = harness(['/current', '/next']);
    h.run("state.ambient = [{id: 1, preview_url: '/current'}, {id: 2, preview_url: '/next'}]; state.interval = 60000;");
    await h.run("setAmbient(state.ambient[0])");
    h.run('restartAmbientTimer()');
    const timer = h.run('state.timer');
    h.context.fetch = async () => ({ok: true, json: async () => ({items: [{id: 1, preview_url: '/current'}, {id: 2, preview_url: '/next'}]})});
    await h.run('loadAmbient()');
    assert.equal(h.run('state.timer'), timer);
    assert.equal(h.timers.get(timer).interval, 60000);
});

test('interval ticks do not restart the timer or overlap a slow image load', async () => {
    const h = harness(['/current', '/slow', '/third'], ['/slow']);
    h.run("state.ambient = [{id: 1, preview_url: '/current'}, {id: 2, preview_url: '/slow'}, {id: 3, preview_url: '/third'}]; state.ambientDeck = state.ambient.slice(1); state.interval = 15000;");
    await h.run("setAmbient(state.ambient[0])");
    h.run('restartAmbientTimer()');
    const timer = h.run('state.timer');
    const tick = h.timers.get(timer).callback;
    const first = tick();
    const second = tick();
    h.pending.get('/slow')();
    await Promise.all([first, second]);
    assert.equal(h.run('state.timer'), timer);
    assert.equal(h.context.localStorage.getItem('mediastudio_simple_ambient_last'), '/slow');
});

test('changing the interval cancels an earlier automatic switch and disabling stops it', async () => {
    const h = harness(['/current', '/slow'], ['/slow']);
    h.run("state.ambient = [{id: 1, preview_url: '/current'}, {id: 2, preview_url: '/slow'}]; state.ambientDeck = state.ambient.slice(1); state.interval = 15000;");
    await h.run("setAmbient(state.ambient[0])");
    h.run('restartAmbientTimer()');
    const pending = h.timers.get(h.run('state.timer')).callback();
    h.run('setAmbientInterval(60)');
    assert.equal([...h.timers.values()][0].interval, 60000);
    h.pending.get('/slow')();
    await pending;
    assert.equal(h.context.localStorage.getItem('mediastudio_simple_ambient_last'), '/current');
    h.run('setAmbientInterval(0)');
    assert.equal(h.timers.size, 0);
    assert.equal(h.context.localStorage.getItem('mediastudio_simple_ambient_interval'), '0');
});


test('Create displays Google access in place and hides stale consent links', () => {
    const h = harness();
    for (const id of ['drive-access', 'drive-access-backdrop', 'drive-access-open', 'drive-access-copy',
        'drive-access-message', 'drive-access-confirm', 'drive-access-cancel']) {
        h.elements.set(id, {hidden: true, focus() { this.focused = true; }});
    }
    h.run(`state.backend = 'colab'; state.colab = {state: 'booting', model_cache: {
        state: 'authorizing', auth_url: 'https://accounts.google.com/test-consent'}}; paintDriveAccess();`);
    assert.equal(h.elements.get('drive-access').hidden, false);
    assert.equal(h.elements.get('drive-access-open').href, 'https://accounts.google.com/test-consent');
    assert.equal(h.elements.get('drive-access-open').focused, true);
    assert.equal(typeof h.elements.get('drive-access-copy').onclick, 'function');
    h.run(`state.colab.state = 'error'; paintDriveAccess();`);
    assert.equal(h.elements.get('drive-access').hidden, true);
    assert.equal(h.elements.get('drive-access-backdrop').hidden, true);
});


test('a queued Drive consent request refreshes the initially idle runtime', async () => {
    const h = harness();
    h.elements.set('drive-access', {hidden: true});
    h.elements.set('drive-access-backdrop', {hidden: true});
    h.run(`state.backend = 'colab'; state.colab = {state: 'off'};
        currentRemote = () => ({model_cache: {state: 'authorizing'}});
        state.driveRefreshes = 0;
        loadColabRuntime = async () => { state.driveRefreshes += 1; };
        paintDriveAccess(); paintDriveAccess();`);
    assert.equal(h.run('state.driveRefreshes'), 1);
    await Promise.resolve();
});
