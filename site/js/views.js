// Ansichten aus Puppertino-Bausteinen. Reine Funktionen: Daten rein, DOM-Knoten raus.
import { h, icon, solMark } from './dom.js';
import { LAMPORTS_PER_SOL, formatSolNumber, formatTokenAmount, formatUsd, monogram, shortAddress, tokenValueUsd } from '../lib/format.js';
import { WSOL_MINT, impersonates } from '../lib/accounts.js';
import { TIP_RECIPIENT, batchTipLamports } from '../lib/tips.js';

export const VALUE_WARNING_USD = 1;
const ROUND_SIZE = 8; // Transaktionen je Wallet-Freigabe (wie in flow.js)

// ---------- Kleine Bausteine ----------

function list(rows, { cls } = {}) {
  return h('ul', { class: ['p-list', 'p-list-touch', 'p-list-inset', cls] }, rows);
}

function label(title, subtitle) {
  return h('span', { class: 'p-list-label' }, h('span', { class: 'p-list-title', text: title }), subtitle ? h('span', { class: 'p-list-subtitle' }, subtitle) : null);
}

function row({ leading, title, subtitle, trailing, cls }) {
  return h('li', { class: ['p-list-row', cls] }, leading, label(title, subtitle), trailing);
}

/** Betrag mit Solana-Zeichen: „◎ 0,0123 SOL“; sign: '+' oder '−'. */
export function amount(lamports, { sign = '', unit = true, cls } = {}) {
  return h(
    'span',
    { class: ['app-amount', cls] },
    sign ? h('span', { text: sign }) : null,
    solMark(),
    h('span', { text: formatSolNumber(lamports) }),
    unit ? h('span', { class: 'app-amount__unit', text: 'SOL' }) : null,
  );
}

function detail(node) {
  return h('span', { class: 'p-list-detail app-push' }, node);
}

function fact(name, text) {
  return h('li', {}, icon(name, { fill: true }), text);
}

function tintFor(text) {
  let sum = 0;
  for (const ch of text) sum = (sum + ch.charCodeAt(0)) % 997;
  return `app-tint-${sum % 8}`;
}

export function tokenTitle(account, meta) {
  return account.kind === 'pump-reward' ? account.title : meta?.name || meta?.symbol || shortAddress(account.mint || account.address) || 'Unknown account';
}

function avatar(account, meta) {
  if (account.kind === 'pump-reward') return h('span', { class: 'app-avatar app-tint-0', 'aria-hidden': 'true' }, icon('gift'));
  const identity = account.mint || account.address || '';
  return h('span', { class: ['app-avatar', tintFor(identity)], 'aria-hidden': 'true', text: monogram(meta?.symbol || meta?.name || identity) });
}

function loading(text) {
  return h(
    'div',
    { class: 'app-loading' },
    h('span', { class: 'p-spinner p-spinner-touch p-spinner-touch-large', role: 'progressbar', 'aria-label': text }),
    h('div', { text }),
  );
}

function groupHead(title, count, action) {
  return h('div', { class: 'app-group-head' }, h('h2', { class: 'app-group-title' }, `${title} `, h('span', { class: 'app-count', text: `· ${count}` })), action);
}

export function renderLoading(text) {
  return loading(text);
}

// ---------- Start ----------

export function renderStart({ onConnect, onWatch }) {
  return h(
    'div',
    { class: 'app-start' },
    h(
      'section',
      { class: 'app-hero app-material', 'aria-labelledby': 'start-title' },
      h('img', { class: 'app-hero__mark', src: 'icon.svg', alt: '', width: 104, height: 104 }),
      h('h1', { class: 'app-hero__title', id: 'start-title' }, 'Get your ', h('span', { class: 'app-gradient-text', text: 'SOL' }), ' back'),
      h('div', { class: 'app-hero__text', text: 'Close empty accounts, burn unwanted tokens, and recover the rent — usually 0.002 SOL per account. Optional tips support Solstake.' }),
      h('button', { class: 'p-button p-button-touch-large p-button-primary app-cta app-wide', type: 'button', on: { click: onConnect } }, 'Connect wallet'),
      h('button', { class: 'p-button p-button-touch-small p-button-borderless', type: 'button', on: { click: onWatch } }, 'View an address'),
      h('ul', { class: 'app-facts', 'aria-label': 'Safety' }, fact('lock-key', 'Your keys stay in your wallet'), fact('flask', 'Simulated before sending'), fact('hand-coins', 'Tipping is optional')),
    ),
  );
}

