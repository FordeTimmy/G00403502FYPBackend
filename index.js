const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");
require('dotenv').config();

// Initialize Firebase Admin
try {
    const serviceAccount = require("./blackjack-7de19-firebase-adminsdk.json");
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: "https://blackjack-7de19.firebaseio.com"
    });
    console.log("✅ Firebase Admin SDK initialized successfully!");

    // Test Firestore connection only
    (async () => {
        try {
            const testRef = admin.firestore().collection("test_collection");
            await testRef.add({
                testField: "Hello, Firestore!",
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
            });
            console.log("✅ Firestore write test successful!");
        } catch (error) {
            console.error("❌ Firestore write test failed:", error);
            process.exit(1);
        }
    })();
} catch (error) {
    console.error("❌ Firebase Admin SDK initialization failed:", error);
    process.exit(1);
}

// Configure Nodemailer with Gmail SMTP - but don't send test email
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// Function to send an email - kept for actual currency code sends
const sendEmail = async (to, currencyCode) => {
    const mailOptions = {
        from: `"Blackjack Rewards" <${process.env.EMAIL_USER}>`,
        to: to,
        subject: "Your Daily Blackjack Bonus 🎰",
        text: `Here is your one-time currency code: ${currencyCode}\n\nUse this code in the game to get your daily bonus of 1000 coins!`
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`Currency code ${currencyCode} sent to ${to}`);
        return true;
    } catch (error) {
        console.error("Error sending email:", error);
        return false;
    }
};

// Remove test email send

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

// Currency Code Email Route (Sends daily bonus)
app.post('/api/send-currency-code', authenticateToken, async (req, res) => {
    const { email } = req.user;
    const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD

    try {
        console.log(`Checking if ${email} already claimed today's reward...`);

        const currencyRef = admin.firestore().collection("currency_codes");
        const snapshot = await currencyRef
            .where("email", "==", email)
            .where("date", "==", today)
            .get();

        if (!snapshot.empty) {
            const existingCode = snapshot.docs[0].data().code;
            console.log(`User ${email} has already claimed today's reward: ${existingCode}`);
            return res.status(400).json({ 
                message: "You have already received your daily bonus!",
                code: existingCode,
                alreadyReceived: true
            });
        }

        // Generate a new currency code
        const currencyCode = `BLACKJACK-${Math.random().toString(36).substr(2, 8).toUpperCase()}`;
        console.log(`Generated currency code for ${email}: ${currencyCode}`);

        // Store in Firestore with additional metadata
        await currencyRef.add({
            email,
            code: currencyCode,
            claimed: false,
            date: today,
            currencyAmount: 1000,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            emailSent: false
        });

        // Send Email
        await sendEmail(email, currencyCode);
        
        // Update emailSent status
        const codeDoc = await currencyRef
            .where("code", "==", currencyCode)
            .limit(1)
            .get();
            
        if (!codeDoc.empty) {
            await codeDoc.docs[0].ref.update({ 
                emailSent: true,
                emailSentAt: admin.firestore.FieldValue.serverTimestamp()
            });
        }

        console.log(`Email sent to: ${email}`);

        res.json({ 
            message: "Daily bonus sent successfully!", 
            code: currencyCode,
            alreadyReceived: false
        });
    } catch (error) {
        console.error("Error in /api/send-currency-code:", error);
        res.status(500).json({ 
            message: "Failed to send daily bonus", 
            error: error.message 
        });
    }
});

