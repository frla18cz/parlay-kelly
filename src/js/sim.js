/* sim.js — the Monte Carlo engine.
 *
 * Runs in batches on the main thread, yielding to the event loop between
 * them. A Web Worker is deliberately NOT used: the engine handles 100M steps
 * in a few seconds, and chunked execution behaves identically in the
 * single-file build, over file://, and inside a strict-CSP host where a blob
 * worker could fail outright.
 *
 * Memory is O(1) in the number of simulations. Rather than keeping every path
 * (100k × 1000 would be 800 MB) it keeps:
 *   - a log-grid histogram per checkpoint → percentile bands
 *   - exact arrays of final bankrolls and max drawdowns (N × 8 B)
 *   - up to 200 full sample paths for the spaghetti in the fan chart
 */
(function (global) {
  'use strict';

  var K = global.Kelly;

  var MAX_STORED_PATHS = 200;   // enough to read as texture, cheap to store
  var MAX_CHECKPOINTS = 121;    // the fan chart cannot resolve more than this
  var LOG_MIN = -9;             // log10(B/B0) — lower edge of the grid
  var LOG_MAX = 9;
  var NBINS = 2400;             // 0.0075 dex/bin → ~1.7 % relative accuracy
  var BINW = (LOG_MAX - LOG_MIN) / NBINS;
  var LOG10E = Math.LOG10E;

  /* mulberry32 — a fast seeded PRNG, fully reproducible. */
  function makeRng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* Percentile of an already sorted array. */
  function percentileSorted(sorted, pct) {
    var n = sorted.length;
    if (!n) return 0;
    var idx = (pct / 100) * (n - 1);
    var lo = Math.floor(idx);
    var hi = Math.min(lo + 1, n - 1);
    var frac = idx - lo;
    return sorted[lo] * (1 - frac) + sorted[hi] * frac;
  }

  /* Percentile from one checkpoint's histogram, linearly interpolated inside
   * the bin. Returns a multiple of the starting bankroll. */
  function percentileFromHist(hist, offset, total, pct) {
    var target = (pct / 100) * total;
    var cum = 0;
    for (var i = 0; i < NBINS; i++) {
      var cnt = hist[offset + i];
      if (cnt === 0) continue;
      if (cum + cnt >= target) {
        var within = cnt > 0 ? (target - cum) / cnt : 0;
        var logv = LOG_MIN + (i + within) * BINW;
        return Math.pow(10, logv);
      }
      cum += cnt;
    }
    return Math.pow(10, LOG_MAX);
  }

  /* Evenly spaced checkpoints over 0..rounds, both ends included. */
  function buildCheckpoints(rounds) {
    var n = Math.min(rounds + 1, MAX_CHECKPOINTS);
    var cps = new Int32Array(n);
    for (var i = 0; i < n; i++) {
      cps[i] = n === 1 ? 0 : Math.round((i * rounds) / (n - 1));
    }
    return cps;
  }

  /* Inverse CDF of a triangular distribution on [lo,hi] peaking at `mode`. */
  function triangular(u, lo, hi, mode) {
    var span = hi - lo;
    if (span <= 0) return lo;
    var f = (mode - lo) / span;
    if (u < f) return lo + Math.sqrt(u * span * (mode - lo));
    return hi - Math.sqrt((1 - u) * span * (hi - mode));
  }

  /* Normalise the config and precompute whatever stays constant. */
  function prepare(cfg) {
    var side = cfg.side || 'sell';
    var isRange = cfg.mode === 'range';
    var concurrent = Math.max(1, Math.round(cfg.concurrent || 1));
    var rounds = Math.max(1, Math.ceil(cfg.tickets / concurrent));

    var fixed = null;
    if (!isRange) {
      // p_true may sit away from the model (the edge haircut).
      var pTrue = K.clamp(cfg.p * (1 + (cfg.probHaircut || 0)), 1e-9, 1 - 1e-9);
      var tModel = K.ticketParams(cfg.p, cfg.price, side);
      var tTrue = K.ticketParams(pTrue, cfg.price, side);
      fixed = {
        // sized from the model, resolved against reality
        fStar: K.fullKelly(tModel),
        b: tModel.b,
        risk: tModel.riskPerContract,
        winProb: tTrue.winProb,
        pModel: cfg.p,
        price: cfg.price
      };
    }

    return {
      side: side, isRange: isRange, concurrent: concurrent, rounds: rounds,
      fixed: fixed,
      checkpoints: buildCheckpoints(rounds),
      seed: (cfg.seed || 0) >>> 0,
      markup: cfg.markup || 0,
      qLo: cfg.qLo, qHi: cfg.qHi,
      dist: cfg.dist || 'uniform',
      distMode: cfg.distMode == null ? 0.5 : cfg.distMode,
      haircut: cfg.probHaircut || 0,
      B0: cfg.bankroll,
      sims: cfg.sims,
      sizing: cfg.sizing || { type: 'kelly', mult: 1 },
      cap: cfg.capFraction == null ? 1 : cfg.capFraction,
      round: !!cfg.roundContracts,
      // Default is NOT to split: independent tickets each get full Kelly.
      // Splitting encodes an assumption of perfect correlation (shared legs).
      splitConcurrent: cfg.concurrent > 1 && cfg.concurrentSplit === true,
      ruinLevel: cfg.bankroll * (cfg.ruinFraction == null ? 1e-6 : cfg.ruinFraction)
    };
  }

  /* Every simulation gets its own well-spread seed, so any single path can be
   * replayed on its own (see replay) without spinning through the ones
   * before it. */
  function mix32(z) {
    z = (z + 0x9E3779B9) | 0;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    return (z ^ (z >>> 15)) >>> 0;
  }
  function simRng(seed, index) {
    return makeRng(mix32((seed ^ mix32(index + 1)) >>> 0));
  }

  /* One simulation. `acc` may be null (replay only) and `log` may be an
   * array, in which case every ticket is written into it. The betting logic
   * lives in exactly ONE place so the log cannot drift from the simulation. */
  function runSim(P, s, acc, log) {
    var cps = P.checkpoints, nCp = cps.length;
    var B0 = P.B0, ruinLevel = P.ruinLevel;
    var sizing = P.sizing, cap = P.cap;
    var isRange = P.isRange, conc = P.concurrent, isSell = P.side !== 'buy';
    var qSpan = P.qHi - P.qLo;
    var triMode = P.qLo + P.distMode * qSpan;
    var rng = simRng(P.seed, s);

    var B = B0, peak = B0, maxDD = 0, ruined = false;
    // fixed barriers measured from the STARTING bankroll — unlike drawdown
    // from a running peak, this quantity converges with the horizon
    var below50 = false, below25 = false;
    // Turnover = how much money changes hands in total. Without it two
    // settings cannot be compared honestly — a ticket at 0.9 turns over 130×
    // more than one at 0.1 for the same capital at risk.
    var turnover = 0;
    var storePath = acc && s < MAX_STORED_PATHS;
    var pathOff = s * nCp;
    var cpi = 0;
    var ticket = 0;

    if (cps[0] === 0) {
      if (acc) {
        acc.hist[0 * NBINS + binOf(1)]++;
        if (storePath) acc.paths[pathOff] = B0;
      }
      cpi = 1;
    }

    for (var r = 1; r <= P.rounds; r++) {
      if (!ruined) {
        var Bstart = B;
        var delta = 0;

        for (var k = 0; k < conc; k++) {
          var winProb, b, risk, fStar, pModel, c;

          if (isRange) {
            var u = rng();
            var q = P.dist === 'triangular'
              ? triangular(u, P.qLo, P.qHi, triMode)
              : P.qLo + u * qSpan;
            // The band is defined over YOUR win probability, so which
            // combo probability that implies depends on the side you take.
            // A seller wins when the combo misses, a buyer when it hits.
            pModel = isSell ? 1 - q : q;
            c = isSell ? pModel * (1 + P.markup) : pModel * (1 - P.markup);
            if (c >= 0.999999) c = 0.999999;
            if (c <= 0.000001) c = 0.000001;
            // Sized from the model. Note this is constant across the band
            // for a seller (m/(1+m)) but NOT for a buyer.
            fStar = isSell ? (c - pModel) / c : (pModel - c) / (1 - c);
            b = isSell ? c / (1 - c) : (1 - c) / c;
            risk = isSell ? 1 - c : c;
            var pTrue = pModel * (1 + P.haircut);  // reality may sit elsewhere
            if (pTrue > 0.999999) pTrue = 0.999999;
            winProb = isSell ? 1 - pTrue : pTrue;
          } else {
            fStar = P.fixed.fStar;
            b = P.fixed.b;
            risk = P.fixed.risk;
            winProb = P.fixed.winProb;
            pModel = P.fixed.pModel;
            c = P.fixed.price;
          }

          var f;
          if (sizing.type === 'flatPct') {
            f = (sizing.pct * B0) / Bstart;        // flat % of the STARTING bankroll
          } else if (sizing.type === 'flatAbs') {
            f = sizing.amount / Bstart;            // flat amount
          } else {
            f = fStar * sizing.mult;
          }
          if (P.splitConcurrent) f /= conc;
          if (f > cap) f = cap;
          if (f > 0.999999) f = 0.999999;

          ticket++;
          if (!(f > 0)) {
            if (log) log.push({ ticket: ticket, round: r, skipped: true, price: c, pModel: pModel, bankroll: B });
            continue;
          }

          var L = f * Bstart;
          var contracts = L / risk;
          if (P.round) {
            contracts = Math.floor(contracts);
            if (contracts < 1) {
              if (log) log.push({ ticket: ticket, round: r, skipped: true, price: c, pModel: pModel, bankroll: B });
              continue;
            }
            L = contracts * risk;
          }
          if (L > Bstart) { L = Bstart; contracts = L / risk; }

          var win = rng() < winProb;
          var pnl = win ? L * b : -L;
          delta += pnl;
          turnover += contracts * c;

          if (log) {
            log.push({
              ticket: ticket, round: r, skipped: false,
              pModel: pModel, winProb: winProb, price: c,
              fraction: f, liability: L, contracts: contracts,
              premium: contracts * (isSell ? c : 1 - c), win: win, pnl: pnl,
              bankroll: Bstart + delta
            });
          }
        }

        B = Bstart + delta;
        if (B > peak) peak = B;
        var dd = peak > 0 ? (peak - B) / peak : 0;
        if (dd > maxDD) maxDD = dd;
        if (B <= B0 * 0.5) below50 = true;
        if (B <= B0 * 0.25) below25 = true;
        if (B <= ruinLevel) { B = ruinLevel; ruined = true; }
      }

      if (acc) {
        while (cpi < nCp && cps[cpi] === r) {
          var mult = B / B0;
          var lg = Math.log(mult);
          acc.hist[cpi * NBINS + binOfLog(lg)]++;
          acc.bandSum[cpi] += mult;
          acc.logSumCp[cpi] += lg;         // for the geometric mean
          if (storePath) acc.paths[pathOff + cpi] = B;
          cpi++;
        }
      }
    }

    if (acc) {
      acc.finals[s] = B;
      acc.maxDD[s] = maxDD;
      acc.logSum += Math.log(B / B0);
      if (ruined) acc.ruined++;
      if (B < B0) acc.belowStart++;
      if (below50) acc.below50++;
      if (below25) acc.below25++;
      acc.turnoverSum += turnover;
    }
    return { final: B, maxDD: maxDD, ruined: ruined };
  }

  function runBatch(P, acc, from, to) {
    for (var s = from; s < to; s++) runSim(P, s, acc, null);
  }

  function binOfLog(lnMult) {
    var lg = lnMult * LOG10E;
    var i = Math.floor((lg - LOG_MIN) / BINW);
    return i < 0 ? 0 : i >= NBINS ? NBINS - 1 : i;
  }
  function binOf(mult) { return binOfLog(Math.log(mult)); }

  /* Runs the simulation in batches. onProgress(0..1) is optional.
   * Returns a Promise of the result. */
  function run(cfg, onProgress) {
    var P = prepare(cfg);
    var cps = P.checkpoints;
    var nCp = cps.length;
    var N = P.sims;

    var acc = {
      checkpoints: cps,
      hist: new Uint32Array(nCp * NBINS),
      bandSum: new Float64Array(nCp),
      logSumCp: new Float64Array(nCp),
      paths: new Float64Array(Math.min(N, MAX_STORED_PATHS) * nCp),
      finals: new Float64Array(N),
      maxDD: new Float64Array(N),
      logSum: 0, ruined: 0, belowStart: 0, below50: 0, below25: 0, turnoverSum: 0
    };

    // ~2M steps per batch, so one round lands around 30-60 ms
    var stepsPerSim = P.rounds * P.concurrent;
    var batch = Math.max(1, Math.min(N, Math.ceil(2e6 / Math.max(1, stepsPerSim))));

    return new Promise(function (resolve) {
      var done = 0;
      function step() {
        var to = Math.min(done + batch, N);
        runBatch(P, acc, done, to);
        done = to;
        if (onProgress) onProgress(done / N);
        if (done < N) {
          setTimeout(step, 0);
        } else {
          resolve(finalise(P, acc, cfg));
        }
      }
      setTimeout(step, 0);
    });
  }

  function finalise(P, acc, cfg) {
    var N = P.sims, nCp = acc.checkpoints.length, B0 = P.B0;

    var bands = {
      p5: new Float64Array(nCp), p25: new Float64Array(nCp),
      p50: new Float64Array(nCp), p75: new Float64Array(nCp),
      p95: new Float64Array(nCp), mean: new Float64Array(nCp),
      geo: new Float64Array(nCp)
    };
    for (var i = 0; i < nCp; i++) {
      var off = i * NBINS;
      bands.p5[i] = percentileFromHist(acc.hist, off, N, 5) * B0;
      bands.p25[i] = percentileFromHist(acc.hist, off, N, 25) * B0;
      bands.p50[i] = percentileFromHist(acc.hist, off, N, 50) * B0;
      bands.p75[i] = percentileFromHist(acc.hist, off, N, 75) * B0;
      bands.p95[i] = percentileFromHist(acc.hist, off, N, 95) * B0;
      bands.mean[i] = (acc.bandSum[i] / N) * B0;
      // geometric mean — smooth, and exactly what Kelly maximises
      bands.geo[i] = Math.exp(acc.logSumCp[i] / N) * B0;
    }
    // at t=0 every path sits at B0; the histogram rounds that, so pin it back
    if (acc.checkpoints[0] === 0) {
      bands.p5[0] = bands.p25[0] = bands.p50[0] = bands.p75[0] = bands.p95[0]
        = bands.mean[0] = bands.geo[0] = B0;
    }

    var finalsSorted = acc.finals.slice().sort(function (a, b) { return a - b; });
    var ddSorted = acc.maxDD.slice().sort(function (a, b) { return a - b; });

    var sum = 0;
    for (var j = 0; j < N; j++) sum += acc.finals[j];

    var nPaths = Math.min(N, MAX_STORED_PATHS);
    var paths = [];
    for (var s = 0; s < nPaths; s++) {
      paths.push(acc.paths.subarray(s * nCp, (s + 1) * nCp));
    }

    var totalTickets = P.rounds * P.concurrent;

    return {
      config: cfg,
      finalsRaw: acc.finals,          // unsorted, indexed by simulation number
      checkpoints: acc.checkpoints,
      rounds: P.rounds,
      concurrent: P.concurrent,
      totalTickets: totalTickets,
      bands: bands,
      samplePaths: paths,
      finals: finalsSorted,
      maxDrawdowns: ddSorted,
      stats: {
        medianFinal: percentileSorted(finalsSorted, 50),
        meanFinal: sum / N,
        p5: percentileSorted(finalsSorted, 5),
        p25: percentileSorted(finalsSorted, 25),
        p75: percentileSorted(finalsSorted, 75),
        p95: percentileSorted(finalsSorted, 95),
        worst: finalsSorted[0],
        best: finalsSorted[N - 1],
        pctRuined: acc.ruined / N,
        pctBelowStart: acc.belowStart / N,
        // fixed barrier from the starting bankroll — converges with horizon
        // mean turnover per path — how much money has to change hands for
        // that result to be reachable at all
        meanTurnover: acc.turnoverSum / N,
        pctEverBelow50: acc.below50 / N,
        pctEverBelow25: acc.below25 / N,
        maxDDMedian: percentileSorted(ddSorted, 50),
        maxDDp95: percentileSorted(ddSorted, 95),
        // MC estimate of E[log] per ticket — must converge to analytic g
        meanLogGrowthPerTicket: acc.logSum / N / totalTickets
      }
    };
  }

  /* Replays one specific simulation and returns the log of every ticket.
   * It calls the same function as the real run, so it cannot drift from it. */
  function replay(cfg, simIndex) {
    var P = prepare(cfg);
    var log = [];
    var res = runSim(P, simIndex, null, log);
    return { index: simIndex, log: log, final: res.final, maxDD: res.maxDD, ruined: res.ruined };
  }

  /* Index of the simulation whose result is closest to a given percentile.
   * `finalsRaw` is the unsorted array indexed by simulation number. */
  function indexAtPercentile(finalsRaw, sortedFinals, pct) {
    var target = percentileSorted(sortedFinals, pct);
    var best = 0, bestD = Infinity;
    for (var i = 0; i < finalsRaw.length; i++) {
      var d = Math.abs(finalsRaw[i] - target);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  /* Quantile curve: the value at each percentile 0..100. Answers "where did I
   * end up in 50 % of cases" directly, without going through a histogram. */
  function quantileCurve(sorted, steps) {
    var n = steps || 101;
    var pcts = new Float64Array(n), vals = new Float64Array(n);
    for (var i = 0; i < n; i++) {
      pcts[i] = (i / (n - 1)) * 100;
      vals[i] = percentileSorted(sorted, pcts[i]);
    }
    return { pcts: pcts, values: vals };
  }

  /* Splits sorted results into `k` equal buckets and returns their bounds.
   * "In this ten-percent band you finished between X and Y." */
  function buckets(sorted, k) {
    var out = [];
    for (var i = 0; i < k; i++) {
      var loP = (i / k) * 100, hiP = ((i + 1) / k) * 100;
      out.push({
        fromPct: loP, toPct: hiP,
        lo: percentileSorted(sorted, loP),
        hi: percentileSorted(sorted, hiP),
        mid: percentileSorted(sorted, (loP + hiP) / 2)
      });
    }
    return out;
  }

  /* Histogram for the bar chart: `values` are already sorted. */
  function histogram(sortedValues, nBins, logScale) {
    var n = sortedValues.length;
    if (!n) return { edges: [], counts: [] };
    var lo = sortedValues[0], hi = sortedValues[n - 1];
    if (logScale) {
      lo = Math.log10(Math.max(lo, 1e-12));
      hi = Math.log10(Math.max(hi, 1e-12));
    }
    if (hi - lo < 1e-12) { hi = lo + 1; }
    var w = (hi - lo) / nBins;
    var counts = new Float64Array(nBins);
    for (var i = 0; i < n; i++) {
      var v = logScale ? Math.log10(Math.max(sortedValues[i], 1e-12)) : sortedValues[i];
      var b = Math.floor((v - lo) / w);
      if (b < 0) b = 0; if (b >= nBins) b = nBins - 1;
      counts[b]++;
    }
    var edges = new Float64Array(nBins + 1);
    for (var e = 0; e <= nBins; e++) {
      var x = lo + e * w;
      edges[e] = logScale ? Math.pow(10, x) : x;
    }
    return { edges: edges, counts: counts };
  }

  global.Sim = {
    MAX_STORED_PATHS: MAX_STORED_PATHS,
    makeRng: makeRng,
    percentileSorted: percentileSorted,
    triangular: triangular,
    run: run,
    replay: replay,
    indexAtPercentile: indexAtPercentile,
    quantileCurve: quantileCurve,
    buckets: buckets,
    histogram: histogram
  };
})(typeof self !== 'undefined' ? self : this);
