const express = require('express');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const port = 3000;

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// *** NOU: Línia per servir arxius estàtics (imatges, etc.) des de la carpeta arrel ***
app.use(express.static(__dirname));

// Configuració de la base de dades SQLite
const db = new sqlite3.Database('./portfolio.db', (err) => {
    if (err) {
        console.error("Error a l'obrir la base de dades", err.message);
    } else {
        console.log("Connectat a la base de dades SQLite.");
        // Creem les taules si no existeixen
        db.run(`CREATE TABLE IF NOT EXISTS projects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            description TEXT NOT NULL,
            url TEXT
        )`);
        db.run(`CREATE TABLE IF NOT EXISTS apps (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            description TEXT NOT NULL,
            url TEXT
        )`);
        db.run(`CREATE TABLE IF NOT EXISTS blog (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            date TEXT
        )`);
    }
});

// Servir arxius estàtics (pàgines principals)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

// API per obtenir totes les dades
app.get('/api/data', (req, res) => {
    const data = {};
    db.all("SELECT * FROM projects", [], (err, rows) => {
        if (err) {
            res.status(500).json({ "error": err.message });
            return;
        }
        data.projects = rows;
        db.all("SELECT * FROM apps", [], (err, rows) => {
            if (err) {
                res.status(500).json({ "error": err.message });
                return;
            }
            data.apps = rows;
            db.all("SELECT * FROM blog", [], (err, rows) => {
                if (err) {
                    res.status(500).json({ "error": err.message });
                    return;
                }
                data.blog = rows;
                res.json(data);
            });
        });
    });
});

// API per afegir un nou element
app.post('/api/add/:type', (req, res) => {
    const type = req.params.type;
    const { title, description, url, content, date } = req.body;

    let query = '';
    let params = [];

    switch (type) {
        case 'project':
            query = `INSERT INTO projects (title, description, url) VALUES (?, ?, ?)`;
            params = [title, description, url];
            break;
        case 'app':
            query = `INSERT INTO apps (title, description, url) VALUES (?, ?, ?)`;
            params = [title, description, url];
            break;
        case 'blog':
            query = `INSERT INTO blog (title, content, date) VALUES (?, ?, ?)`;
            params = [title, content, date];
            break;
        default:
            return res.status(400).json({ "error": "Tipus no vàlid" });
    }

    db.run(query, params, function(err) {
        if (err) {
            return res.status(500).json({ "error": err.message });
        }
        res.json({ id: this.lastID });
    });
});

// API per editar un element
app.put('/api/edit/:type/:id', (req, res) => {
    const type = req.params.type;
    const id = req.params.id;
    const { title, description, url, content, date } = req.body;

    let query = '';
    let params = [];

    switch (type) {
        case 'project':
            query = `UPDATE projects SET title = ?, description = ?, url = ? WHERE id = ?`;
            params = [title, description, url, id];
            break;
        case 'app':
            query = `UPDATE apps SET title = ?, description = ?, url = ? WHERE id = ?`;
            params = [title, description, url, id];
            break;
        case 'blog':
            query = `UPDATE blog SET title = ?, content = ?, date = ? WHERE id = ?`;
            params = [title, content, date, id];
            break;
        default:
            return res.status(400).json({ "error": "Tipus no vàlid" });
    }

    db.run(query, params, function(err) {
        if (err) {
            return res.status(500).json({ "error": err.message });
        }
        res.json({ changes: this.changes });
    });
});

// API per esborrar un element
app.delete('/api/delete/:type/:id', (req, res) => {
    const type = req.params.type;
    const id = req.params.id;
    let table = '';

    switch (type) {
        case 'project':
            table = 'projects';
            break;
        case 'app':
            table = 'apps';
            break;
        case 'blog':
            table = 'blog';
            break;
        default:
            return res.status(400).json({ "error": "Tipus no vàlid" });
    }

    const query = `DELETE FROM ${table} WHERE id = ?`;
    db.run(query, id, function(err) {
        if (err) {
            return res.status(500).json({ "error": err.message });
        }
        res.json({ deleted: this.changes });
    });
});


app.listen(port, () => {
    console.log(`Servidor escoltant a http://localhost:${port}`);
});