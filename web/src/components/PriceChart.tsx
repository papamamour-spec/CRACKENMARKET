import { useEffect, useRef, useState } from "react";
import { createChart, type IChartApi, type ISeriesApi, type UTCTimestamp, ColorType, CrosshairMode } from "lightweight-charts";
import { api } from "../lib/api";
import type { Candle, HistoryResponse, Quote, SeriesPoint } from "../lib/types";
import { fmtNum } from "../lib/format";
import { chartColors, useTheme } from "../hooks/useTheme";

type Timeframe = "1m" | "1D" | "1W" | "1M";
/** Période affichée (années) sur les vues quotidienne, hebdomadaire et mensuelle */
type RangeYears = 1 | 3 | 5;
const RANGES: RangeYears[] = [1, 3, 5];
/** Assez de bougies pour couvrir 5 ans de séances (≈ 1 305 jours ouvrés) */
const HISTORY_LIMIT = 1400;
const YEAR_MS = 365.25 * 86_400_000;

const t = (ms: number) => (ms / 1000) as UTCTimestamp;
const toLine = (pts: SeriesPoint[]) => pts.map((p) => ({ time: t(p.time), value: p.value }));

interface Props {
  symbol: string;
  quote?: Quote;
  height?: number;
}

/**
 * Graphique chandeliers style ProRealTime : volumes, MM20/50/200, Bollinger, RSI et MACD en sous-fenêtres.
 * Les cotations temps réel mettent à jour la dernière bougie sans recharger l'historique.
 */
