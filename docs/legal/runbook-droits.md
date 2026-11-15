# Runbook — répondre à une demande de droits

Ce fichier décrit ce que fait l'exploitant quand une personne demande à voir, corriger ou faire
effacer ses données. Les demandes arrivent par courriel à info@ashudev.com : le site n'a aucun
bouton de suppression ni d'export, et la politique de confidentialité le dit.

## Les droits et ce que le service permet

| Droit | Ce qu'il couvre | Ce que le code permet aujourd'hui |
|---|---|---|
| Accès | Savoir quelles données sont détenues et en recevoir une copie. | `export-fan <handle>` produit un document JSON : compte, XP, niveau, identités rattachées et toutes les entrées du registre, y compris celles déjà abandonnées. |
| Portabilité | Recevoir ses données dans un format lisible par machine. | Le même export JSON sert de réponse : il est structuré, daté et complet pour le compte. |
| Rectification | Corriger une donnée fausse. | Le handle affiché de chaque identité est rafraîchi depuis la plateforme à la connexion suivante. Le handle du compte Dachi, lui, est figé à la création : aucune route ne le renomme. Si le handle est faux, la réponse le dit, et l'effacement suivi d'une nouvelle connexion est la seule voie existante. |
| Effacement | Faire disparaître la personne. | `erase-fan <handle>` pour un compte ; `erase-identity <provider> <handle>` ou `erase-identity-id <uuid>` pour un compte de plateforme jamais rattaché. |
| Opposition | Refuser un traitement fondé sur l'intérêt légitime. | Le classement public et la prévention de la double attribution reposent sur l'intérêt légitime. Une opposition au classement se satisfait par l'effacement : le profil répond alors 404 et sort du classement. L'opposition à la prévention de la double attribution ne peut pas être satisfaite : c'est la seule donnée qui survit à l'effacement, et elle est nécessaire pour qu'une action déjà payée ne le soit pas deux fois. La réponse explique ce refus et son motif. |
| Limitation | Geler le traitement sans effacer. | Aucun mécanisme de gel n'existe dans le code. La réponse le dit et propose l'effacement, qui arrête tout traitement de la personne sauf l'empreinte pseudonyme décrite ci-dessus. |

## Le délai

Un mois à compter de la réception de la demande, preuve d'identité comprise. Si la demande est
complexe ou si plusieurs demandes arrivent en même temps, le délai peut être prolongé de deux
mois, à condition d'envoyer une réponse motivée avant la fin du premier mois : dire pourquoi, et
donner la nouvelle échéance.

