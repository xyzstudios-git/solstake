// Leergut: Steuerung. Zustand ist unveränderlich; jede Änderung erzeugt einen neuen Stand.
import { watchWallets, connectWallet, createSigner, disconnectWallet, onWalletChange, isWalletAuthorizationError, SOLANA_MAINNET } from '../lib/wallet.js';
import { createRpc } from '../lib/rpc.js';
import { WSOL_MINT, classifyAll } from '../lib/accounts.js';
import { fetchTokenNames } from '../lib/metadata.js';
import { fetchUsdPrices } from '../lib/prices.js';
import { prepareBurnPlan, executeBurnPlan } from '../lib/flow.js';
import { scanPumpRewards, refreshPumpRewardItems } from '../lib/pump-rewards.js';
import { isAddress } from '../lib/base58.js';
import { BASE_FEE_LAMPORTS, priorityFeeLamports } from '../lib/fees.js';
import { shortAddress, formatUsd, formatSolNumber } from '../lib/format.js';
import { batchTipLamports } from '../lib/tips.js';
import { createHistoryStore } from '../lib/history.js';
import { syncHistory } from '../lib/history-sync.js';
import { renderAccount } from './account-view.js';
import * as views from './views.js';
import { setContent, openModal, closeModal, isModalOpen, onModalClose, showError } from './dom.js';

const rpc = createRpc();
const historyStore = createHistoryStore();
let accountVisible = false;
let historyRange = '30d';
let historyRefreshing = false;
let historySyncWarning = null;
let historyRequest = 0;
let connecting = false;
let pendingWalletChange = null;
const $ = (id) => document.getElementById(id);

let state = Object.freeze({
  wallets: [],
  wallet: null,
  account: null,
  signer: null,
  owner: null,
  readOnly: false,
  phase: 'start', // start | loading | list
  accounts: [],
  names: new Map(),
  prices: new Map(),
  pricesLoading: false,
  pumpWarnings: [],
  scanError: null,
  selected: new Set(),
  filter: '',
  balance: null,
  plan: null,
  claimPlans: null,
  running: false,
});
let scanToken = 0;
let reviewToken = 0;
let renderedPhase = null;
let finishedRun = false;
let stopWalletEvents = () => {};

function update(patch) {
  state = Object.freeze({ ...state, ...patch });
}

const message = (error) => (error instanceof Error ? error.message : String(error));
const isRejection = (error) => /reject|denied|cancel|declin|abgelehnt/i.test(message(error));

// ---------- Darstellung ----------

function render() {
  const main = $('main');
  const showingAccount = accountVisible && Boolean(state.owner);
  const listShown = state.phase === 'list' && !showingAccount;
  if (showingAccount) renderAccountPage();
  if (!showingAccount && state.phase === 'start') setContent(main, views.renderStart({ onConnect: connect, onWatch: openAddressSheet }));
  if (!showingAccount && state.phase === 'loading') setContent(main, views.renderLoading('Loading accounts…'));
  if (listShown) setContent(main, views.renderAccounts(state, { onToggle: toggle, onSelectAll: selectAll, onFilter: setFilter, onReview: review }));
  // Einblenden nur beim Wechsel der Ansicht, nicht wenn Namen oder Kurse nachkommen
  const currentView = showingAccount ? 'account' : state.phase;
  main.firstElementChild?.classList.toggle('app-enter', renderedPhase !== currentView);
  renderedPhase = currentView;

  renderHeader();
  const hasActions = listShown && state.accounts.some((acc) => acc.action);
  $('action-bar').hidden = !hasActions;
  main.classList.toggle('app-has-action', hasActions);
  renderActionBar();
}

