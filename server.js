const express = require('express');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const fileUpload = require('express-fileupload');

const app = express();
const port = 3001;

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir);
}

app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));
app.use(fileUpload());

app.use(express.static(__dirname));
app.use('/uploads', express.static(uploadsDir));

const db = new sqlite3.Database('./portfolio.db', (err) => {
    if (err) {
        console.error("Error a l'obrir la base de dades", err.message);
    } else {
        console.log("Connectat a la base de dades SQLite i creada de nou.");
        db.run(`CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT NOT NULL, url TEXT, imageUrl TEXT, status TEXT NOT NULL DEFAULT 'published')`);
        db.run(`CREATE TABLE IF NOT EXISTS apps (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT NOT NULL, url TEXT, imageUrl TEXT, status TEXT NOT NULL DEFAULT 'published')`);
        db.run(`CREATE TABLE IF NOT EXISTS blog (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, content TEXT NOT NULL, date TEXT, imageUrl TEXT, status TEXT NOT NULL DEFAULT 'published')`);
    }
});

const getTableName = (type) => {
    const validTypes = { project: 'projects', app: 'apps', blog: 'blog' };
    return validTypes[type] || null;
};

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

app.get('/api/data/all', (req, res) => {
    const data = {};
    db.all("SELECT * FROM projects WHERE status = 'published' ORDER BY id DESC", [], (err, rows) => {
        if (err) return res.status(500).json({ "error": err.message });
        data.projects = rows;
        db.all("SELECT * FROM apps WHERE status = 'published' ORDER BY id DESC", [], (err, rows) => {
            if (err) return res.status(500).json({ "error": err.message });
            data.apps = rows;
            db.all("SELECT * FROM blog WHERE status = 'published' ORDER BY date DESC", [], (err, rows) => {
                if (err) return res.status(500).json({ "error": err.message });
                data.blog = rows;
                res.json(data);
            });
        });
    });
});

app.get('/api/data/:type', async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = 5;
    const offset = (page - 1) * limit;
    
    const typeParam = req.params.type;
    const singularType = (typeParam === 'blog') ? 'blog' : typeParam.slice(0, -1);
    const tableName = getTableName(singularType);

    if (!tableName) {
        return res.status(400).json({ "error": `Tipus no vàlid: ${typeParam}` });
    }

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

app.get('/api/item/:type/:id', (req, res) => {
    const { type, id } = req.params;
    const table = getTableName(type);
    if (!table) return res.status(400).json({ "error": "Tipus no vàlid" });
    db.get(`SELECT * FROM ${table} WHERE id = ?`, [id], (err, row) => {
        if (err) return res.status(500).json({ "error": err.message });
        res.json(row);
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

app.listen(port, () => console.log(`Servidor escoltant a http://localhost:${port}`));