// ---------- Kontenliste ----------

export function selectionSummary(state) {
  const chosen = state.accounts.filter((acc) => state.selected.has(acc.address));
  const burns = chosen.filter((acc) => acc.action === 'burn').length;
  const lamports = chosen.reduce((sum, acc) => sum + acc.lamports, 0);
  const pumpCount = chosen.filter((acc) => acc.action === 'claim-pump').length;
  return { count: chosen.length, burns, lamports, pumpCount };
}

function summaryMeta({ count, burns, pumpCount }) {
  if (count === 0) return 'Choose accounts or Pump rewards.';
  const parts = [];
  const closes = count - pumpCount;
  if (closes) parts.push(`Close ${closes} ${closes === 1 ? 'account' : 'accounts'}`);
  if (pumpCount) parts.push('Claim Pump rewards');
  if (burns) parts.push(`Burn ${burns} ${burns === 1 ? 'token' : 'tokens'}`);
  return parts.join(' · ');
}

function renderPayout(summary, { onReview, running }) {
  return h(
    'section',
    { class: 'app-payout app-material', 'aria-labelledby': 'payout-sol-label' },
    h('h2', { class: 'app-payout__label', id: 'payout-sol-label', text: 'SOL to reclaim' }),
    h('output', { class: 'app-payout__value' }, amount(summary.lamports, { cls: 'app-gradient-amount' })),
    h('div', { class: 'app-payout__meta', text: summaryMeta(summary) }),
    h(
      'button',
      { class: 'p-button p-button-touch-large p-button-primary app-cta app-wide app-desktop-only', type: 'button', disabled: summary.count === 0 || running, on: { click: onReview } },
      'Review selection',
    ),
  );
}

export function renderPayoutSummary(state, { onReview }) {
  const summary = selectionSummary(state);
  const solPrice = state.prices.get(WSOL_MINT);
  const usdValue = summary.lamports === 0 ? 0 : solPrice === undefined ? null : (summary.lamports / LAMPORTS_PER_SOL) * solPrice;
  const estimatedValue = usdValue === null ? '–' : formatUsd(usdValue);
  const priceNote = solPrice === undefined
    ? (state.pricesLoading ? 'Loading SOL price…' : 'SOL price unavailable')
    : `1 SOL ≈ ${formatUsd(solPrice)}`;

  return h(
    'div',
    { class: 'app-summary', id: 'payout-summary' },
    renderPayout(summary, { onReview, running: state.running || state.phase !== 'list' || Boolean(state.scanError) }),
    h(
      'section',
      { class: 'app-payout app-material', 'aria-labelledby': 'payout-usd-label' },
      h('h2', { class: 'app-payout__label', id: 'payout-usd-label', text: 'Estimated USD value' }),
      h('output', { class: 'app-payout__value app-payout__usd', text: estimatedValue }),
      h('div', { class: 'app-payout__meta', text: priceNote }),
    ),
  );
}

function matches(account, meta, filter) {
  if (!filter) return true;
  const needle = filter.toLowerCase();
  return [meta?.name, meta?.symbol, account.mint, account.address].some((text) => text?.toLowerCase().includes(needle));
}

