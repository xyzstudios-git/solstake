import { h, icon } from './dom.js';
import { amount } from './views.js';
import { formatSolNumber, formatUsd, LAMPORTS_PER_SOL, shortAddress } from '../lib/format.js';
import { summarizeHistory } from '../lib/history.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const dateFormat = new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'short' });
const timeFormat = new Intl.DateTimeFormat('en-US', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const STATUS = {
  confirmed: { text: 'Confirmed', icon: 'check-circle', cls: 'app-account-status-ok' },
  sent: { text: 'Confirming', icon: 'clock', cls: 'app-account-status-pending' },
  unknown: { text: 'Status unknown', icon: 'question', cls: 'app-account-status-pending' },
  expired: { text: 'Expired', icon: 'clock', cls: 'app-account-status-failed' },
  failed: { text: 'Failed', icon: 'x-circle', cls: 'app-account-status-failed' },
};

function svg(tag, attributes = {}, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  for (const child of children) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
}

function rangeControl(range, onRange) {
  return h('div', { class: 'p-segmented p-segmented-touch app-account-range', role: 'group', 'aria-label': 'Time range' },
    [['7d', '7 days'], ['30d', '30 days'], ['all', 'All time']].map(([value, label]) =>
      h('label', { class: 'p-segment' },
        h('input', { type: 'radio', name: 'account-range', value, checked: range === value, on: { change: () => onRange(value) } }),
        h('span', { text: label }),
      )),
  );
}

function metric(label, value, note) {
  return h('div', { class: 'app-account-metric' },
    h('div', { class: 'app-account-caption', text: label }),
    h('div', { class: 'app-account-metric-value' }, value),
    h('div', { class: 'app-account-footnote', text: note }),
  );
}

function chart(summary) {
  const points = summary.chartPoints.filter((point) => Number.isFinite(point.timestamp) && Number.isFinite(point.lamports) && point.lamports >= 0);
  if (!summary.confirmedCount || points.length === 0) {
    return h('div', { class: 'app-account-chart-empty' },
      icon('chart-line-up', { cls: 'app-account-empty-icon' }),
      h('div', { class: 'app-account-empty-title', text: 'No confirmed claims in this period' }),
      h('div', { class: 'app-account-footnote', text: 'Confirmed claims build your cumulative history here.' }),
    );
  }

  const left = 0;
  const right = 760;
  const top = 18;
  const bottom = 205;
  const first = points[0].timestamp;
  const last = points[points.length - 1].timestamp;
  const maximum = Math.max(summary.totalClaimedLamports, 1);
  const x = (point) => left + ((point.timestamp - first) / Math.max(last - first, 1)) * (right - left);
  const y = (point) => bottom - (point.lamports / maximum) * (bottom - top);
  const path = points.map((point, index) => `${index ? 'L' : 'M'}${x(point).toFixed(2)},${y(point).toFixed(2)}`).join(' ');
  const lastX = x(points[points.length - 1]).toFixed(2);
  const area = `${path} L${lastX},${bottom} L${left},${bottom} Z`;
  const readout = h('div', { class: 'app-account-chart-readout', 'aria-live': 'polite', text: `${dateFormat.format(last)} · ${formatSolNumber(summary.totalClaimedLamports)} SOL total` });
  const markers = points.length <= 91 ? points : points.filter((point, index) => index === 0 || index === points.length - 1 || index % Math.ceil(points.length / 90) === 0);
  const circles = markers.map((point) => {
    const text = `${dateFormat.format(point.timestamp)} · ${formatSolNumber(point.lamports)} SOL total`;
    const circle = svg('circle', { cx: x(point).toFixed(2), cy: y(point).toFixed(2), r: 6, class: 'app-account-chart-point', tabindex: 0, role: 'img', 'aria-label': text }, svg('title', {}, text));
    circle.addEventListener('focus', () => { readout.textContent = text; });
    circle.addEventListener('mouseenter', () => { readout.textContent = text; });
    return circle;
  });
  for (const [index, circle] of circles.entries()) {
    circle.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const next = Math.max(0, Math.min(circles.length - 1, index + (event.key === 'ArrowRight' ? 1 : -1)));
      circles[next].focus();
    });
  }

  const drawing = svg('svg', { viewBox: '0 0 760 220', preserveAspectRatio: 'none', class: 'app-account-chart', role: 'group', 'aria-label': 'Cumulative confirmed claims in SOL' },
    svg('defs', {}, svg('linearGradient', { id: 'account-chart-fill', x1: 0, y1: 0, x2: 0, y2: 1 },
      svg('stop', { offset: '0%', 'stop-color': 'currentColor', 'stop-opacity': 0.22 }),
      svg('stop', { offset: '100%', 'stop-color': 'currentColor', 'stop-opacity': 0.01 }),
    )),
    ...[0, 0.5, 1].map((fraction) => {
      const rowY = bottom - fraction * (bottom - top);
      return svg('line', { x1: left, y1: rowY, x2: right, y2: rowY, class: 'app-account-grid-line' });
    }),
    svg('path', { d: area, fill: 'url(#account-chart-fill)' }),
    svg('path', { d: path, class: 'app-account-chart-line', 'vector-effect': 'non-scaling-stroke' }),
    ...circles,
  );

  return h('figure', { class: 'app-account-figure' },
    h('div', { class: 'app-account-chart-layout' },
      h('div', { class: 'app-account-y-axis', 'aria-hidden': 'true' },
        ...[1, 0.5, 0].map((fraction) => h('span', { text: formatSolNumber(maximum * fraction) })),
      ),
      h('div', { class: 'app-account-chart-plot' }, drawing,
        h('div', { class: 'app-account-x-axis', 'aria-hidden': 'true' }, h('span', { text: dateFormat.format(first) }), h('span', { text: dateFormat.format(last) })),
      ),
    ), readout,
    h('details', { class: 'app-account-chart-data' },
      h('summary', {}, 'View history as a table'),
      h('table', {},
        h('caption', { class: 'app-account-visually-hidden', text: 'Cumulative claims by day' }),
        h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: 'Date' }), h('th', { scope: 'col', text: 'SOL' }))),
        h('tbody', {}, points.map((point) => h('tr', {}, h('td', { text: dateFormat.format(point.timestamp) }), h('td', { text: formatSolNumber(point.lamports) })))),
      ),
    ),
  );
}

