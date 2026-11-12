/**
 * Lecture du bulletin officiel de la cote de la BRVM (PDF quotidien `boc_AAAAMMJJ_2.pdf`), tel
 * qu'extrait par `pdfToText` (une ligne par ligne du document, cellules séparées par « ; »).
 *
 * Sections lues :
 *  - en-tête : date de séance, indices (BRVM Composite, BRVM 30, BRVM Prestige) et variations ;
 *  - marché des actions : par valeur, cours précédent, ouverture, clôture, variation, volume, valeur,
 *    cours de référence, variation de l'année, dernier dividende net et sa date, rendement net, PER ;
 *    mentions SP (suspendu) et NC (non coté), code secteur sur la ligne suivante ;
 *  - obligations (classiques, GSS, FCTC, sukuk, convertibles) : nominal, précédent, cours du jour,
 *    référence, volume et valeur quand il y a eu échange, coupon couru, périodicité, coupon net,
 *    prochaine échéance, type d'amortissement ;
 *  - opérations en cours, avis et communiqués ;
 *  - carnets (marché des actions, des droits, des obligations) : quantité et cours à l'achat,
 *    cours et quantité à la vente, cours de référence.
 * Les valeurs absentes restent null ; les formats varient d'une ligne à l'autre (montant et date
 * collés, PER manquant, « / » sur la ligne suivante), le lecteur s'appuie donc sur la forme des
 * jetons (nombre, pourcentage, date, mention) plutôt que sur des positions fixes.
 */

export interface BulletinIndex { name: string; level: number; changePct: number | null }

export interface BulletinEquity {
  symbol: string;
  name: string;
  sector: string | null; // code BRVM : TEL, FIN, CD, CB, IND, ENE, SPU…
  compartment: string | null; // PRESTIGE | PRINCIPAL | CROISSANCE
  prev: number | null;
  open: number | null;
  close: number | null;
  changePct: number | null;
  volume: number | null;
  value: number | null;
  ref: number | null;
  ytdPct: number | null;
  lastDividendNet: number | null;
  lastDividendDate: number | null;
  yieldPct: number | null;
  per: number | null;
  suspended: boolean;
  nonQuoted: boolean;
  exDividend: boolean;
}

export interface BulletinBond {
  code: string;
  name: string;
  category: string; // classiques | gss | fctc | sukuk | convertibles
  nominal: number | null;
  prev: number | null;
  close: number | null; // null si NC / SP
  ref: number | null;
  volume: number | null;
  value: number | null;
  accrued: number | null;
  period: string | null; // A, S, T, M
  couponNet: number | null;
  nextCouponDate: number | null;
  amortization: string | null; // ACD, IF, …
  suspended: boolean;
}

export interface BulletinBookLine { symbol: string; name: string; bidQty: number | null; bid: number | null; ask: number | null; askQty: number | null; ref: number | null }

export interface BulletinNotice { section: "operations" | "avis" | "communiques"; issuer: string; number: string | null; nature: string | null; subject: string }

export interface BrvmBulletin {
  sessionTs: number | null;
  issue: string | null;
  indices: BulletinIndex[];
  equities: BulletinEquity[];
  bonds: BulletinBond[];
  equityBook: BulletinBookLine[];
  bondBook: BulletinBookLine[];
  notices: BulletinNotice[];
}

const MONTHS: Record<string, number> = { janv: 0, jan: 0, janvier: 0, fevr: 1, fev: 1, fevrier: 1, mars: 2, mar: 2, avr: 3, avril: 3, mai: 4, juin: 5, juil: 6, juillet: 6, aout: 7, sept: 8, sep: 8, septembre: 8, oct: 9, octobre: 9, nov: 10, novembre: 10, dec: 11, decembre: 11 };
const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/** « 26-mai-26 », « 9-déc.-26 », « 29-sept.-17 » → début de journée UTC. */
export function parseShortDate(tok: string): number | null {
  const m = norm(tok.trim()).match(/^(\d{1,2})-([a-z]+)\.?-(\d{2}|\d{4})$/);
  if (!m || MONTHS[m[2]] == null) return null;
  const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  return Date.UTC(y, MONTHS[m[2]], Number(m[1]));
}

/** « mercredi 11 novembre 2026 » → début de journée UTC. */
export function parseLongDate(text: string): number | null {
  const m = norm(text).match(/(\d{1,2})(?:er)?\s+([a-z]+)\s+(20\d{2})/);
  if (!m || MONTHS[m[2]] == null) return null;
  return Date.UTC(Number(m[3]), MONTHS[m[2]], Number(m[1]));
}

