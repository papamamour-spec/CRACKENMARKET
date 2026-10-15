/**
 * Référentiel indicatif des obligations cotées au compartiment obligataire de la BRVM :
 * emprunts d'État des pays de l'UEMOA, émissions supranationales (BOAD) et obligations
 * d'entreprises. Les caractéristiques (coupon, échéance, amortissement) sont celles des
 * émissions publiques ; elles doivent être vérifiées et complétées depuis le bulletin
 * officiel de la cote (un administrateur peut ajouter, modifier ou désactiver une ligne).
 * Nominal unitaire : 10 000 FCFA.
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
}

export const BONDS: BondDef[] = [
  { code: "TPCI.O28", name: "TPCI 6,00 % 2023-2028", issuer: "Trésor Public de Côte d'Ivoire", issuerType: "souverain", country: "CI", couponPct: 6.0, issueDate: "2023-06-15", maturityDate: "2028-06-15", nominal: 10000, frequency: 2, amortization: "constant", graceYears: 2, taxExempt: true },
  { code: "TPCI.O30", name: "TPCI 6,15 % 2023-2030", issuer: "Trésor Public de Côte d'Ivoire", issuerType: "souverain", country: "CI", couponPct: 6.15, issueDate: "2023-06-15", maturityDate: "2030-06-15", nominal: 10000, frequency: 2, amortization: "constant", graceYears: 3, taxExempt: true },
  { code: "TPCI.O33", name: "TPCI 6,30 % 2023-2033", issuer: "Trésor Public de Côte d'Ivoire", issuerType: "souverain", country: "CI", couponPct: 6.3, issueDate: "2023-11-20", maturityDate: "2033-11-20", nominal: 10000, frequency: 2, amortization: "constant", graceYears: 4, taxExempt: true },
  { code: "TPCI.O31", name: "TPCI 6,25 % 2024-2031", issuer: "Trésor Public de Côte d'Ivoire", issuerType: "souverain", country: "CI", couponPct: 6.25, issueDate: "2024-04-10", maturityDate: "2031-04-10", nominal: 10000, frequency: 2, amortization: "constant", graceYears: 3, taxExempt: true },
  { code: "EOS.O27", name: "État du Sénégal 6,15 % 2022-2027", issuer: "État du Sénégal", issuerType: "souverain", country: "SN", couponPct: 6.15, issueDate: "2022-05-30", maturityDate: "2027-05-30", nominal: 10000, frequency: 1, amortization: "constant", graceYears: 2, taxExempt: true },
  { code: "EOS.O30", name: "État du Sénégal 6,30 % 2023-2030", issuer: "État du Sénégal", issuerType: "souverain", country: "SN", couponPct: 6.3, issueDate: "2023-07-20", maturityDate: "2030-07-20", nominal: 10000, frequency: 1, amortization: "constant", graceYears: 3, taxExempt: true },
  { code: "EOS.O32", name: "État du Sénégal 6,40 % 2024-2032", issuer: "État du Sénégal", issuerType: "souverain", country: "SN", couponPct: 6.4, issueDate: "2024-03-15", maturityDate: "2032-03-15", nominal: 10000, frequency: 1, amortization: "constant", graceYears: 3, taxExempt: true },
  { code: "TPBF.O29", name: "TPBF 6,50 % 2022-2029", issuer: "Trésor Public du Burkina Faso", issuerType: "souverain", country: "BF", couponPct: 6.5, issueDate: "2022-09-30", maturityDate: "2029-09-30", nominal: 10000, frequency: 1, amortization: "constant", graceYears: 2, taxExempt: true },
  { code: "TPBF.O31", name: "TPBF 6,60 % 2024-2031", issuer: "Trésor Public du Burkina Faso", issuerType: "souverain", country: "BF", couponPct: 6.6, issueDate: "2024-02-28", maturityDate: "2031-02-28", nominal: 10000, frequency: 1, amortization: "constant", graceYears: 3, taxExempt: true },
  { code: "EOM.O29", name: "État du Mali 6,50 % 2022-2029", issuer: "État du Mali", issuerType: "souverain", country: "ML", couponPct: 6.5, issueDate: "2022-11-15", maturityDate: "2029-11-15", nominal: 10000, frequency: 1, amortization: "constant", graceYears: 2, taxExempt: true },
  { code: "TPBJ.O30", name: "TPBJ 6,50 % 2023-2030", issuer: "Trésor Public du Bénin", issuerType: "souverain", country: "BJ", couponPct: 6.5, issueDate: "2023-03-10", maturityDate: "2030-03-10", nominal: 10000, frequency: 2, amortization: "constant", graceYears: 3, taxExempt: true },
  { code: "TPTG.O28", name: "TPTG 6,40 % 2023-2028", issuer: "Trésor Public du Togo", issuerType: "souverain", country: "TG", couponPct: 6.4, issueDate: "2023-05-05", maturityDate: "2028-05-05", nominal: 10000, frequency: 1, amortization: "constant", graceYears: 2, taxExempt: true },
  { code: "TPNE.O29", name: "TPNE 6,60 % 2023-2029", issuer: "Trésor Public du Niger", issuerType: "souverain", country: "NE", couponPct: 6.6, issueDate: "2023-08-25", maturityDate: "2029-08-25", nominal: 10000, frequency: 1, amortization: "constant", graceYears: 2, taxExempt: true },
  { code: "BOAD.O30", name: "BOAD 5,95 % 2023-2030", issuer: "Banque Ouest Africaine de Développement", issuerType: "supranational", country: "TG", couponPct: 5.95, issueDate: "2023-10-12", maturityDate: "2030-10-12", nominal: 10000, frequency: 1, amortization: "in_fine", graceYears: 0, taxExempt: false },
  { code: "BOAD.O33", name: "BOAD 6,00 % 2024-2033", issuer: "Banque Ouest Africaine de Développement", issuerType: "supranational", country: "TG", couponPct: 6.0, issueDate: "2024-05-20", maturityDate: "2033-05-20", nominal: 10000, frequency: 1, amortization: "in_fine", graceYears: 0, taxExempt: false },
  { code: "BIDC.O29", name: "BIDC-EBID 6,25 % 2022-2029", issuer: "Banque d'Investissement et de Développement de la CEDEAO", issuerType: "supranational", country: "TG", couponPct: 6.25, issueDate: "2022-12-20", maturityDate: "2029-12-20", nominal: 10000, frequency: 1, amortization: "constant", graceYears: 2, taxExempt: false },
  { code: "SIFCA.O27", name: "SIFCA 6,90 % 2022-2027", issuer: "SIFCA", issuerType: "entreprise", country: "CI", couponPct: 6.9, issueDate: "2022-07-01", maturityDate: "2027-07-01", nominal: 10000, frequency: 1, amortization: "constant", graceYears: 1, taxExempt: false },
  { code: "ORGT.O28", name: "Oragroup 6,75 % 2023-2028", issuer: "Oragroup", issuerType: "entreprise", country: "TG", couponPct: 6.75, issueDate: "2023-04-15", maturityDate: "2028-04-15", nominal: 10000, frequency: 1, amortization: "constant", graceYears: 1, taxExempt: false },
  { code: "CRRH.O32", name: "CRRH-UEMOA 6,10 % 2022-2032", issuer: "Caisse Régionale de Refinancement Hypothécaire", issuerType: "supranational", country: "TG", couponPct: 6.1, issueDate: "2022-10-10", maturityDate: "2032-10-10", nominal: 10000, frequency: 1, amortization: "constant", graceYears: 3, taxExempt: false },
  { code: "PAA.O28", name: "Port Autonome d'Abidjan 6,75 % 2021-2028", issuer: "Port Autonome d'Abidjan", issuerType: "entreprise", country: "CI", couponPct: 6.75, issueDate: "2021-12-15", maturityDate: "2028-12-15", nominal: 10000, frequency: 1, amortization: "constant", graceYears: 2, taxExempt: false },
];

export const BOND_MAP = new Map(BONDS.map((b) => [b.code, b]));
