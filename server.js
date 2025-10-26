const express = require('express');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const fileUpload = require('express-fileupload');
const Fuse = require('fuse.js');

const app = express();
const port = 3001;

// NOU: Cache per als resultats de cerca per restaurar la paginació i el rendiment.
const searchCache = new Map();

const DB_PATH = path.join(__dirname, 'portfolio.db');
const OLD_DB_PATH = path.join(__dirname, 'portfolio_VELL.db');

// --- BLOC 0.1: LÒGICA D'AUTO-REPARACIÓ DE FITXER CORRUPTE ---
function repairCorruptDatabaseFile() {
    return new Promise((resolve) => {
        if (!fs.existsSync(OLD_DB_PATH)) return resolve();
        console.log('[AUTO-REPARACIÓ] S\'ha detectat una base de dades antiga (`portfolio_VELL.db`).');
        console.log('[AUTO-REPARACIÓ] Iniciant procés de rescat de dades...');
        if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
        const newDb = new sqlite3.Database(DB_PATH, (err) => {
            if (err) {
                console.error('[AUTO-REPARACIÓ] ERROR: No s\'ha pogut crear la nova base de dades.', err);
                return resolve();
            }
            newDb.serialize(() => {
                console.log('[AUTO-REPARACIÓ] Creant estructura temporal...');
                newDb.run(`CREATE TABLE projects (id INTEGER, title TEXT, description TEXT, url TEXT, imageUrl TEXT, status TEXT)`);
                newDb.run(`CREATE TABLE apps (id INTEGER, title TEXT, description TEXT, url TEXT, imageUrl TEXT, status TEXT)`);
                newDb.run(`CREATE TABLE blog (id INTEGER, title TEXT, content TEXT, date TEXT, imageUrl TEXT, status TEXT)`);
                newDb.run(`ATTACH DATABASE '${OLD_DB_PATH}' AS vell;`, (err) => {
                    if (err) { console.error("Error a l'adjuntar la BD vella:", err); return resolve(); }
                    newDb.run(`INSERT INTO main.projects SELECT id, title, description, url, imageUrl, status FROM vell.projects;`, () => {});
                    newDb.run(`INSERT INTO main.apps SELECT * FROM vell.apps;`, () => {});
                    newDb.run(`INSERT INTO main.blog SELECT * FROM vell.blog;`, () => {
                        newDb.run(`DETACH DATABASE vell;`, () => {
                            newDb.close(() => {
                                console.log('✅ [AUTO-REPARACIÓ] Dades transferides amb èxit.');
                                fs.unlinkSync(OLD_DB_PATH);
                                console.log('🗑️ [AUTO-REPARACIÓ] Arxiu de base de dades antic eliminat.');
                                resolve();
                            });
                        });
                    });
                });
            });
        });
    });
}

// --- BLOC 0.2: LÒGICA D'AUTO-MIGRACIÓ DE L'ESTRUCTURA DE PROJECTES ---
async function migrateProjectSchema(db) {
    return new Promise((resolve, reject) => {
        db.all('PRAGMA table_info(projects);', (err, columns) => {
            if (err) return reject(err);
            const needsMigration = columns.some(col => col.name === 'description');
            if (!needsMigration) {
                console.log('[MIGRACIÓ D\'ESTRUCTURA] L\'estructura de `projects` ja és correcta. No cal fer res.');
                return resolve();
            }
            console.log('[MIGRACIÓ D\'ESTRUCTURA] S\'ha detectat una estructura de `projects` antiga. Iniciant migració...');
            db.serialize(async () => {
                try {
                    await new Promise((res, rej) => db.run('BEGIN TRANSACTION;', e => e ? rej(e) : res()));
                    await new Promise((res, rej) => db.run('ALTER TABLE projects RENAME TO projects_old;', e => e ? rej(e) : res()));
                    const createNewTableSql = `CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, url TEXT, imageUrl TEXT, status TEXT NOT NULL DEFAULT 'published', data TEXT)`;
                    await new Promise((res, rej) => db.run(createNewTableSql, e => e ? rej(e) : res()));
                    const oldProjects = await new Promise((res, rej) => db.all('SELECT * FROM projects_old;', (e, r) => e ? rej(e) : res(r)));
                    const insertStmt = db.prepare('INSERT INTO projects (id, title, url, imageUrl, status, data) VALUES (?, ?, ?, ?, ?, ?)');
                    for (const project of oldProjects) {
                        const newData = JSON.stringify({ summary: project.description || '', technologies: [], features: [], screenshots: [], description: '' });
                        await new Promise((res, rej) => insertStmt.run(project.id, project.title, project.url, project.imageUrl, project.status, newData, e => e ? rej(e) : res()));
                    }
                    insertStmt.finalize();
                    await new Promise((res, rej) => db.run('DROP TABLE projects_old;', e => e ? rej(e) : res()));
                    await new Promise((res, rej) => db.run('COMMIT;', e => e ? rej(e) : res()));
                    console.log('✅ [MIGRACIÓ D\'ESTRUCTURA] Procés de migració completat amb èxit.');
                    resolve();
                } catch (migrationError) {
                    console.error('[MIGRACIÓ D\'ESTRUCTURA] ERROR DURANT LA MIGRACIÓ:', migrationError);
                    await new Promise((res, rej) => db.run('ROLLBACK;', e => e ? rej(e) : res()));
                    reject(migrationError);
                }
            });
        });
    });
}

