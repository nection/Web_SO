const express = require('express');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const fileUpload = require('express-fileupload');

const app = express();
const port = 3001;

// --- BLOC 1: CONFIGURACIÓ INICIAL I MIDDLEWARE ---

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir);
}

app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));
app.use(fileUpload());

app.use(express.static(__dirname));
app.use('/uploads', express.static(uploadsDir));

// --- BLOC 2: CONNEXIÓ I OPTIMITZACIÓ DE LA BASE DE DADES ---

const db = new sqlite3.Database('./portfolio.db', (err) => {
    if (err) {
        console.error("Error a l'obrir la base de dades", err.message);
    } else {
        console.log("Connectat a la base de dades SQLite.");
        // Creació de taules (si no existeixen)
        db.run(`CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT NOT NULL, url TEXT, imageUrl TEXT, status TEXT NOT NULL DEFAULT 'published')`);
        db.run(`CREATE TABLE IF NOT EXISTS apps (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT NOT NULL, url TEXT, imageUrl TEXT, status TEXT NOT NULL DEFAULT 'published')`);
        db.run(`CREATE TABLE IF NOT EXISTS blog (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, content TEXT NOT NULL, date TEXT, imageUrl TEXT, status TEXT NOT NULL DEFAULT 'published')`);
        
        // **NOU: Creació d'índexs per a millorar el rendiment de les cerques i ordenacions**
        // Aquests índexs acceleren les consultes a gran escala. Només es creen si no existeixen.
        db.run(`CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_apps_status ON apps(status)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_blog_status_date ON blog(status, date)`);
        console.log("Índexs de la base de dades assegurats.");
    }
});

const getTableName = (type) => {
    const validTypes = { project: 'projects', app: 'apps', blog: 'blog', projects: 'projects', apps: 'apps' };
    return validTypes[type] || null;
};

// --- BLOC 3: RUTES ESTÀTIQUES I D'UTILITAT ---

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

app.get('/api/media', (req, res) => {
    fs.readdir(uploadsDir, (err, files) => {
        if (err) return res.status(500).json({ error: "No es poden llegir les imatges." });
        const imageFiles = files.filter(file => /\.(jpg|jpeg|png|gif|webp)$/i.test(file));
        const imageUrls = imageFiles.map(file => `/uploads/${file}`).sort((a, b) => b.localeCompare(a));
        res.json(imageUrls);
    });
});

app.post('/api/upload', (req, res) => {
    if (!req.files || Object.keys(req.files).length === 0) return res.status(400).send('No s\'ha pujat cap arxiu.');
    const uploadedFile = req.files.image;
    const fileName = `${Date.now()}-${uploadedFile.name.replace(/\s/g, '_')}`;
    const uploadPath = path.join(uploadsDir, fileName);
    uploadedFile.mv(uploadPath, (err) => {
        if (err) return res.status(500).send(err);
        res.json({ url: `/uploads/${fileName}` });
    });
});

// --- BLOC 4: API PÚBLICA (PER A INDEX.HTML) - TOTALMENT REVISADA PER A ESCALABILITAT ---

// **ELIMINAT:** L'endpoint /api/data/all que carregava tot de cop ja no existeix.

// **NOU:** Aquest endpoint gestiona la paginació i la cerca per a la part pública.
app.get('/api/public/data/:type', async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = 12; // Nombre d'elements per pàgina a la vista pública
    const offset = (page - 1) * limit;
    const query = req.query.q || ''; // Terme de cerca

    const tableName = getTableName(req.params.type);
    if (!tableName) return res.status(400).json({ "error": `Tipus no vàlid: ${req.params.type}` });

    const runQuery = (sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows)));
    const getQuery = (sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));

    try {
        let whereClauses = ["status = 'published'"];
        let params = [];
        
        if (query) {
            const searchTerm = `%${query}%`;
            if (tableName === 'blog') {
                whereClauses.push(`(title LIKE ? OR content LIKE ?)`);
                params.push(searchTerm, searchTerm);
            } else {
                whereClauses.push(`(title LIKE ? OR description LIKE ?)`);
                params.push(searchTerm, searchTerm);
            }
        }

        const whereString = whereClauses.join(' AND ');

        const countResult = await getQuery(`SELECT COUNT(*) as count FROM ${tableName} WHERE ${whereString}`, params);
        const totalItems = countResult.count;
        const totalPages = Math.ceil(totalItems / limit);
        
        const orderBy = tableName === 'blog' ? 'date DESC' : 'id DESC';
        const items = await runQuery(`SELECT id, title, ${tableName === 'blog' ? 'content' : 'description'}, imageUrl FROM ${tableName} WHERE ${whereString} ORDER BY ${orderBy} LIMIT ? OFFSET ?`, [...params, limit, offset]);
        
        res.json({ items, totalPages, currentPage: page });

    } catch (err) {
        console.error(`Error a l'endpoint /api/public/data/${req.params.type}:`, err.message);
        res.status(500).json({ "error": "Error intern del servidor: " + err.message });
    }
});


