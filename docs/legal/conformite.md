# Conformité — obligation, où elle est satisfaite

Ce fichier relie chaque obligation à l'endroit du dépôt ou du site qui la remplit. Il sert de
point de départ à une revue, pas de preuve à lui seul : chaque ligne se vérifie en ouvrant le
fichier ou la route nommée.

Dernière revue : 15 novembre 2026. Revue suivante : 15 novembre 2027.

## Tableau de correspondance

| Obligation | Où elle est satisfaite | Comment le vérifier |
|---|---|---|
| Mentions légales (LCEN, article 6 III) | `apps/web/src/legal/content.ts` (`MENTIONS_LEGALES`), rendu par `apps/web/src/pages/Legal.tsx` sur la route `/mentions-legales` (`apps/web/src/App.tsx`) | Ouvrir `/mentions-legales` : éditeur, SIREN, siège, directeur de la publication et hébergeur y figurent. |
| Information des personnes (RGPD, articles 12 à 14) | `CONFIDENTIALITE` dans `apps/web/src/legal/content.ts`, route `/confidentialite` | Ouvrir `/confidentialite` : finalités, bases légales, catégories, destinataires, durées, droits, cookies et réclamation y figurent. |
| Conditions d'utilisation | `CGU` dans `apps/web/src/legal/content.ts`, route `/cgu` | Ouvrir `/cgu` : règles du jeu, sanctions, disponibilité, droit applicable. |
| Consentement et âge de 15 ans | Case à cocher dans `apps/web/src/pages/Account.tsx`, garde `accept` dans `apps/api/src/routes/auth.ts`, enregistrement par `recordTermsAcceptance` dans `packages/ledger/src/consent.ts` | Un démarrage de connexion sans `accept` répond `400 consent_required`. La version acceptée est `TERMS_VERSION` et l'horodatage est écrit une seule fois par compte. |
| Droit d'accès | `export-fan <handle>` dans `apps/worker/src/cli.ts`, `exportFan` dans `packages/ledger/src/privacy.ts` | Exécuter `export-fan` sur un compte de test : le JSON contient le compte, ses identités et toutes ses entrées. |
| Droit à l'effacement | `erase-fan`, `erase-identity`, `erase-identity-id` dans `apps/worker/src/cli.ts`, `eraseFan` et `eraseIdentity` dans `packages/ledger/src/privacy.ts` | Exécuter `erase-fan` sur un compte de test : profil 404, entrées abandonnées, identités pseudonymisées. |
| Droit de rectification | Rafraîchissement du handle d'identité par `refreshIdentityHandle` dans `packages/ledger/src/identity.ts`, appelé à chaque connexion depuis `apps/api/src/routes/auth.ts` | Renommer un compte de plateforme puis se reconnecter : le handle affiché suit. Le handle Dachi reste figé (voir le runbook). |
| Durées de conservation | Constantes de `packages/ledger/src/privacy.ts` (`INACTIVE_FAN_RETENTION_DAYS`, `NEVER_LINKED_IDENTITY_RETENTION_DAYS`, `PROCESSED_EVENT_RETENTION_DAYS`, `AUDIT_RETENTION_DAYS`) et `purgeBatch` ; exécution par le CronJob `deploy/helm/ashuworld/templates/purge-cronjob.yaml` | Lire les quatre constantes (1 095, 1 095, 30, 1 095) et vérifier que le CronJob appelle `purge` avec `PURGE_CONFIRM`. |
| Sécurité des traitements (RGPD, article 32) | `@fastify/helmet` et `@fastify/rate-limit` enregistrés dans `apps/api/src/server.ts` (`apps/api/src/security/headers.ts`, `apps/api/src/security/rateLimit.ts`), en-têtes nginx dans `docker/nginx/security-headers.conf`, `Cache-Control: no-store` pour les réponses sensibles dans `docker/nginx/default.conf.template`, images non-root et lecture seule dans `deploy/helm/ashuworld/templates/purge-cronjob.yaml` et `deploy/helm/ashuworld/templates/worker.yaml` | `curl -I` sur le site : HSTS, CSP, `X-Content-Type-Options`, `Referrer-Policy` présents. Le chart pose `runAsNonRoot`, `readOnlyRootFilesystem` et `drop: ["ALL"]`. |
| Cookies et traceurs | Section « Cookies et traceurs » de `CONFIDENTIALITE` dans `apps/web/src/legal/content.ts` | Deux cookies strictement nécessaires seulement : `ashuworld_session` (HttpOnly, 30 jours) et `ashu_oauth_state` (10 minutes). Aucun bandeau, aucun traceur. |
| Registre des traitements (RGPD, article 30) | `docs/legal/registre-des-traitements.md` | Le tableau porte les champs de l'article 30 pour l'unique traitement. |
| Notification d'une violation de données (RGPD, articles 33 et 34) | Procédure ci-dessous | Elle tient en cinq étapes et nomme le délai de 72 heures. |
| Revue annuelle de la conformité | Ce fichier | Relire chaque ligne, mettre à jour la date de revue, et vérifier la rotation des journaux applicatifs sur le cluster. |

