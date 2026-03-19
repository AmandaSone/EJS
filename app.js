//----------------------//
//       IMPORTS        //
//----------------------//
const express = require("express"); // Importerer Express for å lage serveren
const sqlite3 = require("sqlite3").verbose(); // Importerer SQLite3-driveren (med verbose for bedre logging)
const bodyParser = require("body-parser"); // Importerer body-parser for å lese data fra HTML-skjema
const bcrypt = require("bcrypt"); // Importerer bcrypt for sikker hashing av passord
const session = require("express-session"); // Importerer express-session for å håndtere innloggingssesjoner

//----------------------//
//      APP SETUP       //
//----------------------//
const app = express(); // Initialiserer en ny Express-applikasjon
const PORT = 3000; // Definerer porten serveren skal kjøre på (http://localhost:3000)

//----------------------//
//   VIEW & PARSERS     //
//----------------------//
app.set("view engine", "ejs"); // Setter EJS som templatemotor for server-renderte sider
app.use(bodyParser.urlencoded({ extended: true })); // Parser application/x-www-form-urlencoded (HTML-skjema)
app.use(express.json()); // Parser application/json (for API-kall)
app.use(express.static("public")); // Serverer statiske filer (CSS/JS/bilder) fra mappen /public

//----------------------//
//       SESSIONS       //
//----------------------//
app.use(session({ // Setter opp sesjonshåndtering for innlogging
  secret: "secret123", // Nøkkel for å signere session-cookie (bruk miljøvariabel i produksjon)
  resave: false, // Lagre ikke sesjonen på nytt hvis ingenting er endret
  saveUninitialized: false, // Opprett ikke sesjoner før noe er lagret i den
  cookie: { sameSite: "lax" } // Enkel CSRF-beskyttelse; greit for localhost-utvikling
})); // Slutt på session-konfig

//----------------------//
//   DEFAULT RES.LOCALS //
//----------------------//
app.use((req, res, next) => { // Middleware som kjører for alle requests
  res.locals.title = "Min app"; // Setter en standardtittel tilgjengelig i alle EJS-views (kan overstyres i res.render)
  next(); // Går videre til neste middleware/route
}); // Slutt på default locals

//----------------------//
//      DATABASE        //
//----------------------//
const db = new sqlite3.Database("./database.db"); // Åpner/bruker databasefilen database.db (opprettes hvis den ikke finnes)
db.serialize(() => { // Kjører følgende SQL-setninger sekvensielt
    db.run(` 
        CREATE TABLE IF NOT EXISTS User ( 
        UserID INTEGER PRIMARY KEY AUTOINCREMENT, -- Unik ID for bruker
        username TEXT UNIQUE, -- Unikt brukernavn (hindrer duplikater)
        password TEXT, -- Hash av passord (lagres med bcrypt)
        email TEXT, -- E-postadresse (kan settes UNIQUE hvis ønskelig)
        created_at TEXT -- ISO-dato for når brukeren ble opprettet
        )
    `); // Oppretter User-tabellen hvis den ikke finnes

    db.run(`
        CREATE TABLE IF NOT EXISTS Post (
        PostID INTEGER PRIMARY KEY AUTOINCREMENT, -- Unik ID for post
        UserID INTEGER, -- ID til brukeren som eier posten
        content TEXT, -- Innholdet i posten
        likes INTEGER DEFAULT 0 -- Antall likes, standard 0
        )
    `); // Oppretter Post-tabellen hvis den ikke finnes
}); // Slutt på db.serialize

//----------------------//
//   AUTH MIDDLEWARE    //
//----------------------//
function requireLogin(req, res, next) { // Middleware for å beskytte HTML/EJS-sider
  if (!req.session.userId) { // Sjekker om brukeren er innlogget (userId i session)
    return res.redirect("/login"); // Hvis ikke: redirect til innloggingsside
  } // Slutt på sjekk
  next(); // Hvis innlogget: gå videre
} // Slutt på requireLogin