function holdingSubtitle(account, meta, price) {
  const units = `${formatTokenAmount(account.amount, account.decimals)} ${meta?.symbol || ''}`.trim();
  const value = tokenValueUsd(account.amount, account.decimals, price);
  const fake = impersonates(meta, account.mint);
  if (fake) return h('span', {}, icon('warning', { fill: true, cls: 'app-warn-icon', label: 'Warning' }), ` Not the real ${fake} · ${units}`);
  if (value === null) return units;
  if (value >= VALUE_WARNING_USD) {
    return h('span', {}, icon('warning', { fill: true, cls: 'app-warn-icon', label: 'Warning: token has value' }), ` ${units} · Value ≈ ${formatUsd(value)}`);
  }
  return `${units} · ≈ ${formatUsd(value)}`;
}

/** Risiko einer Auswahl: Tokens ohne bekannten Kurs und Tokens mit echtem Wert. */
export function burnRisk(items, state) {
  const burns = items.filter((item) => item.action === 'burn');
  const values = burns.map((item) => tokenValueUsd(item.account.amount, item.account.decimals, state.prices.get(item.account.mint)));
  return {
    unknown: values.filter((v) => v === null).length,
    valuable: values.filter((v) => v !== null && v >= VALUE_WARNING_USD).length,
    valueUsd: values.reduce((sum, v) => sum + (v ?? 0), 0),
  };
}

function selectRow({ account, meta, checked, actionLabel, subtitle, onToggle }) {
  const title = tokenTitle(account, meta);
  return h(
    'li',
    { class: 'p-list-row' },
    h(
      'label',
      { class: 'app-select-row' },
      h('input', {
        class: 'ui-check',
        type: 'checkbox',
        checked,
        'aria-label': `${actionLabel}: ${title}`,
        on: { change: (event) => onToggle(account.address, event.target.checked) },
      }),
      avatar(account, meta),
      label(title, subtitle),
      amount(account.lamports, { sign: '+', unit: false, cls: 'app-row-amount' }),
    ),
  );
}

function textButton(text, onClick) {
  return h('button', { class: 'p-button p-button-touch-small p-button-borderless', type: 'button', on: { click: onClick } }, text);
}

