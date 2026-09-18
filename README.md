# SharePoint Stream Downloader (Chrome / Arc)

Télécharge **la vidéo (MP4)** et **le transcript (VTT / SRT / texte)** des enregistrements
**SharePoint / Teams Stream** que vous êtes autorisé à **visionner**, directement depuis la page —
même quand le bouton « Télécharger » est désactivé.

L'extension reconstruit l'URL du manifeste vidéo à partir des métadonnées de la page
(`g_fileInfo`) et de ce qu'elle observe pendant la lecture (jeton, requêtes du lecteur), sélectionne
**la meilleure qualité disponible**, récupère les segments **en parallèle**, les **déchiffre
(AES-128) via WebCrypto**, puis **remuxe la vidéo + l'audio en MP4 en pur JavaScript** — le tout
**en local, dans votre navigateur**. Aucun serveur tiers, aucune dépendance externe, aucune étape
de build.

> ⚠️ **Usage responsable.** N'utilisez cet outil que sur des contenus que vous avez le droit de
> visionner, et **respectez la politique de votre organisation**. L'outil ne contourne aucune
> authentification : il réutilise l'accès que vous possédez déjà.

---

## Installation (une seule fois)

1. Ouvrez `chrome://extensions` (dans Arc : même URL, ou Menu → Extensions).
2. Activez le **Mode développeur** (en haut à droite).
3. Cliquez **« Charger l'extension non empaquetée »**.
4. Sélectionnez le dossier **`sp-stream-downloader`**.
5. L'icône apparaît dans la barre d'outils. ✅

Aucun téléchargement de dépendance : l'extension est autonome.

---

## Utilisation

1. Ouvrez l'enregistrement dans SharePoint / Teams Stream. La vidéo est détectée dès le
   chargement de la page ; **lancer la lecture quelques secondes** reste conseillé (cela capture
   un jeton frais, nécessaire sur certains tenants).
2. Cliquez sur l'**icône de l'extension** : un **panneau** s'ouvre **en surimpression sur la page**
   (pas de nouvel onglet). Un badge vert **●** sur l'icône indique qu'une vidéo est détectée.
3. Dans le panneau :
   - **⬇︎ Télécharger la vidéo (MP4)** → récupère, déchiffre, remuxe et enregistre le `.mp4`.
   - **Transcript : VTT / SRT / Texte** → export **séparé**, au format choisi (bouton dédié).
4. La progression s'affiche dans le panneau ; à la fin, la fenêtre d'enregistrement apparaît.

Le nom de fichier est pré-rempli d'après le titre de la page (modifiable). Fermez le panneau avec
le **×** ou en recliquant l'icône.

> Le panneau doit rester ouvert pendant le téléchargement (il exécute le travail). Vous pouvez
> continuer à naviguer dans l'onglet.

---

## Partage à d'autres personnes

L'extension est un simple dossier, **sans dépendance à installer** :

1. Zippez le dossier `sp-stream-downloader`.
2. Le destinataire dézippe, puis suit **l'Installation** ci-dessus (Charger l'extension non empaquetée).

Chaque personne télécharge **ses propres** vidéos avec **ses propres** accès : l'extension n'utilise
que le jeton de la session en cours. Rien n'est partagé entre utilisateurs.

> En « load unpacked », Chrome peut afficher au démarrage un rappel « Désactiver les extensions en
> mode développeur ». C'est normal pour une extension non publiée sur le Web Store.

---

## Fonctionnement (pour les curieux)

| Étape | Détail |
|-------|--------|
| **Détection** | `background.js` lit `g_fileInfo` dans la page (via `chrome.scripting`, monde MAIN) : `.transformUrl` + `.ctag` permettent de reconstruire l'URL `…/videomanifest?…&action=Access&part=index` (même méthode que yt-dlp). Il observe aussi les requêtes `…/videomanifest…` et `…/oneDrive.transcode…` du lecteur, l'en-tête `X-SPOPacToken` (rafraîchi à la volée) et l'URL du transcript. |
| **UI** | `content.js` injecte le panneau (`panel.html`) en overlay dans la page ; il tourne dans le contexte de l'extension (accès aux API, permissions d'hôte). |
| **Manifeste** | `manifest.js` construit les URLs candidates (requête capturée, `g_fileInfo`, segment `oneDrive.transcode`) et les essaie dans l'ordre, en **HLS** (`format=hls`) puis en **DASH** (`format=dash`, MPD avec `SegmentTemplate`/`SegmentTimeline` et chiffrement DASH-SEA AES-128-CBC). La variante de **plus haute qualité** est retenue automatiquement ; chaque tentative est tracée dans le journal du panneau. |
| **Déchiffrement** | Les segments sont récupérés **en parallèle** (12 à la fois) et déchiffrés en **AES-128-CBC** via `crypto.subtle` (WebCrypto). |
| **Remux** | `mux.js` fusionne les deux `moov` (pistes déjà distinctes : vidéo=1, audio=2) et entrelace les fragments → MP4 unique. **~15 ms**, sans ré-encodage (qualité d'origine). Si l'audio est déjà inclus dans la piste vidéo, l'étape est ignorée. |
| **Transcript** | JSON Stream chiffré avec la **même clé** → déchiffré puis converti en VTT/SRT/TXT. |

---

## Limites & dépannage

- **« Recherche d'une vidéo… »** qui ne se termine pas → rechargez la page (Cmd/Ctrl+R), lancez la
  **lecture**, puis rouvrez le panneau. Si la page était déjà ouverte avant d'installer ou de
  recharger l'extension, le rechargement est indispensable.
- **Erreur `HTTP 401/403`** ou **« jeton non capturé »** → lancez la lecture quelques secondes
  (le lecteur envoie alors un `X-SPOPacToken` frais), puis réessayez.
- **« Aucun manifeste exploitable »** → le journal du panneau liste chaque URL essayée et la
  réponse obtenue : c'est l'information à transmettre pour diagnostic.
- **Septembre 2026** : le lecteur Microsoft n'appelle plus `videomanifest` (il télécharge ses
  segments via `oneDrive.transcode`), ce qui a rendu muette la capture passive des versions ≤ 1.1.
  La 1.2 reconstruit l'URL du manifeste depuis la page, sans dépendre de la lecture.
- **Diagnostic** : sur `chrome://extensions`, cliquez « service worker » sous l'extension pour voir
  les logs `[SPSD]` (capture du manifeste/jeton). Le panneau affiche aussi un journal détaillé.
- **Contenu protégé par un vrai DRM (Widevine/PlayReady)** → non pris en charge (rare en interne).

---

## Structure du projet

```
sp-stream-downloader/
├─ manifest.json    # MV3 : permissions, content script, CSP
├─ background.js    # capture manifeste + jeton + transcript ; ouvre le panneau
├─ content.js/css   # injecte le panneau overlay dans la page SharePoint
├─ panel.html/js    # UI + pipeline : fetch, déchiffrement, remux, téléchargement
├─ manifest.js      # URLs candidates + parseurs HLS / DASH (pur JS, testable sous Node)
├─ mux.js           # remuxeur fragmented-MP4 en pur JS (vidéo + audio → MP4)
└─ test/            # tests unitaires (node:test)
```

## Tests

```bash
node --test test/manifest.test.js
```
