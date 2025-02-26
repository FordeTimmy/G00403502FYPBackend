const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const admin = require("firebase-admin");
require('dotenv').config();

// Initialize Firebase Admin
const serviceAccount = require("./blackjack-7de19-firebase-adminsdk-ywetd-7b8ff92a48.json");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const app = express();
const PORT = process.env.PORT || 5000;

//allows communication with frontend
app.use(cors());

app.use(express.json());

// Middleware to verify JWT
const authenticateToken = (req, res, next) => {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.sendStatus(403); // Forbidden

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403); // Forbidden
    req.user = user;
    next();
  });
};

// Login route - generates token
app.post('/api/login', (req, res) => {
  const { email, password } = req.body;

  // Replace this with your actual user authentication logic
  if (email === 'test@example.com' && password === 'password123') {
    // Generate JWT token
    const token = jwt.sign({ email }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN });

    return res.json({ message: "Login successful!", token });
  }

  return res.status(401).json({ message: "Invalid email or password" });
});

// Token Verification Route
app.post('/api/verify-token', async (req, res) => {
    console.log("Received request body:", req.body); // Debug incoming data

    const { firebaseToken } = req.body;

    if (!firebaseToken) {
        console.log("No token provided in request"); // Debug missing token
        return res.status(400).json({ message: "No token provided" });
    }

    try {
        // Verify Firebase ID Token
        const decodedToken = await admin.auth().verifyIdToken(firebaseToken);
        console.log("Decoded Firebase Token:", decodedToken); // Check decoding

        // Generate a JWT for your backend
        const token = jwt.sign({ email: decodedToken.email }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN });

        console.log("JWT generated successfully"); // Debug successful token generation
        res.json({ message: "Token verified successfully!", token });
    } catch (error) {
        console.error("Error verifying Firebase token:", error);
        res.status(403).json({ message: "Invalid Firebase token", error: error.message });
    }
});

// Firebase Protected route
app.post('/api/protected', async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];

    if (!token) {
        return res.status(401).json({ message: 'Unauthorized: No token provided' });
    }

    try {
        // Verify the token using Firebase Admin SDK
        const decodedToken = await admin.auth().verifyIdToken(token);
        console.log('Decoded Token:', decodedToken);

        // Continue with your protected logic
        res.json({ message: 'Protected route accessed', user: decodedToken });
    } catch (error) {
        console.error('Error verifying token:', error);
        res.status(403).json({ message: 'Forbidden: Invalid token' });
    }
});

// Protected route example
app.get('/api/protected', authenticateToken, (req, res) => {
  res.json({ message: "This is a protected route", user: req.user });
});

// Test route to see if server is working
app.get('/api/test', (req, res) => {
  res.json({ message: "Hello from the backend!" });
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