function tokenGroups(state, handlers) {
  const usable = state.accounts.filter((acc) => acc.kind !== 'pump-reward');
  const visible = usable.filter((acc) => matches(acc, state.names.get(acc.mint), state.filter));
  const empties = visible.filter((acc) => acc.action === 'close');
  const rank = (acc) => {
    const value = tokenValueUsd(acc.amount, acc.decimals, state.prices.get(acc.mint));
    if (value === null) return [1, 0];
    return [value >= VALUE_WARNING_USD ? 2 : 0, value];
  };
  const holdings = visible
    .filter((acc) => acc.action === 'burn')
    .sort((a, b) => {
      const [ra, va] = rank(a);
      const [rb, vb] = rank(b);
      return ra - rb || va - vb;
    });
  const blocked = visible.filter((acc) => !acc.action);
  const hiddenSelectedCount = state.filter
    ? usable.filter((acc) => state.selected.has(acc.address) && !matches(acc, state.names.get(acc.mint), state.filter)).length
    : 0;
  const parts = [];

  if (usable.length > 12 || state.filter) {
    const search = h('input', { type: 'search', placeholder: 'Search tokens', 'aria-label': 'Search tokens', value: state.filter, on: { input: (event) => handlers.onFilter(event.target.value) } });
    parts.push(
      h(
        'div',
        { class: 'app-search' },
        h(
          'label',
          { class: 'p-bar-search ui-fill' },
          icon('magnifying-glass'),
          search,
          state.filter ? h('button', {
            class: 'p-button p-button-touch p-button-borderless p-button-icon-only app-search-clear',
            type: 'button',
            'aria-label': 'Clear search',
            on: { click: () => {
              search.value = '';
              search.focus();
              handlers.onFilter('');
            } },
          }, icon('x-circle')) : null,
        ),
      ),
    );
  }

  if (hiddenSelectedCount) {
    parts.push(h('div', {
      class: 'app-note app-search-selection-note',
      role: 'status',
      text: hiddenSelectedCount === 1
        ? '1 selected account outside this search remains selected.'
        : `${hiddenSelectedCount} selected accounts outside this search remain selected.`,
    }));
  }

  if (usable.length === 0 && !state.scanError && !state.accounts.some((acc) => acc.kind === 'pump-reward') && !state.pumpWarnings?.length) {
    parts.push(
      h(
        'div',
        { class: 'p-empty-state' },
        icon('seal-check', { cls: 'p-empty-state__glyph' }),
        h('h2', { class: 'p-empty-state__title', text: 'All clear' }),
        h('p', { class: 'p-empty-state__message', text: 'This address has no token accounts holding reclaimable rent.' }),
      ),
    );
  }

  if (empties.length > 0) {
    const allChosen = empties.every((acc) => state.selected.has(acc.address));
    parts.push(
      groupHead('Empty accounts', empties.length, textButton(allChosen ? 'Deselect all' : 'Select all', () => handlers.onSelectAll(empties, !allChosen))),
      list(
        empties.map((account) =>
          selectRow({ account, meta: state.names.get(account.mint), checked: state.selected.has(account.address), actionLabel: 'Close', subtitle: 'Empty', onToggle: handlers.onToggle }),
        ),
        { cls: 'app-select-list' },
      ),
    );
  }

  if (holdings.length > 0) {
    parts.push(
      groupHead('Tokens with a balance', holdings.length),
      list(
        holdings.map((account) => {
          const meta = state.names.get(account.mint);
          return selectRow({ account, meta, checked: state.selected.has(account.address), actionLabel: 'Burn', subtitle: holdingSubtitle(account, meta, state.prices.get(account.mint)), onToggle: handlers.onToggle });
        }),
        { cls: 'app-select-list' },
      ),
      h('div', { class: 'app-note', text: 'Selected tokens will be permanently burned. If a token still has value, consider selling it instead.' }),
    );
  }

  if (blocked.length > 0) {
    parts.push(
      h(
        'details',
        { class: 'app-disclosure' },
        h('summary', { class: 'app-group-head' }, h('h2', { class: 'app-group-title' }, 'Unavailable ', h('span', { class: 'app-count', text: `· ${blocked.length}` })), icon('caret-down')),
        list(blocked.map((account) => row({ leading: avatar(account, state.names.get(account.mint)), title: tokenTitle(account, state.names.get(account.mint)), subtitle: account.reason, cls: 'app-dim' }))),
      ),
    );
  }

  if (visible.length === 0 && usable.length > 0) parts.push(h('div', { class: 'app-note', text: 'No tokens match your search.' }));
  return parts;
}

function pumpGroups(state, handlers) {
  const rewards = state.accounts.filter((account) => account.kind === 'pump-reward');
  const parts = [];
  if (rewards.length) {
    parts.push(
      groupHead('Pump rewards', rewards.length),
      list(rewards.map((account) => selectRow({
        account,
        checked: state.selected.has(account.address),
        actionLabel: 'Claim',
        subtitle: account.description,
        onToggle: handlers.onToggle,
      })), { cls: 'app-select-list' }),
    );
  }
  for (const warning of state.pumpWarnings ?? []) parts.push(h('div', { class: 'app-note', role: 'status', text: warning }));
  return parts;
}

export function renderAccounts(state, handlers) {
  return h(
    'div',
    { class: 'app-layout' },
    state.scanError ? h('div', { class: 'app-scan-warning app-material', role: 'alert' },
      icon('warning', { cls: 'app-warn-icon' }),
      h('div', {},
        h('strong', { text: 'Could not load accounts' }),
        h('div', { text: state.scanError }),
        h('div', { text: 'Use the refresh button in the header to try again.' }),
      ),
    ) : null,
    state.readOnly ? h('div', { class: 'app-note app-readonly-note', role: 'status' },
      icon('eye'),
      h('span', { text: 'View only: You can select accounts and review the amount. Connect the matching wallet to claim.' }),
    ) : null,
    renderPayoutSummary(state, handlers),
    h('section', { class: 'app-tokens app-material', 'aria-label': 'Token accounts' }, pumpGroups(state, handlers), tokenGroups(state, handlers)),
  );
}

