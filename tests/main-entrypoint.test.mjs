import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { encodeBase58 } from '../site/lib/base58.js';
import { createHistoryStore, summarizeHistory } from '../site/lib/history.js';
import { TIP_RECIPIENT } from '../site/lib/tips.js';
import { PUMP_PROGRAM_ID, pumpAccumulatorAddress } from '../site/lib/pump-rewards.js';
import { TOKEN, WSOL, tokenEntry } from './support/fixtures.mjs';

// A deliberately small DOM adapter for the real entry point. It supplies browser
// primitives only; view functions, handlers, signing and claim logic stay real.
function browserFixture(html) {
  const observers = new Set();
  class BrowserNode extends EventTarget {
    constructor(tagName = null, text = '') {
      super();
      this.tagName = tagName?.toUpperCase() ?? null;
      this.children = [];
      this.parentNode = null;
      this.attributes = new Map();
      this.dataset = {};
      this._text = text;
      this.hidden = false;
      this.disabled = false;
      this.checked = false;
      this.value = '';
      this.classList = {
        contains: (name) => this.className.split(/\s+/).includes(name),
        toggle: (name, force) => {
          const values = new Set(this.className.split(/\s+/).filter(Boolean));
          const add = force ?? !values.has(name);
          if (add) values.add(name); else values.delete(name);
          this.className = [...values].join(' ');
          return add;
        },
        add: (...names) => names.forEach((name) => this.classList.toggle(name, true)),
        remove: (...names) => names.forEach((name) => this.classList.toggle(name, false)),
      };
    }
    get className() { return this.attributes.get('class') ?? ''; }
    set className(value) { this.attributes.set('class', String(value)); }
    get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
    set textContent(value) { this.replaceChildren(); this._text = String(value); }
    get firstElementChild() { return this.children.find((child) => child.tagName) ?? null; }
    append(...nodes) {
      for (const node of nodes) {
        if (node.parentNode) node.parentNode.children = node.parentNode.children.filter((child) => child !== node);
        node.parentNode = this;
        this.children.push(node);
      }
    }
    replaceChildren(...nodes) {
      if (this.children.some((child) => child.contains(document.activeElement))) document.activeElement = document.body;
      for (const child of this.children) child.parentNode = null;
      this.children = [];
      this._text = '';
      this.append(...nodes);
    }
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
      if (name === 'value') this.value = String(value);
      if (name === 'type') this.type = String(value);
      if (name === 'hidden') this.hidden = true;
      for (const observer of observers) {
        if (observer.target !== this || !observer.options.attributeFilter?.includes(name)) continue;
        // MutationObserver callbacks run after the current JavaScript turn.
        queueMicrotask(() => observer.callback());
      }
    }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    contains(node) { return this === node || this.children.some((child) => child.contains(node)); }
    focus() {
      if (this.disabled || this.hidden || !document.body.contains(this)) return;
      document.activeElement = this;
      this.dispatchEvent(new Event('focus'));
    }
    click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
    querySelector(selector) {
      const inputValue = /^input\[value="([^"]+)"\]$/.exec(selector);
      return descendants(this).find((node) => inputValue
        ? node.tagName === 'INPUT' && node.value === inputValue[1]
        : selector.startsWith('#') ? node.getAttribute('id') === selector.slice(1)
          : selector.startsWith('.') ? node.classList.contains(selector.slice(1))
            : node.tagName === selector.toUpperCase()) ?? null;
    }
    querySelectorAll(selector) {
      assert.equal(selector, '*', 'the DOM adapter only supports the selectors used by the application');
      return descendants(this);
    }
  }
  class BrowserDocument extends EventTarget {
    constructor() { super(); this.body = new BrowserNode('body'); this.activeElement = null; }
    createElement(tag) { return new BrowserNode(tag); }
    createElementNS(_namespace, tag) { return this.createElement(tag); }
    createTextNode(text) { return new BrowserNode(null, text); }
    getElementById(id) { return descendants(this.body).find((node) => node.getAttribute('id') === id) ?? null; }
    querySelector(selector) { return this.body.querySelector(selector); }
  }
  const document = new BrowserDocument();
  // Preserve the real static hierarchy so modal containment and focus removal
  // behave like a browser. Dynamic trees are built entirely by the real views.
  const markup = html.split(/<body[^>]*>/i)[1].split(/<\/body>/i)[0];
  const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  const stack = [document.body];
  for (const match of markup.matchAll(/<!--[\s\S]*?-->|<(\/?)([a-z][a-z0-9-]*)\b([^>]*)>/gi)) {
    if (!match[2]) continue;
    const tag = match[2].toLowerCase();
    if (match[1]) {
      const index = stack.findLastIndex((node) => node.tagName === tag.toUpperCase());
      if (index > 0) stack.length = index;
      continue;
    }
    const node = document.createElement(tag);
    for (const attr of match[3].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) node.setAttribute(attr[1], attr[2] ?? '');
    stack.at(-1).append(node);
    if (!voidTags.has(tag) && !match[3].trim().endsWith('/')) stack.push(node);
  }
  const window = new EventTarget();
  let lastFocus = null;
  const PuppertinoModalManager = {
    openModal: (selector) => {
      const node = document.getElementById(selector.slice(1));
      assert.ok(node, `Modal ${selector} exists`);
      lastFocus = document.activeElement;
      node.classList.add('active');
      node.setAttribute('aria-hidden', 'false');
      (descendants(node).find((child) => child.tagName === 'BUTTON' && !child.disabled && !child.hidden) ?? node).focus();
    },
    closeModal: (selector) => {
      const node = document.getElementById(selector.slice(1));
      if (!node.classList.contains('active')) return;
      node.classList.remove('active');
      node.setAttribute('aria-hidden', 'true');
      lastFocus?.focus();
      lastFocus = null;
    },
  };
  class MutationObserver {
    constructor(callback) { this.callback = callback; }
    observe(target, options) { this.target = target; this.options = options; observers.add(this); }
    disconnect() { observers.delete(this); }
  }
  return { Node: BrowserNode, document, window, PuppertinoModalManager, MutationObserver };
}