const NUM_RE = /^[+-]?\d{1,3}(?:[ \u00a0]\d{3})*(?:[.,]\d+)?$|^[+-]?\d+(?:[.,]\d+)?$|^[+-]?[.,]\d+$/;
const PCT_RE = /^[+-]?\d+(?:[.,]\d+)?\s*%$/;
const isNum = (t: string) => NUM_RE.test(t.trim());
const isPct = (t: string) => PCT_RE.test(t.trim());
const num = (t: string): number | null => {
  const s = t.replace(/[  %]/g, "").replace(",", ".");
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
};
/** Nombre du carnet : « 9,410 » = 9 410 (virgule de milliers), « 9,213.83 » = 9 213,83, « 59 » = 59. */
const bookNum = (t: string): number | null => {
  const s = t.trim();
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) return Number(s.replace(/,/g, ""));
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  return num(s);
};

function splitCells(line: string): string[] {
  return line.split(/\s*;\s*/).map((c) => c.trim()).filter((c) => c !== "");
}

const SECTOR_RE = /^(TEL|FIN|CD|CB|IND|ENE|SPU|AGR|DIS|TRA|AUT)\b/;
const EQUITY_RE = /^(?!TOTAL$|LIBEL$)[A-Z]{3,5}$/;
/** ligne réduite à une date longue (« mercredi 11 novembre 2026 ») : en-tête de page */
const DATE_ONLY_RE = /^[a-zéû]+\s+\d{1,2}(?:er)?\s+[a-zéû]+\s+20\d{2}$/i;
const BOND_RE = /^[A-Z]{2,7}\.[OS]\d{1,3}$/;

function parseEquityLine(cells: string[]): BulletinEquity | null {
  const [symbol, name, ...rest] = cells;
  if (!EQUITY_RE.test(symbol) || !name || !rest.length) return null;
  const row: BulletinEquity = { symbol, name, sector: null, compartment: null, prev: null, open: null, close: null, changePct: null, volume: null, value: null, ref: null, ytdPct: null, lastDividendNet: null, lastDividendDate: null, yieldPct: null, per: null, suspended: false, nonQuoted: false, exDividend: false };
  const toks = rest.map((t) => t.replace(/\(d\)/g, (m) => { row.exDividend = true; return ""; }).trim()).filter(Boolean);
  const mention = (t: string) => /^(SP|NC)$/.test(t);
  let i = 0;
  if (toks[i] != null && isNum(toks[i])) row.prev = num(toks[i++]);
  if (toks[i] != null && (isNum(toks[i]) || mention(toks[i]))) { if (mention(toks[i])) { if (toks[i] === "SP") row.suspended = true; else row.nonQuoted = true; } else row.open = num(toks[i]); i++; }
  if (toks[i] != null && (isNum(toks[i]) || mention(toks[i]))) { if (mention(toks[i])) { if (toks[i] === "SP") row.suspended = true; else row.nonQuoted = true; } else row.close = num(toks[i]); i++; }
  if (toks[i] != null && isPct(toks[i])) row.changePct = num(toks[i++]);
  // titre négocié : volume ; valeur ; référence ; sinon référence directement
  const tail = toks.slice(i);
  const nums: string[] = [];
  let j = 0;
  while (j < tail.length && isNum(tail[j])) nums.push(tail[j++]);
  if (nums.length >= 3) { row.volume = num(nums[0]); row.value = num(nums[1]); row.ref = num(nums[2]); if (nums.length >= 4) row.per = num(nums[nums.length - 1]); }
  else if (nums.length >= 1) row.ref = num(nums[nums.length - 1]);
  const after = tail.slice(j);
  // variation de l'année (%), dividende net (montant éventuellement collé à la date), date, rendement (%), PER
  let k = 0;
  if (after[k] != null && isPct(after[k])) row.ytdPct = num(after[k++]);
  for (; k < after.length; k++) {
    const t = after[k];
    const glued = t.match(/^(\d[\d  ]*(?:[.,]\d+)?)\s+(\d{1,2}-[a-zéû.]+-\d{2,4})$/i);
    if (glued) { row.lastDividendNet = num(glued[1]); row.lastDividendDate = parseShortDate(glued[2]); continue; }
    const gluedPct = t.match(/^(\d+(?:[.,]\d+)?\s*%)\s+(\d+(?:[.,]\d+)?)$/);
    if (gluedPct) { row.yieldPct = num(gluedPct[1]); row.per = num(gluedPct[2]); continue; }
    const d = parseShortDate(t);
    if (d != null) { row.lastDividendDate = d; continue; }
    if (isPct(t)) { row.yieldPct = num(t); continue; }
    if (isNum(t)) {
      if (row.lastDividendNet == null && row.lastDividendDate == null) row.lastDividendNet = num(t);
      else row.per = num(t);
    }
  }
  if (row.close == null && !row.suspended && !row.nonQuoted && row.ref != null) row.close = row.ref;
  return row;
}