function renderHeader() {
  const hasAccount = Boolean(state.owner);
  const locked = state.running || connecting;
  const refresh = $('header-refresh');
  $('header-connect').hidden = hasAccount;
  $('header-address').hidden = hasAccount;
  $('header-connect').disabled = locked;
  $('header-address').disabled = locked;
  refresh.hidden = !hasAccount;
  refresh.disabled = state.phase === 'loading' || locked;

  const chip = $('wallet-chip');
  chip.hidden = !hasAccount;
  chip.disabled = locked;
  const accountButton = $('header-account');
  accountButton.hidden = !hasAccount;
  accountButton.disabled = locked;
  accountButton.setAttribute('aria-pressed', String(accountVisible));
  if (!hasAccount) return;
  setContent(chip, views.renderWalletChip(state));
  const label = state.readOnly ? 'Address' : 'Wallet';
  chip.setAttribute('aria-label', `${label} ${shortAddress(state.owner)}, open wallet menu`);
}

function renderActionBar() {
  const { count } = views.selectionSummary(state);
  const button = $('review-button');
  button.disabled = count === 0 || state.running || Boolean(state.scanError) || state.phase !== 'list';
  button.textContent = count === 0 ? 'Select accounts' : `Review selection (${count})`;
}

// Nur die Zusammenfassung und den Button erneuern, damit der Fokus auf der angeklickten Checkbox bleibt.
function refreshSelection() {
  $('payout-summary')?.replaceWith(views.renderPayoutSummary(state, { onReview: review }));
  renderActionBar();
}

// ---------- Account und lokale Transaktionshistorie ----------

function renderAccountPage() {
  const main = $('main');
  const previousFocus = main.contains(document.activeElement) ? document.activeElement : null;
  const identity = previousFocus && {
    tag: previousFocus.tagName,
    id: previousFocus.getAttribute('id'),
    label: previousFocus.getAttribute('aria-label'),
    href: previousFocus.getAttribute('href'),
    name: previousFocus.getAttribute('name'),
    value: previousFocus.value,
  };
  const saved = historyStore.read(state.owner);
  setContent(main, renderAccount({
    owner: state.owner,
    entries: saved.entries,
    warning: [saved.warning, historySyncWarning].filter(Boolean).join(' ') || null,
    range: historyRange,
    priceUsd: state.prices.get(WSOL_MINT),
    refreshing: historyRefreshing,
    onBack: () => {
      accountVisible = false;
      render();
      $('header-account').focus();
    },
    onRange: (range) => {
      historyRange = range;
      renderAccountPage();
      $('main').querySelector(`input[value="${range}"]`)?.focus();
    },
    onRefresh: refreshHistory,
  }));
  // Only restore focus if this render removed the user's current Account control.
  // A refresh finishing after they moved elsewhere must never steal their focus.
  if (identity) {
    const target = [...main.querySelectorAll('*')].find((node) => node.tagName === identity.tag && (
      identity.id ? node.getAttribute('id') === identity.id
        : identity.name ? node.getAttribute('name') === identity.name && node.value === identity.value
          : identity.href ? node.getAttribute('href') === identity.href
            : identity.label ? node.getAttribute('aria-label') === identity.label : false
    ));
    (target && !target.disabled ? target : $('account-title'))?.focus({ preventScroll: true });
  }
}

function openHistory() {
  if (!state.owner || state.running || connecting) return;
  accountVisible = !accountVisible;
  render();
  if (accountVisible) {
    refreshHistory();
    $('account-title')?.focus();
  }
}

async function refreshHistory() {
  if (!state.owner || historyRefreshing) return;
  const owner = state.owner;
  const request = ++historyRequest;
  historyRefreshing = true;
  historySyncWarning = null;
  if (accountVisible) renderAccountPage();
  try {
    const warning = await syncHistory({
      store: historyStore,
      rpc,
      owner,
      onUpdate: () => { if (state.owner === owner && accountVisible) renderAccountPage(); },
    });
    if (request === historyRequest) historySyncWarning = warning;
  } catch (error) {
    if (request === historyRequest) historySyncWarning = `Blockchain verification is currently unavailable. ${message(error)}`;
  } finally {
    if (request === historyRequest) {
      historyRefreshing = false;
      if (state.owner === owner && accountVisible) renderAccountPage();
    }
  }
}