Si la demande est refusée, la réponse est motivée et rappelle la voie de recours : réclamation
à la CNIL (l'autorité française qui contrôle le respect du RGPD), 3 place de Fontenoy, TSA 80715,
75334 Paris Cedex 07, ou depuis cnil.fr.

## Vérifier l'identité

Une preuve suffit, parmi :

- une session ouverte au moment de la demande, quand le canal la montre (demande remise de la
  main à la main, ou canal déjà authentifié) ;
- un défi passé par la plateforme : la personne met un code à usage unique dans son nom affiché
  ou son profil chez la plateforme, puis se reconnecte ; le handle stocké est rafraîchi à cette
  connexion, et l'exploitant vérifie qu'il porte le code ;
- un message envoyé depuis le compte de plateforme lui-même (message privé Twitch, courriel
  depuis le compte Google, message Discord) : l'expéditeur est alors la preuve.

Ne jamais demander de mot de passe, de jeton OAuth ni de code de connexion. Ne jamais demander
la clé `ERASURE_PEPPER` ni aucun secret d'infrastructure.

Cas d'un compte de plateforme jamais rattaché : il n'y a pas de compte Dachi, donc pas de
session possible. La preuve est un message depuis ce compte ou un code dans son profil, envoyé à
info@ashudev.com.

## Les commandes

Toutes vivent dans `apps/worker/src/cli.ts` et prennent la forme
`node dist/worker.js <commande> <arguments>`.

| Commande | Effet | Garde |
|---|---|---|
| `export-fan <handle>` | Affiche en JSON le compte et tout son registre. Sort en erreur si aucun compte actif ne porte ce handle. | Aucune : lecture seule. |
| `erase-fan <handle>` | Anonymise le compte : handle aléatoire `deleted_…`, nom « Compte supprimé », sessions supprimées, identités détachées et pseudonymisées, gains en cours abandonnés. Affiche le nombre d'identités et d'entrées abandonnées. | `ERASURE_PEPPER` obligatoire ; refuse un handle inconnu ou déjà effacé, sans rien écrire. |
| `erase-identity <provider> <handle>` | Anonymise un compte de plateforme jamais rattaché. Refuse un handle ambigu en listant les identifiants concernés. | `ERASURE_PEPPER` obligatoire ; refuse un handle ambigu, un handle inconnu, une identité encore rattachée. |
| `erase-identity-id <uuid>` | La même chose, adressée par l'identifiant que la commande précédente a listé. | `ERASURE_PEPPER` obligatoire ; refuse un identifiant qui n'est pas un UUID, une ligne absente, une identité encore rattachée. |
| `purge [--dry-run]` | Applique les fenêtres de conservation (voir le registre). Sans argument, efface ; avec `--dry-run`, compte sans écrire. | `PURGE_CONFIRM` doit valoir exactement `purge-ashuworld`. |

L'export ne contient pas l'identifiant du compte chez la plateforme (l'identifiant interne que
Twitch, Google ou Discord attribue à ce compte) : il n'y a que la plateforme, le handle affiché et
la date de rattachement, par conception. Si la personne veut cet identifiant, la plateforme
elle-même le lui fournit, sur la page de compte du service concerné.

Quand `erase-identity` répond que plusieurs identités partagent le provider et le handle, elle
imprime la liste des UUID. Choisir celui de la personne (par exemple celui dont la date de
création correspond à la demande) et le passer à `erase-identity-id`. Ne jamais prendre le
premier de la liste au hasard.

## Où les exécuter

Jamais de SQL manuel : une écriture directe serait un troisième écrivain à côté de l'API et du
worker, et le registre perdrait la garantie qu'une action n'est payée qu'une fois. Les commandes
passent par le même code que le service.

Le chemin le plus simple est de partir du CronJob de purge : il porte déjà `DATABASE_URL`,
`ERASURE_PEPPER`, `PURGE_CONFIRM` et la bonne image worker. Mais ce CronJob est optionnel dans le
chart (`purge.enabled`, faux par défaut) : la première étape est de vérifier qu'il existe.

```bash
# 1. Le CronJob de purge existe-t-il ? Noter son nom exact et l'espace de noms.
helm get values <release> -n <namespace> | grep purge
kubectl get cronjob -n <namespace>
```

Si aucun CronJob de purge n'apparaît, deux voies :

- l'activer le temps de l'opération :
  `helm upgrade <release> <chart> -n <namespace> --reuse-values --set purge.enabled=true`.
  **Relancer ensuite l'étape 1** (`kubectl get cronjob -n <namespace>`) : le nom du CronJob n'est
  pas connu avant sa création, c'est ce second relevé qui le donne. Exécuter, puis remettre
  `purge.enabled` à `false`. C'est un changement de déploiement : il se consigne, et il ne se fait
  qu'avec l'accord de l'exploitant ;
- créer un Job autonome, décrit ci-dessous. C'est la voie qui ne touche pas au déploiement.

### Le Job autonome

Il porte trois variables, chacune lue dans un Secret existant.

| Variable | Secret | Clé |
|---|---|---|
| `DATABASE_URL` | celui que nomme `postgres.secretName` | `postgres.urlKey` |
| `ERASURE_PEPPER` | celui que nomme `erasure.pepperSecretName` | `erasure.pepperKey` |
| `PURGE_CONFIRM` | le Secret du CronJob créé par le chart, ou `droits-purge-confirm` | `purge.secretKey`, ou `confirm` |

Les deux premiers noms se lisent dans `helm get values <release> -n <namespace>`. Le troisième
n'est pas déductible : `purge.secretName` est vide par défaut et le nom que le chart calcule
n'existe que si le CronJob est activé. Lire les Secrets présents dans le cluster :

```bash
kubectl -n <namespace> get secret
```

Deux cas seulement, tous deux exécutables : le Secret créé par le chart est dans cette liste, on
prend son nom et la clé `purge.secretKey` ; s'il n'y est pas, on crée le nôtre avec la clé
`confirm` :

```bash
kubectl -n <namespace> create secret generic droits-purge-confirm \
  --from-literal=confirm=purge-ashuworld
```

`PURGE_CONFIRM` n'est pas une authentification : c'est une chaîne fixe, `purge-ashuworld`, qui
arme la suppression. Le Secret qui la porte existe pour qu'une faute de frappe ne puisse pas
lancer une purge, rien de plus.

Puis appliquer ce Job. L'image est celle du worker (`worker.image.repository`, avec
`worker.image.tag`, ou `image.tag` du chart quand le tag du worker est vide). Le `securityContext`
est celui du CronJob du chart : un espace de noms qui applique le profil restreint de Pod Security
refuse un Job qui l'omet. Si l'image est privée, ajouter aussi les `imagePullSecrets` du chart
(`imagePullSecrets` dans les valeurs).

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: droits-purge-manuel
spec:
  backoffLimit: 0
  template:
    spec:
      restartPolicy: Never
      # imagePullSecrets: [{ name: <imagePullSecrets du chart> }]   # seulement si l'image est privée
      securityContext:
        runAsNonRoot: true
        runAsUser: 10001
        runAsGroup: 10001
        seccompProfile: { type: RuntimeDefault }
      containers:
        - name: purge
          image: <worker.image.repository>:<worker.image.tag ou image.tag>
          command: ["node", "dist/worker.js", "purge", "--dry-run"]
          securityContext:
            runAsNonRoot: true
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: { drop: ["ALL"] }
          env:
            - name: DATABASE_URL
              valueFrom: { secretKeyRef: { name: <postgres.secretName>, key: <postgres.urlKey> } }
            - name: ERASURE_PEPPER
              valueFrom: { secretKeyRef: { name: <erasure.pepperSecretName>, key: <erasure.pepperKey> } }
            - name: PURGE_CONFIRM
              valueFrom: { secretKeyRef: { name: <Secret de PURGE_CONFIRM>, key: <confirm ou purge.secretKey> } }
