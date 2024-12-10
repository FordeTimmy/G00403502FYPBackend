const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

//allows communication with frontend
app.use(cors());

app.use(express.json());

// Middleware to verify JWT
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.sendStatus(401);

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
};

// Login route - generates token
app.post('/api/login', (req, res) => {
  const user = { id: 1, username: req.body.username };
  const accessToken = jwt.sign(user, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN });
  res.json({ accessToken });
});

// Test route to see if server is working
app.get('/api/test', (req, res) => {
  res.json({ message: "Hello from the backend!" });
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