// ---------- Wallet ----------

export function renderWalletChoices(wallets, onPick) {
  if (wallets.length === 0) {
    return h(
      'div',
      { class: 'p-empty-state app-wallet-empty' },
      icon('wallet', { cls: 'p-empty-state__glyph' }),
      h('h2', { class: 'p-empty-state__title', text: 'No wallet found' }),
      h('p', { class: 'p-empty-state__message', text: 'Install Phantom, Solflare, or Backpack as a browser extension, then reload this page.' }),
    );
  }
  return list(
    wallets.map((wallet) =>
      h(
        'li',
        { class: 'p-list-row' },
        h(
          'button',
          { class: 'app-row-button', type: 'button', on: { click: () => onPick(wallet) } },
          h('span', { class: 'p-list-icon' }, icon('wallet')),
          label(wallet.name),
          icon('caret-right', { cls: 'p-list-chevron' }),
        ),
      ),
    ),
  );
}

export function renderWalletChip(state) {
  return [
    icon(state.readOnly ? 'eye' : 'wallet'),
    h('span', { text: shortAddress(state.owner) }),
    icon('caret-down'),
  ];
}

export function renderAccountSheet({ state, onRefresh, onSwitch, onDisconnect }) {
  const leading = h('span', { class: 'p-list-icon' }, icon(state.readOnly ? 'eye' : 'wallet'));
  return [
    list(
      [
        row({
          leading,
          title: state.readOnly ? 'View only' : state.wallet?.name ?? 'Wallet',
          subtitle: shortAddress(state.owner),
          trailing: state.balance === null ? null : detail(amount(state.balance)),
          cls: 'app-oneline app-wallet-summary',
        }),
      ],
    ),
    h(
      'div',
      { class: 'app-sheet-section' },
      list([
        h('li', { class: 'p-list-row' }, h('button', { class: 'app-row-button', type: 'button', on: { click: onRefresh } }, icon('arrow-clockwise'), label('Reload accounts'))),
        h('li', { class: 'p-list-row' }, h('button', { class: 'app-row-button', type: 'button', on: { click: onSwitch } }, icon('swap'), label(state.readOnly ? 'Connect wallet' : 'Switch wallet'))),
        h('li', { class: 'p-list-row' }, h('button', { class: 'app-row-button app-destructive', type: 'button', on: { click: onDisconnect } }, icon('sign-out'), label(state.readOnly ? 'Stop viewing' : 'Disconnect wallet'))),
      ]),
    ),
    state.readOnly ? null : h('div', { class: 'app-note', text: 'Multiple accounts in Phantom? Switch accounts in Phantom and Solstake will update automatically.' }),
  ];
}

// ---------- Ablauf: prüfen → ausführen → fertig ----------

export function renderFlowSimulating() {
  return loading('Simulating… nothing has changed yet.');
}

function sheetHero(labelText, lamports) {
  return h(
    'div',
    { class: 'app-sheet-hero' },
    h('div', { class: 'app-payout__label', text: labelText }),
    h('output', { class: 'app-payout__value' }, amount(lamports, { cls: 'app-gradient-amount' })),
  );
}