function parseBondLine(cells: string[], category: string): BulletinBond | null {
  const [code, name, ...rest] = cells;
  if (!BOND_RE.test(code) || !name) return null;
  const row: BulletinBond = { code, name, category, nominal: null, prev: null, close: null, ref: null, volume: null, value: null, accrued: null, period: null, couponNet: null, nextCouponDate: null, amortization: null, suspended: false };
  let i = 0;
  const t = rest;
  if (t[i] != null && isNum(t[i])) row.nominal = num(t[i++]);
  if (t[i] != null && isNum(t[i])) row.prev = num(t[i++]);
  if (t[i] != null) { if (/^(NC|SP)$/.test(t[i])) { row.suspended = t[i] === "SP"; i++; } else if (isNum(t[i])) row.close = num(t[i++]); }
  if (t[i] != null && isNum(t[i])) row.ref = num(t[i++]);
  // volume ; valeur (entiers) avant le coupon couru (décimal)
  const dec = (s: string) => /[.,]\d{2}$/.test(s);
  if (t[i] != null && isNum(t[i]) && !dec(t[i]) && t[i + 1] != null && isNum(t[i + 1]) && !dec(t[i + 1])) { row.volume = num(t[i]); row.value = num(t[i + 1]); i += 2; }
  if (t[i] != null && isNum(t[i])) row.accrued = num(t[i++]);
  if (t[i] != null && /^[ASTM]$/.test(t[i])) row.period = t[i++];
  if (t[i] != null && isNum(t[i])) row.couponNet = num(t[i++]);
  if (t[i] != null) { const d = parseShortDate(t[i]); if (d != null) { row.nextCouponDate = d; i++; } }
  if (t[i] != null && /^[A-Z]{1,4}$/.test(t[i])) row.amortization = t[i++];
  return row;
}

function parseBookLine(cells: string[], nextLine: string | undefined, re: RegExp): BulletinBookLine | null {
  const [symbol, name, ...rest] = cells;
  if (!re.test(symbol) || !name) return null;
  const toks = [...rest];
  if (nextLine?.trim() === "/") toks.push("/");
  const slash = toks.indexOf("/");
  const nums = toks.filter((x) => x !== "/");
  const row: BulletinBookLine = { symbol, name, bidQty: null, bid: null, ask: null, askQty: null, ref: null };
  if (!nums.length) return row;
  row.ref = bookNum(nums[nums.length - 1]);
  const mid = nums.slice(0, -1);
  if (mid.length === 4) { row.bidQty = bookNum(mid[0]); row.bid = bookNum(mid[1]); row.ask = bookNum(mid[2]); row.askQty = bookNum(mid[3]); }
  else if (mid.length === 2) {
    // un seul côté : la barre indique s'il est avant (vente) ou après (achat)
    const askSide = slash === 0 || (slash >= 0 && slash < toks.indexOf(mid[0]));
    if (askSide) { row.ask = bookNum(mid[0]); row.askQty = bookNum(mid[1]); } else { row.bidQty = bookNum(mid[0]); row.bid = bookNum(mid[1]); }
  }
  return row;
}

