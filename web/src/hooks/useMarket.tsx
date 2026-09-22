import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getToken } from "../lib/api";
import type { IndexSnapshot, MarketStatus, OrderBook, Quote, Signal } from "../lib/types";

export interface Notification {
  id: number;
  kind: "alert" | "order" | "info";
  message: string;
  ts: number;
}

interface MarketCtx {
  quotes: Map<string, Quote>;
  indices: IndexSnapshot[];
  status: MarketStatus | null;
  connected: boolean;
  notifications: Notification[];
  dismiss: (id: number) => void;
  /** Symboles mis à jour lors du dernier tick (pour le flash visuel) */
  lastUpdated: Set<string>;
  /** Carnets d'ordres des valeurs abonnées */
  books: Map<string, OrderBook>;
  /** Derniers signaux Kraken reçus en direct */
  signals: Signal[];
  /** Abonne la connexion au carnet d'ordres de ces valeurs (vide = aucune) */
  subscribe: (symbols: string[]) => void;
}

const Ctx = createContext<MarketCtx | null>(null);
let notifId = 1;

export function MarketProvider({ children }: { children: ReactNode }) {
  const [quotes, setQuotes] = useState<Map<string, Quote>>(new Map());
  const [indices, setIndices] = useState<IndexSnapshot[]>([]);
  const [status, setStatus] = useState<MarketStatus | null>(null);
  const [connected, setConnected] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [lastUpdated, setLastUpdated] = useState<Set<string>>(new Set());
  const [books, setBooks] = useState<Map<string, OrderBook>>(new Map());
  const [signals, setSignals] = useState<Signal[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const subscribed = useRef<string[]>([]);
  const retry = useRef(0);

  useEffect(() => {
    let closed = false;
    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const token = getToken();
      const ws = new WebSocket(`${proto}://${location.host}/ws${token ? `?token=${encodeURIComponent(token)}` : ""}`);
      wsRef.current = ws;
      ws.onopen = () => {
        setConnected(true);
        retry.current = 0;
        if (subscribed.current.length) ws.send(JSON.stringify({ type: "subscribe", symbols: subscribed.current }));
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        switch (msg.type) {
          case "hello":
            setQuotes(new Map((msg.quotes as Quote[]).map((q) => [q.symbol, q])));
            setIndices(msg.indices);
            setStatus(msg.status);
            break;
          case "quotes":
            setQuotes((prev) => {
              const next = new Map(prev);
              for (const q of msg.quotes as Quote[]) next.set(q.symbol, q);
              return next;
            });
            setLastUpdated(new Set((msg.quotes as Quote[]).map((q) => q.symbol)));
            break;
          case "books":
            setBooks((prev) => {
              const next = new Map(prev);
              for (const b of msg.books as OrderBook[]) next.set(b.symbol, b);
              return next;
            });
            break;
          case "signal":
            setSignals((prev) => [msg.signal as Signal, ...prev].slice(0, 50));
            break;
          case "indices":
            setIndices(msg.indices);
            break;
          case "status":
            setStatus(msg.status);
            break;
          case "alert":
            setNotifications((n) => [{ id: notifId++, kind: "alert" as const, message: msg.message, ts: Date.now() }, ...n].slice(0, 20));
            break;
          case "order_filled":
            setNotifications((n) => [
              { id: notifId++, kind: "order" as const, message: `Ordre limite exécuté : ${msg.order.side === "buy" ? "achat" : "vente"} ${msg.order.quantity} ${msg.order.symbol} à ${msg.order.filled_price}`, ts: Date.now() },
              ...n,
            ].slice(0, 20));
            break;
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (closed) return;
        const delay = Math.min(15000, 1000 * 2 ** retry.current++);
        setTimeout(connect, delay);
      };
      ws.onerror = () => ws.close();
    };
    connect();
    return () => {
      closed = true;
      wsRef.current?.close();
    };
  }, []);

  const subscribe = useCallback((symbols: string[]) => {
    subscribed.current = symbols;
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "subscribe", symbols }));
  }, []);

  const value = useMemo<MarketCtx>(
    () => ({ quotes, indices, status, connected, notifications, lastUpdated, books, signals, subscribe, dismiss: (id) => setNotifications((n) => n.filter((x) => x.id !== id)) }),
    [quotes, indices, status, connected, notifications, lastUpdated, books, signals, subscribe],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useMarket(): MarketCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("MarketProvider manquant");
  return c;
}

export function useQuote(symbol: string | undefined): Quote | undefined {
  const { quotes } = useMarket();
  return symbol ? quotes.get(symbol) : undefined;
}

/** Abonne la page au carnet d'ordres d'une valeur et le renvoie. */
export function useOrderBook(symbol: string | undefined): OrderBook | undefined {
  const { books, subscribe } = useMarket();
  useEffect(() => {
    subscribe(symbol ? [symbol] : []);
    return () => subscribe([]);
  }, [symbol, subscribe]);
  return symbol ? books.get(symbol) : undefined;
}
