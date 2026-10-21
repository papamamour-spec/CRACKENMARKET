/**
 * Compartiment obligataire de la BRVM.
 *
 * Le référentiel est amorcé depuis un instantané de la cote officielle (tableau « Cours des
 * obligations » du site de la BRVM, colonnes Symbole / Libellé / Cours clôture / Cours veille…),
 * complété ensuite par la collecte automatique sur brvm.org ou par le collage du tableau par un
 * administrateur. Les cours obligataires de la BRVM sont exprimés en pourcentage du nominal.
 *
 * Le libellé officiel donne l'émetteur, le taux et les années d'émission et d'échéance ; les dates
 * exactes de jouissance et le mode d'amortissement ne figurant pas dans la cote, ils sont estimés
 * (`datesEstimated`) tant qu'un administrateur ne les a pas précisés. Nominal unitaire : 10 000 FCFA.
 */
export type IssuerType = "souverain" | "supranational" | "entreprise";
export type Amortization = "in_fine" | "constant" | "annuite";

export interface BondDef {
  code: string;
  name: string;
  issuer: string;
  issuerType: IssuerType;
  country: string;
  couponPct: number; // taux nominal annuel
  issueDate: string; // AAAA-MM-JJ
  maturityDate: string;
  nominal: number; // FCFA
  frequency: 1 | 2 | 4; // paiements par an
  amortization: Amortization;
  graceYears: number; // différé d'amortissement (années)
  taxExempt: boolean; // exonération fiscale (emprunts d'État pour les résidents)
  datesEstimated?: boolean;
}

/** Ligne de la cote officielle (telle que publiée par la BRVM). */
export interface CoteRow {
  code: string;
  label: string;
  closePct: number | null; // cours de clôture en % du nominal (null si 0 / non coté)
  prevPct: number | null;
  volume: number;
  suspended: boolean;
}

/** Émetteurs connus par préfixe de code. */
export const ISSUERS: Record<string, { issuer: string; issuerType: IssuerType; country: string; taxExempt: boolean }> = {
  TPCI: { issuer: "Trésor Public de Côte d'Ivoire", issuerType: "souverain", country: "CI", taxExempt: true },
  EOS: { issuer: "État du Sénégal", issuerType: "souverain", country: "SN", taxExempt: true },
  TPBF: { issuer: "Trésor Public du Burkina Faso", issuerType: "souverain", country: "BF", taxExempt: true },
  TPNE: { issuer: "Trésor Public du Niger", issuerType: "souverain", country: "NE", taxExempt: true },
  TPTG: { issuer: "Trésor Public du Togo", issuerType: "souverain", country: "TG", taxExempt: true },
  TPBJ: { issuer: "Trésor Public du Bénin", issuerType: "souverain", country: "BJ", taxExempt: true },
  TPML: { issuer: "Trésor Public du Mali", issuerType: "souverain", country: "ML", taxExempt: true },
  EOM: { issuer: "État du Mali", issuerType: "souverain", country: "ML", taxExempt: true },
  EOBF: { issuer: "État du Burkina Faso", issuerType: "souverain", country: "BF", taxExempt: true },
  EOCI: { issuer: "État de Côte d'Ivoire", issuerType: "souverain", country: "CI", taxExempt: true },
  SUKCI: { issuer: "État de Côte d'Ivoire (Sukuk)", issuerType: "souverain", country: "CI", taxExempt: true },
  SUKTG: { issuer: "État du Togo (Sukuk)", issuerType: "souverain", country: "TG", taxExempt: true },
  SUKSN: { issuer: "État du Sénégal (Sukuk)", issuerType: "souverain", country: "SN", taxExempt: true },
  SUKML: { issuer: "État du Mali (Sukuk)", issuerType: "souverain", country: "ML", taxExempt: true },
  BOAD: { issuer: "Banque Ouest Africaine de Développement", issuerType: "supranational", country: "TG", taxExempt: false },
  BIDC: { issuer: "BIDC-EBID (Banque d'Investissement et de Développement de la CEDEAO)", issuerType: "supranational", country: "TG", taxExempt: false },
  CRRH: { issuer: "CRRH-UEMOA (Caisse Régionale de Refinancement Hypothécaire)", issuerType: "supranational", country: "TG", taxExempt: false },
  SHAF: { issuer: "Shelter Afrique", issuerType: "supranational", country: "KE", taxExempt: false },
  FSNTS: { issuer: "FCTC Sonatel (titrisation)", issuerType: "entreprise", country: "SN", taxExempt: false },
  SNTS: { issuer: "Sonatel", issuerType: "entreprise", country: "SN", taxExempt: false },
  NRMC: { issuer: "Nourmony Holding", issuerType: "entreprise", country: "CI", taxExempt: false },
  ORGT: { issuer: "Oragroup", issuerType: "entreprise", country: "TG", taxExempt: false },
  PADS: { issuer: "Port Autonome de Dakar", issuerType: "entreprise", country: "SN", taxExempt: false },
  PAA: { issuer: "Port Autonome d'Abidjan", issuerType: "entreprise", country: "CI", taxExempt: false },
  PTRC: { issuer: "Petro Ivoire", issuerType: "entreprise", country: "CI", taxExempt: false },
  SIFCA: { issuer: "SIFCA", issuerType: "entreprise", country: "CI", taxExempt: false },
  SNLC: { issuer: "Senelec", issuerType: "entreprise", country: "SN", taxExempt: false },
  BHS: { issuer: "Banque de l'Habitat du Sénégal", issuerType: "entreprise", country: "SN", taxExempt: false },
  CBI: { issuer: "Coris Bank International", issuerType: "entreprise", country: "BF", taxExempt: false },
  BOAC: { issuer: "Bank of Africa Côte d'Ivoire", issuerType: "entreprise", country: "CI", taxExempt: false },
  NSIA: { issuer: "NSIA Banque", issuerType: "entreprise", country: "CI", taxExempt: false },
  ABJC: { issuer: "Servair Abidjan", issuerType: "entreprise", country: "CI", taxExempt: false },
  CIEC: { issuer: "Compagnie Ivoirienne d'Électricité", issuerType: "entreprise", country: "CI", taxExempt: false },
  SDCC: { issuer: "Société de Distribution d'Eau de Côte d'Ivoire", issuerType: "entreprise", country: "CI", taxExempt: false },
  ETIT: { issuer: "Ecobank Transnational", issuerType: "entreprise", country: "TG", taxExempt: false },
};

