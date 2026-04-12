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

  // Nye defaults for sort/filter — brukes av index.ejs toolbaren
  if (typeof res.locals.currentSort === 'undefined') {
    res.locals.currentSort = 'latest';          // Standard sortering
  }
  if (typeof res.locals.currentFilter === 'undefined') {
    res.locals.currentFilter = 'all';           // Standard filter (forberedt for 'following')
  }

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
      email TEXT UNIQUE, -- Unik E-postadresse (hindrer duplikater)
      created_at TEXT -- ISO-dato for når brukeren ble opprettet
    )
  `); // Oppretter User-tabellen hvis den ikke finnes

  db.run(`
  CREATE TABLE IF NOT EXISTS Post (
    PostID INTEGER PRIMARY KEY AUTOINCREMENT, -- Unik ID for post
    UserID INTEGER,                            -- Hvem som eier posten
    content TEXT,                              -- Innhold i posten
    created_at TEXT,                           -- Når posten ble laget
    ParentPostID INTEGER                       -- NULL for toppnivå; ellers peker til en annen PostID (kommentar)
  )
`); // Lager Post-tabellen hvis den ikke finnes

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
app.get("/", (req, res) => { // Definerer GET / som hovedfeed
  const viewerId = req.session.userId || -1; // Leser innlogget bruker-ID, eller -1 hvis utlogget (match’er ingen like-rader)
  const sort = (req.query.sort || "latest").toLowerCase(); // Leser sorteringsvalg fra URL (?sort=...), default 'latest'
  const filter = (req.query.filter || "all").toLowerCase(); // Leser filter (?filter=...), default 'all' (for fremtidig "following")

  // Hvitliste gyldige verdier slik at vi ikke bruker user input direkte i ORDER BY
  const validSorts = new Set(["latest", "trending"]); // Gyldige sort-verdier
  const chosenSort = validSorts.has(sort) ? sort : "latest"; // Hvis ugyldig: bruk 'latest'

  const validFilters = new Set(["all", "following"]); // Gyldige filter (forberedt for framtidig bruk)
  const chosenFilter = validFilters.has(filter) ? filter : "all"; // Hvis ugyldig: bruk 'all'

  console.log('HOME sort:', req.query.sort, 'chosenSort:', chosenSort); // Hjelper å verifisere at chosenSort settes
  
  // Bygg WHERE-klausul for toppnivå-innlegg (ParentPostID IS NULL) og ev. "following"
  let whereClause = "p.ParentPostID IS NULL"; // Viser bare toppnivå-innlegg i feeden
  const params = []; // Parametre som skal inn i SQL
  // Merk: Vi legger viewerId til egen param-liste for liked-sjekk nedenfor, så vi gjør to ting: liked-join + where/params

  // ORDER BY avhenger av valgt sortering
  const orderBy =
    chosenSort === "trending"
      ? "(likeCount + commentCount) DESC, p.created_at DESC" // Trending: sorter på sum likes+kommentarer, tie-break på nyeste først
      : "p.created_at DESC"; // Latest: nyeste først

  // SQL for å hente toppnivå-innlegg med likeCount, commentCount og liked (for viewer)
  const postsSql = `
    SELECT
      p.PostID,                                                        -- Postens ID
      p.content,                                                       -- Innholdet i posten
      p.created_at,                                                    -- Når posten ble laget
      u.username,                                                      -- Forfatterens brukernavn
      (SELECT COUNT(*) FROM PostLike pl WHERE pl.PostID = p.PostID) AS likeCount,    -- Antall likes
      (SELECT COUNT(*) FROM Post c WHERE c.ParentPostID = p.PostID)   AS commentCount, -- Antall kommentarer
      CASE WHEN l.UserID IS NULL THEN 0 ELSE 1 END AS liked           -- Om viewer har liket (1/0)
    FROM Post AS p                                                     -- Leser fra Post-tabellen
    JOIN User AS u ON u.UserID = p.UserID                              -- Joiner for å hente forfatterens navn
    LEFT JOIN PostLike AS l                                            -- Venstrejoin for å sjekke om viewer har liket
      ON l.PostID = p.PostID AND l.UserID = ?                          -- Må matche både PostID og viewerId
    WHERE ${whereClause}                                               -- Bruk den dynamiske WHERE-klausulen
    ORDER BY ${orderBy}                                                -- Bruk valgt sortering
  `; // Slutt SQL for innlegg

  // Bygg parametere til postsSql: viewerId må være første param (for liked-join), deretter ev. filter-parametre
  const postParams = [viewerId, ...params]; // Setter viewerId først (for LEFT JOIN), så filterparametre (om noen)

  db.all(postsSql, postParams, (err, topPosts) => { // Kjører spørringen for å hente innlegg
    if (err) { // Feilhåndtering for DB
      console.error("SQL-feil i GET / (posts):", err.message); // Logger detaljert feil
      return res.status(500).send("Databasefeil"); // Sender 500 ved feil
    } // Slutt feil-sjekk

    if (topPosts.length === 0) { // Hvis ingen innlegg
      return res.render("index", { // Renderer index med tom liste
        posts: [], // Ingen innlegg
        commentsByParent: {}, // Ingen kommentarer
        title: "Home", // Side-tittel
        userId: req.session.userId || null, // Viewer ID for UI
        currentSort: chosenSort, // Sender valgt sortering tilbake til view
        currentFilter: chosenFilter // Sender valgt filter tilbake til view
      }); // Slutt render
    } // Slutt tomt tilfelle

    // Hent kommentarer til alle disse toppnivå-innleggene i ett kall
    const parentIds = topPosts.map(p => p.PostID); // Samler post-id-ene
    const placeholders = parentIds.map(() => "?").join(","); // Lager (?, ?, ?) til IN-klausul

    const commentsSql = `
      SELECT
        c.PostID,                             -- Kommentarens ID (også PostID)
        c.ParentPostID,                       -- Hvilken toppnivå-post den hører til
        c.content,                            -- Kommentar-tekst
        c.created_at,                         -- Tidsstempel
        u.username                            -- Forfatterens brukernavn
      FROM Post AS c                          -- Kommentarer er rader i Post med ParentPostID satt
      JOIN User AS u ON u.UserID = c.UserID   -- Join for forfatter
      WHERE c.ParentPostID IN (${placeholders}) -- Kun kommentarer til disse postene
      ORDER BY c.created_at ASC               -- Eldst → nyest for naturlig leserekkefølge
    `; // Slutt SQL kommentarer

    db.all(commentsSql, parentIds, (err2, comments) => { // Kjører kommentarsøk
      if (err2) { // Feilhåndtering DB
        console.error("SQL-feil i GET / (comments):", err2.message); // Logger feil
        return res.status(500).send("Databasefeil"); // Sender 500 ved feil
      } // Slutt feil-sjekk

      // Grupper kommentarer per ParentPostID så EJS enkelt kan hente commentsByParent[postId]
      const commentsByParent = {}; // Oppslagsobjekt: parentId -> liste av kommentarer
      for (const c of comments) { // Løkke over alle kommentarer
        const pid = c.ParentPostID; // Leser parent-id
        if (!commentsByParent[pid]) commentsByParent[pid] = []; // Opprett liste hvis den ikke finnes
        commentsByParent[pid].push(c); // Legg kommentaren i riktig liste
      } // Slutt grouping-løkke

      // Render index.ejs med alt som trengs
      res.render("index", { // Renderer view
        posts: topPosts, // Innleggsliste (allerede sortert etter valgt strategi)
        commentsByParent, // Kommentarer gruppert per post
        title: "Home", // Side-tittel
        userId: req.session.userId || null, // Viewer
        currentSort: chosenSort, // ‘latest’ eller ‘trending’ (for UI-markering)
        currentFilter: chosenFilter // ‘all’ eller ‘following’ (for fremtidig bruk)
      }); // Slutt render
    }); // Slutt db.all (kommentarer)
  }); // Slutt db.all (innlegg)
}); // Slutt GET /

app.get("/signup", (req, res) => { // Registreringsside (viser skjema)
  res.render("signup", { title: "Registrer deg" }); // Renderer signup.ejs med tittel
}); // Slutt på GET /signup

app.get("/login", (req, res) => { // Innloggingsside (viser skjema)
  res.render("login", { title: "Logg inn" }); // Renderer login.ejs med tittel
}); // Slutt på GET /login

app.get("/profile", requireLogin, (req, res) => { // Definerer GET /profile og beskytter den med requireLogin (må være innlogget)
  const userId = req.session.userId; // Leser innlogget bruker-ID fra session

  const userSql = `               -- SQL for å hente brukerinfo + postCount
    SELECT 
      u.UserID,                   -- Brukerens ID
      u.username,                 -- Brukernavn
      u.email,                    -- E-post (valgfritt å vise)
      u.created_at,               -- Når brukeren ble opprettet
      (SELECT COUNT(*) FROM Post p WHERE p.UserID = u.UserID AND p.ParentPostID IS NULL) AS postCount -- Antall toppnivå-innlegg
    FROM User u                   -- Fra User-tabellen
    WHERE u.UserID = ?            -- Filtrer på innlogget bruker
  `; // Slutt SQL for bruker

  db.get(userSql, [userId], (err, user) => { // Kjører spørringen for å hente bruker
    if (err) { // Sjekker for DB-feil
      console.error(err.message); // Logger feilmelding
      return res.status(500).send("Databasefeil"); // Returnerer 500 ved feil
    } // Slutt feil-sjekk

    if (!user) { // Hvis ingen bruker funnet (bør ikke skje)
      return res.redirect("/logout"); // Logger ut hvis session er korrupt
    } // Slutt bruker-sjekk

    const postsSql = `            -- SQL for å hente ALLE toppnivå-innlegg som denne brukeren har laget
      SELECT 
        p.PostID,                 -- Postens ID
        p.content,                -- Innhold i posten
        p.created_at,             -- Når posten ble laget
        (SELECT COUNT(*) FROM PostLike pl WHERE pl.PostID = p.PostID) AS likeCount, -- Antall likes (telles fra PostLike)
        (SELECT COUNT(*) FROM Post c WHERE c.ParentPostID = p.PostID) AS commentCount, -- Antall kommentarer
        CASE WHEN l.UserID IS NULL THEN 0 ELSE 1 END AS liked -- Om innlogget bruker (deg) har liket
      FROM Post AS p              -- Fra Post-tabellen
      LEFT JOIN PostLike AS l     -- Venstre-join for like-status for viewer (deg)
        ON l.PostID = p.PostID 
       AND l.UserID = ?           -- Sjekk like-status for deg selv
      WHERE p.UserID = ?          -- Bare dine poster
        AND p.ParentPostID IS NULL-- Kun toppnivå-innlegg (ikke kommentarer)
      ORDER BY p.PostID DESC      -- Nyeste først
    `; // Slutt SQL for poster

    db.all(postsSql, [userId, userId], (err2, posts) => { // Kjører spørringen for å hente poster
      if (err2) { // Sjekker for DB-feil
        console.error(err2.message); // Logger feilmelding
        return res.status(500).send("Databasefeil"); // Returnerer 500 ved feil
      } // Slutt feil-sjekk

      if (posts.length === 0) { // Hvis brukeren ikke har noen toppnivå-innlegg
        return res.render("profile", { // Renderer uten kommentarer
          title: "Profil", // Side-tittel
          user, // Bruker-objektet
          posts: [], // Ingen poster
          commentsByParent: {}, // Ingen kommentarer
          userId: req.session.userId || null, // Viewer ID til view
          isOwnProfile: true // VIKTIG: egen profil → vis Logout/Delete
        }); // Slutt render
      } // Slutt hvis ingen poster

      const parentIds = posts.map(p => p.PostID); // Samler alle PostID for å hente kommentarene
      const placeholders = parentIds.map(() => "?").join(","); // Lager (?, ?, ?) for IN-klausul

      const commentsSql = `       -- SQL for å hente ALLE kommentarer til disse postene i ett kall
        SELECT
          c.PostID,               -- Kommentarens ID (også PostID)
          c.ParentPostID,         -- ID til toppnivå-posten kommentaren hører til
          c.content,              -- Kommentar-tekst
          c.created_at,           -- Når kommentaren ble laget
          u.username              -- Forfatterens brukernavn
        FROM Post AS c
        JOIN User AS u ON u.UserID = c.UserID
        WHERE c.ParentPostID IN (${placeholders}) -- Bare kommentarer til brukerens toppnivå-innlegg
        ORDER BY c.created_at ASC                 -- Eldst → nyest for naturlig leserekkefølge
      `; // Slutt SQL for kommentarer

      db.all(commentsSql, parentIds, (err3, comments) => { // Kjører spørringen for å hente kommentarer
        if (err3) { // Sjekker for DB-feil
          console.error(err3.message); // Logger feilmelding
          return res.status(500).send("Databasefeil"); // Returnerer 500 ved feil
        } // Slutt feil-sjekk

        const commentsByParent = {}; // Lager et oppslagsobjekt: parentId -> liste av kommentarer
        for (const c of comments) { // Går gjennom alle kommentarer
          const pid = c.ParentPostID; // Leser parent-id
          if (!commentsByParent[pid]) commentsByParent[pid] = []; // Oppretter liste hvis mangler
          commentsByParent[pid].push(c); // Legger kommentaren inn i lista til riktig parent
        } // Slutt løkke

        // Renderer profile.ejs med både user, posts og commentsByParent
        res.render("profile", { // Renderer profilen
          title: "Profil", // Side-tittel
          user, // Brukerinfo
          posts, // Dine toppnivå-innlegg
          commentsByParent, // Kommentarer gruppert per parent
          userId: req.session.userId || null, // Viewer ID til view
          isOwnProfile: true // VIKTIG: egen profil → vis Logout/Delete
        }); // Slutt render
      }); // Slutt db.all (kommentarer)
    }); // Slutt db.all (poster)
  }); // Slutt db.get (bruker)
}); // Slutt GET /profile

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

app.get("/trending", (req, res) => { // Definerer GET /trending for "mest engasjement"
  const viewerId = req.session.userId || -1; // Leser innlogget bruker-ID eller -1 (matcher ingen like-rader)

  const postsSql = `                       -- SQL for å hente toppnivå-innlegg med like- og kommentar-teller
    SELECT
      p.PostID,                             -- Postens ID
      p.content,                            -- Innhold
      p.created_at,                         -- Når innlegget ble laget
      u.username,                           -- Forfatterens brukernavn
      (SELECT COUNT(*) FROM PostLike pl 
        WHERE pl.PostID = p.PostID) AS likeCount,    -- Antall likes for denne posten
      (SELECT COUNT(*) FROM Post c 
        WHERE c.ParentPostID = p.PostID) AS commentCount, -- Antall kommentarer for denne posten
      CASE WHEN l.UserID IS NULL THEN 0 ELSE 1 END AS liked -- Om viewer har liket (1/0)
    FROM Post AS p                          -- Leser fra Post-tabellen
    JOIN User AS u                           -- Joiner med User for forfatternavn
      ON u.UserID = p.UserID                 -- Knytt Post->User
    LEFT JOIN PostLike AS l                  -- Venstrejoin for å sjekke om viewer har liket
      ON l.PostID = p.PostID AND l.UserID = ? -- Samme post + viewer
    WHERE p.ParentPostID IS NULL             -- Kun toppnivå (ikke kommentarer)
    ORDER BY (likeCount + commentCount) DESC, -- Sorter synkende på sum likes+kommentarer
            p.created_at DESC               -- Ved lik score, nyeste først (valgfri tie-breaker)
  `; // Slutt SQL

  db.all(postsSql, [viewerId], (err, topPosts) => { // Kjører spørringen med viewerId
    if (err) { // Feilhåndtering for DB
      console.error("SQL-feil i GET /trending (posts):", err.message); // Logger detaljert
      return res.status(500).send("Databasefeil"); // Sender 500 ved feil
    } // Slutt feil-sjekk

    if (topPosts.length === 0) { // Hvis ingen poster å vise
      return res.render("trending", {               // Renderer tom liste
        posts: [],                                  // Ingen poster
        commentsByParent: {},                       // Ingen kommentarer
        title: "Trending",                          // Side-tittel
        userId: req.session.userId || null          // Sender videre userId for UI
      }); // Slutt render
    } // Slutt tom-tilfelle

    const parentIds = topPosts.map(p => p.PostID); // Samler PostID for alle toppnivå
    const placeholders = parentIds.map(() => "?").join(","); // Lager (?, ?, ?) til IN-klausul

    const commentsSql = `                   -- Henter alle kommentarer for disse postene i ett kall
      SELECT
        c.PostID,                           -- Kommentarens id (også PostID)
        c.ParentPostID,                     -- Hvilken topp-post den tilhører
        c.content,                          -- Kommentar-tekst
        c.created_at,                       -- Tidsstempel for kommentar
        u.username                          -- Forfatterens brukernavn
      FROM Post AS c                        -- Kommentarer er rader i Post med ParentPostID satt
      JOIN User AS u ON u.UserID = c.UserID -- Join for forfatter
      WHERE c.ParentPostID IN (${placeholders}) -- Bare kommentarer til utvalgte toppposter
      ORDER BY c.created_at ASC             -- Eldst -> nyest for naturlig lesing
    `; // Slutt SQL

    db.all(commentsSql, parentIds, (err2, comments) => { // Kjører kommentarspørringen
      if (err2) { // Feilhåndtering DB
        console.error("SQL-feil i GET /trending (comments):", err2.message); // Logger feil
        return res.status(500).send("Databasefeil"); // Sender 500 ved feil
      } // Slutt feil-sjekk

      const commentsByParent = {}; // Lager grouping: parentId -> liste av kommentarer
      for (const c of comments) { // Går gjennom alle kommentarer
        const pid = c.ParentPostID; // Leser parent-ID
        if (!commentsByParent[pid]) commentsByParent[pid] = []; // Oppretter liste hvis mangler
        commentsByParent[pid].push(c); // Legger kommentaren i riktig liste
      } // Slutt grouping

      res.render("trending", {                 // Renderer trending.ejs
        posts: topPosts,                       // Sender toppposter med tellerne/liked
        commentsByParent,                      // Sender kommentarene gruppert
        title: "Trending",                     // Side-tittel
        userId: req.session.userId || null     // Gjør userId tilgjengelig for view
      }); // Slutt render
    }); // Slutt db.all (comments)
  }); // Slutt db.all (posts)
}); // Slutt GET /trending

app.get("/u/:username", (req, res) => {                               // Definerer offentlig profilside på /u/:username
  const viewerId = req.session.userId || -1;                           // Leser innlogget bruker-ID (eller -1 hvis utlogget)
  const handle = req.params.username;                                  // Leser brukernavn fra URL

  const userSql = `
    SELECT
      u.UserID,
      u.username,
      u.email,
      u.created_at,
      (SELECT COUNT(*) FROM Post p WHERE p.UserID = u.UserID AND p.ParentPostID IS NULL) AS postCount
    FROM User AS u
    WHERE u.username = ?
  `;

  db.get(userSql, [handle], (err, user) => {
    if (err) {
      console.error("Public profile: user SQL error:", err.message); // Logg konkret
      return res.status(500).send("Databasefeil");
    }
    if (!user) {                                                       // Hvis ingen bruker med dette navnet
      return res.status(404).send("User not found");                   // 404: ikke funnet
    }                                                                  // Slutt ikke funnet

    const postsSql = `
      SELECT
        p.PostID,
        p.content,
        p.created_at,
        (SELECT COUNT(*) FROM PostLike pl WHERE pl.PostID = p.PostID) AS likeCount,
        (SELECT COUNT(*) FROM Post c WHERE c.ParentPostID = p.PostID) AS commentCount,
        CASE WHEN l.UserID IS NULL THEN 0 ELSE 1 END AS liked
      FROM Post AS p
      LEFT JOIN PostLike AS l
        ON l.PostID = p.PostID AND l.UserID = ?
      WHERE p.UserID = ?
        AND p.ParentPostID IS NULL
      ORDER BY p.PostID DESC
    `;

    db.all(postsSql, [viewerId, user.UserID], (err2, posts) => {
      if (err2) {
        console.error("Public profile: posts SQL error:", err2.message); // Logg konkret
        return res.status(500).send("Databasefeil");
    }

      if (posts.length === 0) {                                        // Hvis ingen poster
        return res.render("profile", {                                 // Renderer profile.ejs
          title: user.username,                                        // Setter tittel til brukernavn
          user,                                                        // Sender bruker-objektet
          posts: [],                                                   // Ingen poster
          commentsByParent: {},                                        // Ingen kommentarer
          userId: req.session.userId || null,                          // Viewer ID
          isOwnProfile: false                                          // Viktig: dette er IKKE min egen profil
        });                                                            // Slutt render
      }                                                                // Slutt ingen poster

      const commentsSql = `
        SELECT
          c.PostID,
          c.ParentPostID,
          c.content,
          c.created_at,
          u.username
        FROM Post AS c
        JOIN User AS u ON u.UserID = c.UserID
        WHERE EXISTS (
          SELECT 1
          FROM Post AS p
          WHERE p.PostID = c.ParentPostID
            AND p.UserID = ?
            AND p.ParentPostID IS NULL
        )
        ORDER BY c.created_at ASC
      `;

      db.all(commentsSql, [user.UserID], (err3, comments) => {
        if (err3) {
          console.error("Public profile: comments SQL error:", err3.message); // Logg konkret
          return res.status(500).send("Databasefeil");
        }

        const commentsByParent = {};
        for (const c of comments) {
          const pid = c.ParentPostID;
          if (!commentsByParent[pid]) commentsByParent[pid] = [];
          commentsByParent[pid].push(c);
        }

        return res.render("profile", {
          title: user.username,
          user,
          posts,
          commentsByParent,
          userId: req.session.userId || null,
          isOwnProfile: false
        });                                                            // Slutt render
      });                                                              // Slutt db.all (comments)
    });                                                                // Slutt db.all (posts)
  });                                                                  // Slutt db.get (user)
});

app.post("/api/auth/delete-account", requireApiLogin, (req, res) => { // Definerer en POST-API for å slette innlogget bruker
  const userId = req.session.userId; // Leser innlogget bruker-ID fra session

  // Hjelpefunksjon for å rulle tilbake transaksjonen og svare med 500
  const rollback = (label, err) => { // Definerer en liten funksjon for rollback og logging
    console.error(label, err && err.message ? err.message : err); // Logger feilmelding med label
    db.run("ROLLBACK", () => { // Ruller tilbake transaksjonen
      return res.status(500).json({ ok: false, error: "Databasefeil" }); // Svarer 500 til klient
    }); // Slutt ROLLBACK
  }; // Slutt rollback

  db.serialize(() => { // Kjører de neste db.run-kallene sekvensielt
    db.run("BEGIN TRANSACTION", (err) => { // Starter en eksplisitt transaksjon
      if (err) return rollback("BEGIN TRANSACTION error:", err); // Ruller tilbake ved feil

      // 1) Slett likes på alle poster som tilhører brukeren (inkl. kommentarer under brukerens poster)
      const sqlDelLikesOnUserPosts = `
        DELETE FROM PostLike
        WHERE PostID IN (
          SELECT PostID FROM Post WHERE UserID = ?
          UNION
          SELECT c.PostID FROM Post c
          WHERE c.ParentPostID IN (SELECT p.PostID FROM Post p WHERE p.UserID = ?)
        )
      `; // SQL som sletter likes tilknyttet alle brukerens poster (topp + barns kommentarer)
      db.run(sqlDelLikesOnUserPosts, [userId, userId], function (err1) { // Kjører slettingen med to ganger userId
        if (err1) return rollback("Delete likes on user's posts error:", err1); // Rollback ved feil

        // 2) Slett brukerens egne likes (på andres poster)
        db.run("DELETE FROM PostLike WHERE UserID = ?", [userId], function (err2) { // Sletter alle likes laget av brukeren
          if (err2) return rollback("Delete user's own likes error:", err2); // Rollback ved feil

          // 3) Slett kommentarer under brukerens toppnivå-innlegg (postene til andre som svar på dine innlegg)
          const sqlDelCommentsUnderUserTopPosts = `
            DELETE FROM Post
            WHERE ParentPostID IN (SELECT PostID FROM Post WHERE UserID = ?)
          `; // SQL som sletter alle kommentarer som henger på brukerens topp-innlegg
          db.run(sqlDelCommentsUnderUserTopPosts, [userId], function (err3) { // Kjører slettingen
            if (err3) return rollback("Delete comments under user's posts error:", err3); // Rollback ved feil

            // 4) Slett alle brukerens egne poster (topp og kommentarer skrevet av brukeren)
            db.run("DELETE FROM Post WHERE UserID = ?", [userId], function (err4) { // Sletter alle Post-rader eid av brukeren
              if (err4) return rollback("Delete user's posts error:", err4); // Rollback ved feil

              // 5) Slett selve brukeren
              db.run("DELETE FROM User WHERE UserID = ?", [userId], function (err5) { // Sletter User-raden
                if (err5) return rollback("Delete user error:", err5); // Rollback ved feil

                // 6) Commit transaksjonen og ødelegg session
                db.run("COMMIT", (err6) => { // Forsegler endringene
                  if (err6) return rollback("COMMIT error:", err6); // Rollback ved feil på commit

                  // Ødelegg session og svar OK
                  req.session.destroy(() => { // Fjerner sesjonen fra server
                    res.clearCookie("connect.sid"); // Sletter session-cookien i nettleseren
                    return res.status(200).json({ ok: true, message: "Account deleted" }); // Svarer 200 OK
                  }); // Slutt destroy
                }); // Slutt COMMIT
              }); // Slutt delete User
            }); // Slutt delete Post (by user)
          }); // Slutt delete comments under user's posts
        }); // Slutt delete user's own likes
      }); // Slutt delete likes on user's posts
    }); // Slutt BEGIN TRANSACTION
  }); // Slutt serialize
}); // Slutt POST /api/auth/delete-account

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

app.post("/api/posts/:postId/like", requireApiLogin, (req, res) => { // Toggle like/unlike for en post
  const postId = Number(req.params.postId); // Leser PostID fra URL
  if (!Number.isInteger(postId) || postId <= 0) { // Validerer at id er gyldig
    return res.status(400).json({ ok: false, error: "Invalid postId" }); // 400 ved feil id
  } // Slutt validering

  const userId = req.session.userId; // Leser innlogget bruker-ID
  db.run( // Prøver å LIKE først
    "INSERT OR IGNORE INTO PostLike (UserID, PostID) VALUES (?, ?)", // Setter inn rad hvis den ikke finnes
    [userId, postId], // Verdier for like
    function (insErr) { // Callback etter INSERT OR IGNORE
      if (insErr) { // DB-feil
        console.error("INSERT OR IGNORE PostLike feil:", insErr.message); // Logger
        return res.status(500).json({ ok: false, error: "Databasefeil" }); // 500
      } // Slutt feil-sjekk

      const didInsert = this.changes === 1; // true hvis vi nettopp liket (rad ble lagt til)

      const afterCount = () => { // Hjelpefunksjon for å lese og returnere ny count
        db.get( // Leser oppdatert antall likes direkte fra PostLike
          "SELECT COUNT(*) AS c FROM PostLike WHERE PostID = ?", // Teller likes
          [postId], // For aktuell post
          (cntErr, row) => { // Callback etter SELECT
            if (cntErr) { // DB-feil
              console.error("COUNT PostLike feil:", cntErr.message); // Logger
              return res.status(500).json({ ok: false, error: "Databasefeil" }); // 500
            } // Slutt feil-sjekk
            return res.status(200).json({ ok: true, liked: didInsert, likes: row.c }); // Svarer med liked + ny teller
          } // Slutt callback
        ); // Slutt db.get
      }; // Slutt afterCount

      if (didInsert) { // Vi liket nå → bare returner ny count
        return afterCount(); // Returnerer liked=true og ny teller
      } // Slutt if (didInsert)

      // Hvis vi ikke satte inn rad (fantes fra før), gjør UNLIKE
      db.run( // Fjerner like-raden
        "DELETE FROM PostLike WHERE UserID = ? AND PostID = ?", // SQL for å unlike
        [userId, postId], // Parametere
        function (delErr) { // Callback etter DELETE
          if (delErr) { // DB-feil ved DELETE
            console.error("DELETE PostLike feil:", delErr.message); // Logger
            return res.status(500).json({ ok: false, error: "Databasefeil" }); // 500
          } // Slutt feil-sjekk
          return afterCount(); // Returnerer liked=false og ny teller
        } // Slutt callback
      ); // Slutt db.run
    } // Slutt callback
  ); // Slutt db.run
}); // Slutt POST /api/posts/:postId/like

app.post("/api/posts/:postId/comments", requireApiLogin, (req, res) => { // API to create a comment on a post
  const parentId = Number(req.params.postId); // Parses parent PostID from URL
  if (!Number.isInteger(parentId) || parentId <= 0) { // Validates parent id
    return res.status(400).json({ ok: false, error: "Invalid postId" }); // 400 if invalid
  } // End validation

  const { content } = req.body; // Reads comment text from JSON body
  if (!content || !content.trim()) { // Validates content presence
    return res.status(400).json({ ok: false, error: "Comment cannot be empty" }); // 400 if empty
  } // End validation

  // Normalise content so we don’t create huge blank areas
  const normalised = content                  // Takes raw content
    .replace(/\r\n/g, "\n")                   // Normalises CRLF to LF
    .replace(/\n{3,}/g, "\n\n")               // Collapses 3+ blank lines to max 2
    .trim();                                  // Trims surrounding whitespace

  const createdAt = new Date().toISOString(); // ISO timestamp for the comment
  const userId = req.session.userId; // Current logged-in user id

  // Insert this comment as a Post row with ParentPostID = parentId
  db.run(
    "INSERT INTO Post (UserID, content, created_at, ParentPostID) VALUES (?, ?, ?, ?)", // Insert comment as a Post
    [userId, normalised, createdAt, parentId], // Values: author, text, time, parent
    function (insErr) { // Callback after INSERT
      if (insErr) { // DB error
        console.error("Error INSERT comment:", insErr.message); // Log error
        return res.status(500).json({ ok: false, error: "Databasefeil" }); // 500 on error
      } // End error handling

      const newCommentId = this.lastID; // Gets the new PostID for the comment

      // Read the username for the author and compute the parent’s new comment count
      const selectSql = ` 
        SELECT 
          p.PostID,               -- The comment id
          p.ParentPostID,         -- The parent post id
          p.content,              -- The comment content
          p.created_at,           -- The comment timestamp
          u.username              -- The author username
        FROM Post AS p
        JOIN User AS u ON u.UserID = p.UserID
        WHERE p.PostID = ?
      `; // End SQL

      db.get(selectSql, [newCommentId], (selErr, commentRow) => { // Fetch the newly created comment with username
        if (selErr) { // DB error on select
          console.error("Error SELECT new comment:", selErr.message); // Log
          return res.status(500).json({ ok: false, error: "Databasefeil" }); // 500
        } // End error handling

        db.get( // Counts how many comments this parent now has
          "SELECT COUNT(*) AS c FROM Post WHERE ParentPostID = ?",
          [parentId],
          (cntErr, countRow) => {
            if (cntErr) { // DB error on count
              console.error("Error COUNT comments:", cntErr.message); // Log
              return res.status(500).json({ ok: false, error: "Databasefeil" }); // 500
            } // End error handling

            // Return the new comment and updated commentCount for the parent
            return res.status(201).json({ // 201 Created
              ok: true, // Success flag
              comment: commentRow, // The newly inserted comment (with username)
              commentCount: countRow.c // The parent’s updated comment count
            }); // End JSON response
          } // End count callback
        ); // End db.get(count)
      }); // End db.get(select new comment)
    } // End insert callback
  ); // End db.run(insert)
}); // End POST /api/posts/:postId/comments

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