export function PriceChart({ symbol, quote, height = 420 }: Props) {
  const mainRef = useRef<HTMLDivElement>(null);
  const rsiRef = useRef<HTMLDivElement>(null);
  const macdRef = useRef<HTMLDivElement>(null);
  const charts = useRef<{ main: IChartApi; rsi: IChartApi; macd: IChartApi } | null>(null);
  const series = useRef<{ candles: ISeriesApi<"Candlestick">; volume: ISeriesApi<"Histogram">; lines: Record<string, ISeriesApi<"Line">>; rsi: ISeriesApi<"Line">; macd: ISeriesApi<"Line">; macdSig: ISeriesApi<"Line">; macdHist: ISeriesApi<"Histogram"> } | null>(null);
  const lastCandle = useRef<Candle | null>(null);
  const [timeframe, setTimeframe] = useState<Timeframe>("1D");
  const [range, setRange] = useState<RangeYears>(1);
  const candleTimes = useRef<number[]>([]);
  const [overlays, setOverlays] = useState({ sma20: true, sma50: true, sma200: false, boll: false });
  const [legend, setLegend] = useState<string>("");
  const { theme } = useTheme();

  // création des graphiques
  useEffect(() => {
    if (!mainRef.current || !rsiRef.current || !macdRef.current) return;
    const c = chartColors(theme);
    const common = {
      layout: { background: { type: ColorType.Solid, color: c.background }, textColor: c.text },
      grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: c.border },
      timeScale: { borderColor: c.border, timeVisible: true, secondsVisible: false },
      localization: { locale: "fr-FR", priceFormatter: (p: number) => fmtNum(p) },
    };
    const main = createChart(mainRef.current, { ...common, height });
    const rsi = createChart(rsiRef.current, { ...common, height: 120 });
    const macd = createChart(macdRef.current, { ...common, height: 120 });
    const candles = main.addCandlestickSeries({ upColor: c.up, downColor: c.down, borderVisible: false, wickUpColor: c.up, wickDownColor: c.down });
    const volume = main.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "vol" });
    main.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    const mk = (color: string, width: 1 | 2 = 1) => main.addLineSeries({ color, lineWidth: width, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    const lines = { sma20: mk(c.accent), sma50: mk(c.warn), sma200: mk(c.purple, 2), bollUpper: mk(c.neutral), bollLower: mk(c.neutral) };
    const rsiS = rsi.addLineSeries({ color: c.accent, lineWidth: 1, priceLineVisible: false });
    rsiS.createPriceLine({ price: 70, color: c.down, lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: "" });
    rsiS.createPriceLine({ price: 30, color: c.up, lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: "" });
    const macdHist = macd.addHistogramSeries({ priceLineVisible: false });
    const macdS = macd.addLineSeries({ color: c.accent, lineWidth: 1, priceLineVisible: false });
    const macdSig = macd.addLineSeries({ color: c.warn, lineWidth: 1, priceLineVisible: false });
    charts.current = { main, rsi, macd };
    series.current = { candles, volume, lines, rsi: rsiS, macd: macdS, macdSig, macdHist };

    // synchronisation des échelles de temps
    const all = [main, rsi, macd];
    let syncing = false;
    for (const c of all) {
      c.timeScale().subscribeVisibleLogicalRangeChange((range) => {
        if (syncing || !range) return;
        syncing = true;
        for (const o of all) if (o !== c) o.timeScale().setVisibleLogicalRange(range);
        syncing = false;
      });
    }
    main.subscribeCrosshairMove((param) => {
      const d = param.seriesData.get(candles) as { open: number; high: number; low: number; close: number } | undefined;
      if (!d) return setLegend("");
      const v = param.seriesData.get(volume) as { value: number } | undefined;
      setLegend(`O ${fmtNum(d.open)}  H ${fmtNum(d.high)}  L ${fmtNum(d.low)}  C ${fmtNum(d.close)}  Vol ${fmtNum(v?.value ?? 0)}`);
    });
    const ro = new ResizeObserver(() => {
      const w = mainRef.current?.clientWidth ?? 600;
      for (const c of all) c.applyOptions({ width: w });
    });
    ro.observe(mainRef.current);
    return () => {
      ro.disconnect();
      for (const c of all) c.remove();
      charts.current = null;
      series.current = null;
    };
    // Le thème initial est lu ici ; les changements ultérieurs sont appliqués par l'effet dédié ci-dessous.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [height]);

  // application du thème sans recréer les graphiques
  useEffect(() => {
    const ch = charts.current;
    const s = series.current;
    if (!ch || !s) return;
    const c = chartColors(theme);
    for (const chart of [ch.main, ch.rsi, ch.macd]) {
      chart.applyOptions({
        layout: { background: { type: ColorType.Solid, color: c.background }, textColor: c.text },
        grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
        rightPriceScale: { borderColor: c.border },
        timeScale: { borderColor: c.border },
      });
    }
    s.candles.applyOptions({ upColor: c.up, downColor: c.down, wickUpColor: c.up, wickDownColor: c.down });
    s.lines.sma20.applyOptions({ color: c.accent });
    s.lines.sma50.applyOptions({ color: c.warn });
    s.lines.sma200.applyOptions({ color: c.purple });
    s.lines.bollUpper.applyOptions({ color: c.neutral });
    s.lines.bollLower.applyOptions({ color: c.neutral });
    s.rsi.applyOptions({ color: c.accent });
    s.macd.applyOptions({ color: c.accent });
    s.macdSig.applyOptions({ color: c.warn });
  }, [theme]);

  // chargement de l'historique
  useEffect(() => {
    let cancelled = false;
    api<HistoryResponse>(`/market/history/${symbol}?timeframe=${timeframe}&limit=${HISTORY_LIMIT}`).then((h) => {
      if (cancelled || !series.current) return;
      const s = series.current;
      s.candles.setData(h.candles.map((c) => ({ time: t(c.ts), open: c.open, high: c.high, low: c.low, close: c.close })));
      s.volume.setData(h.candles.map((c) => ({ time: t(c.ts), value: c.volume, color: c.close >= c.open ? "rgba(34,197,94,.4)" : "rgba(239,68,68,.4)" })));
      lastCandle.current = h.candles[h.candles.length - 1] ?? null;
      candleTimes.current = h.candles.map((c) => c.ts);
      const ind = h.indicators;
      for (const k of Object.keys(s.lines)) s.lines[k].setData(ind ? toLine(ind[k] ?? []) : []);
      s.rsi.setData(ind ? toLine(ind.rsi) : []);
      s.macd.setData(ind ? toLine(ind.macd) : []);
      s.macdSig.setData(ind ? toLine(ind.macdSignal) : []);
      s.macdHist.setData(ind ? ind.macdHist.map((p) => ({ time: t(p.time), value: p.value, color: p.value >= 0 ? "rgba(34,197,94,.6)" : "rgba(239,68,68,.6)" })) : []);
      applyRange(timeframe, range);
    });
    return () => {
      cancelled = true;
    };
  }, [symbol, timeframe]);

  // période visible : intraday = tout, sinon les N dernières années
  function applyRange(tf: Timeframe, years: RangeYears): void {
    const ts = charts.current?.main.timeScale();
    if (!ts) return;
    const times = candleTimes.current;
    if (tf === "1m" || times.length === 0) {
      ts.fitContent();
      return;
    }
    const since = Date.now() - years * YEAR_MS;
    let from = times.findIndex((t) => t >= since);
    if (from < 0) from = 0;
    ts.setVisibleLogicalRange({ from, to: times.length - 1 });
  }

  useEffect(() => {
    applyRange(timeframe, range);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range]);

  // visibilité des overlays
  useEffect(() => {
    const s = series.current;
    if (!s) return;
    s.lines.sma20.applyOptions({ visible: overlays.sma20 });
    s.lines.sma50.applyOptions({ visible: overlays.sma50 });
    s.lines.sma200.applyOptions({ visible: overlays.sma200 });
    s.lines.bollUpper.applyOptions({ visible: overlays.boll });
    s.lines.bollLower.applyOptions({ visible: overlays.boll });
  }, [overlays]);

  // mise à jour temps réel de la dernière bougie
  useEffect(() => {
    const s = series.current;
    const lc = lastCandle.current;
    if (!s || !quote || !lc) return;
    const bucket = timeframe === "1m" ? Math.floor(quote.ts / 60000) * 60000 : timeframe === "1D" ? Date.UTC(new Date(quote.ts).getUTCFullYear(), new Date(quote.ts).getUTCMonth(), new Date(quote.ts).getUTCDate()) : lc.ts;
    if (bucket === lc.ts) {
      lc.high = Math.max(lc.high, quote.price);
      lc.low = Math.min(lc.low, quote.price);
      lc.close = quote.price;
      if (timeframe === "1D") lc.volume = quote.volume;
    } else if (bucket > lc.ts) {
      lastCandle.current = { ts: bucket, open: quote.price, high: quote.price, low: quote.price, close: quote.price, volume: quote.volume };
    }
    const c = lastCandle.current!;
    s.candles.update({ time: t(c.ts), open: c.open, high: c.high, low: c.low, close: c.close });
    s.volume.update({ time: t(c.ts), value: c.volume, color: c.close >= c.open ? "rgba(34,197,94,.4)" : "rgba(239,68,68,.4)" });
  }, [quote, timeframe]);

  const tfs: Timeframe[] = ["1m", "1D", "1W", "1M"];
  return (
    <div>
      <div className="chart-toolbar">
        <div className="seg">
          {tfs.map((tf) => (
            <button key={tf} className={tf === timeframe ? "active" : ""} onClick={() => setTimeframe(tf)}>
              {tf === "1m" ? "Intraday" : tf === "1D" ? "Jour" : tf === "1W" ? "Semaine" : "Mois"}
            </button>
          ))}
        </div>
        {timeframe !== "1m" && (
          <div className="seg">
            {RANGES.map((y) => (
              <button key={y} className={y === range ? "active" : ""} onClick={() => setRange(y)}>
                {y === 1 ? "1 an" : `${y} ans`}
              </button>
            ))}
          </div>
        )}
        <div className="seg">
          {(["sma20", "sma50", "sma200", "boll"] as const).map((k) => (
            <button key={k} className={overlays[k] ? "active" : ""} onClick={() => setOverlays({ ...overlays, [k]: !overlays[k] })}>
              {k === "boll" ? "Bollinger" : k.toUpperCase().replace("SMA", "MM")}
            </button>
          ))}
        </div>
        <span className="muted" style={{ fontSize: 12 }}>Sous-fenêtres : RSI 14 · MACD 12/26/9</span>
      </div>
      <div className="chart-wrap">
        {legend && <div className="legend mono">{legend}</div>}
        <div ref={mainRef} className="chart-main" style={{ height }} />
        <div ref={rsiRef} className="chart-sub" />
        <div ref={macdRef} className="chart-sub" />
      </div>
    </div>
  );
}