export function renderFlowReady({ plan, tipPlan = null, tipError = null, state, minFeeLamports }) {
  const items = plan.batches.flatMap((b) => b.items);
  const burns = items.filter((item) => item.action === 'burn').length;
  const approvals = Math.ceil(plan.batches.length / ROUND_SIZE);
  const pumpItems = items.filter((item) => item.action === 'claim-pump');
  const closes = items.length - pumpItems.length;
  const parts = [];

  if (plan.batches.length === 0) {
    parts.push(h('div', { class: 'app-note app-note-strong', text: 'Nothing here can be processed. See the reasons below.' }));
  } else {
    parts.push(
      sheetHero('Available to reclaim', plan.reclaimLamports),
      list([
        closes ? row({ title: 'Token accounts to close', trailing: detail(String(closes)) }) : null,
        pumpItems.length ? row({ title: 'Pump rewards', trailing: detail(amount(pumpItems.reduce((sum, item) => sum + item.account.lamports, 0))) }) : null,
        burns ? row({ title: 'Tokens to burn', trailing: detail(String(burns)) }) : null,
        row({ title: 'Network fee', subtitle: 'estimated · without tip', trailing: detail(amount(plan.networkFeeLamports, { sign: '−' })) }),
      ]),
      h('div', { class: 'app-tip-info' },
        h('div', { class: 'app-tip-info__title' }, icon('heart'), h('span', { text: 'Support Solstake with an optional tip' })),
        h('div', { class: 'app-note', text: 'A 20% tip is calculated on the quoted SOL claim before network fees. Both options below show your estimated net amount.' }),
        tipPlan ? h('div', { class: 'app-tip-info__amount' }, h('span', { text: 'Optional tip' }), amount(tipPlan.tipLamports)) : null,
        h('a', { class: 'app-tip-recipient', href: `https://solscan.io/account/${TIP_RECIPIENT}`, target: '_blank', rel: 'noopener noreferrer', 'aria-label': `Tip recipient ${TIP_RECIPIENT}` },
          h('span', { text: `Tip wallet · ${shortAddress(TIP_RECIPIENT)}` }), icon('arrow-square-out')),
        state.owner === TIP_RECIPIENT ? h('div', { class: 'app-note', text: 'You are using the tip-receiving wallet. No tip will be sent.' }) : null,
        tipError ? h('div', { class: 'app-note', role: 'status', text: tipError }) : null,
      ),
    );
  }

  const burnItems = items.filter((item) => item.action === 'burn');
  if (burnItems.length > 0) {
    parts.push(
      h(
        'div',
        { class: 'app-sheet-section' },
        h('div', { class: 'app-group-head' }, h('h3', { class: 'app-group-title' }, 'Tokens to burn ', h('span', { class: 'app-count', text: `· ${burnItems.length}` }))),
        list(burnItems.map(({ account }) => burnRow(account, state))),
      ),
    );
  }

  if (plan.failed.length > 0) {
    parts.push(
      h(
        'details',
        { class: 'app-disclosure app-sheet-section', open: plan.batches.length === 0 },
        h('summary', { class: 'app-group-head' }, h('h3', { class: 'app-group-title' }, 'Skipped ', h('span', { class: 'app-count', text: `· ${plan.failed.length}` })), icon('caret-down')),
        list(plan.failed.map(({ item, error }) => row({ leading: avatar(item.account, state.names.get(item.account.mint)), title: tokenTitle(item.account, state.names.get(item.account.mint)), subtitle: error, cls: 'app-dim' }))),
      ),
    );
  }

  if (pumpItems.length) {
    parts.push(
      h('div', { class: 'app-sheet-section' },
        list(pumpItems.map(({ account }) => row({
          leading: avatar(account),
          title: account.title,
          subtitle: account.description,
          trailing: detail(amount(account.lamports)),
        }))),
      ),
    );
  }

  const notes = [];
  const upfront = pumpItems.reduce((sum, item) => sum + (item.account.upfrontLamports ?? 0), 0);
  if (upfront) notes.push(`PumpSwap temporarily creates a WSOL account. This requires ${formatSolNumber(upfront)} SOL, which is returned after the claim.`);
  if (burns) notes.push('Burned tokens are permanently gone.');
  if (plan.batches.length && !state.readOnly) notes.push(approvals === 1 ? 'Your wallet will ask for approval once.' : `Your wallet will ask for approval ${approvals} times.`);
  if (state.readOnly) notes.push('Connect the wallet that owns this address to continue.');
  if (!state.readOnly && state.balance !== null && plan.batches.length && state.balance < minFeeLamports) {
    notes.push('Your wallet needs more SOL for network fees or the temporary account deposit. Add SOL and review again.');
  }
  parts.push(...notes.map((text, i) => h('div', { class: ['app-note', i === 0 && burns && 'app-note-strong'], text })));
  return parts;
}