const CODE_RE = /^[A-Z]{2,6}\.[OS]\d{1,3}$/;

/**
 * Analyse le tableau de la cote obligataire de la BRVM collé tel quel (colonnes séparées par des
 * tabulations ou plusieurs espaces) : « n° · symbole · libellé · cours clôture · cours veille · … · suspendu ».
 * Les lignes sans symbole obligataire sont ignorées.
 */
export function parseCoteText(text: string): CoteRow[] {
  const out: CoteRow[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const cells = line.split(/\t+|\s{2,}/).map((c) => c.trim()).filter((c) => c !== "");
    const ci = cells.findIndex((c) => CODE_RE.test(c.toUpperCase()));
    if (ci < 0) continue;
    const code = cells[ci].toUpperCase();
    const label = cells[ci + 1] ?? "";
    if (!label || /\d/.test(label) === false) continue;
    const num = (x?: string) => {
      if (x == null) return null;
      const v = Number(x.replace(/\s/g, "").replace(/ /g, "").replace("%", "").replace(",", "."));
      return Number.isFinite(v) ? v : null;
    };
    const close = num(cells[ci + 2]);
    const prev = num(cells[ci + 3]);
    const volume = num(cells[ci + 6]) ?? 0;
    const suspended = cells.some((c) => /^oui$/i.test(c));
    out.push({ code, label, closePct: close && close > 0 ? close : null, prevPct: prev && prev > 0 ? prev : null, volume, suspended });
  }
  return out;
}