function recordHistoryEvent(owner, plan, event) {
  if (!event.signature || !['sent', 'confirmed', 'failed', 'expired', 'unknown'].includes(event.type)) return;
  const batch = plan.batches[event.index];
  if (!batch) return;
  const groups = new Map();
  for (const item of batch.items) {
    const kind = item.action === 'claim-pump' ? 'pump' : 'token';
    const label = kind === 'pump' ? item.account.title : 'Token accounts';
    const key = kind + ':' + label;
    const previous = groups.get(key);
    groups.set(key, { kind, label, count: (previous?.count ?? 0) + 1 });
  }
  const saved = historyStore.upsert(owner, {
    signature: event.signature,
    timestamp: Date.now(),
    status: event.type,
    reclaimLamports: batch.items.reduce((sum, item) => sum + item.account.lamports, 0),
    feeLamports: BASE_FEE_LAMPORTS + priorityFeeLamports(batch.computeUnitLimit, plan.computeUnitPrice),
    tipLamports: batchTipLamports({ owner, items: batch.items, withTip: plan.withTip ?? false }),
    actualNetLamports: null,
    sources: [...groups.values()],
    error: event.error ?? null,
  });
  if (state.owner === owner && saved.warning) historySyncWarning = saved.warning;
}

// ---------- Auswahl ----------

function toggle(address, checked) {
  if (state.running || connecting) return;
  const selected = new Set(state.selected);
  if (checked) selected.add(address);
  else selected.delete(address);
  update({ selected });
  refreshSelection();
}

function selectAll(accounts, checked) {
  if (state.running || connecting) return;
  const selected = new Set(state.selected);
  for (const acc of accounts) {
    if (checked) selected.add(acc.address);
    else selected.delete(acc.address);
  }
  update({ selected });
  render();
}

let filterTimer = 0;
function setFilter(value) {
  if (state.running || connecting) return;
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => {
    if (state.running || connecting || state.phase !== 'list' || accountVisible) return;
    update({ filter: value.trim() });
    const hadFocus = document.activeElement?.type === 'search';
    render();
    if (hadFocus) {
      const search = document.querySelector('.app-search input');
      search?.focus();
      search?.setSelectionRange(search.value.length, search.value.length);
    }
  }, 150);
}

// ---------- Wallet ----------

function connect() {
  if (state.running || connecting) return;
  closeModal('flow-sheet');
  if (state.wallets.length === 1) {
    connectTo(state.wallets[0]);
    return;
  }
  setContent($('wallet-sheet-body'), views.renderWalletChoices(state.wallets, (wallet) => {
    closeModal('wallet-sheet');
    connectTo(wallet);
  }));
  openModal('wallet-sheet');
}

async function connectTo(wallet) {
  if (state.running || connecting) return;
  connecting = true;
  renderHeader();
  try {
    const account = await connectWallet(wallet);
    const signer = createSigner(wallet, account);
    stopWalletEvents();
    stopWalletEvents = onWalletChange(wallet, (event) => handleWalletChange(wallet, event));
    changeOwner({ wallet, account, signer, owner: account.address, readOnly: false });
    await scan();
  } catch (error) {
    if (!isRejection(error)) showError('Connection failed', message(error));
  } finally {
    connecting = false;
    renderHeader();
    applyPendingWalletChange();
  }
}

function handleWalletChange(wallet, event) {
  if (!event || (!('accounts' in event) && !('features' in event)) || state.wallet !== wallet) return;
  if (state.running || connecting) {
    const previous = pendingWalletChange?.wallet === wallet ? pendingWalletChange.event : {};
    pendingWalletChange = { wallet, event: { ...previous, ...event } };
    return;
  }
  const accountsChanged = 'accounts' in event;
  const accounts = accountsChanged ? event.accounts : wallet.accounts;
  // A feature update refreshes permissions for the reviewed owner, not the selected address.
  const next = Array.isArray(accounts) ? accounts.find((account) =>
    account?.chains?.includes?.(SOLANA_MAINNET) && (accountsChanged || account.address === state.owner)) : null;
  if (!next || !isAddress(next.address)) {
    closeModal('flow-sheet');
    closeModal('confirm-alert');
    resetToStart();
    return;
  }
  let signer;
  try {
    signer = createSigner(wallet, next);
  } catch (error) {
    closeModal('flow-sheet');
    closeModal('confirm-alert');
    resetToStart();
    showError('Reconnect your wallet', message(error));
    return;
  }
  if (next.address !== state.owner) {
    closeModal('flow-sheet');
    closeModal('confirm-alert');
    changeOwner({ account: next, signer, owner: next.address });
    scan();
  } else {
    const modeChanged = signer.mode !== state.signer?.mode;
    update({ account: next, signer });
    if (modeChanged) {
      reviewToken += 1;
      update({ plan: null, claimPlans: null });
      closeModal('flow-sheet');
      closeModal('confirm-alert');
    }
    renderHeader();
  }
}

