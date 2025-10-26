// check_fts5.js
const sqlite3 = require('sqlite3').verbose();

// Utilitzem una base de dades en memòria per no interferir amb el teu projecte
const db = new sqlite3.Database(':memory:', (err) => {
    if (err) {
        return console.error("❌ ERROR: No s'ha pogut obrir la base de dades en memòria.", err.message);
    }
    console.log("Connexió a la base de dades en memòria establerta.");
});

db.serialize(() => {
    // Intentem crear una taula virtual FTS5. Aquesta és la prova clau.
    db.run('CREATE VIRTUAL TABLE IF NOT EXISTS test_fts USING fts5(content);', (err) => {
        if (err) {
            console.error("\n❌ ERROR: FTS5 no està disponible o no funciona correctament en el teu entorn de Node.js/SQLite.");
            console.error("Detall de l'error:", err.message);
            console.log("\nSOLUCIÓ: Executa les següents comandes a la terminal per reinstal·lar el paquet de SQLite des del codi font:");
            console.log("1. npm uninstall sqlite3");
            console.log("2. npm install sqlite3 --build-from-source");
            db.close();
            return;
        }

        console.log("✅ La taula virtual FTS5 s'ha creat correctament.");

        // Si la creació funciona, fem una petita prova d'inserció i cerca
        db.run(`INSERT INTO test_fts(content) VALUES ('això és una prova a barcelona');`, function(err) {
            if (err) return console.error("Error inserint dades:", err.message);
            
            const searchTerm = 'barc*';
            db.get("SELECT * FROM test_fts WHERE test_fts MATCH ?", [searchTerm], (err, row) => {
                if (err) return console.error("Error buscant:", err.message);
                
                if (row) {
                    console.log(`✅ La cerca per '${searchTerm}' ha trobat un resultat:`, row);
                    console.log("\n🎉 FELICITATS! El teu entorn és correcte. El problema estava al codi del servidor. Utilitza el nou 'server.js' de la PART 2.");
                } else {
                    console.error("❌ ERROR INESPERAT: La cerca no ha retornat resultats tot i que l'entorn sembla correcte. Procedeix igualment amb la PART 2.");
                }
            });
        });
    });

    db.close((err) => {
        if (err) {
            return console.error(err.message);
        }
        console.log('Connexió tancada.');
    });
});