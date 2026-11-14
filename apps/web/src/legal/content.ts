import { COMPANY } from './company'

/**
 * One block of a legal document: a heading, prose, and optionally a list.
 *
 * The shape is deliberately plain. The page renders it without knowing which document it
 * holds, and a future static export can read the same objects instead of scraping HTML.
 */
export interface LegalSection {
  heading: string
  paragraphs: string[]
  list?: string[]
}

/** A whole legal document, with the metadata the page puts in the document head. */
export interface LegalDocument {
  slug: string
  title: string
  description: string
  version: string
  updated: string
  sections: LegalSection[]
}

/**
 * The version a visitor accepts at sign-in.
 *
 * It is the publication date of this text, not the date of the code. When a paragraph
 * changes meaning, this string changes with it, so an old acceptance is visibly old.
 */
export const TERMS_VERSION = '2026-11-14'

/**
 * The page naming who publishes the site and who answers for it.
 *
 * Every fact comes from `COMPANY`. The host is the publisher: the service runs on the
 * operator's own hardware, so naming a third party here would be untrue.
 */
export const MENTIONS_LEGALES: LegalDocument = {
  slug: 'mentions-legales',
  title: 'Mentions légales',
  description:
    'Éditeur, directeur de la publication, hébergeur et informations légales du site AshuWorld.',
  version: TERMS_VERSION,
  updated: TERMS_VERSION,
  sections: [
    {
      heading: 'Éditeur du site',
      paragraphs: [
        `${COMPANY.name} est une ${COMPANY.legalForm} au capital de ${COMPANY.capital}, immatriculée sous le numéro ${COMPANY.rcs}.`,
        `Siège social : ${COMPANY.address}.`,
        `Contact : ${COMPANY.email}.`,
      ],
      list: [
        `SIREN : ${COMPANY.siren}`,
        `SIRET : ${COMPANY.siret}`,
        `TVA intracommunautaire : ${COMPANY.vat}`,
      ],
    },
    {
      heading: 'Directeur de la publication',
      paragraphs: [
        `${COMPANY.publicationDirector}, représentant légal de ${COMPANY.name}, est le directeur de la publication du site.`,
      ],
    },
    {
      heading: 'Hébergement',
      paragraphs: [
        `Le site est hébergé par ${COMPANY.host}, en France.`,
        'Aucun hébergeur tiers n’intervient. Le siège social indiqué ci-dessus est celui de l’éditeur ; ce n’est pas l’adresse de la machine, dont l’emplacement physique n’est pas publié.',
      ],
    },
    {
      heading: 'Propriété intellectuelle',
      paragraphs: [
        `Le nom AshuWorld, les textes, les éléments graphiques et le code du site appartiennent à ${COMPANY.name}, sauf mention contraire.`,
        'Toute reproduction ou représentation, totale ou partielle, sans autorisation écrite est interdite. Le partage d’un lien vers une page publique reste libre.',
        'L’XP et les niveaux sont des données de jeu : ils ne constituent ni un bien, ni un droit de propriété, ni une valeur monétaire.',
      ],
    },
    {
      heading: 'Responsabilité',
      paragraphs: [
        'Le site est mis à disposition en l’état, dans le cadre d’une version alpha. L’éditeur fait ses meilleurs efforts pour le maintenir disponible et exact, sans garantir une disponibilité continue ni l’absence d’erreur.',
        'Les règles du jeu, les montants d’XP et la table des niveaux peuvent évoluer. Une intervention de maintenance peut rendre le site indisponible temporairement.',
        'L’éditeur n’est responsable que de son propre fait, dans les limites permises par la loi. Les dommages indirects, notamment la perte de chance ou l’atteinte à l’image, ne sont pas indemnisés.',
      ],
    },
    {
      heading: 'Liens externes',
      paragraphs: [
        'Le site renvoie vers des plateformes tierces, chacune pour un usage précis : Twitch et Discord servent à la connexion et à la vérification des actions ; Google sert à la connexion ; YouTube sert, lorsque cette connexion est activée, à vérifier l’abonnement à la chaîne à travers le compte Google.',
        'Ces plateformes ont leurs propres conditions d’utilisation et leur propre politique de confidentialité. L’éditeur ne les contrôle pas et n’est pas responsable de leur contenu ni de leurs pratiques.',
      ],
    },
  ],
}

/**
 * The privacy notice (politique de confidentialité).
 *
 * It describes the processing the code actually performs: an account, its attached
 * platform identities, XP and levels, the public ladder, sessions, and the logs the
 * service writes. It promises no deletion button, no shop and no tracker, because none of
 * those exists.
 */