function applyPendingWalletChange() {
  if (!pendingWalletChange || state.running || connecting) return;
  const deferred = pendingWalletChange;
  pendingWalletChange = null;
  handleWalletChange(deferred.wallet, deferred.event);
}

function changeOwner(patch) {
  accountVisible = false;
  historyRequest += 1;
  historyRefreshing = false;
  historySyncWarning = null;
  pendingWalletChange = null;
  finishedRun = false;
  clearTimeout(filterTimer);
  reviewToken += 1;
  update({ accounts: [], selected: new Set(), names: new Map(), prices: new Map(), pricesLoading: false, pumpWarnings: [], scanError: null, balance: null, filter: '', plan: null, claimPlans: null, ...patch });
}

function resetToStart() {
  if (state.running) return;
  accountVisible = false;
  historyRequest += 1;
  historyRefreshing = false;
  historySyncWarning = null;
  pendingWalletChange = null;
  finishedRun = false;
  clearTimeout(filterTimer);
  reviewToken += 1;
  stopWalletEvents();
  stopWalletEvents = () => {};
  scanToken += 1;
  update({ wallet: null, account: null, signer: null, owner: null, readOnly: false, phase: 'start', accounts: [], selected: new Set(), names: new Map(), prices: new Map(), pricesLoading: false, pumpWarnings: [], scanError: null, balance: null, filter: '', plan: null, claimPlans: null });
  render();
}

async function disconnect() {
  if (state.running || connecting) return;
  closeModal('account-sheet');
  const { wallet } = state;
  resetToStart();
  try {
    await disconnectWallet(wallet);
  } catch (error) {
    showError('Disconnection failed', message(error));
  }
}

// Trennt die aktuelle Wallet und öffnet gleich die Auswahl bzw. die Freigabe der Wallet,
// in der man ein anderes Konto wählen kann.
async function switchWallet() {
  if (state.running || connecting) return;
  closeModal('account-sheet');
  const { wallet, readOnly } = state;
  resetToStart();
  // Schlägt das Trennen fehl, ist das egal: die neue Verbindung ersetzt die alte ohnehin.
  if (!readOnly && wallet) await disconnectWallet(wallet).catch(() => null);
  connect();
}

async function reconnectWallet() {
  if (state.running || connecting) return;
  const { wallet } = state;
  if (!wallet) { connect(); return; }
  connecting = true;
  resetToStart();
  closeModal('flow-sheet');
  closeModal('confirm-alert');
  renderHeader();
  try {
    await disconnectWallet(wallet);
  } catch (error) {
    showError('Unable to reconnect', message(error));
    return;
  } finally {
    connecting = false;
    renderHeader();
  }
  await connectTo(wallet);
}

function openAccountSheet() {
  if (state.running || connecting) return;
  setContent($('account-sheet-body'), views.renderAccountSheet({
    state,
    onRefresh: () => { closeModal('account-sheet'); scan(); },
    onSwitch: switchWallet,
    onDisconnect: disconnect,
  }));
  openModal('account-sheet');
}

function openAddressSheet() {
  if (state.running || connecting) return;
  $('address-error').hidden = true;
  openModal('address-sheet');
}

function submitAddress() {
  if (state.running || connecting) return;
  const value = $('address-input').value.trim();
  if (!isAddress(value)) {
    setContent($('address-error'), views.renderFieldError('Enter a valid Solana address.'));
    $('address-error').hidden = false;
    return;
  }
  closeModal('address-sheet');
  stopWalletEvents();
  changeOwner({ wallet: null, account: null, signer: null, owner: value, readOnly: true });
  scan();
}

