/* app.js — state, UI and wiring for both sections. */
(function () {
  'use strict';

  var K = window.Kelly, S = window.Sim, C = window.Charts;

  /* ---- utils ----------------------------------------------------------- */

  function $(id) { return document.getElementById(id); }
  function num(el) { var v = parseFloat(el.value); return isFinite(v) ? v : 0; }
  function show(el, on) { el.classList.toggle('hidden', !on); }

  function money(v) {
    if (!isFinite(v)) return '—';
    var a = Math.abs(v);
    var d = a >= 1000 ? 0 : a >= 10 ? 1 : 2;
    return v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function count(n) { return n.toLocaleString('en-US'); }
  function pct(v, d) { return (v * 100).toFixed(d == null ? 2 : d) + ' %'; }
  /* Growth per ticket lands around 1e-4, which reads terribly in exponential
   * notation. Everything is therefore shown in basis points: 8.006e-4 → 8.01 bps. */
  function bps(g) {
    if (!isFinite(g)) return '—';
    var v = g * 10000, a = Math.abs(v);
    return (a < 10 ? v.toFixed(2) : a < 100 ? v.toFixed(1) : v.toFixed(0)) + ' bps';
  }
  /* The same for axis ticks — no unit, the axis label carries it. */
  function bpsAxis(v) {
    if (!isFinite(v)) return '';
    if (v === 0) return '0';
    var b = v * 10000, a = Math.abs(b);
    return a < 1 ? b.toFixed(2) : a < 10 ? b.toFixed(1) : b.toFixed(0);
  }
  /* Growth over 100 tickets — more legible than a bare E[log]. */
  function per100(g) { return (Math.expm1(g * 100) * 100).toFixed(2) + ' %'; }

  /* Segmented control: returns the current value, calls onChange. */
  function segment(el, onChange) {
    var btns = Array.prototype.slice.call(el.querySelectorAll('button'));
    btns.forEach(function (b) {
      b.addEventListener('click', function () {
        btns.forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
        onChange(b.dataset.v);
      });
    });
    return function () {
      var on = el.querySelector('[aria-pressed="true"]');
      return on ? on.dataset.v : btns[0].dataset.v;
    };
  }

  function callout(kind, html) {
    var d = document.createElement('div');
    d.className = 'callout' + (kind ? ' ' + kind : '');
    var i = document.createElement('span');
    i.className = 'ico';
    i.textContent = kind === 'bad' ? '✕' : kind === 'warn' ? '!' : 'i';
    var b = document.createElement('div');
    b.className = 'body';
    b.innerHTML = html;                       // our own strings only, never input data
    d.appendChild(i); d.appendChild(b);
    return d;
  }

  function kpi(label, value, detail, tone) {
    var d = document.createElement('div');
    d.className = 'kpi';
    var k = document.createElement('div'); k.className = 'k'; k.textContent = label;
    var v = document.createElement('div'); v.className = 'v' + (tone ? ' ' + tone : ''); v.textContent = value;
    d.appendChild(k); d.appendChild(v);
    if (detail) { var e = document.createElement('div'); e.className = 'd'; e.textContent = detail; d.appendChild(e); }
    return d;
  }

  function legend(el, items) {
    while (el.firstChild) el.removeChild(el.firstChild);
    items.forEach(function (it) {
      var d = document.createElement('div'); d.className = 'legend-item';
      var k = document.createElement('span');
      k.className = 'legend-key' + (it.box ? ' box' : '');
      k.style.background = it.color;
      var t = document.createElement('span'); t.textContent = it.label;
      d.appendChild(k); d.appendChild(t); el.appendChild(d);
    });
  }

  function table(el, headers, rows) {
    while (el.firstChild) el.removeChild(el.firstChild);
    var t = document.createElement('table');
    var thead = document.createElement('thead'), tr = document.createElement('tr');
    headers.forEach(function (h) { var th = document.createElement('th'); th.textContent = h; tr.appendChild(th); });
    thead.appendChild(tr); t.appendChild(thead);
    var tb = document.createElement('tbody');
    rows.forEach(function (r) {
      var trr = document.createElement('tr');
      r.forEach(function (c) { var td = document.createElement('td'); td.textContent = c; trr.appendChild(td); });
      tb.appendChild(trr);
    });
    t.appendChild(tb); el.appendChild(t);
  }

  function downloadCsv(name, headers, rows) {
    var lines = [headers.join(',')].concat(rows.map(function (r) {
      return r.map(function (c) { return /[",\n]/.test(String(c)) ? '"' + String(c).replace(/"/g, '""') + '"' : c; }).join(',');
    }));
    var blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }

  /* ---- perspective ------------------------------------------------------
   *
   * Which side of the ticket you are on governs BOTH tabs, so it lives here
   * rather than inside either of them. Every label that would otherwise
   * quietly assume you are the seller is rewritten from this one place.
   */

  var side = 'sell';
  var perspectiveListeners = [];
  function isSell() { return side !== 'buy'; }
  function onPerspective(fn) { perspectiveListeners.push(fn); }

  function applyPerspectiveLabels() {
    var sell = isSell();

    $('perspNote').innerHTML = sell
      ? 'You win when the combo <strong>misses</strong>.'
      : 'You win when the combo <strong>hits</strong>.';

    $('q_markupLabel').textContent = sell ? 'Markup over fair' : 'Discount below fair';
    $('q_markupNote').textContent = sell
      ? 'left: %, right: the resulting sale price'
      : 'left: %, right: the resulting buy price';
    $('q_priceLabel').textContent = sell
      ? 'Sale price (what you sell it at)'
      : 'Buy price (what you pay)';
    $('q_premiumLabel').textContent = sell ? 'Premium collected' : 'Profit if it hits';
    $('q_haircutNote').innerHTML = sell
      ? 'Positive = the combo hits more often than the product of legs says, so your edge is <strong>smaller</strong>. Leg prices carry a spread, so reality tends to sit below the product — but Kelly is dangerous mainly when the edge is overestimated.'
      : 'Positive = the combo hits more often than the product of legs says, so your edge is <strong>larger</strong>. As a buyer the danger is the other way: drag the slider negative to see what happens when the combo lands less often than you assumed.';

    $('r_markupLabel').textContent = sell
      ? 'Your edge (markup over fair)'
      : 'Your edge (discount below fair)';
    $('r_mirrorCLabel').textContent = sell ? 'sale price' : 'buy price';
    $('r_heroLabel').textContent = sell
      ? 'Kelly per ticket — constant across the whole band at a fixed edge'
      : 'Kelly per ticket — at the balanced end of the band';
  }

  var getPerspective = segment($('perspective'), function (v) {
    side = v;
    applyPerspectiveLabels();
    perspectiveListeners.forEach(function (fn) { fn(v); });
  });

  /* ---- theme and tabs ---------------------------------------------------- */

  var charts = [];
  function redrawAll() { C.invalidateColors(); charts.forEach(function (c) { c.render(); }); }

  $('themeToggle').addEventListener('click', function () {
    var root = document.documentElement;
    root.dataset.theme = root.dataset.theme === 'light' ? 'dark' : 'light';
    document.querySelector('meta[name=theme-color]').setAttribute(
      'content', root.dataset.theme === 'light' ? '#f9f9f7' : '#0d0d0d');
    redrawAll();
  });

  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (tab) {
    tab.addEventListener('click', function () {
      Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
        t.setAttribute('aria-selected', String(t === tab));
      });
      Array.prototype.forEach.call(document.querySelectorAll('.view'), function (v) {
        v.classList.toggle('active', v.id === 'view-' + tab.dataset.view);
      });
      setTimeout(function () { charts.forEach(function (c) { c.resize(); }); }, 0);
    });
  });

  function mount(id) { var c = C.mount($(id)); charts.push(c); return c; }

  /* Every run gets a fresh random seed — otherwise you would stare at one and
   * the same path and never notice how much of the result is just luck. The
   * lock holds it when you want to repeat a run unchanged. */
  function randomSeed() { return Math.floor(Math.random() * 4294967296); }

  function wireSeed(prefix) {
    $(prefix + '_seed').value = randomSeed();
  }

  /* Returns the seed for this run and writes it back so it is visible. */
  function nextSeed(prefix) {
    var input = $(prefix + '_seed');
    if (!$(prefix + '_seedLock').checked) input.value = randomSeed();
    var v = Math.round(num(input));
    return v >= 0 ? v : randomSeed();
  }

  /* ---- shared drawing ---------------------------------------------------- */

  /* Fan chart: percentile bands in one hue (magnitude of certainty), with
   * median and mean as two distinguished series. */
  function fanData(res, logAxis, B0) {
    var x = Array.prototype.slice.call(res.checkpoints);
    var b = res.bands;
    var s1 = C.css('--series-1'), s2 = C.css('--series-2');

    var lo = Infinity, hi = -Infinity;
    for (var i = 0; i < x.length; i++) {
      lo = Math.min(lo, b.p5[i]);
      hi = Math.max(hi, b.p95[i], b.mean[i]);
    }
    lo = Math.min(lo, B0); hi = Math.max(hi, B0);
    if (logAxis) { lo = Math.max(lo * 0.75, B0 * 1e-6); hi = hi * 1.3; }
    else { var padv = (hi - lo) * 0.08; lo = Math.max(0, lo - padv); hi = hi + padv; }

    return {
      x: x, xMin: x[0], xMax: x[x.length - 1],
      yMin: lo, yMax: hi, yScale: logAxis ? 'log' : 'linear',
      xLabel: 'ticket', yLabel: 'bankroll',
      fmtY: C.fmtCompact, fmtX: function (v) { return v.toFixed(0); },
      fmtTipX: function (v) { return 'after ticket ' + v.toFixed(0); },
      spaghetti: res.samplePaths.slice(0, 60),
      spaghettiAlpha: 0.10,
      bands: [
        { lo: b.p5, hi: b.p95, color: s1, alpha: 0.10 },
        { lo: b.p25, hi: b.p75, color: s1, alpha: 0.20 }
      ],
      lines: [
        { y: b.mean, color: s2, width: 2, label: 'mean' },
        { y: b.p50, color: s1, width: 2, label: 'median' }
      ],
      refLines: [{ y: B0, color: C.css('--axis'), label: 'starting bankroll' }],
      tipRows: function (i) {
        return [
          { label: 'p95', value: money(b.p95[i]), color: C.withAlpha(s1, 0.45) },
          { label: 'p75', value: money(b.p75[i]), color: C.withAlpha(s1, 0.7) },
          { label: 'median', value: money(b.p50[i]), color: s1 },
          { label: 'mean', value: money(b.mean[i]), color: s2 },
          { label: 'p25', value: money(b.p25[i]), color: C.withAlpha(s1, 0.7) },
          { label: 'p5', value: money(b.p5[i]), color: C.withAlpha(s1, 0.45) }
        ];
      }
    };
  }

  function fanLegend(el) {
    legend(el, [
      { color: C.css('--series-1'), label: 'median' },
      { color: C.css('--series-2'), label: 'mean' },
      { color: C.withAlpha(C.css('--series-1'), 0.35), label: 'p25–p75', box: true },
      { color: C.withAlpha(C.css('--series-1'), 0.18), label: 'p5–p95', box: true },
      { color: C.withAlpha(C.css('--spaghetti'), 0.35), label: '60 sample paths' }
    ]);
  }

  /* Distribution of the final bankroll — diverging around the starting one.
   * The "lost money / made money" polarity here is real, not decoration. */
  function histData(res, B0) {
    var h = S.histogram(res.finals, 46, true);
    var centers = [];
    for (var i = 0; i < h.counts.length; i++) centers.push(Math.sqrt(h.edges[i] * h.edges[i + 1]));
    var pos = C.css('--div-pos'), neg = C.css('--div-neg');
    var maxC = 0;
    for (var j = 0; j < h.counts.length; j++) maxC = Math.max(maxC, h.counts[j]);

    return {
      x: centers, xMin: h.edges[0], xMax: h.edges[h.edges.length - 1], xScale: 'log',
      yMin: 0, yMax: maxC * 1.1,
      xLabel: 'final bankroll', yLabel: 'simulations',
      fmtX: C.fmtCompact, fmtY: C.fmtCompact,
      fmtTipX: function (v) { return money(v); },
      bars: {
        edges: h.edges, counts: h.counts,
        colorFn: function (center) { return center < B0 ? neg : pos; }
      },
      refLines: [{ x: B0, color: C.css('--text-muted'), label: 'start' }],
      tipRows: function (i) {
        return [
          { label: 'simulations', value: h.counts[i].toFixed(0), color: centers[i] < B0 ? neg : pos },
          { label: 'share', value: pct(h.counts[i] / res.finals.length, 2) }
        ];
      }
    };
  }

  /* Distribution of max drawdown — one hue, magnitude only. */
  function ddData(res) {
    var h = S.histogram(res.maxDrawdowns, 40, false);
    var centers = [];
    for (var i = 0; i < h.counts.length; i++) centers.push((h.edges[i] + h.edges[i + 1]) / 2);
    var maxC = 0;
    for (var j = 0; j < h.counts.length; j++) maxC = Math.max(maxC, h.counts[j]);
    return {
      x: centers, xMin: h.edges[0], xMax: h.edges[h.edges.length - 1],
      yMin: 0, yMax: maxC * 1.1,
      xLabel: 'max drawdown', yLabel: 'simulations',
      fmtX: function (v) { return (v * 100).toFixed(0) + ' %'; },
      fmtY: C.fmtCompact,
      fmtTipX: function (v) { return pct(v, 1) + ' drawdown'; },
      bars: { edges: h.edges, counts: h.counts, color: C.css('--series-1') },
      refLines: [
        { x: res.stats.maxDDMedian, color: C.css('--text-muted'), label: 'median' },
        { x: res.stats.maxDDp95, color: C.css('--critical'), label: 'p95' }
      ],
      tipRows: function (i) {
        return [{ label: 'simulations', value: h.counts[i].toFixed(0), color: C.css('--series-1') }];
      }
    };
  }

  /* Quantile buckets: each band = 10 % of simulations. Answers "where did I
   * end up in this share of cases" directly. */
  function decileData(res, B0) {
    var bk = S.buckets(res.finals, 10);
    var pos = C.css('--div-pos'), neg = C.css('--div-neg');
    var lo = Infinity, hi = -Infinity;
    bk.forEach(function (b) { lo = Math.min(lo, b.lo); hi = Math.max(hi, b.hi); });
    lo = Math.min(lo, B0) * 0.85; hi = Math.max(hi, B0) * 1.15;

    var idx = bk.map(function (_, i) { return i; });
    return {
      x: idx, xMin: lo, xMax: hi, xScale: 'log',
      // the axis is inverted: bucket 0 (the worst 10 %) belongs at the top,
      // because the bars are drawn downwards and the labels must line up
      yMin: bk.length, yMax: 0,
      yTicks: idx.map(function (i) { return i + 0.5; }),
      xLabel: 'final bankroll', pad: { left: 92, bottom: 42, top: 14, right: 20 },
      fmtX: C.fmtCompact,
      fmtY: function (v) {
        var i = Math.floor(v);
        return (i * 10) + '–' + (i * 10 + 10) + ' %';
      },
      fmtTipX: function (i) { return 'percentile ' + (i * 10) + '–' + (i * 10 + 10) + ' %'; },
      rangeBars: {
        items: bk,
        colorFn: function (b) { return b.mid < B0 ? neg : pos; }
      },
      refLines: [{ x: B0, color: C.css('--text-muted'), label: 'start' }],
      tipRows: function (i) {
        var b = bk[i];
        return [
          { label: 'from', value: money(b.lo), color: b.mid < B0 ? neg : pos },
          { label: 'to', value: money(b.hi) },
          { label: 'midpoint', value: money(b.mid) },
          { label: 'multiple of start', value: (b.mid / B0).toFixed(2) + '×' }
        ];
      }
    };
  }

  /* Quantile curve: percentile → final bankroll. */
  function quantData(res, B0) {
    var qc = S.quantileCurve(res.finals, 101);
    var xs = Array.prototype.slice.call(qc.pcts);
    var ys = Array.prototype.slice.call(qc.values);
    var lo = Math.min(ys[2], B0) * 0.9, hi = Math.max(ys[98], B0) * 1.1;
    return {
      x: xs, xMin: 0, xMax: 100, yMin: lo, yMax: hi, yScale: 'log',
      xLabel: 'percentile', yLabel: 'final bankroll',
      fmtX: function (v) { return v.toFixed(0) + ' %'; },
      fmtY: C.fmtCompact,
      fmtTipX: function (v) { return 'percentile ' + v.toFixed(0) + ' %'; },
      lines: [{ y: ys, color: C.css('--series-1'), width: 2, label: 'final bankroll' }],
      refLines: [{ y: B0, color: C.css('--text-muted'), label: 'start' }],
      markers: [5, 25, 50, 75, 95].map(function (p) {
        return { x: p, y: S.percentileSorted(res.finals, p), color: C.css('--series-1') };
      }),
      tipRows: function (i) {
        return [
          { label: 'final bankroll', value: money(ys[i]), color: C.css('--series-1') },
          { label: 'multiple of start', value: (ys[i] / B0).toFixed(2) + '×' },
          { label: 'worse runs', value: xs[i].toFixed(0) + ' %' }
        ];
      }
    };
  }

  /* Trade log of one specific path. */
  function renderLog(el, infoEl, cfg, res, pctile, B0) {
    var idx = S.indexAtPercentile(res.finalsRaw, res.finals, pctile);
    var rep = S.replay(cfg, idx);
    var played = rep.log.filter(function (t) { return !t.skipped; });
    var wins = played.filter(function (t) { return t.win; }).length;
    var sell = (cfg.side || 'sell') !== 'buy';

    infoEl.textContent = 'simulation #' + idx + ' · ' + played.length + ' tickets · '
      + wins + ' wins (' + (played.length ? (wins / played.length * 100).toFixed(1) : '0') + ' %) · '
      + 'ended at ' + money(rep.final) + ' (' + (rep.final / B0).toFixed(2) + '× start)'
      + (rep.ruined ? ' · RUIN' : '');

    var t = document.createElement('table');
    var thead = document.createElement('thead'), htr = document.createElement('tr');
    ['#', 'p(combo)', 'price', 'contracts', 'at risk', sell ? 'premium' : 'max win',
      'outcome', 'P/L', 'bankroll'].forEach(function (h) {
      var th = document.createElement('th'); th.textContent = h; htr.appendChild(th);
    });
    thead.appendChild(htr); t.appendChild(thead);

    var tb = document.createElement('tbody');
    played.forEach(function (r) {
      var tr = document.createElement('tr');
      tr.className = r.win ? 'win' : 'loss';
      var hit = sell ? !r.win : r.win;
      var cells = [
        String(r.ticket),
        (r.pModel * 100).toFixed(1) + ' %',
        r.price.toFixed(4),
        r.contracts.toFixed(1),
        money(r.liability),
        money(r.premium),
        hit ? 'combo hit' : 'combo missed',
        (r.pnl >= 0 ? '+' : '') + money(r.pnl),
        money(r.bankroll)
      ];
      cells.forEach(function (c, i) {
        var td = document.createElement('td');
        td.textContent = c;
        if (i === 7) td.className = r.pnl >= 0 ? 'pos' : 'neg';
        tr.appendChild(td);
      });
      tb.appendChild(tr);
    });
    t.appendChild(tb);

    while (el.firstChild) el.removeChild(el.firstChild);
    el.appendChild(t);
    return { index: idx, log: played };
  }

  function statKpis(el, res, B0, gAnalytic) {
    while (el.firstChild) el.removeChild(el.firstChild);
    var st = res.stats;
    el.appendChild(kpi('Median final bankroll', money(st.medianFinal),
      (st.medianFinal / B0).toFixed(2) + '× start', st.medianFinal >= B0 ? 'pos' : 'neg'));
    el.appendChild(kpi('Mean', money(st.meanFinal), (st.meanFinal / B0).toFixed(2) + '× start'));
    el.appendChild(kpi('p5 — bad case', money(st.p5), (st.p5 / B0).toFixed(2) + '× start',
      st.p5 < B0 ? 'neg' : ''));
    el.appendChild(kpi('p95 — good case', money(st.p95), (st.p95 / B0).toFixed(2) + '× start'));
    el.appendChild(kpi('Ends below start', pct(st.pctBelowStart, 1), 'of ' + count(res.finals.length) + ' simulations',
      st.pctBelowStart > 0.4 ? 'neg' : ''));
    el.appendChild(kpi('Ruin', pct(st.pctRuined, 2), 'below the ruin threshold', st.pctRuined > 0.001 ? 'neg' : 'pos'));
    el.appendChild(kpi('Max drawdown — median', pct(st.maxDDMedian, 1),
      'from a peak, over ' + res.totalTickets + ' tickets · p95: ' + pct(st.maxDDp95, 1),
      st.maxDDMedian > 0.5 ? 'neg' : ''));
    el.appendChild(kpi('Ever below 50 % of start', pct(st.pctEverBelow50, 1),
      'below 25 %: ' + pct(st.pctEverBelow25, 1), st.pctEverBelow50 > 0.3 ? 'neg' : ''));
    el.appendChild(kpi('Total turnover', money(st.meanTurnover),
      (st.meanTurnover / B0).toFixed(0) + '× bankroll · money that has to change hands'));
    el.appendChild(kpi('Growth per ticket', bps(st.meanLogGrowthPerTicket),
      gAnalytic != null ? 'analytically ' + bps(gAnalytic) : 'from Monte Carlo'));
    el.appendChild(kpi('Growth over 100 tickets', per100(st.meanLogGrowthPerTicket), 'compounded'));
  }

  function statTable(el, res, B0) {
    var st = res.stats;
    table(el, ['Quantity', 'Value', 'Multiple of start'], [
      ['Worst', money(st.worst), (st.worst / B0).toFixed(3) + '×'],
      ['p5', money(st.p5), (st.p5 / B0).toFixed(3) + '×'],
      ['p25', money(st.p25), (st.p25 / B0).toFixed(3) + '×'],
      ['Median', money(st.medianFinal), (st.medianFinal / B0).toFixed(3) + '×'],
      ['p75', money(st.p75), (st.p75 / B0).toFixed(3) + '×'],
      ['p95', money(st.p95), (st.p95 / B0).toFixed(3) + '×'],
      ['Best', money(st.best), (st.best / B0).toFixed(3) + '×'],
      ['Mean', money(st.meanFinal), (st.meanFinal / B0).toFixed(3) + '×'],
      ['Ends below start', pct(st.pctBelowStart, 2), '—'],
      ['Ruin', pct(st.pctRuined, 3), '—'],
      ['Max drawdown from a peak — median', pct(st.maxDDMedian, 2), '—'],
      ['Max drawdown from a peak — p95', pct(st.maxDDp95, 2), '—'],
      ['Total turnover', money(st.meanTurnover), (st.meanTurnover / B0).toFixed(1) + '×'],
      ['Ever below 50 % of start', pct(st.pctEverBelow50, 2), '—'],
      ['Ever below 25 % of start', pct(st.pctEverBelow25, 2), '—'],
      ['Growth per ticket', bps(st.meanLogGrowthPerTicket), '—'],
      ['Growth over 100 tickets', per100(st.meanLogGrowthPerTicket), '—'],
      ['Tickets per path', String(res.totalTickets), '—'],
      ['Simulations', count(res.finals.length), '—']
    ]);
  }

  function csvRows(res) {
    var rows = [];
    var b = res.bands;
    for (var i = 0; i < res.checkpoints.length; i++) {
      rows.push([res.checkpoints[i], b.p5[i].toFixed(2), b.p25[i].toFixed(2),
        b.p50[i].toFixed(2), b.p75[i].toFixed(2), b.p95[i].toFixed(2), b.mean[i].toFixed(2)]);
    }
    return rows;
  }

  /* Sizing comparison. In a single run the modes are MUTUALLY EXCLUSIVE — you
   * bet by one rule. Seeing them side by side on the same randomness is still
   * worth it, which is what this does: same seed, same tickets, different stake. */
  var CMP_VARIANTS = [
    { key: 'full', label: 'full Kelly', sizing: { type: 'kelly', mult: 1 }, slot: '--series-1' },
    { key: 'half', label: '½ Kelly', sizing: { type: 'kelly', mult: 0.5 }, slot: '--series-2' },
    { key: 'quarter', label: '¼ Kelly', sizing: { type: 'kelly', mult: 0.25 }, slot: '--series-3' },
    { key: 'flat', label: 'flat 2 % of bankroll', sizing: { type: 'flatPct', pct: 0.02 }, slot: '--series-4' }
  ];

  function runComparison(baseCfg, chart, legendEl, tableEl, onProgress) {
    var B0 = baseCfg.bankroll;
    var jobs = CMP_VARIANTS.map(function (v) {
      var cfg = Object.assign({}, baseCfg, { sizing: v.sizing });
      delete cfg.onDone;
      return { v: v, cfg: cfg };
    });

    var results = [];
    return jobs.reduce(function (chain, job, i) {
      return chain.then(function () {
        return S.run(job.cfg, function (p) {
          if (onProgress) onProgress((i + p) / jobs.length);
        }).then(function (res) { results.push({ v: job.v, res: res }); });
      });
    }, Promise.resolve()).then(function () {
      var x = Array.prototype.slice.call(results[0].res.checkpoints);
      var lo = Infinity, hi = -Infinity;
      results.forEach(function (r) {
        for (var i = 0; i < x.length; i++) {
          lo = Math.min(lo, r.res.bands.geo[i]);
          hi = Math.max(hi, r.res.bands.geo[i]);
        }
      });
      lo = Math.min(lo, B0) * 0.98; hi = Math.max(hi, B0) * 1.02;

      chart.setData({
        // Geometric mean, not median: with a flat stake the median jumps
        // between discrete atoms and the sawtooth would only obscure things.
        x: x, xMin: x[0], xMax: x[x.length - 1], yMin: lo, yMax: hi, yScale: 'log',
        xLabel: 'ticket', yLabel: 'typical bankroll (geometric mean)',
        fmtY: C.fmtCompact, fmtX: function (v) { return v.toFixed(0); },
        fmtTipX: function (v) { return 'after ticket ' + v.toFixed(0); },
        lines: results.map(function (r) {
          return { y: r.res.bands.geo, color: C.css(r.v.slot), width: 2, label: r.v.label };
        }),
        refLines: [{ y: B0, color: C.css('--axis'), label: 'start' }],
        directLabels: true,                      // mandatory once there are 4 series
        tipRows: function (i) {
          return results.map(function (r) {
            return { label: r.v.label, value: money(r.res.bands.geo[i]), color: C.css(r.v.slot) };
          });
        }
      });

      legend(legendEl, results.map(function (r) {
        return { color: C.css(r.v.slot), label: r.v.label };
      }));

      table(tableEl,
        ['Sizing', 'Risk/ticket', 'Median', 'p5', 'Below start', 'maxDD from peak', 'Below 50 % of start', 'Growth/ticket'],
        results.map(function (r) {
          var s = r.res.stats;
          var f = r.v.sizing.type === 'flatPct'
            ? pct(r.v.sizing.pct, 2)
            : pct(K.clamp(baseCfg._fStar * r.v.sizing.mult, 0, 1), 2);
          return [r.v.label, f, money(s.medianFinal), money(s.p5),
            pct(s.pctBelowStart, 1), pct(s.maxDDMedian, 1), pct(s.pctEverBelow50, 1),
            bps(s.meanLogGrowthPerTicket)];
        }));

      return results;
    });
  }

  /* Sizing config read off the panel. */
  function readSizing(prefix, sizingVal) {
    if (sizingVal === 'flatPct') return { type: 'flatPct', pct: num($(prefix + '_flatPct')) / 100 };
    if (sizingVal === 'flatAbs') return { type: 'flatAbs', amount: num($(prefix + '_flatAbs')) };
    return { type: 'kelly', mult: num($(prefix + '_mult')) };
  }

  function wireSizing(prefix) {
    var get = segment($(prefix + '_sizing'), function (v) {
      show($(prefix + '_multField'), v === 'kelly');
      show($(prefix + '_flatPctField'), v === 'flatPct');
      show($(prefix + '_flatAbsField'), v === 'flatAbs');
    });
    $(prefix + '_mult').addEventListener('input', function () {
      $(prefix + '_multOut').textContent = num($(prefix + '_mult')).toFixed(2) + '×';
    });
    return get;
  }

  /* Results already on screen belong to the side they were run on. Flipping
   * perspective must not leave them sitting there looking current — that is
   * exactly the "the tool quietly shows you the other side" trap. */
  function markStale(prefix, resultsEl) {
    if (!resultsEl.dataset.hasRun) return;
    resultsEl.classList.add('stale');
    $(prefix + '_state').textContent = 'side changed — run again to refresh the results below';
  }

  /* Progress handling for a simulation run. */
  function runner(prefix, resultsEl, build) {
    var btn = $(prefix + '_run'), prog = $(prefix + '_prog'), state = $(prefix + '_state');
    var busy = false;
    btn.addEventListener('click', function () {
      if (busy) return;
      var cfg;
      nextSeed(prefix);                      // new seed before build() reads it
      try { cfg = build(); } catch (e) { state.textContent = e.message; return; }
      busy = true;
      btn.disabled = true;
      resultsEl.classList.add('busy');
      state.textContent = 'running ' + count(cfg.sims) + ' simulations × ' + cfg.tickets + ' tickets…';
      prog.style.width = '0%';
      var t0 = performance.now();
      S.run(cfg, function (p) { prog.style.width = (p * 100).toFixed(1) + '%'; })
        .then(function (res) {
          cfg.onDone(res);
          resultsEl.classList.remove('stale');
          resultsEl.dataset.hasRun = '1';
          state.textContent = 'done in ' + Math.round(performance.now() - t0) + ' ms · seed ' + cfg.seed;
        })
        .catch(function (e) { state.textContent = 'error: ' + e.message; })
        .then(function () {
          busy = false; btn.disabled = false;
          resultsEl.classList.remove('busy');
          prog.style.width = '0%';
        });
    });
  }

  /* ══════════════════ SECTION 1 — a single ticket ══════════════════ */

  (function quoteView() {
    var legsEl = $('q_legs');
    var legs = [0.5, 0.5];
    var lastRes = null;

    var chFan = mount('q_fan'), chHist = mount('q_hist'), chDD = mount('q_dd');
    var chCurve = mount('q_curve'), chSens = mount('q_sens');
    var chDec = mount('q_deciles'), chQuant = mount('q_quant'), chCmp = mount('q_cmp');
    var lastCfg = null, lastLog = null;

    function renderLegs() {
      while (legsEl.firstChild) legsEl.removeChild(legsEl.firstChild);
      legs.forEach(function (v, i) {
        var row = document.createElement('div'); row.className = 'leg';
        var idx = document.createElement('span'); idx.className = 'idx'; idx.textContent = 'leg ' + (i + 1);
        var inp = document.createElement('input');
        inp.type = 'number'; inp.step = '0.001'; inp.min = '0.0001'; inp.max = '0.9999'; inp.value = v;
        inp.addEventListener('input', function () { legs[i] = parseFloat(inp.value); update(); });
        var del = document.createElement('button');
        del.type = 'button'; del.textContent = '×'; del.title = 'remove leg';
        del.addEventListener('click', function () {
          if (legs.length <= 1) return;
          legs.splice(i, 1); renderLegs(); update();
        });
        row.appendChild(idx); row.appendChild(inp); row.appendChild(del);
        legsEl.appendChild(row);
      });
    }

    $('q_addLeg').addEventListener('click', function () { legs.push(0.7); renderLegs(); update(); });

    $('q_manualProduct').addEventListener('change', function () {
      var on = $('q_manualProduct').checked;
      show($('q_legsWrap'), !on);
      show($('q_productWrap'), on);
      update();
    });

    var getPriceMode = segment($('q_priceMode'), function (v) {
      show($('q_markupField'), v === 'markup');
      show($('q_priceField'), v === 'explicit');
      update();
    });

    onPerspective(function () { update(); markStale('q', $('q_results')); });

    var getSizing = wireSizing('q');

    ['q_bankroll', 'q_product', 'q_markup', 'q_price', 'q_haircut', 'q_mult',
      'q_flatPct', 'q_flatAbs', 'q_cap'].forEach(function (id) {
      $(id).addEventListener('input', update);
    });
    $('q_round').addEventListener('change', update);
    $('q_log').addEventListener('change', function () {
      if (lastRes) chFan.setData(fanData(lastRes, $('q_log').checked, num($('q_bankroll'))));
    });

    /* Current state of the ticket, read off the panel. */
    function readQuote() {
      var pAsk = $('q_manualProduct').checked ? num($('q_product')) : K.askProduct(legs);
      var c;
      if (getPriceMode() === 'markup') {
        c = K.priceFromEdge(pAsk, num($('q_markup')) / 100, side);
        $('q_priceShow').value = isFinite(c) ? c.toFixed(4) : '';
      } else {
        c = num($('q_price'));
        var e = K.edgeFromPrice(pAsk, c, side);
        $('q_markupShow').value = isFinite(e) ? (e * 100).toFixed(2) : '';
      }
      var pTrue = K.clamp(pAsk * (1 + num($('q_haircut')) / 100), 1e-9, 1 - 1e-9);
      return { pAsk: pAsk, price: c, side: side, pTrue: pTrue, bankroll: num($('q_bankroll')) };
    }

    function update() {
      var q = readQuote();
      var sell = isSell();
      $('q_productOut').textContent = isFinite(q.pAsk) ? q.pAsk.toFixed(4) : '—';
      $('q_pOut').textContent = isFinite(q.pAsk) ? (q.pAsk * 100).toFixed(2) + ' %' : '—';
      $('q_haircutOut').textContent = num($('q_haircut')).toFixed(1) + ' %';

      var box = $('q_callouts');
      while (box.firstChild) box.removeChild(box.firstChild);

      if (!isFinite(q.pAsk) || q.pAsk <= 0 || q.pAsk >= 1 || !isFinite(q.price) || q.price <= 0 || q.price >= 1) {
        $('q_heroF').textContent = '—';
        $('q_heroNote').textContent = 'Enter valid leg prices (0–1) and a ticket price.';
        return;
      }

      var sizingVal = getSizing();
      var mult = sizingVal === 'kelly' ? num($('q_mult')) : 1;
      var cap = num($('q_cap')) / 100;

      // sized from the model (product of legs), resolved against reality
      var tModel = K.ticketParams(q.pAsk, q.price, q.side);
      var tTrue = K.ticketParams(q.pTrue, q.price, q.side);
      var a = K.analyseTicket({
        p: q.pAsk, price: q.price, side: q.side, bankroll: q.bankroll,
        kellyMultiplier: mult, capFraction: cap, roundContracts: $('q_round').checked
      });

      var applied = a.appliedFraction;
      if (sizingVal === 'flatPct') applied = Math.min(num($('q_flatPct')) / 100, cap);
      if (sizingVal === 'flatAbs') applied = Math.min(num($('q_flatAbs')) / q.bankroll, cap);

      var maxLoss = q.bankroll * applied;
      var contracts = tModel.riskPerContract > 0 ? maxLoss / tModel.riskPerContract : 0;
      if ($('q_round').checked) { contracts = Math.floor(contracts); maxLoss = contracts * tModel.riskPerContract; }

      var gReal = K.growthRate({ b: tModel.b, winProb: tTrue.winProb, lossProb: tTrue.lossProb }, applied);

      $('q_heroF').textContent = pct(applied, 2);
      $('q_heroNote').textContent = sizingVal === 'kelly'
        ? 'full Kelly ' + pct(a.fullKellyFraction, 2) + ' × ' + mult.toFixed(2) +
          (a.capHit ? ' · limited by the cap' : '')
        : 'manual sizing · full Kelly would be ' + pct(a.fullKellyFraction, 2);

      $('q_maxLoss').textContent = money(maxLoss);
      $('q_contracts').textContent = money(contracts);
      // At high leg prices this comes out enormous against the bankroll — it is
      // the hardest practical constraint, so it belongs right next to the money.
      var premium = contracts * tModel.gainPerContract;
      $('q_premium').textContent = money(premium) +
        (q.bankroll > 0 ? '  (' + pct(premium / q.bankroll, 0) + ' of bankroll)' : '');
      // EV as a share of the gain is the invariant m/(1+m) — independent of the
      // ticket price. That is your edge; absolute EV moves only with turnover.
      var evTotal = contracts * tTrue.evPerContract;
      $('q_ev').textContent = money(evTotal) +
        (premium > 0 ? '  (' + pct(evTotal / premium, 2) + (sell ? ' of premium)' : ' of max win)') : '');
      $('q_growth').textContent = bps(gReal);
      $('q_k0').textContent = isFinite(a.zeroGrowthMultiple) ? a.zeroGrowthMultiple.toFixed(3) + '× Kelly' : '—';

      /* --- warnings --- */
      if (!tTrue.hasEdge) {
        box.appendChild(callout('bad',
          'At this price you have <strong>no edge</strong> — EV per contract is ' +
          tTrue.evPerContract.toFixed(4) + '. Breakeven price is ' + tModel.breakevenPrice.toFixed(4) + '.'));
      } else {
        var tol = K.edgeTolerance(q.pAsk, q.price, q.side, mult || 1);
        if (isFinite(tol.relativeMargin)) {
          box.appendChild(callout(Math.abs(tol.relativeMargin) < 0.03 ? 'warn' : '',
            'You are sizing from the product of legs. If the combo actually hit just <strong>' +
            Math.abs(tol.relativeMargin * 100).toFixed(2) + ' %</strong> ' +
            (sell ? 'more' : 'less') + ' often in relative terms (p = ' +
            tol.pBreak.toFixed(4) + ' instead of ' + q.pAsk.toFixed(4) + '), growth would fall to zero. ' +
            'Half Kelly widens that margin; full Kelly has the narrowest.'));
        }
      }
      if (applied > 0 && a.dd50 > 0.2) {
        box.appendChild(callout(a.dd50 > 0.6 ? 'warn' : '',
          'Probability the bankroll ever falls below <strong>half its starting value</strong>: ' +
          '<strong>' + pct(a.dd50, 1) + '</strong> · below a quarter: ' + pct(a.dd25, 1) + '. ' +
          'This is a fixed barrier measured from the start — not the same thing as max drawdown ' +
          'from a running peak, which keeps growing with the length of the run.'));
      }

      drawCurves(q, tModel, a.fullKellyFraction);
    }

    /* Growth vs. Kelly multiple, plus sensitivity to an overestimated edge. */
    function drawCurves(q, tModel, fStar) {
      var N = 121, xs = [], gs = [], gPos = [], gNeg = [];
      for (var i = 0; i < N; i++) {
        var m = (i / (N - 1)) * 2.5;
        var f = K.clamp(fStar * m, 0, 0.999999);
        var g = m === 0 ? 0 : K.growthRate(tModel, f);
        if (!isFinite(g)) g = NaN;
        xs.push(m); gs.push(g);
        gPos.push(isFinite(g) ? Math.max(g, 0) : 0);
        gNeg.push(isFinite(g) ? Math.min(g, 0) : 0);
      }
      var gMax = 0, gMin = 0;
      gs.forEach(function (g) { if (isFinite(g)) { gMax = Math.max(gMax, g); gMin = Math.min(gMin, g); } });
      var span = Math.max(gMax - gMin, 1e-9);
      var k0 = K.zeroGrowthMultiple(tModel);

      chCurve.setData({
        x: xs, xMin: 0, xMax: 2.5,
        yMin: gMin - span * 0.12, yMax: gMax + span * 0.18,
        xLabel: 'multiple of full Kelly', yLabel: 'growth per ticket (bps)',
        fmtX: function (v) { return v.toFixed(2) + '×'; }, fmtY: bpsAxis,
        fmtTipX: function (v) { return v.toFixed(2) + '× Kelly'; },
        bands: [
          { lo: gs.map(function () { return 0; }), hi: gPos, color: C.css('--div-pos'), alpha: 0.16 },
          { lo: gNeg, hi: gs.map(function () { return 0; }), color: C.css('--div-neg'), alpha: 0.16 }
        ],
        lines: [{ y: gs, color: C.css('--series-1'), width: 2, label: 'growth' }],
        refLines: [
          { y: 0, color: C.css('--axis') },
          isFinite(k0) ? { x: k0, color: C.css('--critical'), label: 'zero growth ' + k0.toFixed(2) + '×' } : null
        ].filter(Boolean),
        markers: [{ x: 1, y: K.growthRate(tModel, fStar), color: C.css('--series-1') }],
        tipRows: function (i) {
          return [
            { label: 'growth/ticket', value: bps(gs[i]), color: C.css('--series-1') },
            { label: 'fraction at risk', value: pct(K.clamp(fStar * xs[i], 0, 1), 2) },
            { label: 'over 100 tickets', value: isFinite(gs[i]) ? per100(gs[i]) : '—' }
          ];
        }
      });

      /* Sensitivity: sized from the model, reality moves. The dangerous
       * direction differs by side, so the window leans that way. */
      var sell = isSell();
      var variants = [
        { label: 'full Kelly', mult: 1, color: C.css('--series-1') },
        { label: '½ Kelly', mult: 0.5, color: C.css('--series-2') },
        { label: '¼ Kelly', mult: 0.25, color: C.css('--series-3') }
      ];
      var errLo = sell ? -0.06 : -0.08;
      var errHi = sell ? 0.08 : 0.06;
      var M = 101, errs = [], series = variants.map(function () { return []; });
      for (var e = 0; e < M; e++) {
        var rel = errLo + (e / (M - 1)) * (errHi - errLo);
        errs.push(rel);
        var pT = K.clamp(q.pAsk * (1 + rel), 1e-9, 1 - 1e-9);
        var tT = K.ticketParams(pT, q.price, q.side);
        variants.forEach(function (v, vi) {
          var f = K.clamp(fStar * v.mult, 0, 0.999999);
          series[vi].push(K.growthRate({ b: tModel.b, winProb: tT.winProb, lossProb: tT.lossProb }, f));
        });
      }
      var sMin = Infinity, sMax = -Infinity;
      series.forEach(function (arr) { arr.forEach(function (v) { if (isFinite(v)) { sMin = Math.min(sMin, v); sMax = Math.max(sMax, v); } }); });
      var sSpan = Math.max(sMax - sMin, 1e-9);

      chSens.setData({
        x: errs, xMin: errs[0], xMax: errs[errs.length - 1],
        yMin: sMin - sSpan * 0.1, yMax: sMax + sSpan * 0.1,
        xLabel: 'how much more often the combo hits than modelled',
        yLabel: 'growth per ticket (bps)',
        fmtX: function (v) { return (v * 100).toFixed(0) + ' %'; }, fmtY: bpsAxis,
        fmtTipX: function (v) { return (v * 100).toFixed(2) + ' % error'; },
        lines: variants.map(function (v, vi) {
          return { y: series[vi], color: v.color, width: 2, label: v.label };
        }),
        refLines: [{ y: 0, color: C.css('--axis'), label: 'zero growth' },
          { x: 0, color: C.css('--text-muted'), label: 'model' }],
        directLabels: true,
        tipRows: function (i) {
          return variants.map(function (v, vi) {
            return { label: v.label, value: bps(series[vi][i]), color: v.color };
          });
        }
      });
      legend($('q_sensLegend'), variants.map(function (v) { return { color: v.color, label: v.label }; }));
    }

    runner('q', $('q_results'), function () {
      var q = readQuote();
      if (!isFinite(q.pAsk) || q.pAsk <= 0 || q.pAsk >= 1) throw new Error('invalid product of leg prices');
      if (!isFinite(q.price) || q.price <= 0 || q.price >= 1) throw new Error('invalid ticket price');
      var B0 = q.bankroll;
      var cfg = {
        mode: 'single', p: q.pAsk, price: q.price, side: q.side,
        probHaircut: num($('q_haircut')) / 100,
        bankroll: B0,
        tickets: Math.round(num($('q_tickets'))),
        sims: Math.round(num($('q_sims'))),
        seed: Math.round(num($('q_seed'))),
        sizing: readSizing('q', getSizing()),
        capFraction: num($('q_cap')) / 100,
        roundContracts: $('q_round').checked,
        ruinFraction: num($('q_ruin')) / 100,
        onDone: function (res) {
          lastRes = res;
          var tModel = K.ticketParams(q.pAsk, q.price, q.side);
          var tTrue = K.ticketParams(q.pTrue, q.price, q.side);
          var sizingVal = getSizing();
          var f = sizingVal === 'kelly'
            ? K.clamp(K.fullKelly(tModel) * num($('q_mult')), 0, 1)
            : sizingVal === 'flatPct' ? num($('q_flatPct')) / 100 : num($('q_flatAbs')) / B0;
          var gA = K.growthRate({ b: tModel.b, winProb: tTrue.winProb, lossProb: tTrue.lossProb }, f);

          statKpis($('q_kpis'), res, B0, gA);
          chFan.setData(fanData(res, $('q_log').checked, B0));
          fanLegend($('q_fanLegend'));
          chHist.setData(histData(res, B0));
          legend($('q_histLegend'), [
            { color: C.css('--div-neg'), label: 'ended below start', box: true },
            { color: C.css('--div-pos'), label: 'ended above start', box: true }
          ]);
          chDD.setData(ddData(res));
          chDec.setData(decileData(res, B0));
          chQuant.setData(quantData(res, B0));
          statTable($('q_table'), res, B0);

          lastCfg = cfg;
          showLog();
        }
      };
      return cfg;
    });

    /* --- trade log --- */
    var getLogPct = segment($('q_logPick'), function () { showLog(); });

    function showLog() {
      if (!lastRes || !lastCfg) return;
      lastLog = renderLog($('q_tradeLog'), $('q_logInfo'), lastCfg, lastRes,
        parseFloat(getLogPct()), num($('q_bankroll')));
    }

    $('q_logCsv').addEventListener('click', function () {
      if (!lastLog) return;
      downloadCsv('parlay-kelly-trade-log.csv',
        ['ticket', 'p_combo', 'price', 'contracts', 'at_risk', 'max_win', 'won', 'pnl', 'bankroll'],
        lastLog.log.map(function (r) {
          return [r.ticket, r.pModel.toFixed(6), r.price.toFixed(6), r.contracts.toFixed(3),
            r.liability.toFixed(2), r.premium.toFixed(2), r.win ? 1 : 0,
            r.pnl.toFixed(2), r.bankroll.toFixed(2)];
        }));
    });

    /* --- sizing comparison --- */
    $('q_cmpRun').addEventListener('click', function () {
      var btn = $('q_cmpRun');
      if (btn.disabled) return;
      var q = readQuote();
      if (!isFinite(q.pAsk) || !isFinite(q.price)) return;
      btn.disabled = true;
      btn.textContent = 'running…';
      var tModel = K.ticketParams(q.pAsk, q.price, q.side);
      runComparison({
        mode: 'single', p: q.pAsk, price: q.price, side: q.side,
        probHaircut: num($('q_haircut')) / 100, bankroll: q.bankroll,
        tickets: Math.round(num($('q_tickets'))),
        sims: Math.min(Math.round(num($('q_sims'))), 20000),
        seed: Math.round(num($('q_seed'))),
        capFraction: num($('q_cap')) / 100,
        roundContracts: $('q_round').checked,
        ruinFraction: num($('q_ruin')) / 100,
        _fStar: K.fullKelly(tModel)
      }, chCmp, $('q_cmpLegend'), $('q_cmpTable'), function (p) {
        btn.textContent = 'running ' + Math.round(p * 100) + ' %';
      }).then(function () {
        btn.disabled = false; btn.textContent = 'Run comparison';
      }).catch(function () {
        btn.disabled = false; btn.textContent = 'Run comparison';
      });
    });

    $('q_csv').addEventListener('click', function () {
      if (!lastRes) return;
      downloadCsv('parlay-kelly-single.csv', ['ticket', 'p5', 'p25', 'median', 'p75', 'p95', 'mean'],
        csvRows(lastRes));
    });

    wireSeed('q');
    renderLegs();
    update();
  })();

  /* ══════════════════ SECTION 2 — a band of tickets ══════════════════ */

  (function rangeView() {
    var lastRes = null, lastCfg = null, lastLog = null;
    var chFan = mount('r_fan'), chG = mount('r_gcurve'), chM = mount('r_mcurve');
    var chHist = mount('r_hist'), chDD = mount('r_dd');
    var chDec = mount('r_deciles'), chQuant = mount('r_quant'), chCmp = mount('r_cmp');

    var getDist = segment($('r_dist'), function (v) {
      show($('r_modeField'), v === 'triangular');
      update();
    });
    var getSizing = wireSizing('r');

    onPerspective(function () { update(); markStale('r', $('r_results')); });

    ['r_bankroll', 'r_markup', 'r_qLo', 'r_qHi', 'r_distMode', 'r_haircut',
      'r_mult', 'r_flatPct', 'r_flatAbs', 'r_cap', 'r_concurrent'].forEach(function (id) {
      $(id).addEventListener('input', update);
    });
    $('r_split').addEventListener('change', update);
    $('r_log').addEventListener('change', function () {
      if (lastRes) chFan.setData(fanData(lastRes, $('r_log').checked, num($('r_bankroll'))));
    });

    function read() {
      var lo = num($('r_qLo')), hi = num($('r_qHi'));
      if (lo > hi) { var t = lo; lo = hi; hi = t; }
      return {
        qLo: lo, qHi: hi,
        markup: num($('r_markup')) / 100,
        dist: getDist(),
        distMode: num($('r_distMode')),
        haircut: num($('r_haircut')) / 100,
        bankroll: num($('r_bankroll')),
        concurrent: Math.max(1, Math.round(num($('r_concurrent'))))
      };
    }

    /* The band is defined over YOUR win probability. Which combo probability
     * and price that implies depends on which side you are on. */
    function ticketAt(q, r) {
      var p = isSell() ? 1 - q : q;
      var c = K.clamp(K.priceFromEdge(p, r.markup, side), 1e-6, 1 - 1e-6);
      return K.ticketParams(p, c, side);
    }

    function update() {
      var r = read();
      var sell = isSell();
      $('r_qLoOut').textContent = r.qLo.toFixed(2);
      $('r_qHiOut').textContent = r.qHi.toFixed(2);
      $('r_distModeOut').textContent = r.distMode.toFixed(2);
      $('r_haircutOut').textContent = (num($('r_haircut'))).toFixed(1) + ' %';

      // mirror the band into prices
      var tLo = ticketAt(r.qLo, r), tHi = ticketAt(r.qHi, r);
      var pA = Math.min(tLo.p, tHi.p), pB = Math.max(tLo.p, tHi.p);
      var cA = Math.min(tLo.price, tHi.price), cB = Math.max(tLo.price, tHi.price);
      $('r_mirrorQ').textContent = (r.qLo * 100).toFixed(0) + '–' + (r.qHi * 100).toFixed(0) + ' %';
      $('r_mirrorP').textContent = pA.toFixed(3) + '–' + pB.toFixed(3);
      $('r_mirrorC').textContent = cA.toFixed(3) + '–' + cB.toFixed(3);

      var sizingVal = getSizing();
      var mult = sizingVal === 'kelly' ? num($('r_mult')) : 1;
      // For a seller full Kelly is m/(1+m) everywhere in the band. For a buyer
      // it is not — f* = p·d/(1 - p(1-d)) moves with p — so the balanced end
      // is used as the reference and the spread is reported in the note.
      var fLo = K.fullKelly(tLo), fHi = K.fullKelly(tHi);
      var fStar = fLo;
      var applied = K.clamp(fStar * mult, 0, 1);
      if (sizingVal === 'flatPct') applied = num($('r_flatPct')) / 100;
      if (sizingVal === 'flatAbs') applied = num($('r_flatAbs')) / r.bankroll;
      applied = Math.min(applied, num($('r_cap')) / 100);

      $('r_heroF').textContent = pct(applied, 2);
      var kellyDesc = sell
        ? 'full Kelly = m/(1+m) = ' + pct(fStar, 2)
        : 'full Kelly ' + pct(Math.min(fLo, fHi), 2) + '–' + pct(Math.max(fLo, fHi), 2) + ' across the band';
      $('r_heroNote').textContent = kellyDesc +
        (r.concurrent > 1
          ? ($('r_split').checked
            ? ' · split across ' + r.concurrent + ' concurrent → ' + pct(applied / r.concurrent, 2) + ' per ticket'
            : ' · ' + r.concurrent + ' concurrent at ' + pct(applied, 2) + ' each, ' +
              pct(applied * r.concurrent, 2) + ' of bankroll in total')
          : '');

      /* --- curves across the band --- */
      var N = 121, qs = [], gs = [], ms = [];
      for (var i = 0; i < N; i++) {
        var q = r.qLo + (i / (N - 1)) * (r.qHi - r.qLo);
        var t = ticketAt(q, r);
        qs.push(q);
        gs.push(K.growthRate(t, K.clamp(K.fullKelly(t) * mult, 0, 0.999999)));
        ms.push(NaN);
      }
      // reference growth = the most balanced ticket in the band (lowest q)
      var gRef = K.growthRate(tLo, K.fullKelly(tLo));
      for (var j = 0; j < N; j++) {
        var pj = sell ? 1 - qs[j] : qs[j];
        var mm = K.edgeForGrowth(pj, gRef, side);
        ms[j] = isFinite(mm) ? mm * 100 : NaN;
      }

      var gMin = Infinity, gMax = -Infinity;
      gs.forEach(function (v) { if (isFinite(v)) { gMin = Math.min(gMin, v); gMax = Math.max(gMax, v); } });
      var gSpan = Math.max(gMax - gMin, 1e-9);

      $('r_gBal').textContent = bps(gs[0]);
      $('r_gFav').textContent = bps(gs[N - 1]);
      $('r_gRatio').textContent = isFinite(gs[N - 1]) && gs[N - 1] !== 0
        ? (gs[0] / gs[N - 1]).toFixed(1) + '×' : '—';
      var avg = 0, cnt = 0;
      gs.forEach(function (v) { if (isFinite(v)) { avg += v; cnt++; } });
      $('r_gAvg').textContent = cnt ? bps(avg / cnt) : '—';

      chG.setData({
        x: qs, xMin: r.qLo, xMax: r.qHi,
        yMin: Math.min(0, gMin - gSpan * 0.1), yMax: gMax + gSpan * 0.12,
        xLabel: 'your win probability', yLabel: 'growth per ticket (bps)',
        fmtX: function (v) { return v.toFixed(2); }, fmtY: bpsAxis,
        fmtTipX: function (v) {
          return 'win prob ' + v.toFixed(3) + ' · price ' + ticketAt(v, r).price.toFixed(4);
        },
        bands: [{ lo: gs.map(function () { return 0; }), hi: gs.map(function (v) { return isFinite(v) ? Math.max(v, 0) : 0; }), color: C.css('--series-1'), alpha: 0.13 }],
        lines: [{ y: gs, color: C.css('--series-1'), width: 2, label: 'growth' }],
        refLines: [{ y: 0, color: C.css('--axis') }],
        tipRows: function (i) {
          return [
            { label: 'growth/ticket', value: bps(gs[i]), color: C.css('--series-1') },
            { label: 'over 100 tickets', value: isFinite(gs[i]) ? per100(gs[i]) : '—' },
            { label: 'product of legs', value: (sell ? 1 - qs[i] : qs[i]).toFixed(4) }
          ];
        }
      });

      var mMin = Infinity, mMax = -Infinity;
      ms.forEach(function (v) { if (isFinite(v)) { mMin = Math.min(mMin, v); mMax = Math.max(mMax, v); } });
      chM.setData({
        x: qs, xMin: r.qLo, xMax: r.qHi,
        yMin: Math.max(0, mMin - (mMax - mMin) * 0.12), yMax: mMax + (mMax - mMin) * 0.12 + 0.1,
        xLabel: 'your win probability', yLabel: 'edge required',
        fmtX: function (v) { return v.toFixed(2); },
        fmtY: function (v) { return v.toFixed(1) + ' %'; },
        fmtTipX: function (v) { return 'win prob ' + v.toFixed(3); },
        lines: [{ y: ms, color: C.css('--series-4'), width: 2, label: 'edge required' }],
        refLines: [{ y: r.markup * 100, color: C.css('--text-muted'), label: 'you take ' + (r.markup * 100).toFixed(1) + ' %' }],
        tipRows: function (i) {
          return [
            { label: 'for equal growth', value: isFinite(ms[i]) ? ms[i].toFixed(2) + ' %' : '—', color: C.css('--series-4') },
            { label: 'you take', value: (r.markup * 100).toFixed(2) + ' %' }
          ];
        }
      });

      /* --- insight --- */
      var box = $('r_callouts');
      while (box.firstChild) box.removeChild(box.firstChild);
      // Which end of the band earns more is NOT fixed: selling favours the
      // balanced end, buying at a fixed discount favours the long shots,
      // because there f* climbs with p instead of staying put.
      var rawRatio = isFinite(gs[0]) && isFinite(gs[N - 1]) && gs[N - 1] !== 0
        ? gs[0] / gs[N - 1] : NaN;
      var richer, poorer, times;
      if (isFinite(rawRatio) && rawRatio >= 1) {
        richer = 'A balanced ticket (win prob ' + r.qLo.toFixed(2) + ')';
        poorer = 'a long shot (' + r.qHi.toFixed(2) + ')';
        times = rawRatio.toFixed(1);
      } else if (isFinite(rawRatio) && rawRatio > 0) {
        richer = 'A long shot (win prob ' + r.qHi.toFixed(2) + ')';
        poorer = 'a balanced ticket (' + r.qLo.toFixed(2) + ')';
        times = (1 / rawRatio).toFixed(1);
      }
      var comparison = richer
        ? ' ' + richer + ' earns <strong>' + times + '×</strong> more log growth than ' + poorer + '.'
        : '';
      box.appendChild(callout('', sell
        ? 'At a fixed markup, Kelly is <strong>constant</strong> (' + pct(fStar, 2) +
          ') across the whole band — but growth per ticket is not.' + comparison +
          ' Both tie up exactly the same capital.'
        : 'At a fixed discount, Kelly <strong>moves</strong> across the band (' +
          pct(Math.min(fLo, fHi), 2) + '–' + pct(Math.max(fLo, fHi), 2) +
          ') — buying is not the mirror image of selling in this respect, because f* climbs ' +
          'with the probability instead of staying put.' + comparison));
      if (isFinite(ms[N - 1])) {
        box.appendChild(callout('',
          'For the lopsided end to earn what the balanced end does, you would need <strong>' +
          ms[N - 1].toFixed(1) + ' %</strong> there instead of ' + (r.markup * 100).toFixed(1) + ' %.'));
      }
      if (r.concurrent > 1) {
        var k = r.concurrent;
        // The share of growth left after splitting Kelly k ways (quadratic
        // approximation of g(f) = fμ - ½f²σ²; within 0.1 % of the exact value).
        var keep = 2 / k - 1 / (k * k);
        if ($('r_split').checked) {
          box.appendChild(callout('warn',
            'You are splitting Kelly across ' + k + ' concurrent tickets. That is only right when they ' +
            'are <strong>perfectly correlated</strong> — when they hang on the same legs. If they are ' +
            'independent, you are underbetting and giving up roughly <strong>' + ((1 - keep) * 100).toFixed(0) +
            ' %</strong> of the growth per ticket.'));
        } else {
          box.appendChild(callout('',
            'Each of the ' + k + ' concurrent tickets is sized at full Kelly. For <strong>independent</strong> ' +
            'events that is correct, and concurrency changes nothing — growth and drawdown come out the same ' +
            'as running them one after another. Once they start sharing legs, exposure adds up and just two ' +
            'perfectly correlated tickets drive growth to zero.'));
        }
      }
    }

    runner('r', $('r_results'), function () {
      var r = read();
      if (r.qHi <= r.qLo) throw new Error('the upper edge of the band must sit above the lower');
      var B0 = r.bankroll;
      var cfg = {
        mode: 'range', markup: r.markup, qLo: r.qLo, qHi: r.qHi,
        dist: r.dist, distMode: r.distMode, side: side,
        probHaircut: r.haircut,
        bankroll: B0,
        tickets: Math.round(num($('r_tickets'))),
        sims: Math.round(num($('r_sims'))),
        seed: Math.round(num($('r_seed'))),
        sizing: readSizing('r', getSizing()),
        capFraction: num($('r_cap')) / 100,
        ruinFraction: num($('r_ruin')) / 100,
        concurrent: r.concurrent,
        concurrentSplit: $('r_split').checked,
        onDone: function (res) {
          lastRes = res;
          statKpis($('r_kpis'), res, B0, null);
          chFan.setData(fanData(res, $('r_log').checked, B0));
          fanLegend($('r_fanLegend'));
          chHist.setData(histData(res, B0));
          legend($('r_histLegend'), [
            { color: C.css('--div-neg'), label: 'ended below start', box: true },
            { color: C.css('--div-pos'), label: 'ended above start', box: true }
          ]);
          chDD.setData(ddData(res));
          chDec.setData(decileData(res, B0));
          chQuant.setData(quantData(res, B0));
          statTable($('r_table'), res, B0);

          lastCfg = cfg;
          showLog();
        }
      };
      return cfg;
    });

    /* --- trade log --- */
    var getLogPct = segment($('r_logPick'), function () { showLog(); });

    function showLog() {
      if (!lastRes || !lastCfg) return;
      lastLog = renderLog($('r_tradeLog'), $('r_logInfo'), lastCfg, lastRes,
        parseFloat(getLogPct()), num($('r_bankroll')));
    }

    $('r_logCsv').addEventListener('click', function () {
      if (!lastLog) return;
      downloadCsv('parlay-kelly-band-log.csv',
        ['ticket', 'p_combo', 'price', 'contracts', 'at_risk', 'max_win', 'won', 'pnl', 'bankroll'],
        lastLog.log.map(function (t) {
          return [t.ticket, t.pModel.toFixed(6), t.price.toFixed(6), t.contracts.toFixed(3),
            t.liability.toFixed(2), t.premium.toFixed(2), t.win ? 1 : 0,
            t.pnl.toFixed(2), t.bankroll.toFixed(2)];
        }));
    });

    /* --- sizing comparison --- */
    $('r_cmpRun').addEventListener('click', function () {
      var btn = $('r_cmpRun');
      if (btn.disabled) return;
      var r = read();
      if (r.qHi <= r.qLo) return;
      btn.disabled = true; btn.textContent = 'running…';
      runComparison({
        mode: 'range', markup: r.markup, qLo: r.qLo, qHi: r.qHi,
        dist: r.dist, distMode: r.distMode, side: side,
        probHaircut: r.haircut, bankroll: r.bankroll,
        tickets: Math.round(num($('r_tickets'))),
        sims: Math.min(Math.round(num($('r_sims'))), 20000),
        seed: Math.round(num($('r_seed'))),
        capFraction: num($('r_cap')) / 100,
        ruinFraction: num($('r_ruin')) / 100,
        concurrent: r.concurrent,
        concurrentSplit: $('r_split').checked,
        _fStar: K.fullKelly(ticketAt(r.qLo, r))
      }, chCmp, $('r_cmpLegend'), $('r_cmpTable'), function (p) {
        btn.textContent = 'running ' + Math.round(p * 100) + ' %';
      }).then(function () {
        btn.disabled = false; btn.textContent = 'Run comparison';
      }).catch(function () {
        btn.disabled = false; btn.textContent = 'Run comparison';
      });
    });

    $('r_csv').addEventListener('click', function () {
      if (!lastRes) return;
      downloadCsv('parlay-kelly-band.csv', ['ticket', 'p5', 'p25', 'median', 'p75', 'p95', 'mean'],
        csvRows(lastRes));
    });

    wireSeed('r');
    update();
  })();

  applyPerspectiveLabels();
})();
