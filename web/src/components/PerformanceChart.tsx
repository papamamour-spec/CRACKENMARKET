import { useEffect, useRef } from "react";
import { createChart, ColorType, type UTCTimestamp } from "lightweight-charts";
import { chartColors, useTheme } from "../hooks/useTheme";

interface Point {
  time: number;
  portfolioPct: number;
  benchmarkPct: number;
}

/** Courbe portefeuille vs BRVM Composite, en pourcentage depuis le début de la période. */
export function PerformanceChart({ series, height = 300 }: { series: Point[]; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const { theme } = useTheme();
  useEffect(() => {
    if (!ref.current) return;
    const c = chartColors(theme);
    const chart = createChart(ref.current, {
      height,
      layout: { background: { type: ColorType.Solid, color: c.background }, textColor: c.text },
      grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
      localization: { locale: "fr-FR", priceFormatter: (p: number) => `${p.toFixed(1)} %` },
      timeScale: { borderColor: c.border },
      rightPriceScale: { borderColor: c.border },
    });
    const pf = chart.addAreaSeries({ lineColor: c.accent, topColor: c.accent + "4d", bottomColor: c.accent + "00", title: "Portefeuille" });
    const bm = chart.addLineSeries({ color: c.warn, lineWidth: 1, title: "BRVM Composite" });
    // dédoublonner les dates
    const seen = new Set<number>();
    const pts = series.filter((p) => (seen.has(p.time) ? false : (seen.add(p.time), true)));
    pf.setData(pts.map((p) => ({ time: (p.time / 1000) as UTCTimestamp, value: p.portfolioPct })));
    bm.setData(pts.map((p) => ({ time: (p.time / 1000) as UTCTimestamp, value: p.benchmarkPct })));
    chart.timeScale().fitContent();
    const ro = new ResizeObserver(() => chart.applyOptions({ width: ref.current?.clientWidth ?? 600 }));
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      chart.remove();
    };
  }, [series, theme, height]);
  return <div ref={ref} />;
}