function transactionTitle(entry) {
  const kinds = new Set(entry.sources.map((source) => source.kind));
  if (kinds.has('pump') && kinds.has('token')) return 'Pump rewards and account rent';
  if (kinds.has('pump')) return 'Pump rewards';
  return 'Account rent';
}

function transactionRow(entry) {
  const status = STATUS[entry.status] ?? STATUS.unknown;
  const confirmed = entry.status === 'confirmed';
  const count = entry.sources.reduce((sum, source) => sum + source.count, 0);
  return h('li', { class: 'app-account-transaction' },
    h('span', { class: ['app-account-transaction-icon', status.cls], 'aria-hidden': 'true' }, icon(confirmed ? 'arrow-down' : status.icon)),
    h('div', { class: 'app-account-transaction-main' },
      h('div', { class: 'app-account-transaction-title', text: transactionTitle(entry) }),
      h('time', { class: 'app-account-footnote', datetime: new Date(entry.timestamp).toISOString(), text: timeFormat.format(entry.timestamp) }),
      h('div', { class: ['app-account-transaction-status', status.cls] }, icon(status.icon), h('span', { text: status.text }),
        count ? h('span', { class: 'app-account-transaction-count', text: `· ${count} ${count === 1 ? 'source' : 'sources'}` }) : null,
      ),
      entry.error ? h('div', { class: 'app-account-footnote app-account-transaction-error', text: entry.error }) : null,
    ),
    h('div', { class: 'app-account-transaction-amount' },
      h('div', { class: confirmed ? 'app-account-status-ok' : 'app-account-muted' },
        confirmed ? null : h('span', { class: 'app-account-footnote', text: 'Expected: ' }),
        amount(entry.reclaimLamports, { sign: confirmed ? '+' : '', unit: true }),
      ),
      h('div', { class: 'app-account-footnote', text: `Fee ${entry.actualNetLamports === null ? '≈ ' : ''}${formatSolNumber(entry.feeLamports)} SOL` }),
    ),
    h('a', { class: 'p-button p-button-touch-small p-button-borderless p-button-icon-only app-account-explorer', href: `https://solscan.io/tx/${encodeURIComponent(entry.signature)}`, target: '_blank', rel: 'noopener noreferrer', 'aria-label': 'Open transaction in explorer', title: 'Open in explorer' }, icon('arrow-square-out')),
  );
}

