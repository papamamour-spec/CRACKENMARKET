# Routage d'ordres réels vers les SGI partenaires

CrackenMarket n'est pas un intermédiaire agréé : seules les Sociétés de Gestion et
d'Intermédiation (SGI) agréées par l'AMF-UMOA négocient sur la BRVM et conservent les titres.
La plateforme **achemine** les ordres réels de ses membres vers la SGI de leur choix et
**suit** leur exécution. Premier partenaire : **Matha Capital** (Matha Securities, Dakar).

## Parcours client

1. Page « Ordres réels (SGI) » : le membre choisit la SGI, consulte les pièces à fournir et le
   barème, puis envoie une demande d'ouverture de compte-titres (ou déclare un compte existant).
2. La SGI valide la demande dans sa console et saisit le numéro de compte-titres. Le membre est
   notifié en temps réel (WebSocket `sgi_account`).
3. Sur toute fiche valeur, le ticket d'ordre propose le mode « Réel via Matha Capital » :
   ordre au marché ou à cours limité, validité jour / semaine / jusqu'à annulation, frais estimés
   selon le barème de la SGI.
4. L'ordre est transmis ; chaque changement de statut (transmis, pris en charge, exécuté,
   partiel, rejeté, annulé) est notifié en direct (`sgi_order`) et journalisé.

## Côté SGI

- Les collaborateurs de la SGI ont le rôle `sgi` et sont rattachés à leur établissement par
  l'administrateur : `POST /api/sgi/staff { email, sgiCode }` (ou en base : `users.sgi_code`).
- La **console SGI** (`/sgi/console`) présente les ordres à traiter (prise en charge, exécution
  totale ou partielle avec quantité / prix / référence back-office, rejet) et les demandes de
  compte à valider.
- Alternative sans console : **connecteur webhook**. Définir `SGI_MATHA_WEBHOOK_URL` et
  `SGI_MATHA_WEBHOOK_SECRET` ; chaque nouvel ordre est poussé en JSON signé (`x-crackenmarket-signature`,
  HMAC-SHA256 du corps) et le back-office renvoie les statuts sur
  `POST /api/sgi/webhook/MATHA` avec la même signature :

  ```json
  { "orderId": 42, "status": "executed", "executedQty": 10, "executedPrice": 21480, "reference": "MATHA-77" }
  ```

## Ajouter une SGI

Compléter `server/src/data/sgi.ts` (code, coordonnées, barème, pièces). Le barème reste marqué
`feesConfirmed: false` tant que la convention n'est pas signée ; l'interface l'indique au client.

## Cadre à sécuriser avec le partenaire

- Convention de partenariat / apport d'affaires entre CrackenMarket et la SGI.
- Mandat du client autorisant la transmission de ses ordres et de ses coordonnées.
- Vérification d'identité (KYC) : réalisée par la SGI sur les pièces originales ; la plateforme
  ne stocke que les références déclarées.
- Horodatage et conservation des ordres (journal `sgi_order_events`) pour la piste d'audit.
