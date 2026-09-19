import { describe, expect, it } from "vitest";
import { bollinger, ema, macd, maxDrawdown, rsi, sma } from "../src/engine/indicators.js";

describe("indicateurs", () => {
  it("sma calcule la moyenne glissante", () => {
    expect(sma([1, 2, 3, 4, 5], 3).slice(2)).toEqual([2, 3, 4]);
    expect(Number.isNaN(sma([1, 2, 3], 3)[1])).toBe(true);
  });
  it("ema démarre sur la SMA puis lisse", () => {
    const e = ema([1, 2, 3, 4, 5, 6], 3);
    expect(e[2]).toBe(2);
    expect(e[5]).toBeGreaterThan(4);
    expect(e[5]).toBeLessThan(6);
  });
  it("rsi vaut 100 en hausse continue et ~0 en baisse continue", () => {
    const up = Array.from({ length: 30 }, (_, i) => 100 + i);
    const down = Array.from({ length: 30 }, (_, i) => 200 - i);
    expect(rsi(up)[29]).toBe(100);
    expect(rsi(down)[29]).toBeLessThan(1);
  });
  it("macd est positif quand la tendance accélère", () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 * Math.exp(i * 0.01));
    const m = macd(closes);
    expect(m.macd[59]).toBeGreaterThan(0);
  });
  it("bollinger encadre le cours", () => {
    const closes = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i) * 5);
    const b = bollinger(closes);
    expect(b.upper[39]).toBeGreaterThan(closes[39]);
    expect(b.lower[39]).toBeLessThan(closes[39]);
  });
  it("maxDrawdown mesure la pire baisse depuis un sommet", () => {
    expect(maxDrawdown([100, 120, 60, 90])).toBeCloseTo(-0.5);
  });
});