export const CONFIDENTIALITE: LegalDocument = {
  slug: 'confidentialite',
  title: 'Politique de confidentialité',
  description:
    'Quelles données AshuWorld collecte, pourquoi, pendant combien de temps, et comment exercer tes droits.',
  version: TERMS_VERSION,
  updated: TERMS_VERSION,
  sections: [
    {
      heading: 'Responsable du traitement',
      paragraphs: [
        `${COMPANY.name}, dont le siège social est situé au ${COMPANY.address}, est responsable du traitement des données décrites dans cette page.`,
        `Pour toute question ou pour exercer un droit, écris à ${COMPANY.email}.`,
      ],
    },
    {
      heading: 'Finalités du traitement',
      paragraphs: [
        'Les données servent uniquement à faire fonctionner le service :',
      ],
      list: [
        'gérer ton compte Dachi et les identités de plateforme qui y sont rattachées ;',
        'calculer et afficher ton XP et ton niveau ;',
        'publier le classement public, qui affiche les handles et les comptes de plateforme rattachés ;',
        'sécuriser le service, en prévenant une double attribution d’XP et un rattachement abusif.',
      ],
    },
    {
      heading: 'Bases légales',
      paragraphs: [
        'Le compte, l’XP, le niveau et les sessions reposent sur l’exécution du contrat qui te lie à l’éditeur lorsque tu utilises le service.',
        'Le classement public et la prévention d’une double attribution d’XP reposent sur l’intérêt légitime de l’éditeur à faire vivre le classement et à garantir l’équité du jeu. Tu peux t’y opposer dans les conditions décrites plus bas.',
      ],
    },
    {
      heading: 'Données traitées',
      paragraphs: [
        'Le service conserve les catégories de données suivantes :',
      ],
      list: [
        'ton handle et ton nom affiché ;',
        'les comptes de plateforme rattachés : la plateforme et l’identifiant du compte chez cette plateforme ;',
        'ton XP, ton niveau et les entrées du registre qui les composent (action, montant, date) ;',
        'tes sessions : le jeton de session et sa date d’expiration ;',
        'les journaux applicatifs et le journal d’audit des opérations sensibles.',
      ],
    },
    {
      heading: 'Destinataires',
      paragraphs: [
        `Aucun sous-traitant ne reçoit ces données. Seul l’éditeur, qui les exploite pour les finalités ci-dessus, y a accès.`,
        'Elles ne sont ni vendues, ni louées, ni transmises à des fins publicitaires.',
        'Les plateformes de connexion (Twitch, Google, Discord) sont des responsables de traitement indépendants pour l’authentification : elles appliquent leurs propres politiques de confidentialité, sur lesquelles l’éditeur n’a pas de prise.',
      ],
    },
    {
      heading: 'Hébergement et transferts hors Union européenne',
      paragraphs: [
        'Le service est auto-hébergé sur une infrastructure privée située en France et exploitée par l’éditeur. Aucun sous-traitant d’hébergement n’intervient.',
        'Aucune donnée que l’éditeur détient n’est transférée vers un pays situé hors de l’Union européenne. La connexion à une plateforme tierce se déroule sous la responsabilité de cette plateforme, selon ses propres règles.',
      ],
    },
    {
      heading: 'Durées de conservation',
      paragraphs: [
        'Les données sont conservées le temps nécessaire aux finalités décrites, puis supprimées ou anonymisées :',
      ],
      list: [
        'compte et identités rattachées : trois ans après la dernière connexion ;',
        'entrées du registre d’XP : conservées après l’anonymisation du compte, sous forme pseudonyme, tant que la prévention d’un second paiement de la même action l’exige, et non réidentifiables sans la clé détenue par le serveur ;',
        'événements de plateforme traités : 30 jours ;',
        'journal d’audit : trois ans ;',
        'journaux applicatifs : 30 jours ;',
        'sessions : 30 jours, ou jusqu’à la déconnexion.',
      ],
    },
    {
      heading: 'Tes droits',
      paragraphs: [
        'Tu disposes d’un droit d’accès, de rectification, d’effacement, d’opposition, de portabilité et de limitation du traitement.',
        `Ces droits s’exercent par courriel à ${COMPANY.email}. L’éditeur peut demander une preuve que tu contrôles le compte concerné, puis répond dans un délai d’un mois.`,
        'Aucun de ces droits ne s’exerce par un bouton sur le site : la demande se fait par courriel, et l’éditeur la traite lui-même.',
      ],
    },
    {
      heading: 'Réclamation',
      paragraphs: [
        'Si tu estimes que tes données ne sont pas traitées correctement, tu peux adresser une réclamation à la CNIL, 3 place de Fontenoy, TSA 80715, 75334 Paris Cedex 07, ou depuis le site cnil.fr.',
      ],
    },
    {
      heading: 'Cookies et traceurs',
      paragraphs: [
        'Le site dépose deux cookies, tous deux strictement nécessaires à son fonctionnement.',
        'Aucun traceur publicitaire, analytique ou de réseau social n’est déposé, et aucune donnée n’est transmise à un tiers à cette fin.',
        'Ces deux cookies étant strictement nécessaires, ils ne demandent pas de consentement : c’est pourquoi le site n’affiche pas de bandeau de cookies.',
      ],
      list: [
        'ashuworld_session : le jeton de session qui te garde connecté. Il est HttpOnly et expire au bout de 30 jours.',
        'ashu_oauth_state : il relie une tentative de connexion au navigateur qui l’a lancée, pour empêcher qu’une connexion soit détournée. Il expire au bout de 10 minutes.',
      ],
    },
    {
      heading: 'Sécurité',
      paragraphs: [
        'Le site est servi en HTTPS. Les cookies de session sont HttpOnly, donc illisibles par le JavaScript de la page.',
        'Aucun mot de passe n’est stocké : la connexion passe uniquement par les plateformes (Twitch, Google, Discord).',
        'Les services tournent dans des conteneurs non privilégiés, avec un système de fichiers en lecture seule. L’accès à l’infrastructure et aux données est limité à l’exploitant.',
      ],
    },
    {
      heading: 'Mineurs',
      paragraphs: [
        'Le service est réservé aux personnes âgées de 15 ans ou plus.',
        'Au moment de la connexion, tu déclares avoir 15 ans ou plus et accepter les CGU et la présente politique. Aucune date de naissance n’est demandée ni conservée : seule cette déclaration, avec sa date, est enregistrée.',
      ],
    },
    {
      heading: 'Effacement et anonymisation',
      paragraphs: [
        'Une demande d’effacement est traitée par l’éditeur. Le compte est alors anonymisé : le handle est remplacé par un identifiant aléatoire, le nom affiché devient « Compte supprimé », les sessions sont supprimées, et les identités sont détachées avec leur identifiant de plateforme remplacé par une empreinte calculée avec une clé détenue par le serveur.',
        'Les entrées du registre ne sont pas supprimées : elles sont conservées sous forme pseudonyme, parce que leurs clés d’attribution déjà dépensées empêchent qu’une même action soit payée une seconde fois. C’est la seule donnée conservée après l’effacement, et elle ne permet pas de t’identifier sans la clé du serveur.',
      ],
    },
    {
      heading: 'Consentement et version',
      paragraphs: [
        `L’acceptation des CGU et de cette politique est enregistrée au moment de la connexion, avec la version acceptée et sa date. La version en vigueur est ${TERMS_VERSION}.`,
        'Une nouvelle version est publiée lorsqu’un paragraphe change de sens ; la date de mise à jour en haut de cette page suit.',
      ],
    },
  ],
}

