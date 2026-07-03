# SharePoint Stream Downloader (Chrome / Arc)

Télécharge **la vidéo (MP4)** et **le transcript (VTT / SRT / texte)** des enregistrements
**SharePoint / Teams Stream** que vous êtes autorisé à **visionner**, directement depuis la page —
même quand le bouton « Télécharger » est désactivé.

L'extension capte automatiquement, pendant la lecture, le manifeste vidéo et le jeton d'accès de
**votre** session, récupère les segments, les **déchiffre (AES-128) via WebCrypto**, puis
**remuxe la vidéo + l'audio en MP4 en pur JavaScript** — le tout **en local, dans votre navigateur**.
Aucun serveur tiers, aucune dépendance externe, aucune étape de build.

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

1. Ouvrez l'enregistrement dans SharePoint / Teams Stream et **lancez la lecture** (quelques
   secondes suffisent — c'est ce qui déclenche la capture du manifeste + du jeton).
2. Cliquez sur l'**icône de l'extension** : un **panneau** s'ouvre **en surimpression sur la page**
   (pas de nouvel onglet). Un badge vert **●** sur l'icône indique qu'une vidéo est détectée.
3. Dans le panneau :
   - **⬇︎ Télécharger la vidéo (MP4)** → récupère, déchiffre, remuxe, enregistre le `.mp4`
     (et le transcript en `.vtt` s'il existe).
   - **Transcript : VTT / SRT / Texte** → export au format choisi.
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
| **Capture** | `background.js` observe les requêtes `…/videomanifest…` et lit l'en-tête `X-SPOPacToken` + l'URL du transcript. |
| **UI** | `content.js` injecte le panneau (`panel.html`) en overlay dans la page ; il tourne dans le contexte de l'extension (accès aux API, permissions d'hôte). |
| **Manifeste** | Demandé en **HLS** (`format=hls`) : pistes vidéo + audio séparées, clé AES-128 + IV. |
| **Déchiffrement** | Chaque segment est déchiffré en **AES-128-CBC** via `crypto.subtle` (WebCrypto). |
| **Remux** | `mux.js` fusionne les deux `moov` (pistes déjà distinctes : vidéo=1, audio=2) et entrelace les fragments → MP4 unique. **~15 ms**, sans ré-encodage (qualité d'origine). |
| **Transcript** | JSON Stream chiffré avec la **même clé** → déchiffré puis converti en VTT/SRT/TXT. |

---

## Limites & dépannage

- **« Aucune vidéo détectée »** → lancez d'abord la **lecture**, puis (re)cliquez l'icône. Si la page
  était déjà ouverte avant d'installer l'extension, **rechargez-la** (Cmd/Ctrl+R).
- **Erreur `HTTP 401/403`** → le jeton d'accès expire vite. Relancez la lecture puis réessayez.
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
└─ mux.js           # remuxeur fragmented-MP4 en pur JS (vidéo + audio → MP4)
```
