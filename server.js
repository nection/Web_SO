const express = require('express');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const fileUpload = require('express-fileupload');
const Fuse = require('fuse.js'); // Llibreria per a la cerca tolerant a errors

const app = express();
const port = 3001;

// --- BLOC 0: LÒGICA D'AUTO-REPARACIÓ DE LA BASE DE DADES ---

const DB_PATH = path.join(__dirname, 'portfolio.db');
const OLD_DB_PATH = path.join(__dirname, 'portfolio_VELL.db');

function repairAndMigrateDatabase() {
    return new Promise((resolve) => {
        if (!fs.existsSync(OLD_DB_PATH)) {
            return resolve(); // No hi ha res a reparar, continuem.
        }

        console.log('[AUTO-REPARACIÓ] S\'ha detectat una base de dades antiga (`portfolio_VELL.db`).');
        console.log('[AUTO-REPARACIÓ] Iniciant procés de rescat de dades...');

        if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

        const newDb = new sqlite3.Database(DB_PATH, (err) => {
            if (err) {
                console.error('[AUTO-REPARACIÓ] ERROR: No s\'ha pogut crear la nova base de dades.', err);
                return resolve();
            }

            newDb.serialize(() => {
                console.log('[AUTO-REPARACIÓ] Creant estructura neta...');
                newDb.run(`CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT NOT NULL, url TEXT, imageUrl TEXT, status TEXT NOT NULL DEFAULT 'published')`);
                newDb.run(`CREATE TABLE apps (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT NOT NULL, url TEXT, imageUrl TEXT, status TEXT NOT NULL DEFAULT 'published')`);
                newDb.run(`CREATE TABLE blog (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, content TEXT NOT NULL, date TEXT, imageUrl TEXT, status TEXT NOT NULL DEFAULT 'published')`);
                
                console.log('[AUTO-REPARACIÓ] Transferint dades...');
                newDb.run(`ATTACH DATABASE '${OLD_DB_PATH}' AS vell;`, (err) => {
                    if (err) { console.error("Error a l'adjuntar la BD vella:", err); return resolve(); }
                    
                    newDb.run(`INSERT INTO main.projects SELECT * FROM vell.projects;`, () => {});
                    newDb.run(`INSERT INTO main.apps SELECT * FROM vell.apps;`, () => {});
                    newDb.run(`INSERT INTO main.blog SELECT * FROM vell.blog;`, (err) => {
                        if (err) { console.error("Error transferint dades del blog:", err); }
                        
                        newDb.run(`DETACH DATABASE vell;`, () => {
                            newDb.close((err) => {
                                if (err) { console.error("Error al tancar la BD nova:", err); }
                                
                                console.log('✅ [AUTO-REPARACIÓ] Dades transferides amb èxit.');
                                fs.unlinkSync(OLD_DB_PATH);
                                console.log('🗑️ [AUTO-REPARACIÓ] Arxiu de base de dades antic eliminat. Procés completat.');
                                resolve();
                            });
                        });
                    });
                });
            });
        });
    });
}

// --- BLOC PRINCIPAL D'INICI DEL SERVIDOR ---

