// ── analysis.js  ── Technical analysis, AI signals, sell engine (v2)

const ANALYSIS = {
  lastData: [],
  lastSymbol: '',
  lastInd: null,
  // ★ 每支股票各自快取分析結果，解決多股票訊號衝突問題
  _cache: {},      // { code: { ind, candles } }

  run(candles, symbol) {
    if (!candles || candles.length < 15) {
      const el = document.getElementById('reasoning-text');
      if (el) el.textContent = '資料點不足，無法進行完整分析（至少需要 15 根 K 線）';
      return;
    }
    // Race condition guard：只有當前 activeSymbol 才更新 UI
    if (symbol && APP.activeSymbol && symbol !== APP.activeSymbol) return;

    this.lastData = candles;
    if (symbol) this.lastSymbol = symbol;

    const ind = this._calcIndicators(candles);
    this.lastInd = ind;
    // ★ 每股快取 ind + candles，切換股票時立刻用
    if (symbol) this._cache[symbol] = { ind, candles };
    this._updateIndicatorCards(ind);
    this._updateSignals(ind, candles);
    this._updatePatterns(ind, candles);
    this._updateSellEngine(ind);
    CHART.drawMACD(candles);
    CHART.drawKD(candles);
    ORDER.calcPortfolio();
    // 分析完成後重新渲染持股清單和訊號總覽，確保訊號一致
    APP.renderStockList();
    APP._renderSignalOverview();
  },

  _calcIndicators(data) {
    const closes = data.map(d => d.c);
    const n = closes.length;
    const last = data[n - 1];
    const prev = data[n - 2] ?? last;

    const rsi = this._rsi(closes, 14);

    const ema12 = this._ema(closes, 12);
    const ema26 = this._ema(closes, 26);
    const macdVal = +(ema12[n-1] - ema26[n-1]).toFixed(3);
    const macdArr = closes.slice(25).map((_, i) => ema12[i+25] - ema26[i+25]);
    const sigArr  = this._ema(macdArr, 9);
    const signal  = sigArr[sigArr.length - 1];
    const hist    = macdArr[macdArr.length - 1] - signal;
    const prevHist = macdArr.length > 2 ? macdArr[macdArr.length-2] - sigArr[sigArr.length-2] : 0;
    const macdGolden = hist > 0 && prevHist <= 0;
    const macdDead   = hist < 0 && prevHist >= 0;

    const { K, D } = this._kd(data, 9);
    const prev_kd = this._kd(data.slice(0, -1), 9);
    const kdGolden = K > D && prev_kd.K <= prev_kd.D;
    const kdDead   = K < D && prev_kd.K >= prev_kd.D;

    const slice20 = closes.slice(-20);
    const mean = slice20.reduce((a, b) => a + b) / 20;
    const std  = Math.sqrt(slice20.reduce((a, b) => a + (b - mean) ** 2, 0) / 20);
    const bbUp  = +(mean + 2 * std).toFixed(2);
    const bbDn  = +(mean - 2 * std).toFixed(2);
    const bbMid = +mean.toFixed(2);
    const bbPos = last.c > bbUp ? 'overbought' : last.c < bbDn ? 'oversold' : 'normal';

    const ma5  = closes.slice(-5).reduce((a,b)=>a+b)/5;
    const ma20v = closes.slice(-20).reduce((a,b)=>a+b)/20;
    const ma60v = n >= 60 ? closes.slice(-60).reduce((a,b)=>a+b)/60 : null;
    const maBull = ma5 > ma20v && (ma60v === null || ma20v > ma60v);

    const avgVol = data.slice(-10, -1).reduce((a, d) => a + d.v, 0) / 9;
    const volRatio = last.v / (avgVol || 1);
    const volSurge = volRatio > 1.5;

    const trend = last.c > ma20v ? 'up' : last.c < ma20v ? 'down' : 'flat';
    const chg = +(last.c - prev.c).toFixed(2);
    const chgPct = +((chg / prev.c) * 100).toFixed(2);

    const recent = data.slice(-20);
    const support = +Math.min(...recent.map(d => d.l)).toFixed(2);
    const resistance = +Math.max(...recent.map(d => d.h)).toFixed(2);

    return {
      rsi, macdVal, macdGolden, macdDead, hist,
      K: +K.toFixed(2), D: +D.toFixed(2), kdGolden, kdDead,
      bbUp, bbDn, bbMid, bbPos, maBull,
      ma5: +ma5.toFixed(2), ma20: +ma20v.toFixed(2), ma60: ma60v ? +ma60v.toFixed(2) : null,
      volRatio: +volRatio.toFixed(2), volSurge, trend,
      last, chg, chgPct, support, resistance,
    };
  },

  _calcScore(ind) {
    let score = 0;
    if (ind.rsi < 30) score += 2;
    else if (ind.rsi < 45) score += 1;
    else if (ind.rsi > 70) score -= 2;
    else if (ind.rsi > 60) score -= 1;
    if (ind.macdGolden) score += 2;
    else if (ind.macdDead) score -= 2;
    else if (ind.hist > 0) score += 1;
    else score -= 1;
    if (ind.kdGolden) score += 1.5;
    else if (ind.kdDead) score -= 1.5;
    if (ind.bbPos === 'oversold') score += 1;
    else if (ind.bbPos === 'overbought') score -= 1;
    if (ind.maBull) score += 1;
    else score -= 1;
    if (ind.volSurge && ind.chg > 0) score += 0.5;
    return Math.max(-5, Math.min(5, score));
  },

  _updateIndicatorCards(ind) {
    const row = document.getElementById('ind-row');
    if (!row) return;
    const items = [
      { name:'RSI(14)', value:ind.rsi.toFixed(1), signal: ind.rsi>70?{label:'超買',cls:'bull'}:ind.rsi<30?{label:'超賣',cls:'bear'}:{label:'中性',cls:'neu'}, color: ind.rsi>70?'var(--red)':ind.rsi<30?'var(--green-l)':'var(--text-1)' },
      { name:'MACD', value:(ind.hist>=0?'+':'')+ind.hist.toFixed(3), signal: ind.macdGolden?{label:'黃金交叉',cls:'bull'}:ind.macdDead?{label:'死亡交叉',cls:'bear'}:{label:'觀察中',cls:'neu'}, color: ind.hist>=0?'var(--red)':'var(--green-l)' },
      { name:'KD(9)', value:`K${ind.K} D${ind.D}`, signal: ind.kdGolden?{label:'K穿D↑',cls:'bull'}:ind.kdDead?{label:'K穿D↓',cls:'bear'}:{label:`K${ind.K>ind.D?'>':'<'}D`,cls:'neu'}, color: ind.K>ind.D?'var(--red)':'var(--green-l)' },
      { name:'布林帶', value:ind.bbPos==='overbought'?'超買區':ind.bbPos==='oversold'?'超賣區':'帶內', signal: ind.bbPos==='oversold'?{label:'近下軌',cls:'bear'}:ind.bbPos==='overbought'?{label:'近上軌',cls:'bull'}:{label:`中軌${ind.bbMid}`,cls:'neu'}, color: ind.bbPos==='overbought'?'var(--red)':ind.bbPos==='oversold'?'var(--green-l)':'var(--text-1)' },
      { name:'均線排列', value:ind.maBull?'多頭':'空頭', signal: ind.maBull?{label:'MA5>MA20',cls:'bull'}:{label:'MA5<MA20',cls:'bear'}, color: ind.maBull?'var(--red)':'var(--green-l)' },
      { name:'量比', value:ind.volRatio.toFixed(2)+'x', signal: ind.volSurge?{label:'放量',cls:'bull'}:{label:'縮量',cls:'neu'}, color: ind.volSurge?'var(--amber)':'var(--text-1)' },
    ];
    row.innerHTML = items.map(it => `
      <div class="ind-card">
        <div class="ind-name">${it.name}</div>
        <div class="ind-value" style="color:${it.color}">${it.value}</div>
        <span class="ind-signal ${it.signal.cls}">${it.signal.label}</span>
      </div>`).join('');
  },

  _updateSignals(ind, data) {
    const score = this._calcScore(ind);
    // VIX 調整
    const vixAdj = (typeof VIX !== 'undefined' ? VIX.score : 0) || 0;
    const adjScore = score + vixAdj * 0.5;
    const pct = Math.round(((adjScore + 5) / 10) * 100);
    const confidence = adjScore >= 3 ? '強烈買進' : adjScore >= 1.5 ? '偏多' : adjScore <= -3 ? '強烈賣出' : adjScore <= -1.5 ? '偏空' : '中性觀望';
    const confClass  = adjScore >= 2 ? 'high' : adjScore <= -2 ? 'low' : 'mid';
    const action = adjScore >= 2 ? '買進' : adjScore >= 1 ? '觀察買' : adjScore <= -2 ? '賣出' : adjScore <= -1 ? '觀察賣' : '持有';

    // 建構詳細原因清單
    const bullReasons = [], bearReasons = [];
    if (ind.rsi < 30) bullReasons.push(`RSI ${ind.rsi} 超賣`);
    else if (ind.rsi < 45) bullReasons.push(`RSI ${ind.rsi} 偏低`);
    else if (ind.rsi > 70) bearReasons.push(`RSI ${ind.rsi} 超買`);
    else if (ind.rsi > 60) bearReasons.push(`RSI ${ind.rsi} 偏高`);
    if (ind.macdGolden) bullReasons.push('MACD 黃金交叉');
    else if (ind.macdDead) bearReasons.push('MACD 死亡交叉');
    else if (ind.hist > 0) bullReasons.push('MACD 柱狀正值');
    else bearReasons.push('MACD 柱狀負值');
    if (ind.kdGolden) bullReasons.push('KD 黃金交叉');
    else if (ind.kdDead) bearReasons.push('KD 死亡交叉');
    if (ind.bbPos === 'oversold') bullReasons.push('布林下軌支撐');
    else if (ind.bbPos === 'overbought') bearReasons.push('布林上軌壓力');
    if (ind.maBull) bullReasons.push(`均線多頭（MA5 ${ind.ma5} > MA20 ${ind.ma20}）`);
    else bearReasons.push(`均線空頭（MA5 ${ind.ma5} < MA20 ${ind.ma20}）`);
    if (ind.volSurge && ind.chg > 0) bullReasons.push(`放量上漲（量比 ${ind.volRatio}x）`);
    else if (ind.volSurge && ind.chg < 0) bearReasons.push(`放量下跌（量比 ${ind.volRatio}x）`);
    // VIX
    if (typeof VIX !== 'undefined' && VIX.label) {
      if (vixAdj > 0) bullReasons.push(`市場恐慌（VIX ${VIX.level}%）逆向機會`);
      else if (vixAdj < 0) bearReasons.push(`市場過熱（VIX ${VIX.level}%）注意回調`);
    }
    // 持股損益
    const stock = APP.getActiveStock();
    if (stock) {
      const gainPct = (ind.last.c - stock.cost) / stock.cost * 100;
      if (gainPct >= 20) bearReasons.push(`已獲利 +${gainPct.toFixed(1)}%，建議部分了結`);
      else if (gainPct <= -6) bearReasons.push(`虧損 ${gainPct.toFixed(1)}%，接近停損`);
      else if (gainPct > 0) bullReasons.push(`持有獲利 +${gainPct.toFixed(1)}%`);
    }

    const reasonHtml = `
      <div class="sig-reasons">
        ${bullReasons.length ? `<div class="sig-reason-group bull">${bullReasons.map(r=>`<span class="sr-tag bull">↑ ${r}</span>`).join('')}</div>` : ''}
        ${bearReasons.length ? `<div class="sig-reason-group bear">${bearReasons.map(r=>`<span class="sr-tag bear">↓ ${r}</span>`).join('')}</div>` : ''}
      </div>`;

    const curPrice = ind.last.c;
    const entryPct = adjScore >= 2 ? 0.99 : adjScore >= 1 ? 0.975 : 0.97;
    const suggestEntry = +(curPrice * entryPct).toFixed(1);
    const tpMulti = adjScore >= 2 ? 1.12 : 1.08;
    const tp = +(curPrice * tpMulti).toFixed(1);
    const sl = +(curPrice * 0.94).toFixed(1);

    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    const setHTML = (id, val) => { const el = document.getElementById(id); if (el) el.innerHTML = val; };

    // 根據動作設顏色：買入=綠色，賣出=紅色，持有=琥珀色
    const actionColors = {
      '買進':    'var(--green-l)',
      '觀察買':  'var(--green-l)',
      '賣出':    'var(--red)',
      '觀察賣':  'var(--red-l)',
      '持有':    'var(--amber)',
    };
    const actionEl = document.getElementById('sig-action');
    if (actionEl) {
      actionEl.textContent = action;
      actionEl.style.color = actionColors[action] || 'var(--amber)';
    }
    setHTML('sig-action-desc', reasonHtml);
    set('sig-entry', `$${suggestEntry}`);
    set('sig-entry-desc', `支撐${ind.support}，進場區間 ${(curPrice*0.96).toFixed(1)}~${(curPrice*1.002).toFixed(1)}`);
    set('sig-tp', `$${tp}`);
    set('sig-tp-desc', `目標+${((tpMulti-1)*100).toFixed(0)}%，壓力${ind.resistance}`);
    set('sig-sl', `$${sl}`);
    set('sig-sl-desc', '嚴格停損 -6%');

    const chip = document.getElementById('conf-chip');
    if (chip) {
      const modeLabel = (typeof APP !== 'undefined' && symbol)
        ? (APP.getStockMode(symbol) === 'short' ? '短線' : '長線')
        : '長線';
      chip.textContent = `${confidence} ${pct}% ｜${modeLabel}`;
      chip.className = `confidence-chip ${confClass}`;
    }
    const bar = document.getElementById('meter-bar');
    if (bar) { bar.style.width = Math.max(0,Math.min(100,pct)) + '%'; bar.style.background = adjScore>=2?'var(--red)':adjScore<=-2?'var(--green-l)':'var(--amber)'; }
    const mv = document.getElementById('meter-value');
    if (mv) mv.textContent = `${pct}% / 100`;

    this._updateInfoGrid(ind);
    ORDER.suggestEntry = suggestEntry;
    ORDER.suggestSL = sl;
    ORDER.suggestTP = tp;
    ORDER.score = adjScore;
  },

  _updateSellEngine(ind) {
    const stock = APP.getActiveStock();
    const currentPrice = ind.last.c;
    const result = SELL.evaluate({ techInd: ind, stock, currentPrice });
    if (result) {
      // 整併到下單建議 tab 的賣出區塊
      renderSellSignals(result);
      // 同時更新下單建議中的整合賣出提示
      const mergedEl = document.getElementById('sig-sell-hint');
      if (mergedEl) {
        if (result.urgency === 'none') {
          mergedEl.style.display = 'none';
        } else {
          const urgLabels = { watch:'◎ 觀察減碼', sell:'▼ 建議出場', urgent:'⚠ 緊急減碼', emergency:'🔴 緊急離場' };
          const urgColors = { watch:'var(--blue)', sell:'var(--amber)', urgent:'var(--red)', emergency:'var(--red)' };
          const topSignal = result.signals[0];
          mergedEl.style.display = 'block';
          mergedEl.innerHTML = `<span style="color:${urgColors[result.urgency]};font-weight:600">${urgLabels[result.urgency]}</span>${topSignal ? `：${topSignal.label} — ${topSignal.desc}` : ''}`;
        }
      }
    }
  },

  _updatePatterns(ind, data) {
    const patterns = [];
    const n = data.length;
    const last = data[n-1];
    const bodySize = Math.abs(last.c - last.o);
    const lowerWick = Math.min(last.o, last.c) - last.l;
    if (lowerWick > bodySize * 2 && last.c > last.o) patterns.push({ label:'錘形反轉', strength:'strong' });
    if (ind.rsi < 40 && ind.bbPos === 'oversold') patterns.push({ label:'雙底型態', strength:'strong' });
    if (ind.macdGolden) patterns.push({ label:'MACD黃金交叉', strength:'strong' });
    if (ind.kdGolden) patterns.push({ label:'KD黃金交叉', strength:'match' });
    if (ind.volSurge && last.c > last.o) patterns.push({ label:'量增價漲', strength:'match' });
    if (ind.maBull) patterns.push({ label:'均線多頭排列', strength:'match' });
    if (ind.bbPos === 'oversold') patterns.push({ label:'布林帶下軌支撐', strength:'match' });
    if (ind.last.c > ind.support * 1.02 && ind.last.c < ind.support * 1.05) patterns.push({ label:'近期支撐反彈', strength:'match' });
    ['波動收斂','籌碼集中','底部放量'].forEach(p => patterns.push({ label:p, strength:'neutral' }));

    const tagsEl = document.getElementById('pattern-tags');
    if (tagsEl) tagsEl.innerHTML = patterns.map(p => `<span class="ptag ${p.strength}">${p.label}</span>`).join('');

    const strongP = patterns.filter(p=>p.strength==='strong').map(p=>p.label);
    const matchP  = patterns.filter(p=>p.strength==='match').map(p=>p.label);
    let reason = '';
    if (strongP.length) reason += `偵測到強訊號：${strongP.join('、')}；`;
    if (matchP.length)  reason += `輔助訊號：${matchP.join('、')}；`;
    reason += `RSI(14) ${ind.rsi.toFixed(1)}，MACD柱狀${ind.hist>=0?'正值（多頭動能）':'負值（空頭動能）'}，`;
    reason += `KD ${ind.K>ind.D?'K在D上方偏多':'K在D下方偏空'}。`;
    reason += `均線${ind.maBull?'多頭排列，趨勢向上':'空頭排列，注意風險'}。`;
    if (ind.volSurge) reason += `成交量為均量${ind.volRatio.toFixed(1)}倍，屬放量行為。`;
    reason += `進場參考支撐$${ind.support}，壓力$${ind.resistance}。`;
    const rt = document.getElementById('reasoning-text');
    if (rt) rt.textContent = reason;
  },

  _updateInfoGrid(ind) {
    const grid = document.getElementById('info-grid');
    if (!grid) return;
    const items = [
      { label:'當前價格', value:ind.last.c.toFixed(2) },
      { label:'今日漲跌', value:(ind.chg>=0?'+':'')+ind.chg+' ('+(ind.chgPct>=0?'+':'')+ind.chgPct+'%)' },
      { label:'今日最高', value:ind.last.h.toFixed(2) },
      { label:'今日最低', value:ind.last.l.toFixed(2) },
      { label:'MA5', value:ind.ma5.toFixed(2) },
      { label:'MA20', value:ind.ma20.toFixed(2) },
      { label:'MA60', value:ind.ma60?ind.ma60.toFixed(2):'—' },
      { label:'RSI(14)', value:ind.rsi.toFixed(1) },
      { label:'KD K值', value:ind.K },
      { label:'KD D值', value:ind.D },
      { label:'布林上軌', value:ind.bbUp },
      { label:'布林下軌', value:ind.bbDn },
      { label:'近20日支撐', value:ind.support },
      { label:'近20日壓力', value:ind.resistance },
      { label:'量比', value:ind.volRatio+'x' },
    ];
    grid.innerHTML = items.map(it => `<div class="info-item"><div class="info-label">${it.label}</div><div class="info-value">${it.value}</div></div>`).join('');
  },

  // ── Math helpers ──
  _ema(arr, period) {
    const k = 2 / (period + 1);
    const res = new Array(arr.length).fill(0);
    let sum = 0;
    for (let i = 0; i < period; i++) sum += arr[i];
    res[period - 1] = sum / period;
    for (let i = period; i < arr.length; i++) res[i] = arr[i] * k + res[i-1] * (1-k);
    return res;
  },

  _rsi(closes, period = 14) {
    if (closes.length < period + 1) return 50;
    let gains = 0, losses = 0;
    for (let i = closes.length - period; i < closes.length; i++) {
      const d = closes[i] - closes[i-1];
      if (d > 0) gains += d; else losses -= d;
    }
    if (losses === 0) return 100;
    const rs = gains / losses;
    return +((100 - 100 / (1 + rs)).toFixed(1));
  },

  _kd(data, period = 9) {
    const n = data.length;
    if (n < period) return { K: 50, D: 50 };
    let K = 50, D = 50;
    for (let i = period - 1; i < n; i++) {
      const slice = data.slice(i - period + 1, i + 1);
      const high = Math.max(...slice.map(x => x.h));
      const low  = Math.min(...slice.map(x => x.l));
      const rsv = high === low ? 50 : (data[i].c - low) / (high - low) * 100;
      K = 2/3 * K + 1/3 * rsv;
      D = 2/3 * D + 1/3 * K;
    }
    return { K, D };
  },
};

