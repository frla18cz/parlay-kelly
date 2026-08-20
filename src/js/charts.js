/* charts.js — a dependency-free canvas charting layer.
 *
 * Colours are read from CSS custom properties, so switching theme is just an
 * attribute change on <html>. The plotting surface must stay --surface-1 or
 * the contrast ratios checked by the palette validator no longer hold.
 *
 * House rules: 2px lines, hairline solid grid, markers >=8px with a 2px ring
 * in the surface colour, a legend once there are 2+ series, never a value
 * label on every point, and no secondary axis.
 */
(function (global) {
  'use strict';

  /* left/bottom must fit the rotated axis label BESIDE the tick text, or
   * "5.0e-4" and "growth per ticket" end up on top of each other. */
  var PAD = { top: 18, right: 20, bottom: 42, left: 76 };

  /* ---- colours -------------------------------------------------------- */

  var _css = null;
  function css(name) {
    if (!_css) _css = getComputedStyle(document.documentElement);
    return _css.getPropertyValue(name).trim();
  }
  function invalidateColors() { _css = null; }

  function withAlpha(hex, a) {
    hex = hex.replace('#', '');
    if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    var n = parseInt(hex, 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  /* ---- axes ------------------------------------------------------------ */

  /* Classic 1-2-5 nice ticks. */
  function niceTicks(min, max, target) {
    if (!isFinite(min) || !isFinite(max) || min === max) {
      return { ticks: [min], step: 1 };
    }
    var raw = (max - min) / Math.max(1, target);
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var norm = raw / mag;
    var step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
    var first = Math.ceil(min / step) * step;
    var ticks = [];
    for (var v = first; v <= max + step * 1e-9; v += step) ticks.push(v);
    return { ticks: ticks, step: step };
  }

  /* Ticks for a log axis — decades, plus intermediates when they are few. */
  function logTicks(min, max) {
    min = Math.max(min, 1e-12);
    var lo = Math.floor(Math.log10(min)), hi = Math.ceil(Math.log10(max));
    var decades = hi - lo;
    var mids = decades <= 2 ? [1, 2, 5] : decades <= 5 ? [1, 3] : [1];
    var ticks = [];
    for (var d = lo; d <= hi; d++) {
      for (var i = 0; i < mids.length; i++) {
        var v = mids[i] * Math.pow(10, d);
        if (v >= min * 0.999 && v <= max * 1.001) ticks.push(v);
      }
    }
    return ticks;
  }

  /* ---- formatting ------------------------------------------------------ */

  function fmtCompact(v) {
    var a = Math.abs(v);
    if (a >= 1e9) return (v / 1e9).toFixed(a >= 1e10 ? 0 : 1) + 'B';
    if (a >= 1e6) return (v / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M';
    if (a >= 1e3) return (v / 1e3).toFixed(a >= 1e4 ? 0 : 1) + 'k';
    if (a >= 10) return v.toFixed(0);
    if (a >= 1) return v.toFixed(1);
    if (a === 0) return '0';
    // never exponential notation — "1.0e-7" reads terribly on an axis
    if (a >= 0.001) return v.toFixed(3);
    return v.toFixed(6);
  }

  function fmtMoney(v) { return fmtCompact(v); }
  function fmtPct(v, d) { return (v * 100).toFixed(d == null ? 1 : d) + ' %'; }

  /* ---- chart ----------------------------------------------------------- */

  function Chart(container, opts) {
    this.container = container;
    this.opts = opts || {};
    this.data = null;
    this.hover = -1;

    container.classList.add('chart');
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'chart-canvas';
    container.appendChild(this.canvas);

    this.tip = document.createElement('div');
    this.tip.className = 'chart-tip';
    this.tip.hidden = true;
    container.appendChild(this.tip);

    this.ctx = this.canvas.getContext('2d');

    var self = this;
    this._onMove = function (e) { self._pointer(e); };
    this._onLeave = function () { self.hover = -1; self.tip.hidden = true; self.render(); };
    container.addEventListener('pointermove', this._onMove);
    container.addEventListener('pointerleave', this._onLeave);

    this._ro = new ResizeObserver(function () { self.resize(); });
    this._ro.observe(container);
    this.resize();
  }

  Chart.prototype.destroy = function () {
    this._ro.disconnect();
    this.container.removeEventListener('pointermove', this._onMove);
    this.container.removeEventListener('pointerleave', this._onLeave);
  };

  Chart.prototype.resize = function () {
    var r = this.container.getBoundingClientRect();
    var dpr = global.devicePixelRatio || 1;
    this.w = Math.max(120, r.width);
    this.h = Math.max(80, r.height);
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.canvas.style.width = this.w + 'px';
    this.canvas.style.height = this.h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.render();
  };

  Chart.prototype.setData = function (data) {
    this.data = data;
    this.hover = -1;
    this.tip.hidden = true;
    this.render();
  };

  /* Data → pixel projection. */
  Chart.prototype._scales = function () {
    var d = this.data;
    var pad = Object.assign({}, PAD, d.pad || {});
    // On a narrow canvas 76px on the left would eat a third of the plot. The
    // axis label does not fit there anyway (see render), so tick room is
    // enough. An explicitly supplied pad is never overridden — a chart that
    // asked for one needs it for long ticks ("90-100 %") or they get clipped.
    if (this.w < 420) {
      if (!d.pad || d.pad.left == null) pad.left = Math.min(pad.left, 54);
      if (!d.pad || d.pad.right == null) pad.right = Math.min(pad.right, 12);
    }
    var x0 = pad.left, x1 = this.w - pad.right;
    var y0 = this.h - pad.bottom, y1 = pad.top;

    var xMin = d.xMin, xMax = d.xMax;
    var yMin = d.yMin, yMax = d.yMax;
    var yLog = d.yScale === 'log';
    var xLog = d.xScale === 'log';

    var sx, sy;
    if (xLog) {
      xMin = Math.max(xMin, 1e-12);
      var lxMin = Math.log10(xMin), lxMax = Math.log10(xMax);
      if (lxMax - lxMin < 1e-9) lxMax = lxMin + 1;
      sx = function (v) {
        var l = Math.log10(Math.max(v, 1e-12));
        return x0 + ((l - lxMin) / (lxMax - lxMin)) * (x1 - x0);
      };
    } else {
      sx = function (v) { return x0 + ((v - xMin) / (xMax - xMin || 1)) * (x1 - x0); };
    }

    if (yLog) {
      yMin = Math.max(yMin, 1e-12);
      var lyMin = Math.log10(yMin), lyMax = Math.log10(yMax);
      if (lyMax - lyMin < 1e-9) lyMax = lyMin + 1;
      sy = function (v) {
        var l = Math.log10(Math.max(v, 1e-12));
        return y0 + ((l - lyMin) / (lyMax - lyMin)) * (y1 - y0);
      };
    } else {
      sy = function (v) { return y0 + ((v - yMin) / (yMax - yMin || 1)) * (y1 - y0); };
    }

    return {
      pad: pad, x0: x0, x1: x1, y0: y0, y1: y1,
      isLog: yLog, xIsLog: xLog,
      xMin: xMin, xMax: xMax, yMin: yMin, yMax: yMax,
      sx: sx, sy: sy
    };
  };

  Chart.prototype.render = function () {
    var ctx = this.ctx, d = this.data;
    ctx.clearRect(0, 0, this.w, this.h);
    if (!d) return;

    var s = this._scales();
    var grid = css('--gridline'), axis = css('--axis'), muted = css('--text-muted');
    var surface = css('--surface-1');

    ctx.save();

    /* --- grid and axes --- */
    var yTicks = d.yTicks
      ? d.yTicks
      : s.isLog ? logTicks(s.yMin, s.yMax) : niceTicks(s.yMin, s.yMax, 5).ticks;
    ctx.strokeStyle = grid; ctx.lineWidth = 1;
    ctx.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.fillStyle = muted;
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (var i = 0; i < yTicks.length; i++) {
      var py = Math.round(s.sy(yTicks[i])) + 0.5;
      if (py < s.y1 - 1 || py > s.y0 + 1) continue;
      ctx.beginPath(); ctx.moveTo(s.x0, py); ctx.lineTo(s.x1, py); ctx.stroke();
      ctx.fillText((d.fmtY || fmtCompact)(yTicks[i]), s.x0 - 8, py);
    }

    var xTicks = s.xIsLog
      ? logTicks(s.xMin, s.xMax)
      : niceTicks(s.xMin, s.xMax, Math.max(2, Math.floor(this.w / 90))).ticks;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (var j = 0; j < xTicks.length; j++) {
      var px = Math.round(s.sx(xTicks[j])) + 0.5;
      if (px < s.x0 - 1 || px > s.x1 + 1) continue;
      ctx.fillText((d.fmtX || fmtCompact)(xTicks[j]), px, s.y0 + 8);
    }

    ctx.strokeStyle = axis;
    ctx.beginPath();
    ctx.moveTo(s.x0, Math.round(s.y0) + 0.5); ctx.lineTo(s.x1, Math.round(s.y0) + 0.5);
    ctx.stroke();

    /* --- axis labels (on mobile a rotated label will not fit beside ticks) --- */
    if (d.yLabel && this.w >= 420) {
      ctx.save(); ctx.translate(13, (s.y0 + s.y1) / 2); ctx.rotate(-Math.PI / 2);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = muted; ctx.fillText(d.yLabel, 0, 0); ctx.restore();
    }
    if (d.xLabel) {
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillStyle = muted; ctx.fillText(d.xLabel, (s.x0 + s.x1) / 2, this.h - 2);
    }

    ctx.save();
    ctx.beginPath(); ctx.rect(s.x0, s.y1 - 4, s.x1 - s.x0, s.y0 - s.y1 + 8); ctx.clip();

    /* --- sloupce (histogram) --- */
    if (d.bars) this._drawBars(ctx, s, d.bars, surface);

    /* --- horizontal range bars (quantile buckets) --- */
    if (d.rangeBars) this._drawRangeBars(ctx, s, d.rangeBars, surface);

    /* --- bands --- */
    if (d.bands) {
      for (var b = 0; b < d.bands.length; b++) this._drawBand(ctx, s, d.x, d.bands[b]);
    }

    /* --- spaghetti (sample paths) --- */
    if (d.spaghetti && d.spaghetti.length) {
      ctx.strokeStyle = withAlpha(css('--spaghetti'), d.spaghettiAlpha || 0.13);
      ctx.lineWidth = 1;
      for (var k = 0; k < d.spaghetti.length; k++) {
        this._path(ctx, s, d.x, d.spaghetti[k]); ctx.stroke();
      }
    }

    /* --- reference lines --- */
    if (d.refLines) {
      for (var rl = 0; rl < d.refLines.length; rl++) {
        var R = d.refLines[rl];
        ctx.strokeStyle = R.color || axis; ctx.lineWidth = 1;
        ctx.beginPath();
        if (R.y != null) {
          var ry = Math.round(s.sy(R.y)) + 0.5;
          ctx.moveTo(s.x0, ry); ctx.lineTo(s.x1, ry);
        } else {
          var rx = Math.round(s.sx(R.x)) + 0.5;
          ctx.moveTo(rx, s.y1); ctx.lineTo(rx, s.y0);
        }
        ctx.stroke();
        if (R.label) {
          ctx.fillStyle = R.color || muted;
          ctx.font = '10px system-ui, -apple-system, "Segoe UI", sans-serif';
          if (R.y != null) {
            ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
            ctx.fillText(R.label, s.x0 + 4, s.sy(R.y) - 3);
          } else {
            ctx.textAlign = 'left'; ctx.textBaseline = 'top';
            ctx.fillText(R.label, s.sx(R.x) + 4, s.y1 + 2);
          }
        }
      }
    }

    /* --- lines --- */
    if (d.lines) {
      for (var l = 0; l < d.lines.length; l++) {
        var L = d.lines[l];
        ctx.strokeStyle = L.color; ctx.lineWidth = L.width || 2;
        ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        this._path(ctx, s, d.x, L.y); ctx.stroke();
      }
    }

    /* --- markers, ringed in the surface colour --- */
    if (d.markers) {
      for (var m = 0; m < d.markers.length; m++) {
        var M = d.markers[m];
        var mx = s.sx(M.x), my = s.sy(M.y);
        ctx.beginPath(); ctx.arc(mx, my, 6, 0, Math.PI * 2);
        ctx.fillStyle = surface; ctx.fill();
        ctx.beginPath(); ctx.arc(mx, my, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = M.color; ctx.fill();
      }
    }

    ctx.restore();

    /* --- crosshair (meaningless for horizontal range bars) --- */
    if (this.hover >= 0 && !d.rangeBars && d.x && this.hover < d.x.length) {
      var hx = Math.round(s.sx(d.x[this.hover])) + 0.5;
      ctx.strokeStyle = css('--crosshair'); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(hx, s.y1); ctx.lineTo(hx, s.y0); ctx.stroke();
      if (d.lines) {
        for (var hl = 0; hl < d.lines.length; hl++) {
          var HL = d.lines[hl];
          if (HL.y[this.hover] == null || !isFinite(HL.y[this.hover])) continue;
          var hy = s.sy(HL.y[this.hover]);
          ctx.beginPath(); ctx.arc(hx, hy, 5.5, 0, Math.PI * 2);
          ctx.fillStyle = surface; ctx.fill();
          ctx.beginPath(); ctx.arc(hx, hy, 4, 0, Math.PI * 2);
          ctx.fillStyle = HL.color; ctx.fill();
        }
      }
    }

    /* --- direct labels at line ends (selectively) --- */
    if (d.lines && d.directLabels) {
      ctx.font = '600 11px system-ui, -apple-system, "Segoe UI", sans-serif';
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      var used = [];
      for (var dl = d.lines.length - 1; dl >= 0; dl--) {
        var DL = d.lines[dl];
        if (!DL.label) continue;
        var last = DL.y.length - 1;
        while (last > 0 && !isFinite(DL.y[last])) last--;
        var ly = s.sy(DL.y[last]);
        var clash = false;
        for (var u = 0; u < used.length; u++) if (Math.abs(used[u] - ly) < 13) clash = true;
        if (clash) continue;
        used.push(ly);
        var tw = ctx.measureText(DL.label).width;
        if (s.x1 - 6 - tw < s.x0) continue;         // nevejde se → nese to legenda
        ctx.fillStyle = surface; ctx.globalAlpha = 0.82;
        ctx.fillRect(s.x1 - tw - 9, ly - 8, tw + 8, 16);
        ctx.globalAlpha = 1;
        ctx.fillStyle = css('--text-secondary');
        ctx.fillText(DL.label, s.x1 - 5, ly);
      }
    }

    ctx.restore();
  };

  Chart.prototype._path = function (ctx, s, xs, ys) {
    ctx.beginPath();
    var started = false;
    for (var i = 0; i < ys.length; i++) {
      var v = ys[i];
      if (v == null || !isFinite(v)) { started = false; continue; }
      var px = s.sx(xs[i]), py = s.sy(v);
      if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
    }
  };

  Chart.prototype._drawBand = function (ctx, s, xs, band) {
    ctx.beginPath();
    var i;
    for (i = 0; i < band.hi.length; i++) {
      var px = s.sx(xs[i]), py = s.sy(band.hi[i]);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    for (i = band.lo.length - 1; i >= 0; i--) {
      ctx.lineTo(s.sx(xs[i]), s.sy(band.lo[i]));
    }
    ctx.closePath();
    ctx.fillStyle = withAlpha(band.color, band.alpha == null ? 0.14 : band.alpha);
    ctx.fill();
  };

  Chart.prototype._drawBars = function (ctx, s, bars, surface) {
    var edges = bars.edges, counts = bars.counts;
    for (var i = 0; i < counts.length; i++) {
      if (!counts[i]) continue;
      var xa = s.sx(edges[i]), xb = s.sx(edges[i + 1]);
      var w = Math.max(1, xb - xa - 2);          // 2px gap in the surface colour
      var y = s.sy(counts[i]), base = s.sy(0);
      ctx.fillStyle = bars.colorFn
        ? bars.colorFn((edges[i] + edges[i + 1]) / 2, i)
        : bars.color;
      var hgt = base - y;
      if (hgt < 0.6) hgt = 0.6;
      var r = Math.min(3, w / 2, hgt);           // rounded cap, square at the baseline
      ctx.beginPath();
      ctx.moveTo(xa + 1, base);
      ctx.lineTo(xa + 1, y + r);
      ctx.quadraticCurveTo(xa + 1, y, xa + 1 + r, y);
      ctx.lineTo(xa + 1 + w - r, y);
      ctx.quadraticCurveTo(xa + 1 + w, y, xa + 1 + w, y + r);
      ctx.lineTo(xa + 1 + w, base);
      ctx.closePath();
      ctx.fill();
    }
  };

  /* A horizontal bar from `lo` to `hi` on row `y`. Used for quantile buckets:
   * "in this ten-percent band you finished between X and Y". */
  Chart.prototype._drawRangeBars = function (ctx, s, spec, surface) {
    var items = spec.items;
    var rows = items.length;
    var slot = (s.y0 - s.y1) / rows;
    // Both dimensions need a floor, not just a cap: a chart rendered into a
    // collapsed container (a hidden tab, a very short viewport) has slot ~ 0,
    // which drove the corner radius negative and threw out of roundRect.
    var h = Math.max(1, Math.min(22, slot - 4));

    for (var i = 0; i < rows; i++) {
      var it = items[i];
      var yc = s.y1 + slot * (i + 0.5);
      var xa = s.sx(it.lo), xb = s.sx(it.hi);
      var w = Math.max(3, xb - xa);
      var r = Math.max(0, Math.min(4, h / 2, w / 2));   // rounded ends

      ctx.fillStyle = spec.colorFn ? spec.colorFn(it, i) : spec.color;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(xa, yc - h / 2, w, h, r);
      else ctx.rect(xa, yc - h / 2, w, h);
      ctx.fill();

      // bucket midpoint: a 2px marker ringed in the surface colour
      if (it.mid != null) {
        var xm = s.sx(it.mid);
        ctx.fillStyle = surface;
        ctx.fillRect(xm - 2, yc - h / 2, 4, h);
        ctx.fillStyle = C_TEXT();
        ctx.fillRect(xm - 1, yc - h / 2, 2, h);
      }
    }
  };

  function C_TEXT() { return css('--text-primary'); }

  Chart.prototype._pointer = function (e) {
    var d = this.data;
    if (!d || !d.x || !d.x.length) return;
    var r = this.container.getBoundingClientRect();
    var mx = e.clientX - r.left, my = e.clientY - r.top;
    var s = this._scales();
    var best = 0, bestD = Infinity, i, dd;

    if (d.rangeBars) {
      // the bars stack vertically → the target is a row, not an x position
      var rows = d.rangeBars.items.length;
      var slot = (s.y0 - s.y1) / rows;
      best = Math.floor((my - s.y1) / slot);
      if (best < 0 || best >= rows) { this._onLeave(); return; }
    } else {
      if (mx < s.x0 - 12 || mx > s.x1 + 12) { this._onLeave(); return; }
      // nearest index — the reader aims at a position, not at a 2px line
      for (i = 0; i < d.x.length; i++) {
        dd = Math.abs(s.sx(d.x[i]) - mx);
        if (dd < bestD) { bestD = dd; best = i; }
      }
    }
    if (best !== this.hover) { this.hover = best; this.render(); }
    this._showTip(s, best, my, d.rangeBars ? mx : s.sx(d.x[best]));
  };

  Chart.prototype._showTip = function (s, idx, py, anchorX) {
    var d = this.data, tip = this.tip;
    while (tip.firstChild) tip.removeChild(tip.firstChild);

    var head = document.createElement('div');
    head.className = 'tip-head';
    head.textContent = (d.fmtTipX || d.fmtX || fmtCompact)(d.x[idx]);
    tip.appendChild(head);

    var rows = d.tipRows ? d.tipRows(idx) : (d.lines || []).map(function (L) {
      return { label: L.label || '', value: (d.fmtTipY || d.fmtY || fmtCompact)(L.y[idx]), color: L.color };
    });

    for (var i = 0; i < rows.length; i++) {
      var row = document.createElement('div');
      row.className = 'tip-row';
      if (rows[i].color) {
        var key = document.createElement('span');
        key.className = 'tip-key';
        key.style.background = rows[i].color;
        row.appendChild(key);
      }
      var val = document.createElement('span');
      val.className = 'tip-val';
      val.textContent = rows[i].value;              // untrusted data → textContent
      row.appendChild(val);
      var lab = document.createElement('span');
      lab.className = 'tip-lab';
      lab.textContent = rows[i].label;
      row.appendChild(lab);
      tip.appendChild(row);
    }

    tip.hidden = false;
    var tx = anchorX + 14;
    if (tx + tip.offsetWidth > this.w - 4) tx = anchorX - tip.offsetWidth - 14;
    var ty = Math.min(Math.max(py - tip.offsetHeight / 2, 4), this.h - tip.offsetHeight - 4);
    tip.style.left = Math.max(4, tx) + 'px';
    tip.style.top = ty + 'px';
  };

  global.Charts = {
    mount: function (el, opts) { return new Chart(el, opts); },
    niceTicks: niceTicks,
    logTicks: logTicks,
    fmtCompact: fmtCompact,
    fmtMoney: fmtMoney,
    fmtPct: fmtPct,
    withAlpha: withAlpha,
    css: css,
    invalidateColors: invalidateColors
  };
})(window);