export function parseBrvmBulletin(text: string): BrvmBulletin {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+$/, ""));
  const out: BrvmBulletin = { sessionTs: null, issue: null, indices: [], equities: [], bonds: [], equityBook: [], bondBook: [], notices: [] };
  type Section = "head" | "equities" | "rights" | "bonds" | "operations" | "avis" | "communiques" | "bookEquities" | "bookRights" | "bookBonds" | "other";
  const st: { section: Section } = { section: "head" };
  let bondCategory = "classiques";
  let compartment: string | null = null;
  let pendingNotice: BulletinNotice | null = null;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li].trim();
    if (!line) continue;
    const up = line.toUpperCase();
    // ---- en-tête ----
    if (out.sessionTs == null) {
      const d = parseLongDate(line);
      if (d != null) { out.sessionTs = d; const n = line.match(/N°\s*(\d+)/); if (n) out.issue = n[1]; }
    }
    if (st.section === "head") {
      const cells = splitCells(line);
      for (let c = 0; c + 1 < cells.length; c++) {
        if (/^BRVM (COMPOSITE|30|PRESTIGE)$/i.test(cells[c]) && isNum(cells[c + 1])) {
          out.indices.push({ name: cells[c].replace(/\s+/g, " "), level: num(cells[c + 1])!, changePct: null });
        }
      }
      if (/^Variation Jour/i.test(line) && out.indices.length) {
        const pcts = cells.filter(isPct).map(num);
        out.indices.forEach((ix, k) => { if (ix.changePct == null && pcts[k] != null) ix.changePct = pcts[k]; });
      }
    }
    // ---- changements de st.section ----
    if (/^COMPARTIMENT (PRESTIGE|PRINCIPAL|DE CROISSANCE|CROISSANCE)/i.test(line)) { st.section = "equities"; compartment = up.includes("PRESTIGE") ? "PRESTIGE" : up.includes("PRINCIPAL") ? "PRINCIPAL" : "CROISSANCE"; continue; }
    if (/^TOTAL - MARCHE DES ACTIONS/i.test(line)) { st.section = "other"; continue; }
    if (/^MARCHE DES DROITS/i.test(line)) { st.section = st.section === "other" || st.section === "bookEquities" ? "bookRights" : "rights"; continue; }
    if (/^\d\.\s*OBLIGATIONS CLASSIQUES/i.test(line)) { st.section = "bonds"; bondCategory = "classiques"; continue; }
    if (/^\d\.\s*OBLIGATIONS VERTES/i.test(line)) { st.section = "bonds"; bondCategory = "gss"; continue; }
    if (/^\d\.\s*FONDS COMMUNS DE TITRISATION/i.test(line)) { st.section = "bonds"; bondCategory = "fctc"; continue; }
    if (/^\d\.\s*SUKUK/i.test(line)) { st.section = "bonds"; bondCategory = "sukuk"; continue; }
    if (/^\d\.\s*OBLIGATIONS CONVERTIBLES/i.test(line)) { st.section = "bonds"; bondCategory = "convertibles"; continue; }
    if (/^OPERATIONS EN COURS/i.test(line)) { st.section = "operations"; continue; }
    if (/^AVIS$/i.test(line)) { st.section = "avis"; continue; }
    if (/^COMMUNIQUES$/i.test(line)) { st.section = "communiques"; continue; }
    if (/^MARCHE DES ACTIONS/i.test(line)) { st.section = "bookEquities"; continue; }
    if (/^MARCHE DES OBLIGATIONS/i.test(line)) { st.section = "bookBonds"; continue; }
    const cells = splitCells(line);
    if (st.section === "equities") {
      const eq = parseEquityLine(cells);
      if (eq) {
        eq.compartment = compartment;
        const next = lines[li + 1]?.trim() ?? "";
        const sec = next.match(SECTOR_RE);
        if (sec) eq.sector = sec[1];
        out.equities.push(eq);
      }
    } else if (st.section === "bonds") {
      const b = parseBondLine(cells, bondCategory);
      if (b) out.bonds.push(b);
    } else if (st.section === "operations" || st.section === "avis" || st.section === "communiques") {
      if (/^(Emetteur|Entité)\s*;/i.test(line)) continue;
      if (cells.length >= 2 && !/^\d+$/.test(line) && !DATE_ONLY_RE.test(line)) {
        const notice: BulletinNotice = st.section === "operations" ? { section: st.section, issuer: cells[0], number: null, nature: null, subject: cells.slice(1).join(" ; ") } : { section: st.section, issuer: cells[0], number: cells[1] ?? null, nature: cells[2] ?? null, subject: cells.slice(3).join(" ; ") || cells.slice(1).join(" ; ") };
        out.notices.push(notice);
        pendingNotice = notice;
      } else if (pendingNotice && cells.length === 1 && !/^\d+$/.test(line) && !DATE_ONLY_RE.test(line)) {
        // suite de l'objet sur la ligne suivante
        pendingNotice.subject = `${pendingNotice.subject} ${line}`.trim();
      }
    } else if (st.section === "bookEquities") {
      const row = parseBookLine(cells, lines[li + 1], EQUITY_RE);
      if (row) out.equityBook.push(row);
    } else if (st.section === "bookBonds") {
      const row = parseBookLine(cells, lines[li + 1], BOND_RE);
      if (row) out.bondBook.push(row);
    }
  }
  return out;
}

/** Vrai si le texte ressemble à un bulletin officiel de la BRVM (et non à un tableau collé). */
export function looksLikeBrvmBulletin(text: string): boolean {
  return /BRVM COMPOSITE/i.test(text) && /Symbole\s*;\s*Titre/i.test(text);
}

/** Libellés des codes secteur du bulletin. */
export const BULLETIN_SECTORS: Record<string, string> = { TEL: "Télécommunications", FIN: "Banques", CD: "Distribution", CB: "Industrie", IND: "Industrie", ENE: "Distribution", SPU: "Services publics", AGR: "Agriculture", DIS: "Distribution", TRA: "Transport", AUT: "Services" };
