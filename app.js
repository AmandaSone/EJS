// Importerer path for trygge filstier
const path = require('path');

// Importerer express
const express = require('express');

// Importerer sqlite
const sqlite3 = require('sqlite3').verbose();

// Importerer hashing og sessions
const bcrypt = require('bcrypt');
const session = require('express-session');

// Lager express app
const app = express();

// Port
const PORT = 3000;


// ---------------- DATABASE ----------------

// Koble til SQLite database
const db = new sqlite3.Database(path.join(__dirname, 'database.db'));


// Oppretter tabeller hvis de ikke finnes
db.serialize(() => {

  // Users table
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL
    )
  `);

  // Posts table
  db.run(`
    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      user_id INTEGER,
      created_at TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )
  `);

  // Comments table
  db.run(`
    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      comment TEXT NOT NULL,
      user_id INTEGER,
      post_id INTEGER,
      created_at TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(post_id) REFERENCES posts(id)
    )
  `);

});


// ---------------- EXPRESS SETUP ----------------

// templating engine
app.set('view engine', 'ejs');

// views mappe
app.set('views', path.join(__dirname, 'views'));

// public mappe
app.use(express.static(path.join(__dirname, 'public')));

// form parsing
app.use(express.urlencoded({ extended: true }));

// sessions
app.use(session({
  secret: "secretkey",
  resave: false,
  saveUninitialized: false
}));


// ---------------- DATABASE HELPERS ----------------

// SELECT flere rader
function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {

    db.all(sql, params, (err, rows) => {

      if (err) {
        reject(err);
      } else {
        resolve(rows);
      }

    });

  });
}

// INSERT / UPDATE / DELETE
function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {

    db.run(sql, params, function(err) {

      if (err) {
        reject(err);
      } else {
        resolve(this);
      }

    });

  });
}


// ---------------- ROUTES ----------------


// ---------- HOME (VISER POSTS) ----------

app.get('/', async (req, res) => {
  try {
    // Hent alle posts med brukernavn
    const posts = await dbAll(`
      SELECT posts.*, users.username
      FROM posts
      JOIN users ON posts.user_id = users.id
      ORDER BY created_at DESC
    `);

    // Hent kommentarer for hver post
    for (let post of posts) {
      const comments = await dbAll(`
        SELECT comments.*, users.username
        FROM comments
        JOIN users ON comments.user_id = users.id
        WHERE post_id = ?
        ORDER BY created_at ASC
      `, [post.id]);

      post.comments = comments;
    }

    // Render index.ejs
    res.render('index', {
      posts: posts,
      user: req.session.user
    });

  } catch (err) {
    console.error(err);
    res.send("Database error");
  }
});

// ---------- SIGNUP ----------

// vis signup side
app.get('/signup', (req, res) => {

  res.render('signup');

});


// registrer bruker
app.post('/signup', async (req, res) => {

  const { username, email, password } = req.body;

  try {

    const hashedPassword = await bcrypt.hash(password, 10);

    await dbRun(
      "INSERT INTO users (username,email,password) VALUES (?,?,?)",
      [username, email, hashedPassword]
    );

    res.redirect('/login');

  } catch (err) {

    console.error(err);
    res.send("User already exists");

  }

});


// ---------- LOGIN ----------

// vis login side
app.get('/login', (req, res) => {

  res.render('login');

});


// login bruker
app.post('/login', async (req, res) => {

  const { email, password } = req.body;

  try {

    const user = await dbAll(
      "SELECT * FROM users WHERE email = ?",
      [email]
    );

    if (user.length === 0) {
      return res.send("User not found");
    }

    const match = await bcrypt.compare(password, user[0].password);

    if (match) {

      req.session.user = user[0];

      res.redirect('/dashboard');

    } else {

      res.send("Wrong password");

    }

  } catch (err) {

    console.error(err);
    res.send("Login error");

  }

});


// ---------- LOGOUT ----------

app.get('/logout', (req, res) => {

  req.session.destroy(() => {

    res.redirect('/');

  });

});


// ---------- DASHBOARD ----------

app.get('/dashboard', (req, res) => {

  if (!req.session.user) {
    return res.redirect('/login');
  }

  res.render('dashboard', {
    user: req.session.user
  });

});


// ---------- CREATE POST ----------

app.post('/posts', async (req, res) => {

  if (!req.session.user) {
    return res.redirect('/login');
  }

  const { title, content } = req.body;

  try {

    await dbRun(
      "INSERT INTO posts (title,content,user_id,created_at) VALUES (?,?,?,?)",
      [title, content, req.session.user.id, new Date().toISOString()]
    );

    res.redirect('/');

  } catch (err) {

    console.error(err);
    res.send("Error creating post");

  }

});


// ---------- DELETE POST ----------

app.post('/delete-post/:id', async (req, res) => {

  if (!req.session.user) {
    return res.redirect('/login');
  }

  try {

    await dbRun(
      "DELETE FROM posts WHERE id = ? AND user_id = ?",
      [req.params.id, req.session.user.id]
    );

    res.redirect('/');

  } catch (err) {

    console.error(err);
    res.send("Error deleting post");

  }

});


// ---------- ADD COMMENT ----------

app.post('/comment/:postId', async (req, res) => {

  if (!req.session.user) {
    return res.redirect('/login');
  }

  const { comment } = req.body;

  try {

    await dbRun(
      "INSERT INTO comments (comment,user_id,post_id,created_at) VALUES (?,?,?,?)",
      [comment, req.session.user.id, req.params.postId, new Date().toISOString()]
    );

    res.redirect('/');

  } catch (err) {

    console.error(err);
    res.send("Error adding comment");

  }

});


// ---------- START SERVER ----------

app.listen(PORT, () => {

  console.log(`Server running on http://localhost:${PORT}`);

});