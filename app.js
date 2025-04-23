process.env.TZ = 'Europe/Dublin';
const DAILY_INTERVAL = 24 * 60 * 60 * 1000;
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");
const cron = require('node-cron');
const speakeasy = require("speakeasy");
const qrcode = require("qrcode");
require('dotenv').config();

const app = express();

// Initialize Firebase Admin without process.exit
try {
    const serviceAccount = {
        type: process.env.FIREBASE_TYPE,
        project_id: process.env.FIREBASE_PROJECT_ID,
        private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
        private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        client_email: process.env.FIREBASE_CLIENT_EMAIL,
        client_id: process.env.FIREBASE_CLIENT_ID,
        auth_uri: process.env.FIREBASE_AUTH_URI,
        token_uri: process.env.FIREBASE_TOKEN_URI,
        auth_provider_x509_cert_url: process.env.FIREBASE_AUTH_CERT_URL,
        client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL
    };

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log("Firebase Admin SDK initialized successfully!");

    // Only test Firestore in non-test environment
    if (process.env.NODE_ENV !== 'test') {
        (async () => {
            try {
                const testRef = admin.firestore().collection("test_collection");
                await testRef.add({
                    testField: "Hello, Firestore!",
                    timestamp: admin.firestore.FieldValue.serverTimestamp(),
                });
                console.log("Firestore write test successful!");
            } catch (error) {
                console.warn("Firestore write test failed:", error);
            }
        })();
    }
} catch (error) {
    console.error("Firebase Admin SDK initialization failed:", error);
}

// Configure email transporter
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// Middleware
app.use(cors());
app.use(express.json());

// Helper Functions
const sendEmail = async (to, currencyCode, isWelcomeBonus = false) => {
    console.log(`Attempting to send ${isWelcomeBonus ? 'welcome' : 'daily'} bonus email to: ${to}`);

    const subject = isWelcomeBonus ? 
        "Welcome to Blackjack - Here's Your Signup Bonus!" : 
        "Your Daily Blackjack Bonus";
    
    const text = isWelcomeBonus ?
        `Welcome to Blackjack!\n\nHere is your signup bonus code: ${currencyCode}\nUse this code to get 1000 coins to start playing!\n\nYou'll receive your first daily bonus in 24 hours.` :
        `Here is your daily bonus code: ${currencyCode}\n\nUse this code in the game to get your daily bonus of 1000 coins!`;

    const mailOptions = {
        from: `"Blackjack Rewards" <${process.env.EMAIL_USER}>`,
        to,
        subject,
        text
    };

    try {
        const info = await transporter.sendMail(mailOptions);
        console.log(`Email sent successfully to ${to}`);
        console.log(`MessageId: ${info.messageId}`);
        return true;
    } catch (error) {
        console.error(`Error sending email to ${to}:`, error);
        return false;
    }
};

// Verification helper with retry
const verifyTokenWithRetry = async (token, retryCount = 0) => {
    try {
        return await Promise.race([
            admin.auth().verifyIdToken(token),
            new Promise((_, reject) => 
                setTimeout(() => reject(new Error("Verification timeout")), 5000)
            )
        ]);
    } catch (error) {
        if (retryCount >= 3) {
            throw new Error(`Max retries reached: ${error.message}`);
        }
        console.log(`Retry attempt ${retryCount + 1}/3`);
        return verifyTokenWithRetry(token, retryCount + 1);
    }
};

// Update authenticateTokenSkip2FA middleware
const authenticateTokenSkip2FA = async (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) {
        return res.status(401).json({ message: "Authorization token required" });
    }

    try {
        // First try verifying as Firebase token
        const decoded = await admin.auth().verifyIdToken(token);
        req.user = {
            email: decoded.email,
            uid: decoded.uid
        };
        return next();
    } catch (firebaseError) {
        // If Firebase verification fails, try as JWT
        try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
            req.user = {
                email: decoded.email,
                uid: decoded.uid
            };
            return next();
        } catch (jwtError) {
            console.error("Token verification failed:", jwtError);
            return res.status(403).json({ message: "Invalid token" });
        }
    }
};

// JWT authentication with 2FA enforcement
const authenticateTokenWith2FA = (req, res, next) => {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token) return res.sendStatus(403);

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);

        if (!user.twoFAVerified) {
            return res.status(403).json({ 
                message: "2FA verification required" 
            });
        }

        req.user = user;
        next();
    });
};