// ── SELL module ──────────────────────────────────────────
const SELL = {
  evaluate({ techInd, stock, currentPrice }) {
    if (!techInd || !currentPrice) return null;
    const signals = [];
    let urgency = 'none';

    if (stock) {
      const gainPct = (currentPrice - stock.cost) / stock.cost * 100;
      if (gainPct >= 30) {
        signals.push({ label:`獲利+${gainPct.toFixed(1)}%超高`, desc:'建議至少出清50%倉位，保留獲利', urgency:'sell' });
        urgency = this._esc(urgency, 'sell');
      } else if (gainPct >= 20) {
        signals.push({ label:`已獲利+${gainPct.toFixed(1)}%`, desc:'達20%目標，建議分批了結', urgency:'sell' });
        urgency = this._esc(urgency, 'sell');
      }
      if (gainPct <= -6) {
        signals.push({ label:`虧損${gainPct.toFixed(1)}%`, desc:'已觸及停損線，建議執行停損', urgency:'urgent' });
        urgency = this._esc(urgency, 'urgent');
      }
    }

    if (techInd.rsi > 80) { signals.push({ label:`RSI超買${techInd.rsi}`, desc:'極端超買，回壓風險高', urgency:'sell' }); urgency = this._esc(urgency,'sell'); }
    else if (techInd.rsi > 72) { signals.push({ label:`RSI${techInd.rsi}超買區`, desc:'RSI進入超買，建議輕倉', urgency:'watch' }); urgency = this._esc(urgency,'watch'); }
    if (techInd.macdDead) { signals.push({ label:'MACD死亡交叉', desc:'動能轉弱，建議減碼', urgency:'sell' }); urgency = this._esc(urgency,'sell'); }
    if (techInd.kdDead && techInd.K > 80) { signals.push({ label:`KD高檔死叉K=${techInd.K}`, desc:'高檔死叉，回檔機率高', urgency:'sell' }); urgency = this._esc(urgency,'sell'); }
    if (currentPrice < techInd.ma20 * 0.97 && !techInd.maBull) { signals.push({ label:'跌破MA20且空頭排列', desc:'中線趨勢向下', urgency:'sell' }); urgency = this._esc(urgency,'sell'); }
    if (currentPrice < techInd.support * 0.98) { signals.push({ label:'跌破近期支撐', desc:`跌破支撐$${techInd.support}`, urgency:'urgent' }); urgency = this._esc(urgency,'urgent'); }
    if (techInd.volSurge && techInd.chg < 0) { signals.push({ label:'爆量下跌（主力出貨）', desc:'量增價跌為出貨訊號', urgency:'urgent' }); urgency = this._esc(urgency,'urgent'); }

    const plan = this._buildPlan(urgency, currentPrice, stock, techInd);
    return { signals, urgency, plan };
  },

  _esc(cur, next) {
    const o = ['none','watch','sell','urgent','emergency'];
    return o.indexOf(next) > o.indexOf(cur) ? next : cur;
  },

  _buildPlan(urgency, price, stock, ind) {
    if (urgency === 'none') return null;
    const shares = stock?.shares ?? 1;
    const gainPct = stock ? ((price - stock.cost) / stock.cost * 100) : 0;

    // 智慧顯示：1000股以上才說「張」
    const sharesDisp = n => n >= 1000
      ? `${(n/1000).toFixed(n%1000===0?0:1)}張`
      : `${Math.ceil(n)}股`;

    if (urgency === 'urgent') return {
      title:'緊急減碼計畫', color:'urgent',
      rows:[
        { batch:'今日盤中', action:`先出${sharesDisp(shares*0.5)}（50%）`, desc:`建議賣價$${(price*0.995).toFixed(1)}附近` },
        { batch:'明日開盤', action:`再視情況出${sharesDisp(shares*0.3)}`, desc:'若繼續下跌則全出' },
        { batch:'剩餘部位', action:`${sharesDisp(shares*0.2)}設停損`, desc:`停損線$${ind?.support?.toFixed(1)??'—'}` },
      ],
      note:`已獲利${gainPct>=0?'+':''}${gainPct.toFixed(1)}%，優先保護獲利`,
    };
    if (urgency === 'sell') {
      const firstPct = gainPct >= 20 ? 0.4 : 0.25;
      const firstShares = shares * firstPct;
      return {
        title:'分批獲利了結計畫', color:'sell',
        rows:[
          { batch:'第一批', action:`出${sharesDisp(firstShares)}（${Math.round(firstPct*100)}%）`, desc:'鎖住部分獲利' },
          { batch:'第二批', action:`出${sharesDisp(shares*0.3)}`, desc:`跌破MA20$${ind?.ma20?.toFixed(1)??'—'}執行` },
          { batch:'剩餘部位', action:'持有觀察', desc:`停損$${ind?.support?.toFixed(1)??'—'}` },
        ],
        note:`建議先實現${gainPct>=0?gainPct.toFixed(1)+'%':'部分'}獲利`,
      };
    }
    return {
      title:'觀察減碼提示', color:'watch',
      rows:[{ batch:'密切觀察', action:'不動', desc:`跌破$${(price*0.97).toFixed(1)}開始出` }],
      note:'目前尚未到強賣訊號，保持警戒',
    };
  },
};