function requireApiLogin(req, res, next) { // Middleware for å beskytte API-endepunkter
  if (!req.session.userId) { // Sjekker om brukeren er innlogget
    return res.status(401).json({ ok: false, error: "Ikke innlogget" }); // Returnerer 401 Unauthorized som JSON
  } // Slutt på sjekk
  next(); // Hvis innlogget: gå videre
} // Slutt på requireApiLogin

//----------------------//
//  HTML ROUTES (EJS)   //
//----------------------//
app.get("/", (req, res) => { // Forsiden: viser alle poster
  db.all("SELECT * FROM Post ORDER BY PostID DESC", [], (err, posts) => { // Henter alle poster sortert nyeste først
    if (err) { // Sjekker for databasefeil
      console.error(err); // Logger feilen i konsollen
      return res.status(500).send("Databasefeil"); // Sender 500-feil til klienten
    } // Slutt på feil-sjekk
    res.render("index", { posts, title: "Home", userId: req.session.userId || null }); // Renderer index.ejs med posts, tittel og (valgfritt) userId
  }); // Slutt på db.all callback
}); // Slutt på GET /

app.get("/signup", (req, res) => { // Registreringsside (viser skjema)
  res.render("signup", { title: "Registrer deg" }); // Renderer signup.ejs med tittel
}); // Slutt på GET /signup

app.get("/login", (req, res) => { // Innloggingsside (viser skjema)
  res.render("login", { title: "Logg inn" }); // Renderer login.ejs med tittel
}); // Slutt på GET /login

app.get("/dashboard", requireLogin, (req, res) => { // Beskyttet dashboard-side (krever innlogging)
  res.render("dashboard", { title: "Dashboard" }); // Renderer dashboard.ejs for innlogget bruker
}); // Slutt på GET /dashboard

app.get("/logout", (req, res) => { // Logg ut via link (HTML-rute)
  req.session.destroy((err) => { // Ødelegger sesjonen på serveren
    if (err) { // Sjekker om det oppstod feil
      console.error(err); // Logger feilen
    } // Slutt på feil-sjekk
    res.clearCookie("connect.sid"); // Fjerner session-cookien i nettleseren
    res.redirect("/"); // Sender brukeren tilbake til forsiden
  }); // Slutt på destroy callback
}); // Slutt på GET /logout

app.post("/add-post", requireLogin, (req, res) => { // Lager ny post via HTML-skjema (krever innlogging)
  const { content } = req.body; // Leser content fra skjemaet
  if (!content || !content.trim()) { // Validerer at content ikke er tomt
    return res.redirect("/"); // Hvis tomt: gå tilbake til forsiden uten å lagre
  } // Slutt på validering
  db.run( // Setter inn ny post i databasen
    "INSERT INTO Post (UserID, content) VALUES (?, ?)", // SQL for å opprette post
    [req.session.userId, content.trim()], // Verdier: innlogget brukerID og trimmed innhold
    (err) => { // Callback etter kjøring
      if (err) { // Sjekker for feil
        console.error(err); // Logger feilen
      } // Slutt på feil-sjekk
      res.redirect("/"); // Ved suksess: tilbake til forsiden
    } // Slutt på callback
  ); // Slutt på db.run
}); // Slutt på POST /add-post