/** Déduit émetteur, taux et années d'un libellé officiel (« Etat du Sénégal 6,40% 2025-2028(1) »). */
export function defFromLabel(code: string, label: string): BondDef {
  const prefix = code.split(".")[0];
  const years = label.match(/(\d{4})\s*[-–]\s*(\d{4})/);
  const y1 = years ? Number(years[1]) : new Date().getUTCFullYear();
  const y2 = years ? Number(years[2]) : y1 + 5;
  const before = years ? label.slice(0, years.index) : label;
  const coupon = before.match(/(\d{1,2}[.,]\d{1,2})\s*%?/) ?? before.match(/(\d{1,2})\s*%/);
  const couponPct = coupon ? Number(coupon[1].replace(",", ".")) : 6;
  const known = ISSUERS[prefix];
  const issuerText = before.replace(/(\d{1,2}[.,]?\d{0,2})\s*%?\s*$/, "").trim().replace(/\s+/g, " ");
  const isSukuk = /\.S\d/.test(code) || /sukuk/i.test(label);
  const issuer = known?.issuer ?? (issuerText || prefix);
  const issuerType: IssuerType = known?.issuerType ?? (/etat|état|tr[ée]sor/i.test(issuerText) ? "souverain" : "entreprise");
  return {
    code,
    name: label.replace(/\s+/g, " ").trim(),
    issuer,
    issuerType,
    country: known?.country ?? "CI",
    couponPct,
    issueDate: `${y1}-07-01`,
    maturityDate: `${y2}-12-31`,
    nominal: 10000,
    frequency: 1,
    amortization: isSukuk ? "in_fine" : "in_fine",
    graceYears: 0,
    taxExempt: known?.taxExempt ?? issuerType === "souverain",
    datesEstimated: true,
  };
}

