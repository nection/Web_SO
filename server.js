const express = require('express');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const fileUpload = require('express-fileupload');
const Fuse = require('fuse.js');

const app = express();
const port = 3001;

const DB_PATH = path.join(__dirname, 'portfolio.db');
const OLD_DB_PATH = path.join(__dirname, 'portfolio_VELL.db');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

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

async function startServer() {
    await repairCorruptDatabaseFile();
    
    if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

    app.use(bodyParser.json({ limit: '50mb' }));
    app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));
    app.use(fileUpload());
    app.use(express.static(__dirname));
    app.use('/uploads', express.static(UPLOADS_DIR));

    const db = new sqlite3.Database(DB_PATH, async (err) => {
        if (err) return console.error("Error fatal a l'obrir la base de dades", err.message);
        console.log("Connectat a la base de dades SQLite principal.");
        
        // Assegurar estructura base
        await new Promise(res => db.run(`CREATE TABLE IF NOT EXISTS apps (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT NOT NULL, url TEXT, imageUrl TEXT, status TEXT NOT NULL DEFAULT 'published')`, () => res()));
        await new Promise(res => db.run(`CREATE TABLE IF NOT EXISTS blog (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, content TEXT NOT NULL, date TEXT, imageUrl TEXT, status TEXT NOT NULL DEFAULT 'published')`, () => res()));
        await new Promise(res => db.run(`CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT, url TEXT, imageUrl TEXT, status TEXT NOT NULL DEFAULT 'published')`, () => res()));
        
        // Executar migració de Projects si cal
        await migrateProjectSchema(db);

        // NOU: Funció de migració per afegir el camp 'summary'
        const addSummaryColumn = (tableName) => {
            return new Promise((resolve) => {
                db.all(`PRAGMA table_info(${tableName});`, (err, columns) => {
                    if (err) {
                        console.error(`[MIGRACIÓ SUMMARY] Error en comprovar la taula ${tableName}:`, err);
                        return resolve();
                    }
                    const hasSummary = columns.some(col => col.name === 'summary');
                    if (hasSummary) {
                        console.log(`[MIGRACIÓ SUMMARY] El camp 'summary' ja existeix a la taula '${tableName}'. No cal fer res.`);
                        return resolve();
                    }
                    console.log(`[MIGRACIÓ SUMMARY] El camp 'summary' no existeix a '${tableName}'. Afegint columna...`);
                    db.run(`ALTER TABLE ${tableName} ADD COLUMN summary TEXT`, (alterErr) => {
                        if (alterErr) {
                            console.error(`[MIGRACIÓ SUMMARY] No s'ha pogut afegir la columna a ${tableName}:`, alterErr);
                        } else {
                            console.log(`✅ [MIGRACIÓ SUMMARY] Columna 'summary' afegida a '${tableName}' amb èxit.`);
                        }
                        resolve();
                    });
                });
            });
        };

        // Aplicar la nova migració a 'apps' i 'blog'
        await addSummaryColumn('apps');
        await addSummaryColumn('blog');

        console.log("Estructura de la base de dades assegurada.");
    });

    const getTableName = (type) => ({ project: 'projects', app: 'apps', blog: 'blog', projects: 'projects', apps: 'apps' })[type] || null;
    
    app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
    app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

    app.get('/api/media', (req, res) => {
        fs.readdir(UPLOADS_DIR, (err, files) => {
            if (err) return res.status(500).json({ error: "No es poden llegir les imatges." });
            const imageFiles = files.filter(file => /\.(jpg|jpeg|png|gif|webp)$/i.test(file));
            res.json(imageFiles.map(file => `/uploads/${file}`).sort((a, b) => b.localeCompare(a)));
        });
    });
    
    app.delete('/api/media', (req, res) => {
        const { filename } = req.body;
        if (!filename) {
            return res.status(400).json({ error: 'Nom d\'arxiu no proporcionat.' });
        }
        const safeFilename = path.basename(filename);
        const filePath = path.join(UPLOADS_DIR, safeFilename);
        if (filePath.indexOf(UPLOADS_DIR) !== 0) {
            return res.status(403).json({ error: 'Accés denegat.' });
        }
        fs.unlink(filePath, (err) => {
            if (err) {
                if (err.code === 'ENOENT') {
                    return res.status(404).json({ error: 'L\'arxiu no s\'ha trobat.' });
                }
                return res.status(500).json({ error: 'No s\'ha pogut eliminar l\'arxiu.' });
            }
            res.json({ success: true, message: `Arxiu ${safeFilename} eliminat.` });
        });
    });

    app.post('/api/upload', (req, res) => {
        if (!req.files || !req.files.image) return res.status(400).send('No s\'ha pujat cap arxiu.');
        const uploadedFile = req.files.image;
        const fileName = `${Date.now()}-${uploadedFile.name.replace(/\s/g, '_')}`;
        uploadedFile.mv(path.join(UPLOADS_DIR, fileName), (err) => {
            if (err) return res.status(500).send(err);
            res.json({ url: `/uploads/${fileName}` });
        });
    });

    const searchCache = new Map();
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
                    const searchKeys = tableName === 'projects' 
                        ? ['title', 'data.summary', 'data.technologies', 'data.features', 'data.description'] 
                        : (tableName === 'apps' 
                            ? ['title', 'summary', 'description'] 
                            : ['title', 'summary', 'content']);
                    const itemsToSearch = tableName === 'projects' ? allItems.map(item => ({...item, data: JSON.parse(item.data || '{}')})) : allItems;
                    const fuse = new Fuse(itemsToSearch, { keys: searchKeys, includeScore: true, threshold: 0.4, ignoreLocation: true, findAllMatches: true });
                    const searchResults = fuse.search(query);
                    let fuzzyItems = searchResults.map(result => result.item);
                    if (sort === 'oldest') fuzzyItems.sort((a, b) => (tableName === 'blog' ? new Date(a.date) - new Date(b.date) : a.id - b.id));
                    else if (sort === 'newest') fuzzyItems.sort((a, b) => (tableName === 'blog' ? new Date(b.date) - new Date(a.date) : b.id - a.id));
                    sortedIds = fuzzyItems.map(item => item.id);
                    searchCache.set(cacheKey, sortedIds);
                    setTimeout(() => searchCache.delete(cacheKey), 300000);
                }
                totalItems = sortedIds.length;
                const idsForPage = sortedIds.slice(offset, offset + limit);
                if (idsForPage.length > 0) {
                    const placeholders = idsForPage.map(() => '?').join(',');
                    const itemsFromDb = await runQuery(`SELECT * FROM ${tableName} WHERE id IN (${placeholders})`, idsForPage);
                    paginatedItems = idsForPage.map(id => itemsFromDb.find(item => item.id === id));
                }
            } else {
                searchCache.clear();
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
                // NOU: Prioritzem 'summary' per a la descripció de la targeta
                return { id: item.id, title: item.title, description: item.summary || item.description || item.content, imageUrl: item.imageUrl };
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
            // NOU: Afegim 'summary' a la creació
            const { title, content, date, imageUrl, status, description, url, summary } = req.body;
            const query = type === 'blog' 
                ? `INSERT INTO blog (title, content, date, imageUrl, status, summary) VALUES (?, ?, ?, ?, ?, ?)` 
                : `INSERT INTO ${table} (title, description, url, imageUrl, status, summary) VALUES (?, ?, ?, ?, ?, ?)`;
            const params = type === 'blog' 
                ? [title, content, date, imageUrl, status, summary] 
                : [title, description, url, imageUrl, status, summary];
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
            // NOU: Afegim 'summary' a l'actualització
            const { title, content, date, imageUrl, status, description, url, summary } = req.body;
            const query = type === 'blog' 
                ? `UPDATE blog SET title = ?, content = ?, date = ?, imageUrl = ?, status = ?, summary = ? WHERE id = ?` 
                : `UPDATE ${table} SET title = ?, description = ?, url = ?, imageUrl = ?, status = ?, summary = ? WHERE id = ?`;
            const params = type === 'blog' 
                ? [title, content, date, imageUrl, status, summary, id] 
                : [title, description, url, imageUrl, status, summary, id];
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