/* kelly.js — the analytical core.
 *
 * One combo (parlay) ticket, one contract, payout 1.00 if the combo hits.
 * Everything is expressed from *your* point of view, whichever side you take:
 *
 *   SELL (you write the combo, you are the counterparty)
 *       you collect  +c        with probability  q = 1 - p
 *       you pay      -(1 - c)  with probability  p
 *
 *   BUY (you back the combo, the usual punter position)
 *       you win      +(1 - c)  with probability  p
 *       you lose     -c        with probability  q = 1 - p
 *
 * where p is the probability the combo hits and c is the price of the
 * contract. The two sides are mirror images, so a single set of formulas
 * covers both once win/loss are named from your seat rather than the
 * market's.
 */
(function (global) {
  'use strict';

  var EPS = 1e-12;

  function clamp(x, lo, hi) {
    return x < lo ? lo : x > hi ? hi : x;
  }

  /* Product of the individual leg prices — the fair price of the combo,
   * assuming the legs are independent. */
  function askProduct(legs) {
    var prod = 1;
    for (var i = 0; i < legs.length; i++) {
      var a = Number(legs[i]);
      if (!isFinite(a) || a <= 0 || a >= 1) return NaN;
      prod *= a;
    }
    return legs.length ? prod : NaN;
  }

  /* Price implied by an edge over fair.
   *
   * A seller needs to be paid ABOVE fair, a buyer needs to pay BELOW it, so
   * the same positive `edge` moves the price in opposite directions. Both
   * sides therefore enter the same positive number and mean "my margin".
   */
  function priceFromEdge(p, edge, side) {
    return side === 'buy' ? p * (1 - edge) : p * (1 + edge);
  }

  /* Inverse of priceFromEdge: the edge implied by a price. */
  function edgeFromPrice(p, c, side) {
    if (!(p > EPS)) return NaN;
    return side === 'buy' ? 1 - c / p : c / p - 1;
  }

  /* Derived parameters of one ticket, from your seat.
   *
   *   p       true probability the combo hits
   *   c       price of one contract
   *   side    'sell' = you write the combo (default)
   *           'buy'  = you back the combo
   */
  function ticketParams(p, c, side) {
    var isSell = side !== 'buy';
    // Normalised to "what I win / what I lose". Buying flips both the
    // stake and the event you are rooting for.
    var winProb = isSell ? 1 - p : p;
    var risk = isSell ? 1 - c : c;         // lost per contract
    var gain = isSell ? c : 1 - c;         // won per contract
    var b = risk > EPS ? gain / risk : Infinity;
    var evPerContract = isSell ? c - p : p - c;

    return {
      side: isSell ? 'sell' : 'buy',
      p: p,
      q: 1 - p,
      price: c,
      winProb: winProb,
      lossProb: 1 - winProb,
      riskPerContract: risk,
      gainPerContract: gain,
      b: b,
      evPerContract: evPerContract,
      // Price at which EV is exactly zero.
      breakevenPrice: p,
      hasEdge: evPerContract > EPS
    };
  }

  /* Full Kelly = the fraction of BANKROLL AT RISK (max loss / bankroll).
   *
   *     f* = (b·winProb - lossProb) / b
   *
   * With an asymmetric payout this is the only unambiguous definition:
   * "fraction of stake" and "fraction of exposure" part ways once winning
   * and losing move different amounts of money.
   *
   * On the sell side it collapses to f* = (c - p)/c = EV/c.
   */
  function fullKelly(t) {
    if (!(t.b > 0) || !isFinite(t.b)) return 0;
    var f = (t.b * t.winProb - t.lossProb) / t.b;
    return clamp(f, 0, 1);
  }

  /* Expected log growth of the bankroll per ticket:
   *     g(f) = winProb·ln(1 + f·b) + lossProb·ln(1 - f)
   */
  function growthRate(t, f) {
    if (f <= 0) return 0;
    if (f >= 1) return -Infinity;
    var gainMult = 1 + f * t.b;
    var lossMult = 1 - f;
    if (gainMult <= 0 || lossMult <= 0) return -Infinity;
    return t.winProb * Math.log(gainMult) + t.lossProb * Math.log(lossMult);
  }

  /* Variance of the per-ticket log return — needed for drawdown. */
  function logVariance(t, f) {
    if (f <= 0 || f >= 1) return 0;
    var logWin = Math.log(1 + f * t.b);
    var logLoss = Math.log(1 - f);
    var g = t.winProb * logWin + t.lossProb * logLoss;
    return t.winProb * Math.pow(logWin - g, 2) + t.lossProb * Math.pow(logLoss - g, 2);
  }

  /* Probability the bankroll ever falls to a fraction `frac` of its STARTING
   * value.
   *
   * P ≈ frac^s, where s = 2g / var(log) — the classic fixed-barrier problem
   * (gambler's ruin via an exponential martingale). More general than the
   * textbook x^(2/k - 1), which only holds in the diffusion limit of a
   * symmetric bet.
   *
   * NOTE: this is NOT max drawdown from a running peak. That is a reflected
   * walk, and it grows roughly logarithmically with the horizon — it does
   * not converge to anything. The fixed barrier does converge (simulation:
   * 49.2 % against 49.8 % theory over 100k tickets); drawdown from a peak
   * does not (56 % → 87 % → 98 % over 1k/10k/100k tickets).
   */
  function drawdownProb(t, f, frac) {
    if (f <= 0 || frac <= 0 || frac >= 1) return 0;
    var g = growthRate(t, f);
    if (!(g > 0)) return 1;                 // without growth, any level is reached eventually
    var varLog = logVariance(t, f);
    if (varLog < 1e-15) return 0;
    return clamp(Math.pow(frac, 2 * g / varLog), 0, 1);
  }

  /* Analytical risk of ruin for a FLAT stake (comparison mode).
   *
   * Solves the characteristic equation of a random walk with steps +W, -L:
   *     winProb·r^W + lossProb·r^(-L) = 1,  root r ∈ (0,1)
   * Risk of ruin = r^(bankroll / bet).
   */
  function fixedRiskOfRuin(t, betSize, bankroll) {
    if (!t.hasEdge) return 1;
    if (betSize <= 0 || bankroll <= 0) return 1;
    var W = t.b, L = 1;
    var units = bankroll / betSize;
    function fn(r) {
      return t.winProb * Math.pow(r, W) + t.lossProb * Math.pow(r, -L) - 1;
    }
    var lo = 1e-10, hi = 1 - 1e-10;
    if (fn(lo) >= 0 && fn(hi) >= 0) return 0;
    for (var i = 0; i < 200; i++) {
      var mid = (lo + hi) / 2;
      if (fn(mid) > 0) lo = mid; else hi = mid;
      if (hi - lo < 1e-15) break;
    }
    return clamp(Math.pow((lo + hi) / 2, units), 0, 1);
  }

  /* The Kelly multiple at which growth falls exactly to zero.
   *
   * The familiar "2× Kelly = zero growth" holds EXACTLY only for a symmetric
   * bet (winProb = 0.5). With an asymmetric payout the point sits lower
   * (~1.977 at winProb = 0.9, 4 % edge), so it is found numerically rather
   * than hardcoded to 2.0.
   */
  function zeroGrowthMultiple(t) {
    var fStar = fullKelly(t);
    if (fStar <= EPS) return NaN;
    var lo = 1, hi = Math.min(1 / fStar * 0.999999, 1e6);
    if (growthRate(t, clamp(fStar * hi, 0, 0.999999)) > 0) return hi;
    for (var i = 0; i < 200; i++) {
      var mid = (lo + hi) / 2;
      if (growthRate(t, clamp(fStar * mid, 0, 0.999999)) > 0) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  /* How far the edge can be overestimated before growth hits zero.
   *
   * You size from a model probability pModel, but reality is different. For a
   * seller the danger is the combo hitting MORE often than modelled; for a
   * buyer it is hitting LESS often. Returns the true p at which g = 0 and the
   * relative margin against the model (signed: negative means reality has to
   * fall for you to be hurt).
   */
  function edgeTolerance(pModel, c, side, kellyMult) {
    var t = ticketParams(pModel, c, side);
    var f = fullKelly(t) * kellyMult;
    if (f <= EPS) return { pBreak: NaN, relativeMargin: NaN };
    var isSell = t.side === 'sell';
    var lo = pModel;
    var hi = isSell ? Math.min(0.999999, c) : Math.max(1e-6, c);
    function gAt(pT) {
      // f stays fixed (you sized from the model); only reality moves.
      var tt = ticketParams(pT, c, side);
      return growthRate({ b: t.b, winProb: tt.winProb, lossProb: tt.lossProb }, f);
    }
    for (var i = 0; i < 200; i++) {
      var mid = (lo + hi) / 2;
      if (gAt(mid) > 0) lo = mid; else hi = mid;
    }
    var pBreak = (lo + hi) / 2;
    return { pBreak: pBreak, relativeMargin: pBreak / pModel - 1 };
  }

  /* The edge that brings this ticket's growth up to a reference value.
   *
   * Answers "how much margin do I need on a lopsided ticket for it to earn
   * as much as a balanced one". Returns the edge as a decimal (0.04 = 4 %),
   * in the same convention as priceFromEdge — a positive number meaning
   * "my margin", whichever side you are on.
   */
  function edgeForGrowth(p, gTarget, side) {
    var isSell = side !== 'buy';
    // A seller can mark up until the price approaches 1; a buyer can only
    // discount until the price approaches 0, i.e. edge approaches 1.
    var lo = 1e-6;
    var hi = isSell ? Math.min(5, 0.98 / p - 1) : 0.999999;
    if (hi <= lo) return NaN;
    function gAt(m) {
      var c = priceFromEdge(p, m, side);
      if (c <= 0 || c >= 1) return -Infinity;
      var t = ticketParams(p, c, side);
      return growthRate(t, fullKelly(t));
    }
    if (gAt(hi) < gTarget) return NaN;      // even an extreme edge cannot reach it
    for (var i = 0; i < 200; i++) {
      var mid = (lo + hi) / 2;
      if (gAt(mid) < gTarget) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  /* Full analysis of a single ticket. */
  function analyseTicket(opts) {
    var p = opts.p;
    var c = opts.price;
    var side = opts.side || 'sell';
    var bankroll = opts.bankroll;
    var mult = opts.kellyMultiplier == null ? 1 : opts.kellyMultiplier;
    var cap = opts.capFraction == null ? null : opts.capFraction;

    var t = ticketParams(p, c, side);
    var fStar = fullKelly(t);
    var scaled = fStar * mult;
    var applied = Math.max(scaled, 0);
    var capHit = false;
    if (cap != null && applied > cap) { applied = cap; capHit = true; }

    var maxLoss = bankroll * applied;
    var contracts = t.riskPerContract > EPS ? maxLoss / t.riskPerContract : 0;
    if (opts.roundContracts) {
      contracts = Math.floor(contracts);
      maxLoss = contracts * t.riskPerContract;
      applied = bankroll > 0 ? maxLoss / bankroll : 0;
    }

    return {
      params: t,
      fullKellyFraction: fStar,
      scaledFraction: scaled,
      appliedFraction: applied,
      capHit: capHit,
      maxLoss: maxLoss,                                  // the most you can lose
      contracts: contracts,
      premium: contracts * t.gainPerContract,            // the most you can win
      evTotal: contracts * t.evPerContract,
      evPerContract: t.evPerContract,
      growthPerTicket: growthRate(t, applied),
      growthAtFullKelly: growthRate(t, fStar),
      zeroGrowthMultiple: zeroGrowthMultiple(t),
      dd50: drawdownProb(t, applied, 0.5),
      dd25: drawdownProb(t, applied, 0.25),
      breakevenPrice: t.breakevenPrice,
      hasEdge: t.hasEdge
    };
  }

  global.Kelly = {
    EPS: EPS,
    clamp: clamp,
    askProduct: askProduct,
    priceFromEdge: priceFromEdge,
    edgeFromPrice: edgeFromPrice,
    ticketParams: ticketParams,
    fullKelly: fullKelly,
    growthRate: growthRate,
    logVariance: logVariance,
    drawdownProb: drawdownProb,
    fixedRiskOfRuin: fixedRiskOfRuin,
    zeroGrowthMultiple: zeroGrowthMultiple,
    edgeTolerance: edgeTolerance,
    edgeForGrowth: edgeForGrowth,
    markupForGrowth: edgeForGrowth,   // legacy name
    analyseTicket: analyseTicket
  };
})(typeof self !== 'undefined' ? self : this);
