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
      likes INTEGER DEFAULT 0, -- Antall likes, standard 0
      created_at TEXT -- ISO-dato for når posten ble laget
    )
  `); // Oppretter Post-tabellen (med created_at) hvis den ikke finnes

  db.run(`
    CREATE TABLE IF NOT EXISTS PostLike (       -- Link table for likes
      UserID INTEGER,                           -- Which user liked
      PostID INTEGER,                           -- Which post was liked
      PRIMARY KEY (UserID, PostID)              -- Enforce max 1 like per user per post
    )
  `); // End CREATE TABLE PostLike
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
app.get("/", (req, res) => { // Home page: list posts with author, likes, and viewer liked-flag
  const viewerId = req.session.userId || -1; // -1 when logged out (matches no rows in PostLike)

  const sql = `
    SELECT
      p.PostID,            -- Post id
      p.content,           -- Post content
      p.created_at,        -- Created timestamp
      p.likes,             -- Denormalized likes counter
      u.username,          -- Author username
      CASE WHEN l.UserID IS NULL THEN 0 ELSE 1 END AS liked -- 1 if current viewer liked
    FROM Post AS p
    JOIN User AS u
      ON p.UserID = u.UserID
    LEFT JOIN PostLike AS l
      ON l.PostID = p.PostID AND l.UserID = ?
    ORDER BY p.PostID DESC
  `; // End SQL

  db.all(sql, [viewerId], (err, posts) => { // Run the query with viewerId
    if (err) { // Handle DB error
      console.error("SQL error in GET /:", err.message); // Log detailed error
      return res.status(500).send("Databasefeil"); // Send generic error to client
    } // End error check

    res.render("index", { // Render the view
      posts, // Posts including username, likes, liked
      title: "Home", // Page title
      userId: req.session.userId || null // Pass userId to views (to hide/show like button)
    }); // End render
  }); // End db.all
}); // End GET /

app.get("/signup", (req, res) => { // Registreringsside (viser skjema)
  res.render("signup", { title: "Registrer deg" }); // Renderer signup.ejs med tittel
}); // Slutt på GET /signup

app.get("/login", (req, res) => { // Innloggingsside (viser skjema)
  res.render("login", { title: "Logg inn" }); // Renderer login.ejs med tittel
}); // Slutt på GET /login

app.get("/profile", requireLogin, (req, res) => { // Definerer GET /profile og beskytter den med requireLogin (må være innlogget)
  const userId = req.session.userId; // Leser innlogget bruker-ID fra session

  const sql = `               -- Starter SQL-spørring som henter brukerinfo og antall poster
    SELECT 
      u.UserID,               -- Henter brukerens ID
      u.username,             -- Henter brukernavn
      u.email,                -- Henter e-post (valgfritt å vise)
      u.created_at,           -- Henter tidspunkt for når brukeren ble opprettet
      (SELECT COUNT(*)        -- Teller antall rader i Post-tabellen
        FROM Post p 
        WHERE p.UserID = u.UserID) AS postCount -- Gir antall poster brukeren har laget som postCount
    FROM User u               -- Fra User-tabellen (alias u)
    WHERE u.UserID = ?        -- Filtrerer på innlogget bruker
  `; // Slutt på SQL-streng

  db.get(sql, [userId], (err, user) => { // Kjører spørringen, forventer én rad (db.get)
    if (err) { // Sjekker for databasefeil
      console.error(err); // Logger feilen
      return res.status(500).send("Databasefeil"); // Returnerer 500 hvis DB-feil
    } // Slutt på feil-sjekk

    if (!user) { // Hvis ingen bruker funnet (skulle ikke skje for gyldig session)
      return res.redirect("/logout"); // Logger ut hvis session er korrupt
    } // Slutt på bruker-sjekk

    const postsSql = `    -- SQL for å hente ALLE poster som denne brukeren har laget
      SELECT 
        p.PostID,         -- Postens ID
        p.content,        -- Innhold i posten
        p.created_at,     -- Når posten ble laget
        p.likes,          -- Antall likes på posten
        CASE WHEN l.UserID IS NULL THEN 0 ELSE 1 END AS liked -- Om innloggede bruker har likt posten (1/0)
      FROM Post p         -- Fra Post-tabellen
      LEFT JOIN PostLike l      -- Left-join for like-status
        ON p.PostID = l.PostID AND l.UserID = ?   -- Sjekk like-status for den innloggede brukeren (viewer = deg selv)
      WHERE p.UserID = ?        -- Filtrer på bruker
      ORDER BY p.PostID DESC    -- Nyeste først
    `; //Slutt SQL for poster

    db.all(postsSql, [userId, userId], (err2, posts) => { // Kjører spørringen for å hente poster
      if (err2) { // Sjekker for DB-feil
        console.error(err2);  // Logger feilen
        return res.status(500).send("Databasefeil");
      } // sLutt feil-sjekk

      res.render("profile", { title: "Profil", user, posts }); // Renderer profile.ejs og sender med user-objektet (inkl. postCount)
    }); // Slutt db.all for poster
  }); // Slutt på db.get callback
}); // Slutt på GET /profile

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

  const createdAt = new Date().toISOString(); // Lager et tidsstempel i ISO-format (lagres i DB)

  db.run( // Setter inn ny post i databasen
    "INSERT INTO Post (UserID, content, created_at) VALUES (?, ?, ?)", // SQL for å opprette post (inkl. created_at)
    [req.session.userId, content.trim(), createdAt], // Verdier: innlogget bruker, trimmed content og tidspunkt
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

app.post("/api/posts/:postId/like", requireApiLogin, (req, res) => { // Definerer API for å toggle like/unlike, krever innlogging
  const raw = req.params.postId; // Leser postId som tekst fra URL-parameter
  const postId = Number(raw); // Konverterer til tall (f.eks. "3" -> 3)
  if (!Number.isInteger(postId) || postId <= 0) { // Validerer at postId er et positivt heltall
    return res.status(400).json({ ok: false, error: "Invalid postId" }); // Returnerer 400 hvis ugyldig
  } // Slutt på validering

  const userId = req.session.userId; // Leser innlogget bruker-ID fra session
  const now = new Date().toISOString(); // Lager tidsstempel for like-raden

  // 1) Prøv å LIKE: sett inn rad i PostLike, men ignorer hvis den finnes fra før
  db.run( // Kjører en INSERT OR IGNORE for å unngå UNIQUE-konflikt når like finnes
    "INSERT OR IGNORE INTO PostLike (UserID, PostID) VALUES (?, ?)", // SQL for å prøve å like
    [userId, postId], // Verdier: innlogget bruker, aktuell post
    function (insErr) { // Callback etter at INSERT OR IGNORE er kjørt
      if (insErr) { // Sjekker om det oppstod databasefeil ved INSERT
        console.error("Error INSERT OR IGNORE PostLike:", insErr.message); // Logger detaljert feil
        return res.status(500).json({ ok: false, error: "Databasefeil" }); // Returnerer 500 ved DB-feil
      } // Slutt på feil-sjekk

      if (this.changes === 1) { // Hvis én rad ble satt inn nå: brukeren har nettopp LIKET
        db.run( // Øker likes-telleren i Post-tabellen
          "UPDATE Post SET likes = likes + 1 WHERE PostID = ?", // SQL for å inkrementere likes
          [postId], // Parameter: aktuell post
          function (updErr) { // Callback etter UPDATE
            if (updErr) { // Sjekker for DB-feil ved UPDATE
              console.error("Error UPDATE Post (like):", updErr.message); // Logger feil
              return res.status(500).json({ ok: false, error: "Databasefeil" }); // Returnerer 500 ved DB-feil
            } // Slutt på feil-sjekk
            db.get( // Leser oppdatert likes-verdi for å returnere til klient
              "SELECT likes FROM Post WHERE PostID = ?", // SQL for å hente likes
              [postId], // Parameter: aktuell post
              (cntErr, row) => { // Callback etter SELECT
                if (cntErr) { // Sjekker for feil ved SELECT
                  console.error("Error SELECT likes (like):", cntErr.message); // Logger feil
                  return res.status(500).json({ ok: false, error: "Databasefeil" }); // Returnerer 500 ved DB-feil
                } // Slutt på feil-sjekk
                return res.status(200).json({ ok: true, liked: true, likes: row.likes }); // Svar: LIKET, med ny teller
              } // Slutt på callback
            ); // Slutt på db.get
          } // Slutt på callback
        ); // Slutt på db.run (UPDATE)
        return; // Avslutter her når LIKE ble gjort
      } // Slutt på if (this.changes === 1)

      // 2) Hvis INSERT ikke gjorde endringer: raden fantes => brukeren har allerede liket → gjør UNLIKE
      db.run( // Sletter like-raden for å un-like
        "DELETE FROM PostLike WHERE UserID = ? AND PostID = ?", // SQL for å fjerne like
        [userId, postId], // Parametere: innlogget bruker og aktuell post
        function (delErr) { // Callback etter DELETE
          if (delErr) { // Sjekker for DB-feil ved DELETE
            console.error("Error DELETE PostLike (unlike):", delErr.message); // Logger feil
            return res.status(500).json({ ok: false, error: "Databasefeil" }); // Returnerer 500 ved DB-feil
          } // Slutt på feil-sjekk
          if (this.changes === 0) { // Hvis ingen rader ble slettet (uvanlig, men mulig ved inkonsistens)
            return res.status(200).json({ ok: true, liked: false, likes: undefined }); // Returnerer liked=false uten teller
          } // Slutt på if (this.changes === 0)

          db.run( // Reduserer likes-telleren, men ikke under 0
            "UPDATE Post SET likes = CASE WHEN likes > 0 THEN likes - 1 ELSE 0 END WHERE PostID = ?", // SQL for å decrementere
            [postId], // Parameter: aktuell post
            function (updErr2) { // Callback etter UPDATE
              if (updErr2) { // Sjekker for DB-feil ved UPDATE
                console.error("Error UPDATE Post (unlike):", updErr2.message); // Logger feil
                return res.status(500).json({ ok: false, error: "Databasefeil" }); // Returnerer 500 ved DB-feil
              } // Slutt på feil-sjekk
              db.get( // Leser oppdatert likes-verdi
                "SELECT likes FROM Post WHERE PostID = ?", // SQL for å hente likes
                [postId], // Parameter: aktuell post
                (cntErr2, row2) => { // Callback etter SELECT
                  if (cntErr2) { // Sjekker for feil ved SELECT
                    console.error("Error SELECT likes (unlike):", cntErr2.message); // Logger feil
                    return res.status(500).json({ ok: false, error: "Databasefeil" }); // Returnerer 500 ved DB-feil
                  } // Slutt på feil-sjekk
                  return res.status(200).json({ ok: true, liked: false, likes: row2.likes }); // Svar: UNLIKET, med ny teller
                } // Slutt på callback
              ); // Slutt på db.get
            } // Slutt på callback
          ); // Slutt på db.run (UPDATE)
        } // Slutt på callback
      ); // Slutt på db.run (DELETE)
    } // Slutt på callback for INSERT OR IGNORE
  ); // Slutt på db.run (INSERT OR IGNORE)
}); // Slutt på POST /api/posts/:postId/like

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
        res.redirect("/profile"); // Send brukeren til profile
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