/**
 * The terms of use (conditions générales d’utilisation).
 *
 * The XP section restates the game rules exactly: XP is not a currency, there is no
 * maximum level, a level is never lost, and a detach forfeits XP for good. Those four
 * sentences are product copy and change with the game, not with the code.
 */
export const CGU: LegalDocument = {
  slug: 'cgu',
  title: 'Conditions générales d’utilisation',
  description:
    'Les règles d’utilisation d’AshuWorld : compte, identités rattachées, XP, niveaux et sanctions.',
  version: TERMS_VERSION,
  updated: TERMS_VERSION,
  sections: [
    {
      heading: 'Objet',
      paragraphs: [
        'Les présentes conditions générales d’utilisation régissent l’accès au site AshuWorld, à son classement et au système d’XP et de niveaux.',
        'Utiliser le service vaut acceptation de ces conditions et de la politique de confidentialité, dans leur version en vigueur au moment de la connexion.',
      ],
    },
    {
      heading: 'Accès au service',
      paragraphs: [
        'La consultation du classement et des profils publics est libre et gratuite, sans compte.',
        'La connexion se fait uniquement par une plateforme tierce : Twitch, Google ou Discord. Aucun mot de passe n’est créé ni stocké par AshuWorld.',
        'Le service est fourni dans le cadre d’une version alpha. L’éditeur peut en suspendre l’accès pour maintenance ou pour faire évoluer ses règles.',
      ],
    },
    {
      heading: 'Compte et identités rattachées',
      paragraphs: [
        'Un compte Dachi peut rattacher plusieurs identités de plateforme. Chaque identité appartient à une seule plateforme, et une identité ne peut être rattachée qu’à un seul compte.',
        'Toute identité rattachée est une porte d’entrée : se connecter avec l’une d’elles mène au même compte, avec le même handle, le même XP et le même niveau.',
        'Le compte doit conserver au moins une identité rattachée. La dernière ne peut pas être retirée, sinon le compte ne serait plus accessible.',
        'Tu ne peux pas rattacher une identité qui appartient déjà à un autre compte, même inactif. Un compte ne donne jamais accès aux données d’un autre Dachi.',
      ],
    },
    {
      heading: 'Règles de conduite',
      paragraphs: [
        'Tu t’engages à ne pas fausser le jeu ni le classement. Il est notamment interdit :',
      ],
      list: [
        'de créer plusieurs comptes ou plusieurs identités pour multiplier l’XP ;',
        'de simuler ou de provoquer des événements de plateforme pour obtenir une récompense ;',
        'd’extraire le classement ou les profils de façon automatisée et massive ;',
        'd’usurper l’identité d’un autre Dachi ou d’une autre personne ;',
        'de tenter de contourner les contrôles d’accès, de perturber le service ou de porter atteinte à son fonctionnement.',
      ],
    },
    {
      heading: 'XP et niveaux',
      paragraphs: [
        'L’XP récompense des actions vérifiées par la plateforme qui les héberge. Elle n’est pas une monnaie : elle ne s’achète pas, ne se vend pas, ne s’échange pas et ne donne droit à aucun achat.',
        'Une action à bonus unique n’est payée qu’une seule fois par identité de plateforme. Une action récurrente est créditée chaque mois tant que sa condition est remplie.',
        'Les niveaux n’ont pas de maximum : chaque niveau demande plus d’XP que le précédent. L’XP peut baisser après une sanction ou un changement de règle, mais un niveau n’est jamais perdu.',
        'Le détachement d’une identité est une perte définitive : l’XP gagnée grâce à elle est abandonnée, et rattacher à nouveau la même identité ne la rend pas. Un avertissement le rappelle avant le détachement.',
      ],
    },
    {
      heading: 'Sanctions',
      paragraphs: [
        'En cas de manquement à ces conditions, l’éditeur peut annuler l’XP obtenue irrégulièrement, retirer le compte du classement ou suspendre l’accès au service.',
        'La sanction est proportionnée au manquement et motivée. Elle ne fait pas perdre de niveau acquis : elle porte sur l’XP en cours et sur l’accès.',
        'Un compte qui cesse d’être utilisé est anonymisé après trois ans, dans les conditions décrites dans la politique de confidentialité.',
      ],
    },
    {
      heading: 'Disponibilité',
      paragraphs: [
        'L’éditeur fait ses meilleurs efforts pour garder le service disponible, sans garantie de disponibilité continue ni d’absence d’erreur.',
        'Pendant l’alpha, les données peuvent être remises à zéro sans préavis. Une telle remise à zéro est une opération d’exploitation, pas une sanction.',
        'Le service dépend de plateformes tierces. Une panne ou un changement d’API chez Twitch, Google ou Discord peut empêcher la vérification d’une action ou la connexion.',
      ],
    },
    {
      heading: 'Responsabilité',
      paragraphs: [
        'Tu utilises le service sous ta responsabilité. L’éditeur ne répond pas des dommages indirects ni de la perte de données causée par un usage contraire à ces conditions.',
        'L’éditeur n’est pas responsable du contenu publié sur les plateformes tierces ni de leurs pratiques.',
        'Ces limitations s’appliquent dans les limites permises par la loi et ne privent pas un consommateur des droits que la loi lui accorde.',
      ],
    },
    {
      heading: 'Propriété intellectuelle',
      paragraphs: [
        `Le nom AshuWorld, les textes, les éléments graphiques et le code du site appartiennent à ${COMPANY.name}, sauf mention contraire.`,
        'L’XP et les niveaux ne sont ni un bien ni un droit de propriété : ils restent attachés au compte et ne peuvent pas être cédés.',
      ],
    },
    {
      heading: 'Droit applicable et juridiction',
      paragraphs: [
        'Les présentes conditions sont soumises au droit français.',
        'En cas de litige, une solution amiable est recherchée d’abord. À défaut, les tribunaux compétents sont ceux prévus par la loi ; pour un consommateur, celui de son domicile ou celui du siège de l’éditeur, à son choix.',
      ],
    },
  ],
}