// ---------- Konten lesen ----------

async function scan() {
  if (state.running || !state.owner) return;
  const token = ++scanToken;
  const { owner } = state;
  update({ phase: 'loading', filter: '', scanError: null, plan: null, claimPlans: null });
  render();
  try {
    const [entries, balance, pump] = await Promise.all([
      rpc.getTokenAccounts(owner),
      rpc.getBalance(owner),
      scanPumpRewards({ rpc, owner }).catch((error) => ({
        accounts: [],
        reservedAddresses: [],
        warnings: [`Pump rewards could not be checked. ${message(error)}`],
      })),
    ]);
    if (token !== scanToken) return;
    const reserved = new Set(pump.reservedAddresses);
    const tokenAccounts = classifyAll(entries, owner).map((account) => reserved.has(account.address)
      ? { ...account, action: null, reason: 'This WSOL account is needed for Pump rewards. You can check it again after claiming.' }
      : account);
    const accounts = [...tokenAccounts, ...pump.accounts];
    const selected = new Set(accounts.filter((acc) => acc.action === 'close' || acc.action === 'claim-pump').map((acc) => acc.address));
    update({ phase: 'list', accounts, selected, balance, names: new Map(), prices: new Map(), pricesLoading: true, pumpWarnings: pump.warnings });
    render();
    loadDetails(token, accounts);
  } catch (error) {
    if (token !== scanToken) return;
    update({ phase: 'list', scanError: message(error) });
    render();
    showError('Unable to load accounts', message(error));
  }
}

// Namen und Kurse kommen nach; die Liste ist vorher schon benutzbar.
async function loadDetails(token, accounts) {
  const mints = accounts.filter((acc) => acc.action === 'burn').map((acc) => acc.mint);
  await Promise.all([
    fetchTokenNames({ rpc, accounts: accounts.filter((acc) => acc.mint) }).then((names) => {
      if (token !== scanToken) return;
      update({ names });
      render();
    }),
    fetchUsdPrices({ mints: [WSOL_MINT, ...mints] }).then((prices) => {
      if (token !== scanToken) return;
      update({ prices, pricesLoading: false });
      render();
    }),
  ]);
}

// ---------- Ablauf: prüfen → ausführen → fertig (ein Sheet) ----------

function minFeeFor(plan) {
  let required = 0;
  let spent = 0;
  let received = 0;
  for (const batch of plan.batches) {
    spent += BASE_FEE_LAMPORTS + priorityFeeLamports(batch.computeUnitLimit, plan.computeUnitPrice);
    required = Math.max(required, spent - received);
    for (const item of batch.items) {
      required = Math.max(required, spent - received + (item.account.upfrontLamports ?? 0));
      received += item.account.lamports;
    }
    spent += batchTipLamports({ owner: plan.owner, items: batch.items, withTip: plan.withTip ?? false });
    required = Math.max(required, spent - received);
  }
  return required;
}

function showFlow({ title, body, footer, closable = true }) {
  const modal = $('flow-sheet');
  const hadFocus = modal.contains(document.activeElement);
  setContent($('flow-sheet-title'), title);
  setContent($('flow-sheet-body'), body);
  setContent($('flow-sheet-footer'), footer ?? null);
  $('flow-close').hidden = !closable;
  $('flow-close').disabled = !closable;
  if (isModalOpen('flow-sheet') && hadFocus
    && (!modal.contains(document.activeElement) || document.activeElement === $('flow-close') && !closable)) {
    $('flow-sheet-title').setAttribute('tabindex', '-1');
    $('flow-sheet-title').focus({ preventScroll: true });
  }
}

function review() {
  return prepareReview();
}

