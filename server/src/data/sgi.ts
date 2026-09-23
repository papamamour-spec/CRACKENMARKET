/**
 * Registre des SGI partenaires (Sociétés de Gestion et d'Intermédiation agréées par l'AMF-UMOA).
 * Seules les SGI sont habilitées à transmettre des ordres à la BRVM : CrackenMarket
 * n'exécute jamais d'ordre réel lui-même, il les achemine vers la SGI choisie par le client.
 *
 * Les barèmes et pièces sont des valeurs de référence UEMOA à confirmer avec chaque partenaire
 * (`feesConfirmed: false` tant que la convention n'est pas signée).
 */
export type SgiChannel = "console" | "webhook";

export interface SgiPartner {
  code: string;
  name: string;
  shortName: string;
  country: string; // code UEMOA
  city: string;
  website: string;
  email: string;
  phone: string;
  /** Canal de transmission des ordres : console SGI intégrée, ou webhook vers le back-office du partenaire */
  channel: SgiChannel;
  /** Commission de courtage (%) et minimum par ordre (FCFA) */
  brokerageFeePct: number;
  minFee: number;
  /** Frais BRVM + DC/BR (%) inclus dans le total facturé au client */
  marketFeePct: number;
  feesConfirmed: boolean;
  /** Pièces demandées pour l'ouverture d'un compte-titres */
  requiredDocuments: string[];
  /** Délai d'ouverture indicatif */
  onboardingDelay: string;
  featured: boolean;
}

export const SGI_PARTNERS: SgiPartner[] = [
  {
    code: "MATHA",
    name: "Matha Capital (Matha Securities)",
    shortName: "Matha Capital",
    country: "SN",
    city: "Dakar",
    website: "https://mathasecurities.com",
    email: "contact@mathasecurities.com",
    phone: "",
    channel: "console",
    brokerageFeePct: 1.0,
    minFee: 5000,
    marketFeePct: 0.25,
    feesConfirmed: false,
    requiredDocuments: [
      "Pièce d'identité en cours de validité (CNI ou passeport)",
      "Justificatif de domicile de moins de 3 mois",
      "Relevé d'identité bancaire (RIB)",
      "Photo d'identité",
      "Formulaire d'ouverture de compte-titres et convention de compte signés",
    ],
    onboardingDelay: "48 à 72 h ouvrées après réception des pièces",
    featured: true,
  },
];

export const SGI_MAP = new Map(SGI_PARTNERS.map((p) => [p.code, p]));