// Token generation helper
const generateToken = (email, uid, verified = false) => {
    return jwt.sign(
        { email, uid, twoFAVerified: verified },
        process.env.JWT_SECRET,
        { 
            expiresIn: process.env.JWT_EXPIRES_IN || '1h',
            algorithm: 'HS256'
        }
    );
};

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.post('/api/login', async (req, res) => {
    const { firebaseToken } = req.body;

    if (!firebaseToken) {
        return res.status(400).json({ message: "No token provided" });
    }

    try {
        const decodedToken = await admin.auth().verifyIdToken(firebaseToken);
        const { email, uid } = decodedToken;
        console.log(`\nLogin attempt for: ${email}`);

        const db = admin.firestore();
        const userDoc = await db.collection("users").doc(email).get();

        // Check if user has 2FA enabled
        if (userDoc.exists && userDoc.data().twoFactorEnabled) {
            const tempToken = generateToken(email, uid, false);
            return res.json({
                success: true,
                requires2FA: true,
                tempToken,
                message: "2FA verification required"
            });
        }

        // No 2FA required - generate full access token
        const token = generateToken(email, uid, true);
        res.json({
            success: true,
            token,
            requires2FA: false
        });
    } catch (error) {
        console.error("\nLogin error:", error);
        res.status(403).json({
            success: false,
            message: "Login failed",
            error: error.message
        });
    }
});