async function startServer() {
    // Primer, executem la reparació. No continuarà fins que acabi.
    await repairAndMigrateDatabase();

    // La resta del codi del servidor s'executa amb la seguretat
    // que `portfolio.db` existeix i és sa.
    
    // --- BLOC 1: CONFIGURACIÓ INICIAL I MIDDLEWARE ---
    const uploadsDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

    app.use(bodyParser.json({ limit: '50mb' }));
    app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));
    app.use(fileUpload());
    app.use(express.static(__dirname));
    app.use('/uploads', express.static(uploadsDir));

    // --- BLOC 2: CONNEXIÓ A LA BASE DE DADES ---
    const db = new sqlite3.Database(DB_PATH, (err) => {
        if (err) {
            console.error("Error a l'obrir la base de dades principal", err.message);
        } else {
            console.log("Connectat a la base de dades SQLite principal.");
            db.serialize(() => {
                db.run(`CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT NOT NULL, url TEXT, imageUrl TEXT, status TEXT NOT NULL DEFAULT 'published')`);
                db.run(`CREATE TABLE IF NOT EXISTS apps (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT NOT NULL, url TEXT, imageUrl TEXT, status TEXT NOT NULL DEFAULT 'published')`);
                db.run(`CREATE TABLE IF NOT EXISTS blog (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, content TEXT NOT NULL, date TEXT, imageUrl TEXT, status TEXT NOT NULL DEFAULT 'published')`);
                console.log("Estructura de la base de dades assegurada.");
            });
        }
    });

    const getTableName = (type) => ({ project: 'projects', app: 'apps', blog: 'blog', projects: 'projects', apps: 'apps' })[type] || null;

    // --- BLOC 3: RUTES ---
    app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
    app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

    app.get('/api/media', (req, res) => {
        fs.readdir(uploadsDir, (err, files) => {
            if (err) return res.status(500).json({ error: "No es poden llegir les imatges." });
            const imageFiles = files.filter(file => /\.(jpg|jpeg|png|gif|webp)$/i.test(file));
            res.json(imageFiles.map(file => `/uploads/${file}`).sort((a, b) => b.localeCompare(a)));
        });
    });

    app.post('/api/upload', (req, res) => {
        if (!req.files || !req.files.image) return res.status(400).send('No s\'ha pujat cap arxiu.');
        const uploadedFile = req.files.image;
        const fileName = `${Date.now()}-${uploadedFile.name.replace(/\s/g, '_')}`;
        uploadedFile.mv(path.join(uploadsDir, fileName), (err) => {
            if (err) return res.status(500).send(err);
            res.json({ url: `/uploads/${fileName}` });
        });
    });

    // --- API PÚBLICA (AMB CERCA FUZZY) ---
    app.get('/api/public/data/:type', async (req, res) => {
        const { type } = req.params;
        const page = parseInt(req.query.page) || 1;
        const limit = 12;
        const offset = (page - 1) * limit;
        const query = req.query.q || '';
        const sort = req.query.sort || (query ? 'relevance' : 'newest');
        const singularType = type === 'blog' ? 'blog' : type.slice(0, -1);
        const tableName = getTableName(singularType);
        if (!tableName) return res.status(400).json({ "error": `Tipus no vàlid: ${type}` });
        const runQuery = (sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows)));
        const getQuery = (sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));
        const mainContentColumn = tableName === 'blog' ? 'content' : 'description';

        try {
            let items = [], totalItems = 0;
            if (query) {
                const allItems = await runQuery(`SELECT id, title, ${mainContentColumn}, imageUrl, date FROM ${tableName} WHERE status = 'published'`);
                const fuseOptions = { keys: ['title', mainContentColumn], includeScore: true, threshold: 0.4, ignoreLocation: true };
                const fuse = new Fuse(allItems, fuseOptions);
                const searchResults = fuse.search(query);
                let fuzzyItems = searchResults.map(result => result.item);
                totalItems = fuzzyItems.length;
                if (sort === 'oldest') fuzzyItems.sort((a, b) => (tableName === 'blog' ? new Date(a.date) - new Date(b.date) : a.id - b.id));
                else if (sort === 'newest') fuzzyItems.sort((a, b) => (tableName === 'blog' ? new Date(b.date) - new Date(a.date) : b.id - a.id));
                items = fuzzyItems.slice(offset, offset + limit);
            } else {
                const countResult = await getQuery(`SELECT COUNT(*) as count FROM ${tableName} WHERE status = 'published'`);
                totalItems = countResult ? countResult.count : 0;
                let orderByClause = `ORDER BY ${tableName === 'blog' ? 'date' : 'id'} DESC`;
                if (sort === 'oldest') orderByClause = `ORDER BY ${tableName === 'blog' ? 'date' : 'id'} ASC`;
                items = await runQuery(`SELECT id, title, ${mainContentColumn}, imageUrl FROM ${tableName} WHERE status = 'published' ${orderByClause} LIMIT ? OFFSET ?`, [limit, offset]);
            }
            const finalItems = items.map(item => ({ id: item.id, title: item.title, [mainContentColumn]: item[mainContentColumn], imageUrl: item.imageUrl }));
            res.json({ items: finalItems, totalPages: Math.ceil(totalItems / limit), currentPage: page });
        } catch (err) {
            console.error(`Error a l'endpoint /api/public/data/${type}:`, err.message);
            res.status(500).json({ "error": "Error intern del servidor." });
        }
    });

    // --- API PRIVADA (ADMIN) ---
    app.get('/api/data/:type', async (req, res) => {
        const { type } = req.params;
        const page = parseInt(req.query.page) || 1;
        const limit = 5;
        const offset = (page - 1) * limit;
        const singularType = type === 'blog' ? 'blog' : type.slice(0, -1);
        const tableName = getTableName(singularType);
        if (!tableName) return res.status(400).json({ error: `Tipus no vàlid` });
        try {
            const total = await new Promise((res, rej) => db.get(`SELECT COUNT(*) as count FROM ${tableName}`, (e, r) => e ? rej(e) : res(r.count)));
            const items = await new Promise((res, rej) => db.all(`SELECT * FROM ${tableName} ORDER BY ${tableName === 'blog' ? 'date' : 'id'} DESC LIMIT ? OFFSET ?`, [limit, offset], (e, r) => e ? rej(e) : res(r)));
            res.json({ items, totalPages: Math.ceil(total / limit), currentPage: page });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });
    app.get('/api/item/:type/:id', (req, res) => {
        const { type, id } = req.params;
        const table = getTableName(type);
        if (!table) return res.status(400).json({ "error": "Tipus no vàlid" });
        db.get(`SELECT * FROM ${table} WHERE id = ?`, [id], (err, row) => {
            if (err) return res.status(500).json({ "error": err.message });
            res.json(row);
        });
    });
    app.post('/api/add/:type', (req, res) => {
        const { type } = req.params;
        const table = getTableName(type);
        if (!table) return res.status(400).json({ "error": "Tipus no vàlid" });
        const { title, content, date, imageUrl, status, description, url } = req.body;
        const query = type === 'blog' ? `INSERT INTO blog (title, content, date, imageUrl, status) VALUES (?, ?, ?, ?, ?)` : `INSERT INTO ${table} (title, description, url, imageUrl, status) VALUES (?, ?, ?, ?, ?)`;
        const params = type === 'blog' ? [title, content, date, imageUrl, status] : [title, description, url, imageUrl, status];
        db.run(query, params, function (err) {
            if (err) return res.status(500).json({ "error": err.message });
            res.status(201).json({ id: this.lastID });
        });
    });
    app.put('/api/edit/:type/:id', (req, res) => {
        const { type, id } = req.params;
        const table = getTableName(type);
        if (!table) return res.status(400).json({ "error": "Tipus no vàlid" });
        const { title, content, date, imageUrl, status, description, url } = req.body;
        const query = type === 'blog' ? `UPDATE blog SET title = ?, content = ?, date = ?, imageUrl = ?, status = ? WHERE id = ?` : `UPDATE ${table} SET title = ?, description = ?, url = ?, imageUrl = ?, status = ? WHERE id = ?`;
        const params = type === 'blog' ? [title, content, date, imageUrl, status, id] : [title, description, url, imageUrl, status, id];
        db.run(query, params, function (err) {
            if (err) return res.status(500).json({ "error": err.message });
            res.json({ changes: this.changes });
        });
    });
    app.delete('/api/delete/:type/:id', (req, res) => {
        const { type, id } = req.params;
        const table = getTableName(type);
        if (!table) return res.status(400).json({ "error": "Tipus no vàlid" });
        db.run(`DELETE FROM ${table} WHERE id = ?`, id, function (err) {
            if (err) return res.status(500).json({ "error": err.message });
            res.json({ deleted: this.changes });
        });
    });
    app.put('/api/status/:type/:id', (req, res) => {
        const { type, id } = req.params;
        const { status } = req.body;
        const table = getTableName(type);
        if (!table) return res.status(400).json({ "error": "Tipus no vàlid" });
        db.run(`UPDATE ${table} SET status = ? WHERE id = ?`, [status, id], function (err) {
            if (err) return res.status(500).json({ "error": err.message });
            res.json({ changes: this.changes });
        });
    });

    // --- BLOC 6: INICI DEL SERVIDOR ---
    app.listen(port, () => console.log(`Servidor escoltant a http://localhost:${port}`));
}

// Executem la funció principal per iniciar el servidor.
startServer();