/** Instantané de la cote officielle (site de la BRVM, « Cours des obligations »). */
export const BRVM_COTE_SNAPSHOT_DATE = "2026-10-21";
export const BRVM_COTE_SNAPSHOT = `
1		BIDC.O7	BIDC-EBID 5,90% 2022-2029	100	100	0	0%	0	0	0	Non	12:47:00
2		BIDC.O5	BIDC-EBID 6,40% 2019-2026	0	0	0	0%	0	0	0	Non	12:47:00
3		BIDC.O6	BIDC-EBID 6,50% 2021-2028	107	107	0	0%	0	0	0	Non	12:47:00
4		BIDC.O8	BIDC-EBID 6,50% 2024-2031	100	100	0	0%	0	0	0	Non	12:47:00
5		BIDC.O4	BIDC-EBID 6.10% 2017- 2027	100	100	0	0%	0	0	0	Non	12:47:00
6		CRRH.O5	CRRH-UEMOA 5,85% 2015-2025	0	0	0	0%	0	0	0	Non	12:47:00
7		CRRH.O6	CRRH-UEMOA 5,85% 2016-2026	98	98	0	0%	0	0	0	Non	12:47:00
8		EOS.O18	Etat du Sénégal 6,40% 2025-2028(1)	99	99	0	0%	0	0	0	Non	12:47:00
9		EOS.O19	Etat du Sénégal 6,60% 2025-2030(1)	99	99	0	0%	0	0	0	Non	12:47:00
10		EOS.O20	Etat du Sénégal 6,75% 2025-2032(1)	96	96	0	0%	0	0	0	Non	12:47:00
11		EOS.O21	Etat du Sénégal 6,95% 2025-2035(1)	100	100	0	0%	0	0	0	Non	12:47:00
12		EOS.O8	Etat du Sénégal 5,95% 2022-2034	100	100	0	0%	0	0	0	Non	12:47:00
13		EOS.O9	ETAT DU SENEGAL 6% 2023-2028	95	95	0	0%	0	0	0	Non	12:47:00
14		EOS.O15	Etat du Sénégal 6,25% 2024-2029	100	100	0	0%	0	0	0	Non	12:47:00
15		EOS.O11	ETAT DU SENEGAL 6,35% 2023-2033	100	100	0	0%	0	0	0	Non	12:47:00
16		EOS.O26	ETAT DU SENEGAL 6,40% 2025-2028(2)	98	98	0	0%	0	0	0	Non	12:47:00
17		EOS.O27	ETAT DU SENEGAL 6,60% 2025-2030(2)	94	94	0	0%	0	0	0	Non	12:47:00
18		EOS.O17	Etat du Sénégal 6,65% 2024-2034	92	92	0	0.01%	65	0	92	Non	12:47:00
19		EOS.O28	ETAT DU SENEGAL 6,75% 2025-2032(2)	99	99	0	0%	0	0	0	Non	12:47:00
20		EOS.O7	ETAT DU SENEGAL 6.30% 2015-2025	0	0	0	0%	0	0	0	Non	12:47:00
21		FSNTS.O1	FCTC SONATEL C-1 6,40% 2023 – 2028	100	100	0	0%	0	0	0	Non	12:47:00
22		FSNTS.O2	FCTC SONATEL C-2 6,60% 2023 – 2030	99	99	0	0%	0	0	0	Non	12:47:00
23		NRMC.O1	NOURMONY HOLDING 7,25% 2024-2029	100	100	0	0%	0	0	0	Non	12:47:00
24		ORGT.O2	ORAGROUP SA 7,15% 2021-2028	110	110	0	0%	1	0	110	Non	12:47:00
25		PADS.O3	PAD 6.6% 2020-2027	91	91	0	0%	0	0	0	Non	12:47:00
26		PTRC.O1	PETRO IVOIRE 6,80 % 2022-2029	131	131	0	0%	0	0	0	Non	12:47:00
27		SNTS.O2	SONATEL Sénégal 6.5% 2020-2027	100	100	0	0%	0	0	0	Non	12:47:00
28		SUKTG.S1	SUKUK ETAT DU TOGO 6,50% 2016-2026	0	0	0	0%	0	0	0	Non	12:47:00
29		TPBF.O11	TPBF 6,5 % 2020-2028 B	100	100	0	0%	0	0	0	Non	12:47:00
30		TPBF.O4	TPBF 6.50% 2017-2027	110	110	0	0%	0	0	0	Non	12:47:00
31		TPCI.O39	TPCI 5,75 % 2019-2026	0	0	0	0%	0	0	0	Non	12:47:00
32		TPCI.O33	TPCI 5,75 % 2019-2026 A	0	0	0	0%	0	0	0	Non	12:47:00
33		TPCI.O38	TPCI 5,75 2019-2026 F	99	99	0	0%	0	0	0	Non	12:47:00
34		TPCI.O40	TPCI 5,75 2019-2026 G	100	100	0	0%	0	0	0	Non	12:47:00
35		TPCI.O69	TPCI 5,75% 2022-2037	100	100	0	0%	0	0	0	Non	12:47:00
36		TPCI.O45	TPCI 5,80 % 2020-2027 C	100	100	0	0%	0	0	0	Non	12:47:00
37		TPCI.O47	TPCI 5,80% 2020-2027 D	100	100	0	0%	0	0	0	Non	12:47:00
38		TPCI.O51	TPCI 5,80% 2020-2027 F	100	100	0	0%	0	0	0	Non	12:47:00
39		TPCI.O58	TPCI 5,80% 2021-2028	100	100	0	0%	0	0	0	Non	12:47:00
40		TPCI.O67	TPCI 5,90% 2021-2036	100	100	0	0%	0	0	0	Non	12:47:00
41		TPCI.O22	TPCI 5.90% 2016-2026 A	0	0	0	0%	0	0	0	Non	12:47:00
42		TPCI.O91	TPCI 5.90% 2024-2029	100	100	0	0%	0	0	0	Non	12:47:00
43		TPCI.O28	TPCI 6% 2018-2026 A	0	0	0	0%	0	0	0	Non	12:47:00
44		TPCI.O29	TPCI 6,00% 2018-2026 B	0	0	0	0%	0	0	0	Non	12:47:00
45		TPNE.O2	TPNE 6.50% 2019-2026	0	0	0	0%	0	0	0	Non	12:47:00
`;

/** Codes de l'ancien référentiel fictif (à désactiver : ils ne correspondent pas à la cote officielle). */
export const LEGACY_SEED_CODES = ["TPCI.O28", "TPCI.O30", "TPCI.O33", "TPCI.O31", "EOS.O27", "EOS.O30", "EOS.O32", "TPBF.O29", "TPBF.O31", "EOM.O29", "TPBJ.O30", "TPTG.O28", "TPNE.O29", "BOAD.O30", "BOAD.O33", "BIDC.O29", "SIFCA.O27", "ORGT.O28", "CRRH.O32", "PAA.O28"];

/** Référentiel amorcé depuis l'instantané. */
export const BONDS: BondDef[] = parseCoteText(BRVM_COTE_SNAPSHOT).map((r) => defFromLabel(r.code, r.label));
export const BOND_MAP = new Map(BONDS.map((b) => [b.code, b]));