app.post('/api/verify-token', async (req, res) => {
    const { firebaseToken, email } = req.body;

    if (!firebaseToken || !email) {
        return res.status(400).json({
            success: false,
            message: "Firebase token and email are required"
        });
    }

    try {
        const decodedToken = await verifyTokenWithRetry(firebaseToken);
        
        if (decodedToken.email !== email) {
            return res.status(403).json({
                success: false,
                message: "Token email mismatch"
            });
        }

        const userDoc = await admin.firestore()
            .collection("users")
            .doc(email)
            .get();

        if (!userDoc.exists) {
            return res.status(404).json({
                success: false,
                message: "User not found"
            });
        }

        return res.json({
            success: true,
            email: decodedToken.email,
            verified: true
        });

    } catch (error) {
        console.error("Token verification failed:", error);
        return res.status(403).json({
            success: false,
            message: "Token verification failed",
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

app.post('/api/verify-2fa', async (req, res) => {
    const { email, token, tempToken } = req.body;
    
    if (!email || !token || !tempToken) {
        return res.status(400).json({ 
            success: false,
            message: "Missing required fields" 
        });
    }

    try {
        let decodedTemp = jwt.verify(tempToken, process.env.JWT_SECRET);
        if (decodedTemp.email !== email) {
            throw new Error("Token email mismatch");
        }

        const userDoc = await admin.firestore().collection("users").doc(email).get();
        
        if (!userDoc.exists) {
            return res.status(404).json({
                success: false,
                message: "User not found"
            });
        }

        const userData = userDoc.data();
        if (!userData.twoFactorEnabled || !userData.twoFactorSecret) {
            return res.status(400).json({
                success: false,
                message: "2FA not enabled for this user"
            });
        }

        const verified = speakeasy.totp.verify({
            secret: userData.twoFactorSecret,
            encoding: 'base32',
            token,
            window: 1
        });

        if (!verified) {
            return res.status(400).json({
                success: false,
                message: "Invalid 2FA code"
            });
        }

        const finalToken = generateToken(email, decodedTemp.uid, true);
        console.log(`2FA verified successfully for ${email}`);

        res.json({
            success: true,
            message: "2FA verified successfully",
            token: finalToken
        });

    } catch (error) {
        console.error("2FA verification error:", error);
        res.status(500).json({
            success: false,
            message: "Failed to verify 2FA",
            error: error.message
        });
    }
});

app.post('/api/setup-2fa', authenticateTokenSkip2FA, async (req, res) => {
    try {
        const { email } = req.user;
        
        if (!email) {
            return res.status(400).json({
                success: false,
                message: "User email is required"
            });
        }

        const userRef = admin.firestore().collection("users").doc(email);
        const userDoc = await userRef.get();

        if (!userDoc.exists) {
            return res.status(404).json({
                success: false,
                message: "User not found"
            });
        }

        const userData = userDoc.data();
        if (userData.twoFactorEnabled) {
            return res.json({
                success: true,
                alreadyEnabled: true,
                message: "2FA already enabled"
            });
        }

        const secret = speakeasy.generateSecret({
            length: 20,
            name: email,
            issuer: "Blackjack Game"
        });

        const qrCodeUrl = await qrcode.toDataURL(secret.otpauth_url);

        await userRef.update({
            twoFactorEnabled: true,
            twoFactorSecret: secret.base32,
            twoFactorSetupDate: admin.firestore.FieldValue.serverTimestamp()
        });

        return res.json({
            success: true,
            qrCode: qrCodeUrl,
            secret: secret.base32,
            message: "2FA setup successful"
        });

    } catch (error) {
        console.error('2FA Setup Error:', error);
        return res.status(500).json({
            success: false,
            message: "Failed to setup 2FA",
            error: error.message
        });
    }
});

app.post('/api/send-currency-code', authenticateTokenWith2FA, async (req, res) => {
    const { email } = req.user;

    try {
        console.log(`\nProcessing daily bonus request for: ${email}`);
        const userRef = admin.firestore().collection("users").doc(email);
        const userDoc = await userRef.get();

        if (!userDoc.exists) {
            return res.status(404).json({ message: "User not found" });
        }

        const lastBonus = userDoc.data().lastBonus?.toDate() || new Date(0);
        const hoursSinceLastBonus = (new Date() - lastBonus) / (1000 * 60 * 60);
        
        console.log(`Hours since last bonus: ${hoursSinceLastBonus.toFixed(2)}`);

        if (hoursSinceLastBonus < 24) {
            const hoursRemaining = Math.ceil(24 - hoursSinceLastBonus);
            return res.status(400).json({ 
                message: `Please wait ${hoursRemaining} hours before claiming another bonus`,
                hoursRemaining
            });
        }

        const currencyCode = `DAILY-${Math.random().toString(36).substr(2, 8).toUpperCase()}`;
        
        await admin.firestore().collection("currency_codes").add({
            email,
            code: currencyCode,
            claimed: false,
            currencyAmount: 1000,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            type: 'daily_bonus',
            emailSent: false
        });

        console.log(`Attempting to send daily bonus email to: ${email}`);
        const emailSent = await sendEmail(email, currencyCode, false);

        if (!emailSent) {
            console.error(`Failed to send daily bonus email to: ${email}`);
            return res.status(500).json({ 
                message: "Failed to send daily bonus email",
                code: currencyCode
            });
        }

        await userRef.update({
            lastBonus: admin.firestore.FieldValue.serverTimestamp(),
            lastEmailSent: admin.firestore.FieldValue.serverTimestamp()
        });

        console.log(`Daily bonus process completed for: ${email}`);
        res.json({ 
            message: "Daily bonus sent successfully!", 
            code: currencyCode,
            nextBonusIn: 24
        });
    } catch (error) {
        console.error("Error processing daily bonus:", error);
        res.status(500).json({ 
            message: "Failed to process daily bonus", 
            error: error.message 
        });
    }
});

app.post('/api/claim-currency-code', authenticateTokenWith2FA, async (req, res) => {
    const { email } = req.user;

    try {
        const db = admin.firestore();
        const currencyRef = db.collection("currency_codes");
        const usersRef = db.collection("users").doc(email);

        console.log(`Processing claim request for user: ${email}`);

        const snapshot = await currencyRef
            .where("email", "==", email)
            .where("claimed", "==", false)
            .limit(1)
            .get();

        if (snapshot.empty) {
            return res.status(400).json({ message: "No available currency codes or already claimed." });
        }

        const currencyDoc = snapshot.docs[0];
        const { code, currencyAmount } = currencyDoc.data();

        await currencyDoc.ref.update({ 
            claimed: true,
            claimedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        const userDoc = await usersRef.get();
        const currentBalance = userDoc.exists ? (userDoc.data().balance || 0) : 0;
        const newBalance = currentBalance + currencyAmount;

        await usersRef.set({
            email,
            balance: newBalance,
            lastUpdated: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        res.json({ 
            message: "Currency code claimed successfully!", 
            code, 
            amountAdded: currencyAmount,
            previousBalance: currentBalance,
            newBalance: newBalance
        });
    } catch (error) {
        console.error("Error claiming currency code:", error);
        res.status(500).json({ message: "Failed to claim currency code" });
    }
});

app.post('/api/redeem-currency-code', authenticateTokenWith2FA, async (req, res) => {
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
            return res.status(400).json({ message: "Invalid or already claimed code." });
        }

        const currencyDoc = snapshot.docs[0];
        await currencyDoc.ref.update({ 
            claimed: true,
            claimedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        res.json({ 
            message: "Currency code redeemed successfully!", 
            amount: currencyDoc.data().currencyAmount 
        });
    } catch (error) {
        console.error("Error redeeming currency code:", error);
        res.status(500).json({ message: "Failed to redeem currency code" });
    }
});

app.post('/api/update-balance', authenticateTokenWith2FA, async (req, res) => {
    const { email } = req.user;
    const { balance } = req.body;

    if (typeof balance !== 'number') {
        return res.status(400).json({ message: "Balance must be a number" });
    }

    try {
        await admin.firestore().collection("users").doc(email).set({ 
            balance,
            lastBalanceUpdate: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        res.json({ 
            message: "Balance updated successfully", 
            newBalance: balance,
            email 
        });
    } catch (error) {
        console.error("Error updating balance:", error);
        res.status(500).json({ 
            message: "Failed to update balance", 
            error: error.message 
        });
    }
});

// Test route
app.get('/api/test', (req, res) => {
    res.json({ message: "Hello from the backend!" });
});

// Make sure this is the last line and not wrapped in any conditions
module.exports = app;