async function prepareReview({ validation = null, originalItems = null, failures = [], notice = null } = {}) {
  if (state.running || connecting || state.phase !== 'list' || accountVisible || state.scanError) return;
  const token = ++reviewToken;
  const items = originalItems ?? state.accounts.filter((acc) => state.selected.has(acc.address)).map((account) => ({ action: account.action, account }));
  if (items.length === 0) return;
  update({ plan: null, claimPlans: null });
  showFlow({ title: 'Review', body: views.renderFlowSimulating() });
  openModal('flow-sheet');
  try {
    const owner = state.owner;
    const fresh = validation ?? await refreshPumpRewardItems({ rpc, owner, items });
    if (token !== reviewToken || owner !== state.owner || !isModalOpen('flow-sheet')) return;
    const reviewedPump = new Set(items.filter((item) => item.action === 'claim-pump').map((item) => item.account.address));
    if (reviewedPump.size) {
      const available = new Map(fresh.items.filter((item) => item.action === 'claim-pump').map((item) => [item.account.address, item.account]));
      const selected = new Set(state.selected);
      for (const address of reviewedPump) if (!available.has(address)) selected.delete(address);
      update({
        accounts: state.accounts.flatMap((account) => reviewedPump.has(account.address) ? available.has(account.address) ? [available.get(account.address)] : [] : [account]),
        selected,
        pumpWarnings: [...new Set([...fresh.warnings, ...fresh.skipped.map((entry) => entry.error)])],
      });
      render();
    }
    const prepared = await prepareBurnPlan({ rpc, owner, items: fresh.items });
    if (token !== reviewToken || owner !== state.owner || !isModalOpen('flow-sheet')) return;
    const plan = { ...prepared, owner, failed: [...failures, ...fresh.skipped, ...prepared.failed] };
    let tipPlan = null;
    let tipError = null;
    if (plan.batches.length) {
      try {
        const claimable = plan.batches.flatMap((batch) => batch.items);
        const tipped = await prepareBurnPlan({ rpc, owner, items: claimable, withTip: true });
        if (tipped.failed.length || tipped.batches.flatMap((batch) => batch.items).length !== claimable.length) {
          throw new Error('This selection could not be simulated with a tip.');
        }
        tipPlan = { ...tipped, owner };
      } catch {
        tipError = 'The tip option is currently unavailable. You can still claim without a tip.';
      }
    }
    if (token !== reviewToken || owner !== state.owner || !isModalOpen('flow-sheet')) return;
    update({ plan, claimPlans: { withoutTip: plan, withTip: tipPlan } });
    const minFeeLamports = minFeeFor(plan);
    const minTipFeeLamports = tipPlan ? minFeeFor(tipPlan) : Infinity;
    showFlow({
      title: 'Review',
      body: views.renderFlowReady({ plan, tipPlan, tipError, state, minFeeLamports, notice: notice ?? (fresh.requiresReview ? 'Pump rewards changed. Review the updated selection before continuing.' : null) }),
      footer: views.renderFlowReadyFooter({ plan, tipPlan, state, minFeeLamports, minTipFeeLamports, onExecute: requestExecute, onConnect: connect }),
    });
  } catch (error) {
    if (token !== reviewToken) return;
    closeModal('flow-sheet');
    showError('Simulation failed', message(error));
  }
}

function requestExecute(withTip) {
  if (state.running || connecting) return;
  if (typeof withTip !== 'boolean') return;
  const plan = withTip ? state.claimPlans?.withTip : state.claimPlans?.withoutTip;
  if (!plan) return;
  update({ plan });
  const risk = views.burnRisk(plan.batches.flatMap((b) => b.items), state);
  if (risk.unknown === 0 && risk.valuable === 0) {
    execute();
    return;
  }
  const parts = [];
  parts.push(plan.tipLamports ? `Your voluntary tip is ${formatSolNumber(plan.tipLamports)} SOL (20% of the quoted claim).` : 'No tip will be sent.');
  if (risk.valuable) parts.push(`${risk.valuable} ${risk.valuable === 1 ? 'token still has' : 'tokens still have'} value (≈ ${formatUsd(risk.valueUsd)} in total).`);
  if (risk.unknown) parts.push(`No price is available for ${risk.unknown} ${risk.unknown === 1 ? 'token' : 'tokens'}.`);
  parts.push('Burning is permanent and cannot be undone.');
  setContent($('confirm-alert-text'), parts.join(' '));
  openModal('confirm-alert');
}

