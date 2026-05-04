// ── analysis.js v3 ── 長線投資邏輯
const ANALYSIS = {
  _calcScore(ind) {
    let score = 0;
    // 修改 6: 重新定義長線邏輯
    // 對你而言，長線是抱到老，創高不賣。
    const isLongTerm = true; 

    if (isLongTerm) {
      // 價格創歷史新高或接近阻力位：在長線邏輯中代表趨勢強勁，不應視為超買賣出
      if (ind.last.c >= ind.resistance * 0.98) {
        score += 2; // 強勢加分
      }
      // 除非發生「重大事件」：例如跌破 60 日均線(季線)或 240 日均線(年線)
      if (ind.ma60 && ind.last.c < ind.ma60) {
        score -= 4; // 只有這時候才建議考慮減碼
      }
    } else {
      // 只有短線模式才會因為 RSI 過高而扣分
      if (ind.rsi > 75) score -= 2;
    }
    return score;
  }
};