//----------------------//
//     API: AUTH        //
//----------------------//
app.post("/api/auth/signup", async (req, res) => { // Registrering via API (JSON inn/ut)
  try { // Try-catch for uventede feil
    const { username, email, password } = req.body; // Leser felt fra JSON-body
    if (!username || !email || !password) { // Sjekker at alle felter finnes
      return res.status(400).json({ ok: false, error: "Mangler username, email eller password" }); // 400 Bad Request ved mangler
    } // Slutt på felt-sjekk
    if (password.length < 8) { // Enkel passordregel
      return res.status(400).json({ ok: false, error: "Passord må være minst 8 tegn" }); // 400 ved for kort passord
    } // Slutt på passord-sjekk

    const hashedPassword = await bcrypt.hash(password, 10); // Hasher passordet med 10 salt-runder

    db.run( // Setter inn ny bruker i databasen
      "INSERT INTO User (username, email, password, created_at) VALUES (?, ?, ?, ?)", // SQL for å opprette bruker
      [username, email, hashedPassword, new Date().toISOString()], // Verdier som settes inn
      function (err) { // Callback får tilgang til this.lastID
        if (err) { // Sjekker for databasefeil
          if (err.message && err.message.includes("UNIQUE")) { // Unikhetskonflikt (duplikat brukernavn)
            return res.status(409).json({ ok: false, error: "Brukernavn er allerede tatt" }); // 409 Conflict
          } // Slutt på unikhets-sjekk
          console.error(err); // Logger ukjent DB-feil
          return res.status(500).json({ ok: false, error: "Databasefeil" }); // 500 ved ukjent DB-feil
        } // Slutt på DB-feil-sjekk
        return res.status(201).json({ ok: true, message: "Bruker opprettet", userId: this.lastID }); // 201 Created med ny bruker-ID
      } // Slutt på callback
    ); // Slutt på db.run
  } catch (e) { // Fanger opp uventede feil
    console.error(e); // Logger feilen
    return res.status(500).json({ ok: false, error: "Uventet feil" }); // 500 ved uventet feil
  } // Slutt på catch
}); // Slutt på POST /api/auth/signup

app.post("/api/auth/login", (req, res) => { // Innlogging via API (JSON inn/ut)
  const { username, password } = req.body; // Leser brukernavn og passord fra JSON
  if (!username || !password) { // Sjekker at feltene finnes
    return res.status(400).json({ ok: false, error: "Mangler username eller password" }); // 400 ved mangler
  } // Slutt på felt-sjekk

  db.get( // Henter bruker basert på brukernavn
    "SELECT * FROM User WHERE username = ?", // SQL-spørring
    [username], // Parameter for spørringen
    async (err, user) => { // Callback etter at spørringen er kjørt
      if (err) { // Sjekker for DB-feil
        console.error(err); // Logger feilen
        return res.status(500).json({ ok: false, error: "Databasefeil" }); // 500 ved DB-feil
      } // Slutt på DB-feil-sjekk
      if (!user) { // Brukeren finnes ikke
        return res.status(401).json({ ok: false, error: "Feil brukernavn eller passord" }); // 401 Unauthorized (ikke avslør hva som er feil)
      } // Slutt på bruker-sjekk

      const match = await bcrypt.compare(password, user.password); // Sammenligner passord med hash
      if (!match) { // Hvis passord feil
        return res.status(401).json({ ok: false, error: "Feil brukernavn eller passord" }); // 401 ved feil passord
      } // Slutt på passord-sjekk

      req.session.userId = user.UserID; // Lagrer brukerens ID i sesjonen for å markere innlogging
      return res.status(200).json({ ok: true, message: "Innlogget", userId: user.UserID }); // 200 OK ved suksess
    } // Slutt på callback
  ); // Slutt på db.get
}); // Slutt på POST /api/auth/login

app.post("/api/auth/logout", (req, res) => { // Utlogging via API (JSON)
  req.session.destroy((err) => { // Ødelegger sesjonen
    if (err) { // Sjekker for feil
      console.error(err); // Logger feilen
      return res.status(500).json({ ok: false, error: "Kunne ikke logge ut" }); // 500 ved feil
    } // Slutt på feil-sjekk
    res.clearCookie("connect.sid"); // Sletter session-cookien
    return res.status(200).json({ ok: true, message: "Logget ut" }); // 200 OK ved suksess
  }); // Slutt på destroy callback
}); // Slutt på POST /api/auth/logout

//----------------------//
//     API: POSTS       //
//----------------------//
app.get("/api/posts", (req, res) => { // Henter alle poster via API (åpen)
  db.all("SELECT * FROM Post ORDER BY PostID DESC", [], (err, posts) => { // Henter poster fra DB
    if (err) { // Sjekker for DB-feil
      console.error(err); // Logger feil
      return res.status(500).json({ ok: false, error: "Databasefeil" }); // 500 ved DB-feil
    } // Slutt på feil-sjekk
    return res.status(200).json({ ok: true, posts }); // 200 OK med liste av poster
  }); // Slutt på db.all
}); // Slutt på GET /api/posts