function descendants(node) {
  return node.children.flatMap((child) => [child, ...descendants(child)]);
}

async function until(predicate, description) {
  const deadline = performance.now() + 5_000;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, `Timed out: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('real entry point connects, simulates, signs and confirms a claim, then renders its persisted Account history', { timeout: 15_000 }, async (t) => {
  const html = await readFile(new URL('../site/index.html', import.meta.url), 'utf8');
  const browser = browserFixture(html);
  const now = new Date(2026, 10, 18, 12).getTime();
  t.mock.method(Date, 'now', () => now);
  const keypair = Keypair.fromSeed(new Uint8Array(32).fill(41));
  const owner = keypair.publicKey.toBase58();
  const emptyAccount = tokenEntry({
    owner,
    pubkey: Keypair.fromSeed(new Uint8Array(32).fill(42)).publicKey.toBase58(),
    mint: Keypair.fromSeed(new Uint8Array(32).fill(43)).publicKey.toBase58(),
  });
  const nativePumpAddress = await pumpAccumulatorAddress(owner, PUMP_PROGRAM_ID);
  const pumpReserve = 1_346_200;
  let pumpAvailable = false;
  let pumpCashback = 100_000;
  let mixedSelection = false;
  let submittedPumpLamports = 0;
  let submittedRentLamports = emptyAccount.account.lamports;
  const extraAccounts = Array.from({ length: 14 }, () => tokenEntry({ owner }));
  const pumpRaw = () => {
    const data = new Uint8Array(137);
    data.set([86, 255, 112, 14, 102, 53, 154, 250]);
    data.set(keypair.publicKey.toBytes(), 8);
    data[40] = 1; // Preserve the accumulator for pending incentives; only claim cashback.
    return { owner: PUMP_PROGRAM_ID, executable: false, lamports: pumpReserve + pumpCashback, data: [Buffer.from(data).toString('base64'), 'base64'] };
  };
  const balance = 100_000_000;
  const actualFee = 5_029;
  const storageValues = new Map();
  const writes = [];
  const localStorage = {
    getItem: (key) => storageValues.get(key) ?? null,
    setItem: (key, value) => { storageValues.set(key, value); writes.push(JSON.parse(value)); },
  };
  const calls = [];
  let connected = 0;
  let signed = 0;
  let submittedSignature = null;
  let submittedTransaction = null;
  let walletChange = () => {};
  let failAuthorization = false;
  const nextOwner = Keypair.fromSeed(new Uint8Array(32).fill(44)).publicKey.toBase58();
  const watchedOwner = Keypair.fromSeed(new Uint8Array(32).fill(45)).publicKey.toBase58();
  let failNextOwnerScan = true;
  let refreshClaim = false;
  let failTipSimulation = false;
  let submittedTip = 0;
  let blockhashRound = 0;
  const watchedAccount = tokenEntry({ owner: watchedOwner });
  let releaseConfirmation;
  const confirmation = new Promise((resolve) => { releaseConfirmation = resolve; });
  const walletAccount = { address: owner, publicKey: keypair.publicKey.toBytes(), chains: ['solana:mainnet'], features: ['solana:signTransaction'] };
  const wallet = {
    name: 'Local test wallet', icon: 'data:image/svg+xml,<svg/>', version: '1.0.0',
    chains: ['solana:mainnet'], accounts: [walletAccount],
    features: {
      'standard:connect': { version: '1.0.0', connect: async () => { connected += 1; wallet.accounts = [walletAccount]; return { accounts: wallet.accounts }; } },
      'standard:events': { version: '1.0.0', on: (_type, listener) => { walletChange = (event) => { if ('accounts' in event) wallet.accounts = event.accounts; listener(event); }; return () => { walletChange = () => {}; }; } },
      'solana:signTransaction': {
        version: '1.0.0', supportedTransactionVersions: ['legacy'],
        signTransaction: async (...requests) => requests.map(({ transaction, account }) => {
          assert.equal(account.address, owner);
          assert.equal(account, wallet.accounts.find((entry) => entry.address === account.address), 'the wallet accepts only its current account object');
          if (failAuthorization) throw Object.assign(new Error('The requested method and/or account has not been authorized by the user.'), { code: 4100 });
          const tx = VersionedTransaction.deserialize(transaction);
          tx.sign([keypair]);
          signed += 1;
          return { signedTransaction: tx.serialize() };
        }),
      },
    },
  };
  browser.window.addEventListener('wallet-standard:app-ready', (event) => event.detail.register(wallet));
  const fetch = async (url, options) => {
    if (String(url).startsWith('https://api.jup.ag/price/v3?')) {
      return { ok: true, json: async () => ({ [WSOL]: { usdPrice: 100 } }) };
    }
    assert.equal(url, '/rpc', 'all chain traffic is intercepted locally');
    const { id, method, params } = JSON.parse(options.body);
    calls.push({ method, params });
    let result;
    switch (method) {
      case 'getTokenAccountsByOwner':
        assert.ok([owner, nextOwner, watchedOwner, nativePumpAddress].includes(params[0]));
        if (params[0] === nextOwner && failNextOwnerScan) throw new Error('Synthetic scan failure');
        result = { value: params[1].programId !== TOKEN ? [] : params[0] === watchedOwner ? [watchedAccount] : params[0] === owner && (!submittedSignature || refreshClaim) ? [emptyAccount, ...(mixedSelection ? extraAccounts : [])] : [] };
        break;
      case 'getBalance': result = { value: balance }; break;
      case 'getMultipleAccounts': result = { value: params[0].map((address) => address === nativePumpAddress && pumpAvailable ? pumpRaw() : null) }; break;
      case 'getMinimumBalanceForRentExemption': result = pumpReserve; break;
      case 'getRecentPrioritizationFees': result = []; break;
      case 'simulateTransaction':
        assert.equal(signed, calls.filter((call) => call.method === 'sendTransaction').length, 'review simulates without requesting another signature');
        assert.equal(params[1].sigVerify, false);
        {
          const tx = VersionedTransaction.deserialize(Buffer.from(params[0], 'base64'));
          const hasTip = tx.message.compiledInstructions.some((ix) => tx.message.staticAccountKeys[ix.programIdIndex].toBase58() === '11111111111111111111111111111111'
            && tx.message.staticAccountKeys[ix.accountKeyIndexes[1]]?.toBase58() === TIP_RECIPIENT);
          result = { value: { err: hasTip && failTipSimulation ? { InstructionError: [3, { Custom: 1 }] } : null, logs: [], unitsConsumed: 15_000 } };
        }
        break;
      case 'getLatestBlockhash': result = { value: { blockhash: Keypair.fromSeed(new Uint8Array(32).fill(100 + blockhashRound++)).publicKey.toBase58(), lastValidBlockHeight: 500 } }; break;
      case 'sendTransaction':
        refreshClaim = false;
        submittedTransaction = VersionedTransaction.deserialize(Buffer.from(params[0], 'base64'));
        submittedSignature = encodeBase58(submittedTransaction.signatures[0]);
        submittedRentLamports = emptyAccount.account.lamports * (mixedSelection ? 15 : 1);
        submittedPumpLamports = submittedTransaction.message.compiledInstructions.some((ix) => submittedTransaction.message.staticAccountKeys[ix.programIdIndex].toBase58() === PUMP_PROGRAM_ID) ? pumpCashback : 0;
        if (submittedPumpLamports) pumpAvailable = false;
        assert.equal(submittedTransaction.message.staticAccountKeys[0].toBase58(), owner);
        submittedTip = submittedTransaction.message.compiledInstructions.reduce((sum, ix) => sum + (
          submittedTransaction.message.staticAccountKeys[ix.programIdIndex].toBase58() === '11111111111111111111111111111111'
            && submittedTransaction.message.staticAccountKeys[ix.accountKeyIndexes[1]]?.toBase58() === TIP_RECIPIENT
            ? Number(new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength).getBigUint64(4, true)) : 0), 0);
        result = submittedSignature;
        break;
      case 'getSignatureStatuses':
        assert.deepEqual(params[0], [submittedSignature]);
        await confirmation;
        result = { value: [{ err: null, confirmationStatus: 'confirmed' }] };
        break;
      case 'getTransaction': {
        assert.equal(params[0], submittedSignature);
        const keys = submittedTransaction.message.staticAccountKeys.map((key) => key.toBase58());
        const preBalances = keys.map((_, index) => index === 0 ? balance : 0);
        const postBalances = [...preBalances];
        postBalances[0] += submittedRentLamports + submittedPumpLamports - actualFee - submittedTip;
        const tipIndex = keys.indexOf(TIP_RECIPIENT);
        if (tipIndex >= 0) postBalances[tipIndex] += submittedTip;
        result = { blockTime: now / 1000, transaction: { signatures: [submittedSignature], message: { accountKeys: keys } }, meta: { err: null, fee: actualFee, preBalances, postBalances } };
        break;
      }
      default: assert.fail(`Unexpected RPC method: ${method}`);
    }
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id, result }) };
  };
  for (const [name, value] of Object.entries({ ...browser, localStorage, fetch })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => descriptor ? Object.defineProperty(globalThis, name, descriptor) : delete globalThis[name]);
  }
  const $ = (id) => browser.document.getElementById(id);
  const findButton = (root, text) => descendants(root).find((node) => node.tagName === 'BUTTON' && (node.textContent === text || node.getAttribute('aria-label') === text));
  const store = createHistoryStore({ storage: localStorage });
  const saved = () => store.read(owner).entries;

  await import(`../site/js/main.js?entrypoint-test=${now}`);
  assert.equal($('header-account').hidden, true);
  assert.ok($('app-footer'), 'the landing-page footer has a stable visibility hook');
  assert.equal($('app-footer').hidden, false, 'the start page shows the brand links');
  assert.match($('main').textContent, /Connect wallet/);
  assert.deepEqual(saved(), []);

  $('header-connect').click();
  await until(() => !$('header-account').hidden && $('review-button').textContent === 'Review selection (1)', 'connected wallet and scanned account');
  assert.equal(connected, 1);
  assert.equal($('app-footer').hidden, true, 'connected account selection does not show landing-page links');
  assert.equal($('header-connect').hidden, true);
  assert.match($('main').textContent, /Empty accounts/);
  assert.equal(calls.filter((call) => call.method === 'getTokenAccountsByOwner').length, 2);
  assert.equal(signed, 0);

  $('review-button').click();
  await until(() => findButton($('flow-sheet-footer'), 'Claim without Tip'), 'simulated review is ready');
  assert.ok($('flow-sheet').classList.contains('active'));
  assert.ok(calls.some((call) => call.method === 'simulateTransaction'));
  assert.equal(signed, 0, 'opening review never signs or sends');
  assert.equal(submittedSignature, null);
  assert.equal(findButton($('flow-sheet-footer'), 'Claim with Tip').disabled, false);
  assert.match(findButton($('flow-sheet-footer'), 'Claim with Tip').textContent, /20% tip included/);

  walletChange({ accounts: [{ ...walletAccount }] });
  wallet.accounts = [{ ...walletAccount, address: nextOwner }, wallet.accounts[0]];
  walletChange({ features: wallet.features });
  assert.equal($('flow-sheet').classList.contains('active'), true, 'same-owner renewal and feature updates preserve the reviewed owner');
  failAuthorization = true;
  findButton($('flow-sheet-footer'), 'Claim without Tip').click();
  await until(() => findButton($('flow-sheet-footer'), 'Reconnect wallet'), 'authorization errors offer explicit reconnection');
  assert.equal(calls.filter((call) => call.method === 'sendTransaction').length, 0);
  assert.equal(connected, 1, 'an authorization failure never reconnects automatically');
  assert.deepEqual(saved(), [], 'a denied signature does not create a fabricated transaction record');
  failAuthorization = false;
  findButton($('flow-sheet-footer'), 'Reconnect wallet').click();
  await until(() => connected === 2 && !$('header-refresh').disabled, 'user reconnects the same wallet');
  assert.equal(signed, 0, 'reconnection does not retry the claim');
  $('review-button').click();
  await until(() => findButton($('flow-sheet-footer'), 'Claim without Tip'), 'reconnected wallet requires a fresh review');

  findButton($('flow-sheet-footer'), 'Claim without Tip').focus();
  findButton($('flow-sheet-footer'), 'Claim without Tip').click();
  await until(() => saved()[0]?.status === 'sent', 'signed transaction is sent and recorded');
  assert.equal(signed, 1, 'execute reaches the signer (regression: undeclared submitted)');
  assert.equal(calls.filter((call) => call.method === 'sendTransaction').length, 1);
  assert.equal(saved()[0].signature, submittedSignature);
  assert.equal(saved()[0].actualNetLamports, null);
  assert.equal(submittedTip, 0, 'the opt-out transaction includes no tip transfer');
  assert.equal(saved()[0].tipLamports, 0);
  assert.equal(saved()[0].reclaimLamports, emptyAccount.account.lamports);
  assert.deepEqual(saved()[0].sources, [{ kind: 'token', label: 'Token accounts', count: 1 }]);
  assert.equal(summarizeHistory(saved(), { now }).totalClaimedLamports, 0, 'pending signatures are excluded from Total claimed');
  assert.equal(browser.document.activeElement, $('flow-sheet-title'), 'removing the execute button keeps focus inside the progress sheet');
  for (const id of ['wallet-chip', 'header-refresh', 'header-account', 'header-connect', 'header-address']) {
    assert.equal($(id).disabled, true, `${id} is locked while a signature is pending`);
    $(id).dispatchEvent(new Event('click')); // Also exercise handler guards, bypassing disabled.
  }
  assert.equal($('account-sheet').classList.contains('active'), false);
  assert.equal($('address-sheet').classList.contains('active'), false);
  assert.equal(connected, 2);
  walletChange({ accounts: [walletAccount] }); // A same-account event must not suppress the final rescan.

  releaseConfirmation();
  await until(() => saved()[0]?.status === 'confirmed' && $('flow-sheet-title').textContent === 'Done', 'network confirmation and finished state');
  assert.equal(saved().length, 1, 'sent and confirmed deduplicate by signature');
  assert.equal(saved()[0].timestamp, now);
  assert.equal(summarizeHistory(saved(), { now }).totalClaimedLamports, emptyAccount.account.lamports);
  assert.ok(writes.length >= 2, 'both sent and confirmed were persisted');
  assert.equal($('header-account').disabled, false);
  assert.doesNotMatch($('flow-sheet-body').textContent, /submitted is not defined|Status unknown|Failed/);

  findButton($('flow-sheet-footer'), 'Done').click();
  await until(() => !$('flow-sheet').classList.contains('active') && $('review-button').textContent === 'Select accounts', 'finished claim closes sheet and rescans');
  $('header-account').click();
  assert.equal($('app-footer').hidden, true, 'Account history does not show landing-page links');
  await until(() => saved()[0]?.actualNetLamports !== null && $('main').textContent.includes('from confirmed transactions'), 'Account reconciles and displays on-chain totals');
  assert.equal($('header-account').getAttribute('aria-pressed'), 'true');
  assert.equal($('action-bar').hidden, true);
  assert.match($('main').textContent, /Total claimed/);
  assert.match($('main').textContent, /Confirmed/);
  assert.match($('main').textContent, /Recorded in this browser/);
  assert.equal(saved()[0].feeLamports, actualFee);
  assert.equal(saved()[0].actualNetLamports, emptyAccount.account.lamports - actualFee);
  const restored = createHistoryStore({ storage: localStorage }).read(owner);
  assert.equal(restored.warning, null);
  assert.deepEqual(restored.entries, saved(), 'a fresh store reads the persisted history');
  const chart = descendants($('main')).find((node) => node.tagName === 'SVG' && node.getAttribute('aria-label') === 'Cumulative confirmed claims in SOL');
  assert.ok(chart, 'confirmed history produces an accessible chart');
  const transactionLink = descendants($('main')).find((node) => node.getAttribute('href') === `https://solscan.io/tx/${submittedSignature}`);
  assert.ok(transactionLink, 'history links the exact signed transaction');
  assert.equal(browser.document.activeElement, $('account-title'), 'initial and asynchronous Account renders preserve the heading focus');

  const sevenDays = $('main').querySelector('input[value="7d"]');
  sevenDays.dispatchEvent(new Event('change'));
  assert.equal($('main').querySelector('input[value="7d"]').checked, true);
  assert.equal(browser.document.activeElement, $('main').querySelector('input[value="7d"]'));
  browser.window.dispatchEvent(new Event('storage'));
  assert.equal(browser.document.activeElement, $('main').querySelector('input[value="7d"]'), 'cross-tab storage updates preserve the selected range focus');
  const accountRefresh = descendants($('main')).find((node) => node.getAttribute('aria-label') === 'Refresh transaction status');
  accountRefresh.focus();
  accountRefresh.click();
  $('header-refresh').focus();
  await until(() => !descendants($('main')).find((node) => node.getAttribute('aria-label') === 'Refresh transaction status').disabled, 'Account refresh completes');
  assert.equal(browser.document.activeElement, $('header-refresh'), 'late Account refresh completion does not steal focus from outside the view');
  const back = descendants($('main')).find((node) => node.getAttribute('aria-label') === 'Back to selection');
  back.click();
  assert.equal($('header-account').getAttribute('aria-pressed'), 'false');
  assert.equal(browser.document.activeElement, $('header-account'));
  assert.equal($('error-alert').classList.contains('active'), false);

  // Switching wallets must never show the previous wallet's accounts after an
  // unsuccessful scan. The header and retry remain available for the new owner.
  walletChange({ accounts: [{ ...walletAccount, address: nextOwner }] });
  await until(() => $('error-alert').classList.contains('active') && !$('header-refresh').disabled, 'new-owner scan failure is reported');
  assert.equal($('wallet-chip').hidden, false);
  assert.equal($('header-account').hidden, false);
  assert.equal($('review-button').disabled, true);
  assert.equal(descendants($('main')).filter((node) => node.tagName === 'INPUT' && node.type === 'checkbox').length, 0);
  assert.doesNotMatch($('main').textContent, /All clear/);
  assert.equal(saved().length, 1, 'the first wallet history remains intact');
  browser.PuppertinoModalManager.closeModal('#error-alert');
  failNextOwnerScan = false;
  $('header-refresh').click();
  await until(() => !$('header-refresh').disabled && $('main').textContent.includes('All clear'), 'the header retries the failed wallet scan');

  $('wallet-chip').click();
  findButton($('account-sheet-body'), 'Disconnect wallet').click();
  assert.equal($('app-footer').hidden, false, 'disconnecting returns to the landing-page footer');
  assert.equal($('header-account').hidden, true);
  $('header-address').click();
  $('address-input').value = watchedOwner;
  $('address-submit').click();
  await until(() => $('review-button').textContent === 'Review selection (1)', 'read-only address accounts load');
  assert.equal($('app-footer').hidden, true, 'watch-only account pages also hide landing-page links');
  $('review-button').click();
  await until(() => findButton($('flow-sheet-footer'), 'Connect wallet'), 'read-only review offers a connection instead of execution');
  assert.equal(findButton($('flow-sheet-footer'), 'Claim without Tip'), undefined);
  assert.match($('flow-sheet-body').textContent, /Connect the wallet that owns this address/);
  assert.equal(calls.filter((call) => call.method === 'sendTransaction').length, 1, 'watch-only mode never submits another transaction');
  findButton($('flow-sheet-footer'), 'Connect wallet').click();
  await until(() => connected === 3 && !$('header-refresh').disabled, 'read-only mode transitions back to a connected wallet');
  assert.deepEqual(createHistoryStore({ storage: localStorage }).read(watchedOwner).entries, []);
  assert.equal(saved().length, 1);

  // Wallet extension events may arrive while confirmation is pending. Keep the
  // captured claim owner intact, then apply the latest account after completion.
  refreshClaim = true;
  failTipSimulation = true;
  $('header-refresh').click();
  await until(() => !$('header-refresh').disabled && $('review-button').textContent === 'Review selection (1)', 'another synthetic claim is available');
  $('review-button').click();
  await until(() => findButton($('flow-sheet-footer'), 'Claim with Tip')?.disabled, 'tip failure leaves the untipped option available');
  assert.equal(findButton($('flow-sheet-footer'), 'Claim without Tip').disabled, false);
  findButton($('flow-sheet-footer'), 'Claim with Tip').dispatchEvent(new Event('click'));
  assert.equal(signed, 1, 'an unavailable tipped plan never signs');
  failTipSimulation = false;
  browser.PuppertinoModalManager.closeModal('#flow-sheet');
  $('review-button').click();
  await until(() => findButton($('flow-sheet-footer'), 'Claim with Tip')?.disabled === false, 'second review is ready');
  findButton($('flow-sheet-footer'), 'Claim with Tip').click();
  await until(() => saved().length === 2 && saved().some((entry) => entry.status === 'sent'), 'second claim has been submitted');
  assert.equal(submittedTip, Math.floor(emptyAccount.account.lamports / 5));
  assert.equal(saved().find((entry) => entry.signature === submittedSignature).tipLamports, submittedTip);
  const chipDuringClaim = $('wallet-chip').textContent;
  walletChange({ accounts: [{ ...walletAccount, address: nextOwner }] });
  walletChange({ features: wallet.features }); // Must not discard the queued account switch.
  assert.equal($('wallet-chip').textContent, chipDuringClaim, 'extension switching is deferred during the active claim');
  await until(() => saved().every((entry) => entry.status === 'confirmed') && !$('header-refresh').disabled && $('wallet-chip').textContent !== chipDuringClaim, 'deferred wallet account is applied after confirmation');
  assert.equal($('flow-sheet').classList.contains('active'), false);
  assert.equal(createHistoryStore({ storage: localStorage }).read(nextOwner).entries.length, 0, 'the captured claim is never attributed to the newly selected wallet');
  assert.equal(saved().length, 2);

  // Reproduce the reported mixed claim: one changing Pump item must not fail all 16 items.
  mixedSelection = true;
  pumpAvailable = true;
  refreshClaim = true;
  walletChange({ accounts: [walletAccount] });
  await until(() => !$('header-refresh').disabled && $('review-button').textContent === 'Review selection (16)', 'mixed Pump and token selection is scanned');
  $('review-button').click();
  await until(() => findButton($('flow-sheet-footer'), 'Claim without Tip'), 'mixed review is ready');
  const sentBeforeRefresh = calls.filter((call) => call.method === 'sendTransaction').length;
  const signedBeforeRefresh = signed;
  pumpAvailable = false;
  findButton($('flow-sheet-footer'), 'Claim without Tip').click();
  await until(() => $('flow-sheet-title').textContent === 'Review' && $('flow-sheet-body').textContent.includes('Skipped') && findButton($('flow-sheet-footer'), 'Claim without Tip'), 'disappearing Pump rewards return to an updated review');
  assert.equal(signed, signedBeforeRefresh, 'a changed quote is never signed automatically');
  assert.equal(calls.filter((call) => call.method === 'sendTransaction').length, sentBeforeRefresh);
  assert.match($('flow-sheet-body').textContent, /15/);
  findButton($('flow-sheet-footer'), 'Claim without Tip').click();
  await until(() => saved().length === 3 && saved().every((entry) => entry.status === 'confirmed') && findButton($('flow-sheet-footer'), 'Done'), 'the 15 remaining accounts can be claimed without a tip');
  assert.equal(submittedTip, 0);
  assert.equal(submittedPumpLamports, 0);
  assert.equal(signed, signedBeforeRefresh + 1);
  const scansBeforeSubsetClose = calls.filter((call) => call.method === 'getBalance').length;
  findButton($('flow-sheet-footer'), 'Done').click();
  await until(() => calls.filter((call) => call.method === 'getBalance').length > scansBeforeSubsetClose && !$('header-refresh').disabled, 'the successful subset is rescanned');

  for (const withTip of [false, true]) {
    pumpAvailable = true;
    pumpCashback = 100_000;
    refreshClaim = true;
    $('header-refresh').click();
    await until(() => !$('header-refresh').disabled && $('review-button').textContent === 'Review selection (16)', 'growing rewards are scanned');
    $('review-button').click();
    await until(() => findButton($('flow-sheet-footer'), 'Claim without Tip'), 'growing-reward quote is ready');
    const expectedTip = withTip ? Math.floor((15 * emptyAccount.account.lamports + pumpCashback) / 5) : 0;
    const before = signed;
    const historyCount = saved().length;
    pumpCashback += 50_000;
    findButton($('flow-sheet-footer'), withTip ? 'Claim with Tip' : 'Claim without Tip').click();
    await until(() => saved().length === historyCount + 1 && saved().every((entry) => entry.status === 'confirmed') && findButton($('flow-sheet-footer'), 'Done'), 'unchanged instructions can claim growing rewards');
    assert.equal(signed, before + 1);
    assert.equal(submittedPumpLamports, 150_000);
    assert.equal(submittedTip, expectedTip, 'growth never increases an already agreed tip or adds a tip to opt-out');
    const scansBeforeGrowthClose = calls.filter((call) => call.method === 'getBalance').length;
    findButton($('flow-sheet-footer'), 'Done').click();
    await until(() => calls.filter((call) => call.method === 'getBalance').length > scansBeforeGrowthClose && !$('header-refresh').disabled, 'growth claim is rescanned');
  }

});
