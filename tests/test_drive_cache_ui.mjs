import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../app/static/js/remote-gpu.js', import.meta.url), 'utf8')
    .replace("import { customConfirm } from './utils.js';", '');

function setup(payload, cardName = 'setupCard', runtimePayload = null) {
    const element = tag => ({
        tag, textContent: '', children: [],
        append(...children) { this.children.push(...children); },
        addEventListener() {},
        setAttribute() {},
    });
    const context = vm.createContext({
        document: { getElementById: () => null, createElement: element },
        window: { location: { hash: '' }, addEventListener() {} },
    });
    vm.runInContext(source, context);
    vm.runInContext(`status = ${JSON.stringify(payload)}`, context);
    vm.runInContext(`runtime = ${JSON.stringify(runtimePayload)}`, context);
    const tree = vm.runInContext(`${cardName}()`, context);
    const nodes = node => [node, ...node.children.flatMap(nodes)];
    return {
        text: nodes(tree).map(node => node.textContent).join(' '),
        buttons: nodes(tree).filter(node => node.tag === 'button').map(node => node.textContent),
        inputs: nodes(tree).filter(node => node.tag === 'input'),
        links: nodes(tree).filter(node => node.tag === 'a'),
    };
}

test('Drive cache settings expose an enabled toggle and a consent link', () => {
    const card = setup({settings: {colab: {gpu: 'G4', idle_minutes: 10, model_cache: true},
        gpus: [], idle_minutes_range: [2, 60]}}, 'settingsCard',
    {model_cache: {enabled: true, state: 'authorizing', auth_url: 'https://accounts.google.com/test'}});
    assert.equal(card.inputs.find(input => input.type === 'checkbox').checked, true);
    assert.match(card.text, /next Colab runtime/);
    assert.equal(card.links[0].href, 'https://accounts.google.com/test');
    assert.ok(card.buttons.includes('I have granted access'));
});