app.post("/api/posts", requireApiLogin, (req, res) => { // Oppretter ny post via API (krever innlogging)
  const { content } = req.body; // Leser content fra JSON-body
  if (!content || !content.trim()) { // Validerer innholdet
    return res.status(400).json({ ok: false, error: "Mangler content" }); // 400 ved manglende content
  } // Slutt på validering
  db.run( // Setter inn ny post
    "INSERT INTO Post (UserID, content) VALUES (?, ?)", // SQL for å lage post
    [req.session.userId, content.trim()], // Verdier: innlogget bruker og trimmed content
    function (err) { // Callback etter SQL
      if (err) { // Sjekker for feil
        console.error(err); // Logger feilen
        return res.status(500).json({ ok: false, error: "Databasefeil" }); // 500 ved feil
      } // Slutt på feil-sjekk
      return res.status(201).json({ ok: true, message: "Post opprettet", postId: this.lastID }); // 201 Created med ny post-ID
    } // Slutt på callback
  ); // Slutt på db.run
}); // Slutt på POST /api/posts

//----------------------//
// LEGACY FORM AUTH (V) //
//----------------------//
app.post("/signup", async (req, res) => { // Legacy: Registrering via HTML-skjema (ikke API)
  try { // Try-catch for uventede feil
    const { username, email, password } = req.body; // Leser feltene fra skjema
    if (!username || !email || !password) { // Sjekker at feltene finnes
      return res.send("Mangler felter"); // Enkel respons ved mangler
    } // Slutt på felt-sjekk
    const hashedPassword = await bcrypt.hash(password, 10); // Hasher passordet
    db.run( // Setter inn ny bruker
      "INSERT INTO User (username, email, password, created_at) VALUES (?, ?, ?, ?)", // SQL for å opprette bruker
      [username, email, hashedPassword, new Date().toISOString()], // Verdier som settes inn
      function (err) { // Callback etter SQL
        if (err) { // Sjekker for feil
          console.log(err); // Logger feilen
          return res.send("User already exists"); // Enkel tekst ved duplikat
        } // Slutt på feil-sjekk
        res.redirect("/login"); // Redirecter til innloggingssiden ved suksess
      } // Slutt på callback
    ); // Slutt på db.run
  } catch (e) { // Fanger uventede feil
    console.error(e); // Logger feilen
    res.send("Uventet feil"); // Enkel feilmelding
  } // Slutt på catch
}); // Slutt på POST /signup

app.post("/login", (req, res) => { // Legacy: Innlogging via HTML-skjema (ikke API)
  const { username, password } = req.body; // Leser brukernavn og passord fra skjema
  db.get( // Henter bruker fra DB
    "SELECT * FROM User WHERE username = ?", // SQL-spørring
    [username], // Parameter inn i spørringen
    async (err, user) => { // Callback etter spørring
      if (!user) { // Hvis bruker ikke finnes
        return res.send("User not found"); // Enkel tekst-respons
      } // Slutt på bruker-sjekk
      const match = await bcrypt.compare(password, user.password); // Sjekker passordet mot hash
      if (match) { // Hvis passordet stemmer
        req.session.userId = user.UserID; // Lagre bruker-ID i session
        res.redirect("/dashboard"); // Send brukeren til dashboard
      } else { // Hvis passordet er feil
        res.send("Wrong password"); // Enkel tekst-respons
      } // Slutt på passord-sjekk
    } // Slutt på callback
  ); // Slutt på db.get
}); // Slutt på POST /login

//----------------------//
//     SERVER START     //
//----------------------//
app.listen(PORT, () => { // Starter HTTP-serveren og lytter på valgt port
  console.log(`Running on http://localhost:${PORT}`); // Logger URL-en der appen kjører
}); // Slutt på app.listen