// --- BLOC 5: API PRIVADA (PER A ADMIN.HTML) - SENSE CANVIS, JA ERA CORRECTA ---

// Endpoint per obtenir dades paginades per a l'admin
app.get('/api/data/:type', async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = 5; // Paginació més curta per a l'admin
    const offset = (page - 1) * limit;
    
    const typeParam = req.params.type;
    const singularType = (typeParam === 'blog') ? 'blog' : typeParam.slice(0, -1);
    const tableName = getTableName(singularType);

    if (!tableName) return res.status(400).json({ "error": `Tipus no vàlid: ${typeParam}` });

    const runQuery = (query, params = []) => new Promise((resolve, reject) => db.all(query, params, (err, rows) => err ? reject(err) : resolve(rows)));
    const getQuery = (query, params = []) => new Promise((resolve, reject) => db.get(query, params, (err, row) => err ? reject(err) : resolve(row)));

    try {
        const countResult = await getQuery(`SELECT COUNT(*) as count FROM ${tableName}`);
        const totalItems = countResult.count;
        const totalPages = Math.ceil(totalItems / limit);
        const orderBy = tableName === 'blog' ? 'date DESC' : 'id DESC';
        const items = await runQuery(`SELECT * FROM ${tableName} ORDER BY ${orderBy} LIMIT ? OFFSET ?`, [limit, offset]);
        
        res.json({ items, totalPages, currentPage: page });
    } catch (err) {
        console.error(`Error a l'endpoint /api/data/${req.params.type}:`, err.message);
        res.status(500).json({ "error": "Error intern del servidor: " + err.message });
    }
});

// Endpoint per obtenir un sol element (utilitzat per l'admin i ara també pel públic)
app.get('/api/item/:type/:id', (req, res) => {
    const { type, id } = req.params;
    const table = getTableName(type);
    if (!table) return res.status(400).json({ "error": "Tipus no vàlid" });
    db.get(`SELECT * FROM ${table} WHERE id = ?`, [id], (err, row) => {
        if (err) return res.status(500).json({ "error": err.message });
        res.json(row);
    });
});

// Endpoints per a afegir, editar, esborrar i canviar l'estat (només per a l'admin)
app.post('/api/add/:type', (req, res) => {
    const type = req.params.type;
    const table = getTableName(type);
    if (!table) return res.status(400).json({ "error": "Tipus no vàlid" });
    const body = req.body;
    let query, params;
    if (type === 'blog') {
        query = `INSERT INTO blog (title, content, date, imageUrl, status) VALUES (?, ?, ?, ?, ?)`;
        params = [body.title, body.content, body.date, body.imageUrl, body.status];
    } else {
        query = `INSERT INTO ${table} (title, description, url, imageUrl, status) VALUES (?, ?, ?, ?, ?)`;
        params = [body.title, body.description, body.url, body.imageUrl, body.status];
    }
    db.run(query, params, function(err) {
        if (err) return res.status(500).json({ "error": err.message });
        res.status(201).json({ id: this.lastID });
    });
});

app.put('/api/edit/:type/:id', (req, res) => {
    const { type, id } = req.params;
    const table = getTableName(type);
    if (!table) return res.status(400).json({ "error": "Tipus no vàlid" });
    const body = req.body;
    let query, params;
    if (type === 'blog') {
        query = `UPDATE blog SET title = ?, content = ?, date = ?, imageUrl = ?, status = ? WHERE id = ?`;
        params = [body.title, body.content, body.date, body.imageUrl, body.status, id];
    } else {
        query = `UPDATE ${table} SET title = ?, description = ?, url = ?, imageUrl = ?, status = ? WHERE id = ?`;
        params = [body.title, body.description, body.url, body.imageUrl, body.status, id];
    }
    db.run(query, params, function(err) {
        if (err) return res.status(500).json({ "error": err.message });
        res.json({ changes: this.changes });
    });
});

app.delete('/api/delete/:type/:id', (req, res) => {
    const { type, id } = req.params;
    const table = getTableName(type);
    if (!table) return res.status(400).json({ "error": "Tipus no vàlid" });
    db.run(`DELETE FROM ${table} WHERE id = ?`, id, function(err) {
        if (err) return res.status(500).json({ "error": err.message });
        res.json({ deleted: this.changes });
    });
});

app.put('/api/status/:type/:id', (req, res) => {
    const { type, id } = req.params;
    const { status } = req.body;
    const table = getTableName(type);
    if (!table) return res.status(400).json({ "error": "Tipus no vàlid" });
    db.run(`UPDATE ${table} SET status = ? WHERE id = ?`, [status, id], function(err) {
        if (err) return res.status(500).json({ "error": err.message });
        res.json({ changes: this.changes });
    });
});

// --- BLOC 6: INICI DEL SERVIDOR ---

app.listen(port, () => console.log(`Servidor escoltant a http://localhost:${port}`));