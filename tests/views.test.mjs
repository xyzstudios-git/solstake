import test from 'node:test';
import assert from 'node:assert/strict';
import { renderAccounts, renderAccountSheet, renderFlowReadyFooter, renderFlowReady, renderFlowProgressFooter } from '../site/js/views.js';
import { classifyTokenAccount } from '../site/lib/accounts.js';
import { encodeBase58 } from '../site/lib/base58.js';
import { shortAddress } from '../site/lib/format.js';

// Minimal DOM primitives; all view functions and classification stay real.
class ViewNode extends EventTarget {
  constructor(tag = '', text = '') {
    super();
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this._text = text;
  }
  append(...nodes) { this.children.push(...nodes); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  set className(value) { this.setAttribute('class', value); }
  get className() { return this.getAttribute('class') ?? ''; }
  set textContent(value) { this.children = []; this._text = String(value); }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
  focus() { document.activeElement = this; }
}

function withDom(run) {
  const previousNode = globalThis.Node;
  const previousDocument = globalThis.document;
  globalThis.Node = ViewNode;
  globalThis.document = {
    createElement: (tag) => new ViewNode(tag),
    createElementNS: (_ns, tag) => new ViewNode(tag),
    createTextNode: (text) => new ViewNode('', String(text)),
  };
  try { return run(); } finally {
    if (previousNode === undefined) delete globalThis.Node; else globalThis.Node = previousNode;
    if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
  }
}

const address = (byte) => encodeBase58(new Uint8Array(32).fill(byte));
const owner = address(9);
const handlers = { onReview() {}, onToggle() {}, onSelectAll() {}, onFilter() {} };
const state = (overrides = {}) => ({
  owner, phase: 'list', accounts: [], names: new Map(), prices: new Map(),
  selected: new Set(), filter: '', pumpWarnings: [], scanError: null,
  readOnly: false, running: false, balance: 100_000_000, ...overrides,
});
const nodes = (node) => [node, ...node.children.flatMap(nodes)];
const hasClass = (node, cls) => node.className.split(/\s+/).includes(cls);
const findClass = (root, cls) => nodes(root).find((node) => hasClass(node, cls));
const token = (action = 'close') => ({
  address: address(1), mint: address(2), status: action === 'burn' ? 'holding' : 'empty',
  action, lamports: 2_039_280, amount: action === 'burn' ? 100n : 0n, decimals: 6,
});
const pump = () => ({ address: address(3), kind: 'pump-reward', action: 'claim-pump', lamports: 2_000_000, title: 'Pump rewards', description: 'Available rewards' });

test('unknown account formats remain visible without becoming selectable or reporting success', () => withDom(() => {
  const unknown = classifyTokenAccount({ pubkey: address(4), account: {} }, owner);
  const view = renderAccounts(state({ accounts: [unknown] }), handlers);
  const disclosure = nodes(view).find((node) => node.tagName === 'DETAILS');
  assert.ok(disclosure);
  assert.match(disclosure.textContent, /Unavailable/);
  assert.match(disclosure.textContent, /Unknown account format/);
  assert.ok(disclosure.textContent.includes(shortAddress(unknown.address)));
  assert.equal(nodes(view).some((node) => node.tagName === 'INPUT' && node.getAttribute('type') === 'checkbox'), false);
  assert.doesNotMatch(view.textContent, /All clear/);
}));

test('a failed scan presents its warning instead of the clean empty state and disables review', () => withDom(() => {
  const account = token();
  const view = renderAccounts(state({ accounts: [account], selected: new Set([account.address]), scanError: 'RPC did not respond.' }), handlers);
  const warning = findClass(view, 'app-scan-warning');
  assert.equal(warning?.getAttribute('role'), 'alert');
  assert.match(warning.textContent, /RPC did not respond/);
  assert.match(warning.textContent, /try again/);
  assert.equal(findClass(view, 'app-desktop-only').disabled, true);
  const empty = renderAccounts(state({ scanError: 'Request timed out' }), handlers);
  assert.doesNotMatch(empty.textContent, /All clear/);
}));

test('only a successfully scanned empty account list displays the clean state', () => withDom(() => {
  assert.match(renderAccounts(state(), handlers).textContent, /All clear/);
  assert.doesNotMatch(renderAccounts(state({ pumpWarnings: ['Could not load rewards.'] }), handlers).textContent, /All clear/);
}));

test('read-only account lists explain the viewing mode before the review flow', () => withDom(() => {
  const view = renderAccounts(state({ readOnly: true, accounts: [token()] }), handlers);
  const hint = findClass(view, 'app-readonly-note');
  assert.ok(hint);
  assert.match(hint.textContent, /View only/);
  assert.match(hint.textContent, /Connect the matching wallet/);
}));

test('wallet summary keeps its address and balance under a dedicated responsive hook', () => withDom(() => {
  const wrapper = new ViewNode('div');
  wrapper.append(...renderAccountSheet({ state: state({ wallet: { name: 'Phantom' } }), onRefresh() {}, onSwitch() {}, onDisconnect() {} }).filter(Boolean));
  const summary = findClass(wrapper, 'app-wallet-summary');
  assert.ok(summary);
  assert.ok(summary.textContent.includes(shortAddress(owner)));
  assert.match(summary.textContent, /0\.10/);
}));

test('claim options emphasize an explicit optional tip and keep opting out directly available', () => withDom(() => {
  for (const accounts of [[token()], [pump()], [token(), pump()], [token('burn')], [token('burn'), pump()]]) {
    const reclaimLamports = accounts.reduce((sum, account) => sum + account.lamports, 0);
    const plan = { batches: [{ items: accounts.map((account) => ({ account, action: account.action })) }], reclaimLamports, networkFeeLamports: 5_000, tipLamports: 0 };
    const tipPlan = { ...plan, tipLamports: Math.floor(reclaimLamports / 5), withTip: true };
    const choices = [];
    const view = renderFlowReadyFooter({ plan, tipPlan, state: state(), minFeeLamports: 5_000, minTipFeeLamports: 5_000, onExecute: (withTip) => choices.push(withTip), onConnect() {} });
    const buttons = nodes(view).filter((node) => node.tagName === 'BUTTON');
    assert.equal(buttons.length, 2);
    assert.match(buttons[0].getAttribute('aria-label'), /Claim with Tip$/);
    assert.match(buttons[1].getAttribute('aria-label'), /Claim without Tip$/);
    assert.equal(hasClass(buttons[0], 'app-cta'), true);
    assert.equal(hasClass(buttons[1], 'app-cta'), false);
    assert.match(buttons[0].textContent, /20% tip included/);
    assert.equal(buttons[0].disabled, undefined);
    assert.equal(buttons[1].disabled, undefined);
    buttons[0].dispatchEvent(new Event('click'));
    buttons[1].dispatchEvent(new Event('click'));
    assert.deepEqual(choices, [true, false], 'each choice supplies its explicit consent value');
    if (accounts.some((account) => account.action === 'burn')) {
      assert.match(view.textContent, /Burning is permanent/);
      assert.match(buttons[0].getAttribute('aria-label'), /^Burn & Claim/);
      assert.match(buttons[1].getAttribute('aria-label'), /^Burn & Claim/);
    }
  }
}));

test('an unavailable tipped plan disables only that option, and every option checks its own upfront requirement', () => withDom(() => {
  const plan = { batches: [{ items: [{ account: token(), action: 'close' }] }], reclaimLamports: 2_039_280, networkFeeLamports: 5_000, tipLamports: 0 };
  const unavailable = renderFlowReadyFooter({ plan, state: state(), minFeeLamports: 5_000, onExecute() {}, onConnect() {} });
  const buttons = nodes(unavailable).filter((node) => node.tagName === 'BUTTON');
  assert.equal(buttons[0].disabled, true);
  assert.equal(buttons[1].disabled, undefined);
  const insufficient = renderFlowReadyFooter({ plan, tipPlan: { ...plan, tipLamports: 407_856 }, state: state({ balance: 5_000 }), minFeeLamports: 5_000, minTipFeeLamports: 5_001, onExecute() {}, onConnect() {} });
  const limited = nodes(insufficient).filter((node) => node.tagName === 'BUTTON');
  assert.equal(limited[0].disabled, true);
  assert.equal(limited[1].disabled, undefined);
}));

test('review remains disabled before the list phase even with an existing selection', () => withDom(() => {
  const account = token();
  const view = renderAccounts(state({ phase: 'loading', accounts: [account], selected: new Set([account.address]) }), handlers);
  assert.equal(findClass(view, 'app-desktop-only').disabled, true);
}));

test('search explains selected token accounts outside its results without counting visible Pump rewards', () => withDom(() => {
  const accounts = Array.from({ length: 13 }, (_, index) => ({ ...token(), address: address(index + 20), mint: address(index + 40) }));
  const reward = pump();
  const selected = new Set([...accounts.slice(0, 12).map((account) => account.address), reward.address]);
  const names = new Map(accounts.map((account, index) => [account.mint, { name: index === 0 ? 'Match' : `Other token ${index}` }]));
  const view = renderAccounts(state({ accounts: [...accounts, reward], selected, names, filter: 'Match' }), handlers);
  const note = findClass(view, 'app-search-selection-note');
  assert.equal(note?.getAttribute('role'), 'status');
  assert.equal(note.textContent, '11 selected accounts outside this search remain selected.');
  assert.match(view.textContent, /Pump rewards/);
  const checkboxes = nodes(view).filter((node) => node.tagName === 'INPUT' && node.getAttribute('type') === 'checkbox');
  assert.equal(checkboxes.length, 2);
  assert.equal(checkboxes.every((node) => node.checked), true);

  const unfiltered = renderAccounts(state({ accounts: [...accounts, reward], selected, names }), handlers);
  assert.equal(findClass(unfiltered, 'app-search-selection-note'), undefined);
  const noHiddenSelections = renderAccounts(state({ accounts, names, selected: new Set([accounts[0].address]), filter: 'Match' }), handlers);
  assert.equal(findClass(noHiddenSelections, 'app-search-selection-note'), undefined);
}));

test('clear search empties the query and returns focus before the filter callback', () => withDom(() => {
  const accounts = Array.from({ length: 13 }, (_, index) => ({ ...token(), address: address(index + 20) }));
  let callCount = 0;
  const view = renderAccounts(state({ accounts, filter: 'no match' }), {
    ...handlers,
    onFilter: (value) => {
      callCount++;
      assert.equal(value, '');
      assert.equal(document.activeElement?.getAttribute('type'), 'search');
      assert.equal(document.activeElement.value, '');
    },
  });
  const clear = nodes(view).find((node) => node.getAttribute('aria-label') === 'Clear search');
  assert.ok(clear);
  assert.equal(clear.tagName, 'BUTTON');
  clear.dispatchEvent(new Event('click'));
  assert.equal(callCount, 1);
  const unfiltered = renderAccounts(state({ accounts }), handlers);
  assert.equal(nodes(unfiltered).some((node) => node.getAttribute('aria-label') === 'Clear search'), false);
}));


test('reconnection is an explicit finished-flow action and never appears during signing', () => withDom(() => {
  let reconnects = 0;
  const done = renderFlowProgressFooter({ done: true, onDone() {}, onReconnect: () => { reconnects++; } });
  assert.equal(done.textContent, 'Reconnect wallet');
  assert.equal(reconnects, 0);
  done.dispatchEvent(new Event('click'));
  assert.equal(reconnects, 1);
  const pending = renderFlowProgressFooter({ done: false, onDone() {}, onReconnect() {} });
  assert.equal(nodes(pending).some((node) => node.tagName === 'BUTTON'), false);
}));


test('updated review clearly explains a changed Pump selection before either claim choice', () => withDom(() => {
  const plan = { batches: [], failed: [], reclaimLamports: 0, networkFeeLamports: 0 };
  const parts = renderFlowReady({ plan, state: state(), minFeeLamports: 0, notice: 'Pump rewards changed. Review the updated selection before continuing.' });
  const notice = parts.find((part) => part.getAttribute('role') === 'status');
  assert.ok(notice);
  assert.match(notice.textContent, /Review the updated selection/);
}));