function burnRow(account, state) {
  const meta = state.names.get(account.mint);
  const value = tokenValueUsd(account.amount, account.decimals, state.prices.get(account.mint));
  const fake = impersonates(meta, account.mint);
  const units = `${formatTokenAmount(account.amount, account.decimals)} ${meta?.symbol || ''}`.trim();
  const valueText = fake ? `Not the real ${fake}` : value === null ? 'Value unknown' : `≈ ${formatUsd(value)}`;
  const risky = fake || value === null || value >= VALUE_WARNING_USD;
  return row({
    leading: avatar(account, meta),
    title: tokenTitle(account, meta),
    subtitle: `${units} · ${valueText} · ${shortAddress(account.mint)}`,
    trailing: risky ? icon('warning', { fill: true, cls: 'p-list-trailing-icon app-warn-icon', label: 'Review carefully' }) : null,
    cls: 'app-oneline',
  });
}

export function renderFlowReadyFooter({ plan, tipPlan = null, state, minFeeLamports, minTipFeeLamports = Infinity, onExecute, onConnect }) {
  if (state.readOnly) {
    return h('button', { class: 'p-button p-button-touch-large p-button-primary app-cta app-wide', type: 'button', on: { click: onConnect } }, 'Connect wallet');
  }
  const items = plan.batches.flatMap((b) => b.items);
  if (items.length === 0) return null;
  const burns = items.filter((item) => item.action === 'burn').length;
  const tooPoor = state.balance !== null && state.balance < minFeeLamports;
  const tipDisabled = !tipPlan || state.balance !== null && state.balance < minTipFeeLamports;
  const net = (choice) => Math.max(0, choice.reclaimLamports - choice.networkFeeLamports - (choice.tipLamports ?? 0));
  const option = (title, choice, withTip, disabled) => h('button', {
    class: ['p-button', 'p-button-touch-large', 'app-wide', 'app-claim-choice', withTip ? 'p-button-primary app-cta' : 'p-button-default app-claim-choice--plain'],
    type: 'button', disabled,
    'aria-label': title,
    on: { click: () => onExecute(withTip) },
  },
  h('span', { class: 'app-claim-choice__title' }, withTip ? icon('heart') : icon('arrow-down'), h('span', { text: title })),
  h('span', { class: 'app-claim-choice__detail', text: choice ? `Receive ≈ ${formatSolNumber(net(choice))} SOL${withTip && choice.tipLamports > 0 ? ' · 20% tip included' : ''}` : 'Not available for this selection' }),
  );
  return h('div', { class: 'app-claim-choices' },
    burns ? h('div', { class: 'app-claim-burn-note', role: 'note', text: `Both options burn ${burns} selected ${burns === 1 ? 'token' : 'tokens'}. Burning is permanent.` }) : null,
    option(burns ? 'Burn & Claim with Tip' : 'Claim with Tip', tipPlan, true, tipDisabled),
    option(burns ? 'Burn & Claim without Tip' : 'Claim without Tip', plan, false, tooPoor),
  );
}

