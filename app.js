// Importerer innebygd 'path' for trygg håndtering av filstier på tvers av OS
const path = require('path'); // Brukes til å lage korrekte stier til views, public og databasefil

// Importerer Express-rammeverket
const express = require('express'); // Gjør det enkelt å lage HTTP-server og ruter

// Importerer SQLite3-driveren for Node.js
const sqlite3 = require('sqlite3').verbose(); // Lar oss koble til og kjøre SQL mot en lokal SQLite-fil

// Lager en ny Express-applikasjon
const app = express(); // Initialiserer Express-appen

// Setter portnummeret som serveren skal lytte på
const PORT = 3000; // Standard port for lokal utvikling

// Åpner/oppretter SQLite-databasefilen 'EJS_MusikkDatabase.db' i prosjektmappen
const db = new sqlite3.Database(path.join(__dirname, 'EJS_MusikkDatabase.db')); // Oppretter/åpner databasefilen der data lagres

// Oppretter 'songs'-tabellen hvis den ikke finnes fra før
db.serialize(() => { // Sørger for at SQL-kommandoer kjører i rekkefølge
  db.run(` -- Starter SQL for å lage tabellen
    CREATE TABLE IF NOT EXISTS songs (               -- Lager tabellen bare hvis den ikke finnes
      id INTEGER PRIMARY KEY AUTOINCREMENT,          -- Primærnøkkel som øker automatisk
      title TEXT NOT NULL,                           -- Sangtittel (påkrevd)
      artist TEXT NOT NULL,                          -- Artistnavn (påkrevd)
      listened_date TEXT NOT NULL,                   -- Dato i format YYYY-MM-DD (påkrevd)
      nationality TEXT NOT NULL                      -- Nasjonalitet (påkrevd)
)                                                -- Slutt på CREATE TABLE
  `); // Avslutter kjøringen av SQL-setningen
}); // Avslutter serialize-blokk

// Setter EJS som templatemotor
app.set('view engine', 'ejs'); // Forteller Express at .ejs-filer skal rendre HTML

// Angir mappen som inneholder EJS-visningene
app.set('views', path.join(__dirname, 'views')); // Sikrer korrekt sti til 'views'-mappen

// Gjør statiske filer tilgjengelig (f.eks. CSS) fra 'public'-mappen
app.use(express.static(path.join(__dirname, 'public'))); // Lar nettleseren hente /styles.css osv.

// Aktiverer parsing av URL-enkodede skjemaer (application/x-www-form-urlencoded)
app.use(express.urlencoded({ extended: true })); // Lar oss lese req.body ved POST fra HTML-skjema

// Hjelpefunksjon: kjør SELECT som henter flere rader (Promise-basert)
function dbAll(sql, params = []) { // Definerer en funksjon for å kjøre SELECT som returnerer flere rader
  return new Promise((resolve, reject) => { // Returnerer et Promise for å kunne bruke async/await
    db.all(sql, params, (err, rows) => { // Kjører spørringen med parametere
      if (err) return reject(err); // Avviser Promise hvis SQL-feil oppstår
      resolve(rows); // Løser Promise med resultat-radene
    }); // Avslutter callback for db.all
  }); // Avslutter Promise
} // Avslutter funksjonen dbAll

// Hjelpefunksjon: kjør INSERT/UPDATE/DELETE (Promise-basert)
function dbRun(sql, params = []) { // Definerer en funksjon for å kjøre skrivende spørringer
  return new Promise((resolve, reject) => { // Returnerer et Promise
    db.run(sql, params, function (err) { // Kjører spørringen og beholder 'this' for lastID/changes
      if (err) return reject(err); // Avviser Promise ved SQL-feil
      resolve(this); // Løser Promise med 'this' (inneholder lastID for INSERT)
    }); // Avslutter callback for db.run
  }); // Avslutter Promise
} // Avslutter funksjonen dbRun

// GET / - viser skjema for å legge inn sang og lister alle lagrede sanger
app.get('/', async (req, res) => { // Definerer rute for å vise startsiden
  try { // Starter try/catch for feilhandtering
    const songs = await dbAll( // Henter alle sanger fra databasen
      'SELECT id, title, artist, listened_date, nationality FROM songs ORDER BY listened_date DESC, id DESC', // SQL for å liste sanger
      [] // Ingen parametere for denne spørringen
    ); // Avslutter henting av sanger
    res.render('index', { title: 'Registrer sanger', songs, message: null }); // Renderer index.ejs med data
  } catch (err) { // Fanger eventuelle feil
    console.error(err); // Logger feilen i konsollen
    res.status(500).send('Noe gikk galt.'); // Sender en enkel feilmelding til klienten
  } // Avslutter try/catch
}); // Avslutter GET-ruten

// POST /songs - validerer og lagrer en ny sang i databasen
app.post('/songs', async (req, res) => { // Definerer rute for innsending av nytt sangskjema
  try { // Starter try/catch for å håndtere feil
    const { title, artist, listened_date, nationality } = req.body; // Leser ut feltene fra skjemaet
    if (!title || !artist || !listened_date || !nationality) { // Sjekker at alle felt er utfylt
      const songs = await dbAll('SELECT id, title, artist, listened_date, nationality FROM songs ORDER BY listened_date DESC, id DESC'); // Henter liste for visning ved feil
      return res.status(400).render('index', { title: 'Registrer sanger', songs, message: 'Fyll ut tittel, artist, dato og nasjonalitet.' }); // Viser feilmelding
    } // Avslutter validering for tomme felt
    if (!/^\d{4}-\d{2}-\d{2}$/.test(listened_date)) { // Sjekker at dato har format YYYY-MM-DD
      const songs = await dbAll('SELECT id, title, artist, listened_date, nationality FROM songs ORDER BY listened_date DESC, id DESC'); // Henter liste for visning ved feil
      return res.status(400).render('index', { title: 'Registrer sanger', songs, message: 'Dato må være i format YYYY-MM-DD.' }); // Viser feilmelding om datoformat
    } // Avslutter datoformat-sjekk
    await dbRun( // Kjører INSERT for å lagre sangen
      'INSERT INTO songs (title, artist, listened_date, nationality) VALUES (?, ?, ?, ?)', // SQL med parametere
      [title.trim(), artist.trim(), listened_date, nationality.trim()] // Verdier å sette inn (trim fjerner ekstra mellomrom)
    ); // Avslutter INSERT
    res.redirect('/'); // Sender brukeren tilbake til forsiden for å se oppdatert liste
  } catch (err) { // Fanger uventede feil
    console.error(err); // Logger feilen
    const songs = await dbAll('SELECT id, title, artist, listened_date, nationality FROM songs ORDER BY listened_date DESC, id DESC'); // Henter liste for visning ved feil
    res.status(500).render('index', { title: 'Registrer sanger', songs, message: 'Kunne ikke lagre sangen.' }); // Viser generell feilmelding
  } // Avslutter try/catch
}); // Avslutter POST-ruten

// Starter serveren
app.listen(PORT, () => { // Ber Express lytte på definert port
  console.log(`Server kjører på http://localhost:${PORT}`); // Logger URL for lett tilgang i nettleser
}); // Avslutter app.listen