const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");
require('dotenv').config();

// Initialize Firebase Admin
const serviceAccount = require(process.env.FIREBASE_SERVICE_ACCOUNT_KEY_PATH);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

// Configure Nodemailer with Gmail SMTP
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// Function to send an email
const sendEmail = async (to, currencyCode) => {
    const mailOptions = {
        from: `"Blackjack Rewards" <${process.env.EMAIL_USER}>`,
        to: to,
        subject: "Your Daily Blackjack Bonus 🎰",
        text: `Here is your one-time currency code: ${currencyCode}\n\nUse this code in the game to get your daily bonus!`
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`Currency code ${currencyCode} sent to ${to}`);
    } catch (error) {
        console.error("Error sending email:", error);
    }
};

// Test email send
sendEmail("timmyforde02@gmail.com", "BLACKJACK-TEST123")
    .then(() => console.log("Test email sent successfully"))
    .catch(error => console.error("Test email failed:", error));

const app = express();
const PORT = process.env.PORT || 5000;

// Allow communication with frontend
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

app.post('/api/login', async (req, res) => {
    const { firebaseToken } = req.body;

    if (!firebaseToken) {
        return res.status(400).json({ message: "No token provided" });
    }

    try {
        // Verify Firebase Token
        const decodedToken = await admin.auth().verifyIdToken(firebaseToken);
        console.log("Decoded Firebase Token:", decodedToken);

        // Extract email from the decoded token
        const email = decodedToken.email;

        // Generate a JWT for your backend
        const token = jwt.sign({ email }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN });

        res.json({ message: "Login successful!", token });
    } catch (error) {
        console.error("Error verifying Firebase token:", error);
        res.status(403).json({ message: "Invalid Firebase token" });
    }
});


// Token Verification Route
app.post('/api/verify-token', async (req, res) => {
    console.log("Received request body:", req.body);

    const { firebaseToken } = req.body;

    if (!firebaseToken) {
        console.log("No token provided in request");
        return res.status(400).json({ message: "No token provided" });
    }

    try {
        // Verify Firebase ID Token
        const decodedToken = await admin.auth().verifyIdToken(firebaseToken);
        console.log("Decoded Firebase Token:", decodedToken);

        // Generate a JWT for your backend
        const token = jwt.sign({ email: decodedToken.email }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN });

        console.log("JWT generated successfully");
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

// Currency Code Email Route
app.post('/api/send-currency-code', authenticateToken, async (req, res) => {
    const { email } = req.user;

    if (!email) {
        return res.status(400).json({ message: "Email is required" });
    }

    const currencyCode = `BLACKJACK-${Math.random().toString(36).substr(2, 8).toUpperCase()}`;

    try {
        await sendEmail(email, currencyCode);
        res.json({ message: "Email sent successfully!", code: currencyCode });
    } catch (error) {
        console.error("Error sending email:", error);
        res.status(500).json({ message: "Failed to send email" });
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