// Claim currency code (Once per user)
app.post('/api/claim-currency-code', authenticateToken, async (req, res) => {
    const { email } = req.user;

    try {
        const db = admin.firestore();
        const currencyRef = db.collection("currency_codes");
        const usersRef = db.collection("users").doc(email);

        console.log(`Processing claim request for user: ${email}`);

        // Find an unclaimed currency code
        const snapshot = await currencyRef
            .where("email", "==", email)
            .where("claimed", "==", false)
            .limit(1)
            .get();

        if (snapshot.empty) {
            console.log(`No unclaimed codes found for: ${email}`);
            return res.status(400).json({ message: "No available currency codes or already claimed." });
        }

        const currencyDoc = snapshot.docs[0];
        const { code, currencyAmount } = currencyDoc.data();

        // Mark the currency code as claimed
        await currencyDoc.ref.update({ 
            claimed: true,
            claimedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        console.log(`Marked code ${code} as claimed`);

        // Get current balance and update atomically
        const userDoc = await usersRef.get();
        const currentBalance = userDoc.exists ? (userDoc.data().balance || 0) : 0;
        const newBalance = currentBalance + currencyAmount;

        console.log(`Updating balance: ${currentBalance} + ${currencyAmount} = ${newBalance}`);

        // Update or create user document with new balance
        await usersRef.set({
            email,
            balance: newBalance,
            lastUpdated: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        console.log(`Successfully updated balance for ${email}`);

        res.json({ 
            message: "Currency code claimed successfully!", 
            code, 
            amountAdded: currencyAmount,
            previousBalance: currentBalance,
            newBalance: newBalance
        });
    } catch (error) {
        console.error("Error claiming currency code:", error);
        console.error("Stack trace:", error.stack);
        res.status(500).json({ message: "Failed to claim currency code" });
    }
});

// Redeem Currency Code Route
app.post('/api/redeem-currency-code', authenticateToken, async (req, res) => {
    const { email } = req.user;
    const { code } = req.body;

    if (!code) {
        return res.status(400).json({ message: "No code provided" });
    }

    try {
        console.log(`Attempting to redeem code ${code} for ${email}`);
        const currencyRef = admin.firestore().collection("currency_codes");
        const snapshot = await currencyRef
            .where("email", "==", email)
            .where("code", "==", code)
            .where("claimed", "==", false)
            .limit(1)
            .get();

        if (snapshot.empty) {
            console.log(`Invalid or already claimed code: ${code}`);
            return res.status(400).json({ message: "Invalid or already claimed code." });
        }

        const currencyDoc = snapshot.docs[0];
        await currencyDoc.ref.update({ 
            claimed: true,
            claimedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        console.log(`Successfully redeemed code ${code} for ${email}`);
        res.json({ 
            message: "Currency code redeemed successfully!", 
            amount: currencyDoc.data().currencyAmount 
        });
    } catch (error) {
        console.error("Error redeeming currency code:", error);
        res.status(500).json({ message: "Failed to redeem currency code" });
    }
});

// Update Balance Route
app.post('/api/update-balance', authenticateToken, async (req, res) => {
    const { email } = req.user;
    const { balance } = req.body;

    if (typeof balance !== 'number') {
        return res.status(400).json({ message: "Balance must be a number" });
    }

    try {
        const db = admin.firestore();
        const userRef = db.collection("users").doc(email);

        console.log(`Updating balance for ${email} to ${balance}`);

        // Get current balance for logging
        const userDoc = await userRef.get();
        const oldBalance = userDoc.exists ? userDoc.data().balance : 0;

        // Update balance with metadata
        await userRef.set({
            balance,
            email,
            lastBalanceUpdate: admin.firestore.FieldValue.serverTimestamp(),
            previousBalance: oldBalance
        }, { merge: true });

        console.log(`Successfully updated balance for ${email}: ${oldBalance} → ${balance}`);
        
        res.json({ 
            message: "Balance updated successfully", 
            oldBalance,
            newBalance: balance,
            email 
        });
    } catch (error) {
        console.error("Error updating balance:", error);
        console.error("Stack trace:", error.stack);
        res.status(500).json({ 
            message: "Failed to update balance", 
            error: error.message 
        });
    }
});

// Test route to see if server is working
app.get('/api/test', (req, res) => {
    res.json({ message: "Hello from the backend!" });
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