async function execute() {
  closeModal('confirm-alert');
  const { plan, signer, owner } = state;
  if (!plan || !signer || state.running) return;
  if (plan.owner !== owner) {
    showError('Account changed', 'This review was for a different account. Please review your selection again.');
    return;
  }
  if (!isModalOpen('flow-sheet')) openModal('flow-sheet');
  let submitted = false;
  let reviewReplaced = false;
  let statuses = plan.batches.map(() => ({ status: 'waiting', signature: null, error: null }));
  const draw = (done) =>
    showFlow({
      title: done ? 'Done' : 'Processing',
      body: views.renderFlowProgress({ plan, statuses }),
      footer: views.renderFlowProgressFooter({ done, onDone: finishRun, onReconnect: done && statuses.some((status) => isWalletAuthorizationError(status.error)) ? reconnectWallet : undefined }),
      closable: done,
    });
  update({ running: true });
  clearTimeout(filterTimer);
  renderHeader();
  renderActionBar();
  draw(false);
  try {
    const items = plan.batches.flatMap((batch) => batch.items);
    const fresh = await refreshPumpRewardItems({ rpc, owner, items });
    if (fresh.requiresReview) {
      // Nothing has been signed or sent. Replace the preview and require a new explicit choice.
      reviewReplaced = true;
      finishedRun = false;
      update({ running: false, plan: null, claimPlans: null });
      renderHeader();
      renderActionBar();
      applyPendingWalletChange();
      if (state.owner === owner && isModalOpen('flow-sheet')) {
        await prepareReview({ validation: fresh, originalItems: items, failures: plan.failed,
          notice: 'Pump rewards changed. Review the updated selection before continuing.' });
      }
      return;
    }
    // A higher reward with identical instructions may proceed using the original quote and tip.
    submitted = true;
    await executeBurnPlan({
      rpc,
      signer,
      owner,
      plan,
      onProgress: (event) => {
        recordHistoryEvent(owner, plan, event);
        const indexes = event.type === 'signing' ? event.indexes : [event.index];
        const status = event.type === 'signing' ? 'signing' : event.type;
        statuses = statuses.map((s, i) => (indexes.includes(i) ? { status, signature: event.signature ?? s.signature, error: event.error ?? null } : s));
        draw(false);
      },
    });
  } catch (error) {
    statuses = statuses.map((s, index) => {
      if (!['waiting', 'signing', 'sent'].includes(s.status)) return s;
      const status = submitted ? 'unknown' : 'failed';
      recordHistoryEvent(owner, plan, { type: status, index, signature: s.signature, error: message(error) });
      return { ...s, status, error: message(error) };
    });
  } finally {
    update({ running: false });
    renderHeader();
    if (!reviewReplaced) {
      finishedRun = true;
      draw(true);
    }
    applyPendingWalletChange();
  }
}

function finishRun() {
  closeModal('flow-sheet');
}

// ---------- Start ----------

function init() {
  watchWallets(window, (wallets) => update({ wallets }));
  $('review-button').addEventListener('click', review);
  $('header-connect').addEventListener('click', connect);
  $('header-address').addEventListener('click', openAddressSheet);
  $('header-refresh').addEventListener('click', scan);
  $('wallet-chip').addEventListener('click', openAccountSheet);
  $('header-account').addEventListener('click', openHistory);
  window.addEventListener('storage', () => {
    if (accountVisible && state.owner) renderAccountPage();
  });
  $('address-submit').addEventListener('click', submitAddress);
  $('confirm-burn').addEventListener('click', execute);
  $('address-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submitAddress();
  });
  onModalClose('flow-sheet', () => {
    reviewToken += 1;
    // Nach einem Lauf die Liste neu lesen, egal wie das Sheet geschlossen wurde
    if (finishedRun && !state.running) {
      finishedRun = false;
      update({ plan: null, claimPlans: null });
      scan();
    }
  });
  // Während Transaktionen laufen, schließt Escape das Sheet nicht und die Seite warnt beim Verlassen.
  document.addEventListener('keydown', (event) => {
    if (state.running && event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
  window.addEventListener('beforeunload', (event) => {
    if (state.running) event.preventDefault();
  });
  render();
}

init();