/** Account data is scoped to the selected wallet and stored by this browser. */
export function renderAccount({ owner, entries, range = '30d', warning = '', onRange, onBack, onRefresh, priceUsd = null, refreshing = false, now = Date.now() }) {
  const summary = summarizeHistory(entries, { range, now });
  const visible = summary.entries;
  const usd = typeof priceUsd === 'number' && Number.isFinite(priceUsd) && priceUsd > 0 ? formatUsd(summary.totalClaimedLamports / LAMPORTS_PER_SOL * priceUsd) : null;
  const hero = h('section', { class: 'app-account-overview app-material', 'aria-label': 'Claims in the selected period' },
    h('div', { class: 'app-account-overview-head' },
      h('div', {},
        h('div', { class: 'app-account-caption', text: 'Total claimed' }),
        h('div', { class: 'app-account-total' }, amount(summary.totalClaimedLamports)),
        h('div', { class: 'app-account-footnote', text: summary.claimedIsEstimated ? 'Confirmed claims · estimated before network fees' : 'Confirmed claims · before network fees' }),
      ),
      usd ? h('div', { class: 'app-account-usd' }, h('div', { text: `≈ ${usd}` }), h('div', { class: 'app-account-footnote', text: 'at the current SOL price' })) : null,
    ),
    h('div', { class: 'app-account-graph-head' }, h('div', { class: 'app-account-caption', text: 'History' }), rangeControl(range, onRange)),
    chart(summary),
    h('div', { class: 'app-account-metrics' },
      metric('Confirmed transactions', String(summary.confirmedCount), summary.pendingCount ? `${summary.pendingCount} still pending` : 'in the selected period'),
      metric('Network fees', amount(summary.totalFeeLamports), summary.netIsEstimated ? 'estimated from claims' : 'from confirmed transactions'),
      metric('Net reclaimed', amount(summary.netLamports), summary.netIsEstimated ? 'estimated after network fees' : 'from confirmed transactions'),
    ),
  );

  return h('div', { class: 'app-account', 'aria-labelledby': 'account-title' },
    h('div', { class: 'app-account-heading' },
      h('div', { class: 'app-account-identity' },
        h('button', { class: 'p-button p-button-touch p-button-default p-button-icon-only app-account-back', type: 'button', 'aria-label': 'Back to selection', on: { click: onBack } }, icon('arrow-left')),
        h('div', {},
          h('h1', { class: 'app-account-title', id: 'account-title', tabindex: -1, text: 'Account' }),
          h('a', { class: 'app-account-wallet', href: `https://solscan.io/account/${encodeURIComponent(owner)}`, target: '_blank', rel: 'noopener noreferrer', 'aria-label': 'Open wallet in explorer' }, icon('wallet'), shortAddress(owner), icon('arrow-square-out')),
        ),
      ),
      h('button', { class: 'p-button p-button-touch p-button-default p-button-icon-only app-account-refresh', type: 'button', disabled: refreshing, 'aria-label': 'Refresh transaction status', title: 'Refresh transaction status', on: { click: onRefresh } }, icon('arrow-clockwise')),
    ),
    warning ? h('div', { class: 'app-account-warning', role: 'status' }, icon('warning'), h('span', { text: warning })) : null,
    hero,
    h('section', { class: 'app-account-history app-material', 'aria-labelledby': 'account-history-title' },
      h('div', { class: 'app-account-history-head' }, h('h2', { class: 'app-account-section-title', id: 'account-history-title', text: 'Transactions' }), h('span', { class: 'app-account-footnote', text: 'Recorded in this browser' })),
      visible.length
        ? h('ul', { class: 'app-account-transactions' }, visible.map(transactionRow))
        : h('div', { class: 'app-account-history-empty' }, icon('clock-counter-clockwise', { cls: 'app-account-empty-icon' }), h('div', { class: 'app-account-empty-title', text: 'No transactions yet' }), h('div', { class: 'app-account-footnote', text: 'Your confirmed claims will appear here. History starts when you use this Account feature.' })),
    ),
  );
}
