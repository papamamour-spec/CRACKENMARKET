export const fmtFcfa = (n: number, digits = 0) =>
  new Intl.NumberFormat("fr-FR", { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(n) + " FCFA";
export const fmtNum = (n: number, digits = 0) => new Intl.NumberFormat("fr-FR", { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(n);
export const fmtPct = (n: number, digits = 2) => `${n > 0 ? "+" : ""}${n.toFixed(digits)} %`;
export const fmtTime = (ts: number) => new Date(ts).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
export const fmtDate = (ts: number) => new Date(ts).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" });
export const fmtDateTime = (ts: number) => `${fmtDate(ts)} ${fmtTime(ts)}`;
export const signClass = (n: number) => (n > 0 ? "up" : n < 0 ? "down" : "flat");
export const compact = (n: number) => new Intl.NumberFormat("fr-FR", { notation: "compact", maximumFractionDigits: 1 }).format(n);