const STATUS_VIEW = {
  waiting: { text: 'Waiting', icon: () => icon('circle-dashed', { cls: 'p-list-trailing-icon app-status-wait' }) },
  signing: { text: 'Approve in your wallet', icon: () => h('span', { class: 'p-spinner p-spinner-touch', role: 'progressbar', 'aria-label': 'Waiting for approval' }) },
  sent: { text: 'Sent, awaiting confirmation', icon: () => h('span', { class: 'p-spinner p-spinner-touch', role: 'progressbar', 'aria-label': 'Confirming' }) },
  confirmed: { text: 'Confirmed', icon: () => icon('check-circle', { fill: true, cls: 'p-list-trailing-icon app-status-ok', label: 'Confirmed' }) },
  failed: { text: 'Failed', icon: () => icon('x-circle', { fill: true, cls: 'p-list-trailing-icon app-status-fail', label: 'Failed' }) },
  expired: { text: 'Expired', icon: () => icon('x-circle', { fill: true, cls: 'p-list-trailing-icon app-status-fail', label: 'Expired' }) },
  rejected: { text: 'Not executed', icon: () => icon('prohibit', { cls: 'p-list-trailing-icon app-status-wait', label: 'Not executed' }) },
  unknown: { text: 'Status unknown', icon: () => icon('warning', { fill: true, cls: 'p-list-trailing-icon app-warn-icon', label: 'Status unknown' }) },
};

export function renderFlowProgress({ plan, statuses }) {
  const total = plan.batches.length;
  const finished = statuses.filter((s) => !['waiting', 'signing', 'sent'].includes(s.status)).length;
  const confirmedLamports = plan.batches.reduce(
    (sum, batch, i) => (statuses[i].status === 'confirmed' ? sum + batch.items.reduce((s, item) => s + item.account.lamports, 0) : sum),
    0,
  );
  const confirmedTips = plan.batches.reduce((sum, batch, i) => sum + (statuses[i].status === 'confirmed'
    ? batchTipLamports({ owner: plan.owner, items: batch.items, withTip: plan.withTip ?? false }) : 0), 0);
  const rows = plan.batches.map((batch, i) => {
    const s = statuses[i];
    const view = STATUS_VIEW[s.status] ?? STATUS_VIEW.unknown;
    const link = s.signature
      ? h('a', { class: 'app-link', href: `https://solscan.io/tx/${encodeURIComponent(s.signature)}`, target: '_blank', rel: 'noopener noreferrer', 'aria-label': `Open transaction ${i + 1} in explorer` }, icon('arrow-square-out'))
      : null;
    const hasPump = batch.items.some((item) => item.action === 'claim-pump');
    const category = hasPump ? (batch.items.length === 1 ? 'item' : 'items') : batch.items.length === 1 ? 'account' : 'accounts';
    const subtitle = `${batch.items.length} ${category} · ${s.error ?? view.text}`;
    return row({ title: total === 1 ? 'Transaction' : `Transaction ${i + 1} of ${total}`, subtitle, trailing: h('span', { class: 'ui-row app-push' }, link, view.icon()) });
  });
  return [
    sheetHero('Reclaimed before tips and fees', confirmedLamports),
    confirmedTips > 0 ? h('div', { class: 'app-note', text: `Voluntary tip sent: ${formatSolNumber(confirmedTips)} SOL. Included in the confirmed transactions.` }) : null,
    h('progress', { class: 'p-progress p-progress-touch app-progress', value: String(finished), max: String(Math.max(1, total)), 'aria-label': `${finished} of ${total} complete` }),
    list(rows),
  ];
}

export function renderFlowProgressFooter({ done, onDone, onReconnect }) {
  if (!done) return h('div', { class: 'app-note', text: 'Keep this page open until all transactions are confirmed.' });
  return h('button', { class: 'p-button p-button-touch-large p-button-primary app-cta app-wide', type: 'button', on: { click: onReconnect ?? onDone } }, onReconnect ? 'Reconnect wallet' : 'Done');
}

export function renderFieldError(text) {
  return [icon('warning', { fill: true }), h('span', { text })];
}