## Procédure en cas de violation de données

Une violation de données (une fuite, une perte ou un accès non autorisé) se traite en cinq
étapes, dans cet ordre. La notification à la CNIL doit partir dans les 72 heures après la
constatation.

1. **Constater.** Noter ce qui s'est passé, quand, et comment on l'a su. Conserver les journaux
   et captures utiles, sans les recopier dans un fichier versionné.
2. **Contenir.** Couper l'accès qui a fuité : révoquer un secret, retirer une route, arrêter un
   conteneur, fermer une session. Ne rien supprimer avant d'avoir constaté.
3. **Évaluer.** Déterminer les catégories de données touchées, le nombre de personnes, et le
   risque pour elles. Une fuite de handles publics et d'XP n'a pas le même poids qu'une fuite de
   jetons de session ou de la clé `ERASURE_PEPPER`.
4. **Notifier.** Si le risque est avéré, notifier la CNIL dans les 72 heures, depuis le
   téléservice de notification en ligne. Si le risque est élevé pour les personnes, les informer
   directement, en langage clair : ce qui a fuité, ce qu'il faut faire, qui contacter.
5. **Documenter.** Écrire un compte rendu hors du dépôt : dates, faits, mesures, décision de
   notifier ou non et son motif. Le tenir à disposition de la CNIL.

Aucun délai de 72 heures ne se rattrape : une notification tardive se justifie dans le compte
rendu, elle ne s'oublie pas.

## Ce qui n'est pas couvert

- **Pas de DPO désigné.** Il n'y a pas de délégué à la protection des données (la personne
  chargée du sujet dans l'entreprise). Les demandes passent par info@ashudev.com.
- **Pas de certification ni de label CNIL.** Aucune démarche de conformité formelle n'a été
  engagée, et rien sur le site ne le prétend.
- **Pas de vérification d'âge au-delà de la déclaration.** La case cochée à la connexion est la
  seule preuve : aucune date de naissance n'est demandée ni conservée.
- **Aucun sous-traitant.** Rien à encadrer par un contrat de sous-traitance : le service est
  auto-hébergé et l'exploitant est la seule personne qui accède aux données.
- **Aucun transfert hors Union européenne.** Rien à encadrer par des clauses contractuelles
  types ni par des règles d'entreprise contraignantes.
- **Pas d'export pour une identité jamais rattachée.** `export-fan` ne connaît que les comptes ;
  une demande d'accès portant sur un compte de plateforme sans compte Dachi se compose à la
  main, en lecture seule (voir le runbook).
- **Rotation des journaux applicatifs hors du dépôt.** Les 30 jours sont un réglage du pipeline
  de journaux du cluster : le code ne les applique pas, la revue annuelle les vérifie.
