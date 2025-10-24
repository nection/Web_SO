# Portafolis Web retro amb Express i SQLite

Aquest projecte és una aplicació web d'estil retro inspirada en els escriptoris clàssics, pensada per mostrar un portafolis personal. Consta d'un frontend estàtic que simula un escriptori amb finestres i icones i d'un backend basat en Node.js que gestiona el contingut mitjançant una API REST i una base de dades SQLite.

## Característiques principals

- **Interfície retro**: la pàgina principal (`index.html`) recrea l'aspecte d'un sistema operatiu antic amb escriptori, barra de tasques, finestres arrossegables i icones personalitzades per accedir a seccions com Projectes, Aplicacions o Blog.
- **Panell d'administració**: la vista `admin.html` permet crear, editar i eliminar entrades del portafolis sense modificar fitxers manuals.
- **API REST**: el servidor Express (`server.js`) exposa punts d'entrada per llistar, afegir, editar i esborrar elements de les taules `projects`, `apps` i `blog`.
- **Base de dades SQLite**: la informació es persisteix en el fitxer `portfolio.db`. Les taules es creen automàticament si no existeixen.
- **Gestió d'arxius estàtics**: el servidor serveix directament els fitxers estàtics des de l'arrel del projecte, incloent imatges i documents.

## Tecnologies utilitzades

- [Node.js](https://nodejs.org/) i [Express](https://expressjs.com/) per al backend.
- [Body-Parser](https://www.npmjs.com/package/body-parser) per processar dades de formularis i JSON.
- [SQLite3](https://www.sqlite.org/) per a la persistència de dades.
- [Multer](https://www.npmjs.com/package/multer) (preparat per a càrrega d'arxius si cal expandir funcionalitats).
- HTML, CSS i JavaScript per al frontend.

## Requisits previs

- Node.js 18 o superior.
- `npm` per gestionar les dependències.

## Instal·lació i execució

1. Instal·la les dependències:

   ```bash
   npm install
   ```

2. Inicia el servidor en mode desenvolupament:

   ```bash
   node server.js
   ```

3. Obre el navegador a [http://localhost:3000](http://localhost:3000) per veure el portafolis i a [http://localhost:3000/admin](http://localhost:3000/admin) per accedir al panell d'administració.

## Estructura del projecte

```text
Web_SO/
├── admin.html         # Interfície d'administració del contingut
├── index.html         # Portafolis en format escriptori retro
├── server.js          # API REST i configuració del servidor Express
├── portfolio.db       # Base de dades SQLite amb projectes, apps i entrades del blog
├── uploads/           # Carpeta per a possibles càrregues de fitxers
├── pujades/           # Recursos addicionals (imatges, documents, etc.)
├── ascii-animation.txt
├── package.json
├── package-lock.json
└── README.md
```

## Desenvolupament i extensió

- Les taules `projects`, `apps` i `blog` poden ampliar-se amb camps addicionals segons les necessitats.
- Es poden afegir nous punts d'entrada a l'API per gestionar altres tipus de contingut.
- La interfície retro es pot personalitzar modificant els estils a `index.html`.

## Llicència

Encara no s'ha especificat una llicència. Afegiu-ne una si voleu distribuir el projecte.

## Crèdits

Projecte creat com a entorn de portafolis personal amb estètica retro i gestió de contingut mitjançant Express i SQLite.

## Changelog

Consulta el fitxer [CHANGELOG.md](CHANGELOG.md) per seguir l'historial de canvis.
