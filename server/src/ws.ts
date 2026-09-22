import type { Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { Services } from "./routes/index.js";
import type { QuoteSnapshot } from "./services/market.js";
import type { OrderBook } from "./services/orderbook.js";
import type { Signal } from "./services/signals.js";

interface ClientState {
  userId: number | null;
  symbols: Set<string>; // vide = toutes les valeurs
}

/**
 * Serveur WebSocket temps réel.
 * Messages client → serveur : { type: "subscribe", symbols: [...] } | { type: "auth", token } | { type: "ping" }
 * Messages serveur → client : quotes | books | indices | status | alert | order_filled | signal | pong
 * Le carnet d'ordres n'est diffusé que pour les valeurs auxquelles le client est abonné.
 */
export function attachWebSocket(server: Server, s: Services): WebSocketServer {
  const wss = new WebSocketServer({ server, path: "/ws" });
  const clients = new Map<WebSocket, ClientState>();

  const send = (ws: WebSocket, msg: unknown) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  wss.on("connection", (ws, req) => {
    const state: ClientState = { userId: null, symbols: new Set() };
    clients.set(ws, state);
    const url = new URL(req.url ?? "/", "http://localhost");
    const token = url.searchParams.get("token");
    if (token) {
      try {
        state.userId = s.auth.verify(token).sub;
      } catch {
        /* jeton invalide : connexion anonyme */
      }
    }
    send(ws, { type: "hello", status: s.market.status(), indices: s.market.indices(), quotes: s.market.allSnapshots() });

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        if (msg.type === "subscribe" && Array.isArray(msg.symbols)) {
          state.symbols = new Set(msg.symbols.map((x: string) => String(x).toUpperCase()));
          const books = [...state.symbols].map((sym) => s.market.orderBook(sym)).filter((b): b is OrderBook => !!b);
          if (books.length) send(ws, { type: "books", books });
        } else if (msg.type === "auth" && typeof msg.token === "string") {
          state.userId = s.auth.verify(msg.token).sub;
          send(ws, { type: "auth_ok", userId: state.userId });
        } else if (msg.type === "ping") {
          send(ws, { type: "pong", ts: Date.now() });
        }
      } catch {
        send(ws, { type: "error", error: "message invalide" });
      }
    });
    ws.on("close", () => clients.delete(ws));
  });

  s.market.on("quotes", (quotes: QuoteSnapshot[]) => {
    for (const [ws, st] of clients) {
      const filtered = st.symbols.size ? quotes.filter((q) => st.symbols.has(q.symbol)) : quotes;
      if (filtered.length) send(ws, { type: "quotes", quotes: filtered });
    }
    // ordres limites & alertes
    const filled = s.portfolios.matchOpenOrders(quotes.map((q) => q.symbol));
    for (const o of filled) {
      for (const [ws, st] of clients) if (st.userId === o.user_id) send(ws, { type: "order_filled", order: o });
    }
    for (const t of s.alerts.evaluate(quotes)) {
      for (const [ws, st] of clients) if (st.userId === t.alert.user_id) send(ws, { type: "alert", alert: t.alert, price: t.price, message: t.message });
    }
  });
  s.market.on("books", (books: OrderBook[]) => {
    for (const [ws, st] of clients) {
      if (!st.symbols.size) continue;
      const mine = books.filter((b) => st.symbols.has(b.symbol));
      if (mine.length) send(ws, { type: "books", books: mine });
    }
  });
  s.signals.on("signal", (signal: Signal) => {
    for (const ws of clients.keys()) send(ws, { type: "signal", signal });
  });
  s.market.on("indices", (indices) => {
    for (const ws of clients.keys()) send(ws, { type: "indices", indices });
  });
  s.market.on("status", (status) => {
    for (const ws of clients.keys()) send(ws, { type: "status", status });
  });

  // keepalive
  setInterval(() => {
    for (const ws of clients.keys()) if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, 25_000);

  return wss;
}