// --- BLOC PRINCIPAL D'INICI DEL SERVIDOR ---
async function startServer() {
    await repairCorruptDatabaseFile();
    
    const uploadsDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

    app.use(bodyParser.json({ limit: '50mb' }));
    app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));
    app.use(fileUpload());
    app.use(express.static(__dirname));
    app.use('/uploads', express.static(uploadsDir));

    const db = new sqlite3.Database(DB_PATH, async (err) => {
        if (err) return console.error("Error fatal a l'obrir la base de dades", err.message);
        console.log("Connectat a la base de dades SQLite principal.");
        await new Promise(res => db.run(`CREATE TABLE IF NOT EXISTS apps (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT NOT NULL, url TEXT, imageUrl TEXT, status TEXT NOT NULL DEFAULT 'published')`, () => res()));
        await new Promise(res => db.run(`CREATE TABLE IF NOT EXISTS blog (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, content TEXT NOT NULL, date TEXT, imageUrl TEXT, status TEXT NOT NULL DEFAULT 'published')`, () => res()));
        await new Promise(res => db.run(`CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT, url TEXT, imageUrl TEXT, status TEXT NOT NULL DEFAULT 'published')`, () => res()));
        await migrateProjectSchema(db);
        console.log("Estructura de la base de dades assegurada.");
    });

    const getTableName = (type) => ({ project: 'projects', app: 'apps', blog: 'blog', projects: 'projects', apps: 'apps' })[type] || null;
    
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
        
        try {
            let paginatedItems = [], totalItems = 0;

            if (query) {
                const cacheKey = `${type}-${query}-${sort}`;
                let sortedIds = [];

                if (searchCache.has(cacheKey)) {
                    sortedIds = searchCache.get(cacheKey);
                } else {
                    const allItems = await runQuery(`SELECT * FROM ${tableName} WHERE status = 'published'`);
                    const searchKeys = tableName === 'projects' ? ['title', 'data.summary', 'data.technologies', 'data.features', 'data.description'] : (tableName === 'apps' ? ['title', 'description'] : ['title', 'content']);
                    const itemsToSearch = tableName === 'projects' ? allItems.map(item => ({...item, data: JSON.parse(item.data || '{}')})) : allItems;
                    const fuse = new Fuse(itemsToSearch, { keys: searchKeys, includeScore: true, threshold: 0.4, ignoreLocation: true, findAllMatches: true });
                    const searchResults = fuse.search(query);
                    let fuzzyItems = searchResults.map(result => result.item);
                    if (sort === 'oldest') fuzzyItems.sort((a, b) => (tableName === 'blog' ? new Date(a.date) - new Date(b.date) : a.id - b.id));
                    else if (sort === 'newest') fuzzyItems.sort((a, b) => (tableName === 'blog' ? new Date(b.date) - new Date(a.date) : b.id - a.id));
                    sortedIds = fuzzyItems.map(item => item.id);
                    searchCache.set(cacheKey, sortedIds);
                    // Neteja la cache després d'un temps per estalviar memòria
                    setTimeout(() => searchCache.delete(cacheKey), 300000); // 5 minuts
                }

                totalItems = sortedIds.length;
                const idsForPage = sortedIds.slice(offset, offset + limit);

                if (idsForPage.length > 0) {
                    const placeholders = idsForPage.map(() => '?').join(',');
                    const itemsFromDb = await runQuery(`SELECT * FROM ${tableName} WHERE id IN (${placeholders})`, idsForPage);
                    // Re-ordena els resultats de la BD per a que coincideixin amb l'ordre de la cerca
                    paginatedItems = idsForPage.map(id => itemsFromDb.find(item => item.id === id));
                }

            } else {
                searchCache.clear(); // Neteja la cache si ja no hi ha cerca
                const countResult = await getQuery(`SELECT COUNT(*) as count FROM ${tableName} WHERE status = 'published'`);
                totalItems = countResult ? countResult.count : 0;
                let orderByClause = `ORDER BY ${tableName === 'blog' ? 'date' : 'id'} DESC`;
                if (sort === 'oldest') orderByClause = `ORDER BY ${tableName === 'blog' ? 'date' : 'id'} ASC`;
                paginatedItems = await runQuery(`SELECT * FROM ${tableName} WHERE status = 'published' ${orderByClause} LIMIT ? OFFSET ?`, [limit, offset]);
            }

            const finalItems = paginatedItems.map(item => {
                if (tableName === 'projects') {
                    const projectData = (typeof item.data === 'string') ? JSON.parse(item.data || '{}') : item.data;
                    return { id: item.id, title: item.title, description: projectData.summary || '', imageUrl: item.imageUrl };
                }
                return { id: item.id, title: item.title, description: item.description || item.content, imageUrl: item.imageUrl };
            });

            res.json({ items: finalItems, totalPages: Math.ceil(totalItems / limit), currentPage: page });
        } catch (err) {
            console.error(`Error a l'endpoint /api/public/data/${type}:`, err.message);
            res.status(500).json({ "error": "Error intern del servidor." });
        }
    });

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
            if (type === 'project' && row && row.data) {
                row.data = JSON.parse(row.data);
            }
            res.json(row);
        });
    });

    app.post('/api/add/:type', (req, res) => {
        const { type } = req.params;
        const table = getTableName(type);
        if (!table) return res.status(400).json({ "error": "Tipus no vàlid" });
        if (type === 'project') {
            const { title, url, imageUrl, status, data } = req.body;
            db.run(`INSERT INTO projects (title, url, imageUrl, status, data) VALUES (?, ?, ?, ?, ?)`, [title, url, imageUrl, status, JSON.stringify(data)], function(err) {
                if (err) return res.status(500).json({ "error": err.message });
                res.status(201).json({ id: this.lastID });
            });
        } else {
            const { title, content, date, imageUrl, status, description, url } = req.body;
            const query = type === 'blog' ? `INSERT INTO blog (title, content, date, imageUrl, status) VALUES (?, ?, ?, ?, ?)` : `INSERT INTO ${table} (title, description, url, imageUrl, status) VALUES (?, ?, ?, ?, ?)`;
            const params = type === 'blog' ? [title, content, date, imageUrl, status] : [title, description, url, imageUrl, status];
            db.run(query, params, function (err) {
                if (err) return res.status(500).json({ "error": err.message });
                res.status(201).json({ id: this.lastID });
            });
        }
    });

    app.put('/api/edit/:type/:id', (req, res) => {
        const { type, id } = req.params;
        const table = getTableName(type);
        if (!table) return res.status(400).json({ "error": "Tipus no vàlid" });
        if (type === 'project') {
            const { title, url, imageUrl, status, data } = req.body;
            db.run(`UPDATE projects SET title = ?, url = ?, imageUrl = ?, status = ?, data = ? WHERE id = ?`, [title, url, imageUrl, status, JSON.stringify(data), id], function(err) {
                if (err) return res.status(500).json({ "error": err.message });
                res.json({ changes: this.changes });
            });
        } else {
            const { title, content, date, imageUrl, status, description, url } = req.body;
            const query = type === 'blog' ? `UPDATE blog SET title = ?, content = ?, date = ?, imageUrl = ?, status = ? WHERE id = ?` : `UPDATE ${table} SET title = ?, description = ?, url = ?, imageUrl = ?, status = ? WHERE id = ?`;
            const params = type === 'blog' ? [title, content, date, imageUrl, status, id] : [title, description, url, imageUrl, status, id];
            db.run(query, params, function (err) {
                if (err) return res.status(500).json({ "error": err.message });
                res.json({ changes: this.changes });
            });
        }
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

    app.listen(port, () => console.log(`Servidor escoltant a http://localhost:${port}`));
}

startServer();