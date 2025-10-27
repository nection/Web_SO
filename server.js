const express = require('express');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const fileUpload = require('express-fileupload');
const https = require('https');

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

async function addSummaryColumn(tableName) {
    return new Promise((resolve, reject) => {
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

async function startServer() {
    await repairCorruptDatabaseFile();
    
    if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

    app.use(bodyParser.json({ limit: '50mb' }));
    app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));
    app.use(fileUpload());
    app.use(express.static(__dirname));
    app.use('/uploads', express.static(UPLOADS_DIR));

    db = new sqlite3.Database(DB_PATH, async (err) => {
        if (err) return console.error("Error fatal a l'obrir la base de dades", err.message);
        console.log("Connectat a la base de dades SQLite principal.");
        
        await new Promise(res => db.run(`CREATE TABLE IF NOT EXISTS apps (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT, url TEXT, imageUrl TEXT, status TEXT NOT NULL DEFAULT 'published', summary TEXT)`, () => res()));
        await new Promise(res => db.run(`CREATE TABLE IF NOT EXISTS blog (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, content TEXT, date TEXT, imageUrl TEXT, status TEXT NOT NULL DEFAULT 'published', summary TEXT)`, () => res()));
        await new Promise(res => db.run(`CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, url TEXT, imageUrl TEXT, status TEXT NOT NULL DEFAULT 'published', data TEXT)`, () => res()));
        
        await migrateProjectSchema(db);
        await addSummaryColumn('apps');
        await addSummaryColumn('blog');

        const setupFtsForTable = async (tableName, contentFields) => {
            const ftsTableName = `${tableName}_fts`;
            const fieldsForFts = contentFields.join(', ');
            console.log(`[FTS5] Verificant l'índex de cerca per a la taula '${tableName}'...`);
            
            await new Promise(res => db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS ${ftsTableName} USING fts5(id, ${fieldsForFts}, content='${tableName}', content_rowid='id', tokenize = 'porter unicode61')`, () => res()));
            
            const triggers = `
                CREATE TRIGGER IF NOT EXISTS ${tableName}_after_insert AFTER INSERT ON ${tableName} BEGIN
                    INSERT INTO ${ftsTableName}(rowid, ${fieldsForFts}) VALUES (new.id, ${contentFields.map(f => `new.${f}`).join(', ')});
                END;
                CREATE TRIGGER IF NOT EXISTS ${tableName}_after_delete AFTER DELETE ON ${tableName} BEGIN
                    INSERT INTO ${ftsTableName}(${ftsTableName}, rowid, ${fieldsForFts}) VALUES ('delete', old.id, ${contentFields.map(f => `old.${f}`).join(', ')});
                END;
                CREATE TRIGGER IF NOT EXISTS ${tableName}_after_update AFTER UPDATE ON ${tableName} BEGIN
                    INSERT INTO ${ftsTableName}(${ftsTableName}, rowid, ${fieldsForFts}) VALUES ('delete', old.id, ${contentFields.map(f => `old.${f}`).join(', ')});
                    INSERT INTO ${ftsTableName}(rowid, ${fieldsForFts}) VALUES (new.id, ${contentFields.map(f => `new.${f}`).join(', ')});
                END;
            `;
            await new Promise((res, rej) => db.exec(triggers, err => err ? rej(err) : res()));
            
            const { count: ftsCount } = await new Promise((res, rej) => db.get(`SELECT count(*) as count FROM ${ftsTableName}`, (e, r) => e ? rej(e) : res(r || { count: 0 })));
            const { count: mainCount } = await new Promise((res, rej) => db.get(`SELECT count(*) as count FROM ${tableName}`, (e, r) => e ? rej(e) : res(r || { count: 0 })));
            
            if (ftsCount < mainCount) {
                console.log(`[FTS5] L'índex de '${tableName}' està desincronitzat o buit. Repoblant amb dades existents...`);
                await new Promise(res => db.run(`DELETE FROM ${ftsTableName}`, res));
                await new Promise(res => db.run(`INSERT INTO ${ftsTableName}(rowid, ${fieldsForFts}) SELECT id, ${fieldsForFts} FROM ${tableName}`, () => res()));
                console.log(`✅ [FTS5] Índex de '${tableName}' (re)poblat.`);
            } else {
                console.log(`[FTS5] L'índex de '${tableName}' ja existeix i està sincronitzat.`);
            }
        };

        const setupFtsForProjects = async () => {
            const ftsTableName = 'projects_fts';
            console.log(`[FTS5] Verificant l'índex de cerca per a la taula 'projects'...`);
        
            await new Promise(res => db.run(`DROP TABLE IF EXISTS ${ftsTableName}`, res));
        
            await new Promise(res => db.run(`CREATE VIRTUAL TABLE ${ftsTableName} USING fts5(title, summary, technologies, features, description, tokenize = 'porter unicode61')`, () => res()));
        
            console.log(`[FTS5] Repoblant índex de 'projects' amb l'estructura correcta...`);
            const allProjects = await new Promise((res, rej) => db.all('SELECT * FROM projects', (e, r) => e ? rej(e) : res(r)));
            const stmt = db.prepare(`INSERT INTO ${ftsTableName}(rowid, title, summary, technologies, features, description) VALUES (?, ?, ?, ?, ?, ?)`);
            for (const project of allProjects) {
                try {
                    const data = JSON.parse(project.data || '{}');
                    const technologies = Array.isArray(data.technologies) ? data.technologies.join(' ') : '';
                    const features = Array.isArray(data.features) ? data.features.join(' ') : '';
                    stmt.run(project.id, project.title, data.summary || '', technologies, features, data.description || '');
                } catch(e) { console.error(`[FTS5] Error processant projecte ID ${project.id} per a l'índex.`); }
            }
            await new Promise(res => stmt.finalize(res));
            console.log(`✅ [FTS5] Índex de 'projects' llest.`);
        };
        
        await setupFtsForTable('apps', ['title', 'summary', 'description']);
        await setupFtsForTable('blog', ['title', 'summary', 'content']);
        await setupFtsForProjects();

        console.log("Estructura de la base de dades i índexs de cerca assegurats.");
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
                const ftsTableName = `${tableName}_fts`;
                const ftsQuery = query.trim().split(' ').map(term => `${term}*`).join(' ');
                const searchResults = await runQuery(`SELECT rowid FROM ${ftsTableName} WHERE ${ftsTableName} MATCH ? ORDER BY rank`, [ftsQuery]);
                let sortedIds = searchResults.map(item => item.rowid);
                totalItems = sortedIds.length;

                if (sort !== 'relevance' && totalItems > 0) {
                     const placeholders = sortedIds.map(() => '?').join(',');
                     const dateField = tableName === 'blog' ? 'date' : 'id';
                     const itemsForSorting = await runQuery(`SELECT id, ${dateField} FROM ${tableName} WHERE id IN (${placeholders})`, sortedIds);
                     const idMap = new Map(itemsForSorting.map(i => [i.id, i[dateField]]));
                     if (sort === 'oldest') {
                        sortedIds.sort((a, b) => tableName === 'blog' ? new Date(idMap.get(a)) - new Date(idMap.get(b)) : a - b);
                     } else {
                        sortedIds.sort((a, b) => tableName === 'blog' ? new Date(idMap.get(b)) - new Date(idMap.get(a)) : b - a);
                     }
                }

                const idsForPage = sortedIds.slice(offset, offset + limit);
                if (idsForPage.length > 0) {
                    const placeholders = idsForPage.map(() => '?').join(',');
                    const itemsFromDb = await runQuery(`SELECT * FROM ${tableName} WHERE id IN (${placeholders})`, idsForPage);
                    paginatedItems = idsForPage.map(id => itemsFromDb.find(item => item.id === id)).filter(Boolean);
                }
            } else {
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
            const { count: total } = await new Promise((res, rej) => db.get(`SELECT COUNT(*) as count FROM ${tableName}`, (e, r) => e ? rej(e) : res(r)));
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
                try {
                    row.data = JSON.parse(row.data);
                } catch (e) {
                    console.error("Error al parsejar data del projecte ID:", id);
                    row.data = {};
                }
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
                
                const newId = this.lastID;
                const technologies = (data.technologies || []).join(' ');
                const features = (data.features || []).join(' ');
                db.run(`INSERT INTO projects_fts(rowid, title, summary, technologies, features, description) VALUES (?, ?, ?, ?, ?, ?)`,
                    [newId, title, data.summary || '', technologies, features, data.description || '']);
                
                res.status(201).json({ id: newId });
            });
        } else {
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
                
                const technologies = (data.technologies || []).join(' ');
                const features = (data.features || []).join(' ');
                db.run(`DELETE FROM projects_fts WHERE rowid = ?`, id, () => {
                    db.run(`INSERT INTO projects_fts(rowid, title, summary, technologies, features, description) VALUES (?, ?, ?, ?, ?, ?)`,
                        [id, title, data.summary || '', technologies, features, data.description || '']);
                });

                res.json({ changes: this.changes });
            });
        } else {
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

        if (type === 'project') {
            db.run(`DELETE FROM projects_fts WHERE rowid = ?`, id);
        }

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


    // --- LÒGICA D'INICI DEL SERVIDOR SEGUR I AUTOMÀTIC ---
    try {
        console.log("🔍 Buscant arxius de certificat SSL a la carpeta actual...");
        
        const files = fs.readdirSync(__dirname);
        const certKeyFile = files.find(file => file.endsWith('-key.pem'));
        const certFile = files.find(file => file.endsWith('.pem') && !file.endsWith('-key.pem'));

        if (!certKeyFile || !certFile) {
            throw new Error("No s'han trobat els arxius de certificat .pem. Executa l'script de desplegament per generar-los.");
        }

        console.log(`   -> Usant clau: ${certKeyFile}`);
        console.log(`   -> Usant certificat: ${certFile}`);

        const httpsOptions = {
            key: fs.readFileSync(path.join(__dirname, certKeyFile)),
            cert: fs.readFileSync(path.join(__dirname, certFile))
        };
    
        https.createServer(httpsOptions, app).listen(port, () => {
            console.log(`\n✅ Servidor segur iniciat correctament!`);
            console.log(`   Pots accedir des del teu Mac a: https://192.168.1.47:${port} o https://192.168.1.38:${port}`);
        });

    } catch (error) {
        console.error("\n\n❌ ERROR FATAL EN INICIAR EL SERVIDOR HTTPS:", error.message);
        console.error("Això normalment passa si els certificats no s'han generat. Prova de llançar l'script 'deploy.sh' manualment al servidor una vegada.");
        process.exit(1); // Atura l'aplicació si no pot arrencar de forma segura
    }
}

startServer();