```

Le modèle de pod d'un Job est immuable : on ne retire pas `--dry-run` sur un Job déjà créé, on le
supprime et on en crée un autre. Chaque exécution est donc un Job neuf, sous le même nom.

```bash
# A. Répétition à blanc : lire les compteurs, ne rien supprimer.
kubectl apply -n <namespace> -f droits-purge.yaml
kubectl logs -f job/droits-purge-manuel -n <namespace>
kubectl -n <namespace> delete job droits-purge-manuel

# B. Exécution réelle : retirer --dry-run du manifeste, puis recréer le Job.
kubectl apply -n <namespace> -f droits-purge.yaml
kubectl logs -f job/droits-purge-manuel -n <namespace>
kubectl -n <namespace> delete job droits-purge-manuel
```

Pour une demande de droits, remplacer la commande par `export-fan`, `erase-fan`,
`erase-identity` ou `erase-identity-id`.

Quand un CronJob existe, à l'origine ou après activation, avec le nom relevé :

```bash
# 2. Un Job ponctuel dérivé du CronJob, commande remplacée, appliqué sans passer par un fichier.
# Le nom est celui de `ashuworld.fullname` suivi de -purge : <release> seul quand le nom de
# release contient déjà « ashuworld », sinon <release>-ashuworld. Ne pas le deviner : recopier
# celui que l'étape 1 a affiché.
CRONJOB='nom-releve-etape-1'
kubectl create job --from=cronjob/$CRONJOB droits-2026-11-15 \
  --dry-run=client -o yaml \
  | kubectl patch --local -f - --type=json \
      -p '[{"op":"replace","path":"/spec/template/spec/containers/0/command","value":["node","dist/worker.js","export-fan","<handle>"]}]' \
      -o yaml \
  | kubectl apply -n <namespace> -f -

# 3. La sortie, puis le nettoyage.
kubectl logs -f job/droits-2026-11-15 -n <namespace>
kubectl delete job droits-2026-11-15 -n <namespace>
```

Remplacer la valeur de `command` par la commande voulue, par exemple
`["node","dist/worker.js","erase-fan","<handle>"]` ou
`["node","dist/worker.js","purge","--dry-run"]`. Pour une purge réelle, aucun remplacement n'est
nécessaire : `kubectl create job --from=cronjob/$CRONJOB purge-manuel -n <namespace>` suffit.
Lancer toujours `purge --dry-run` avant une purge réelle et lire les compteurs.

Ne jamais écrire un secret en clair dans une ligne de commande : il resterait dans l'historique du
shell et dans `kubectl describe`. Les trois variables se lisent par `secretKeyRef`.

Le code de sortie est 0 en cas de succès et non nul en cas de refus. Un refus n'a rien écrit :
l'exploitant peut corriger l'argument et relancer.

## Vérifier après l'effacement

- Le profil public répond 404 : `curl -s -o /dev/null -w '%{http_code}\n' https://<hôte>/api/public/fans/<handle>`.
- Le classement ne liste plus le compte : chercher le handle dans
  `curl -s https://<hôte>/api/public/ladder`. Une identité jamais rattachée disparaît du
  classement des comptes libres dès qu'elle n'a plus de gain vivant.
- `export-fan <handle>` ne trouve plus de compte actif.
- Si la personne se reconnecte avec la même identité de plateforme, elle repart d'un compte neuf
  à 0 XP, sans bonus de bienvenue : la clé d'attribution déjà dépensée et les gains abandonnés
  empêchent un second paiement.
- Les compteurs affichés par `erase-fan` (identités, entrées abandonnées) sont notés dans le
  compte rendu de la demande.

## Ce qu'on consigne, et ce qu'on ne consigne jamais

À consigner, dans un fichier tenu par l'exploitant hors du dépôt (il contient des données
personnelles) :

- la date de réception et la date de réponse ;
- le droit exercé (accès, rectification, effacement, opposition, portabilité, limitation) ;
- la preuve d'identité retenue, en une ligne, sans la recopier ;
- les commandes exécutées, avec leurs arguments génériques et leur code de sortie ;
- le résultat : compteurs, 404 constaté, suite donnée ou motif du refus.

À ne jamais consigner, ni dans ce fichier, ni dans un ticket, ni dans un journal :

- les identifiants de session ;
- les identifiants externes des plateformes (l'identifiant du compte chez Twitch, Google ou
  Discord) ;
- le handle effacé ;
- les secrets (`ERASURE_PEPPER`, `PURGE_CONFIRM`, `DATABASE_URL`).

Le journal d'audit du service ne porte que des compteurs, sans identité de personne : il ne
remplace pas ce compte rendu, il le complète.
