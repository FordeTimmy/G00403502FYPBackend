process.env.TZ = 'Europe/Dublin'; // Set to Ireland's timezone
const DAILY_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");
const cron = require('node-cron');
const speakeasy = require("speakeasy");
const qrcode = require("qrcode");
require('dotenv').config();

// Add these constants near the top of your file
const MAX_RETRIES = 3;
const VERIFY_TIMEOUT = 5000;

// Initialize Firebase Admin
try {
    // Use environment variables instead of JSON file
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

    // Test Firestore connection
    (async () => {
        try {
            const testRef = admin.firestore().collection("test_collection");
            await testRef.add({
                testField: "Hello, Firestore!",
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
            });
            console.log("Firestore write test successful!");
        } catch (error) {
            console.error("Firestore write test failed:", error);
            process.exit(1);
        }
    })();
} catch (error) {
    console.error("Firebase Admin SDK initialization failed:", error);
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

// Updated email sending function with better error handling
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
        console.error('Email configuration:', {
            user: process.env.EMAIL_USER,
            to: to,
            subject: subject
        });
        return false;
    }
};

const app = express();
const PORT = process.env.PORT || 5000;

// Allow communication with frontend
app.use(cors());
app.use(express.json());

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

// Update your token generation to explicitly specify algorithm
// In your backend
const generateToken = (email, uid, verified = false) => {
    return jwt.sign(
        { email, uid, twoFAVerified: verified },
        process.env.JWT_SECRET,
        { 
            expiresIn: process.env.JWT_EXPIRES_IN || '1h',
            algorithm: 'HS256' // Explicitly set
        }
    );
};

// Helper function to check if user exists
const checkUserExists = async (email) => {
    try {
        const db = admin.firestore();
        const userDoc = await db.collection("users").doc(email).get();
        return userDoc.exists;
    } catch (error) {
        console.error(`Error checking user existence: ${error}`);
        return false;
    }
};

// Helper function to create or update user
const createOrUpdateUser = async (email, data = {}) => {
    try {
        const db = admin.firestore();
        const userRef = db.collection("users").doc(email);
        
        // Check if user exists
        const userDoc = await userRef.get();
        
        if (!userDoc.exists) {
            // Create new user with default values
            await userRef.set({
                email,
                balance: 0,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                lastBonus: null,
                isNewUser: true,
                ...data
            });
            return true;
        }
        
        // Update existing user if needed
        if (Object.keys(data).length > 0) {
            await userRef.update(data);
        }
        return false;
    } catch (error) {
        console.error(`Error creating/updating user: ${error}`);
        throw error;
    }
};

// Updated login route with enhanced debugging
app.post('/api/login', async (req, res) => {
    const { firebaseToken, email } = req.body;

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
        
        // Rest of your existing login logic for new/returning users
        // ...existing code...
    } catch (error) {
        console.error("\nLogin error:", error);
        res.status(403).json({
            success: false,
            message: "Login failed",
            error: error.message
        });
    }
});

// Update verifyToken helper function
const verifyTokenWithRetry = async (token, retryCount = 0) => {
    try {
        return await Promise.race([
            admin.auth().verifyIdToken(token),
            new Promise((_, reject) => 
                setTimeout(() => reject(new Error("Verification timeout")), VERIFY_TIMEOUT)
            )
        ]);
    } catch (error) {
        if (retryCount >= MAX_RETRIES) {
            throw new Error(`Max retries (${MAX_RETRIES}) reached: ${error.message}`);
        }
        console.log(`Retry attempt ${retryCount + 1}/${MAX_RETRIES}`);
        return verifyTokenWithRetry(token, retryCount + 1);
    }
};

// Update verify-token endpoint to only handle verification
app.post('/api/verify-token', async (req, res) => {
    const { firebaseToken, email } = req.body;

    if (!firebaseToken || !email) {
        return res.status(400).json({
            success: false,
            message: "Firebase token and email are required"
        });
    }

    try {
        // Verify Firebase token
        const decodedToken = await verifyTokenWithRetry(firebaseToken);
        
        // Verify email matches token
        if (decodedToken.email !== email) {
            return res.status(403).json({
                success: false,
                message: "Token email mismatch"
            });
        }

        // Simple user existence check
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

        // Return simple verification success
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

const handleLogin = async (e) => {
    e.preventDefault();
    setError('');
    
    try {
        // 1. Firebase auth
        const userCredential = await signInWithEmailAndPassword(auth, email, password);
        const user = userCredential.user;
        
        // 2. Get fresh Firebase token (THIS IS CRUCIAL)
        const firebaseToken = await user.getIdToken(true);
        
        // 3. Verify with backend
        const response = await fetch("http://localhost:5000/api/verify-token", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ 
                firebaseToken, // Send the actual Firebase token
                email: user.email 
            })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.message || "Verification failed");
        }

        // 4. Handle 2FA requirement
        if (data.requires2FA) {
            setTwoFARequired(true);
            setTempToken(data.tempToken);
            return;
        }
        
        // 5. No 2FA required
        localStorage.setItem("token", data.token);
        navigate('/profile');
        
    } catch (error) {
        setError(error.message || "Login failed");
        console.error("Login error:", error);
    }
};

// Core daily bonus function
const manuallyTriggerDailyBonus = async () => {
    console.log('\n⏰ Running daily bonus email job...');
    try {
        const db = admin.firestore();
        const usersSnapshot = await db.collection("users")
            .where("email", "!=", null) // Only get users with valid emails
            .get();

        if (usersSnapshot.empty) {
            console.log('⚠️ No eligible users found for daily bonus.');
            return;
        }

        for (const userDoc of usersSnapshot.docs) {
            const userData = userDoc.data();
            const email = userData.email?.trim();

            // Validate email
            if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                console.error(`❌ Invalid email format for user ${userDoc.id}`);
                continue;
            }

            const lastBonus = userData.lastBonus?.toDate() || new Date(0);
            const hoursSinceLastBonus = (new Date() - lastBonus) / (1000 * 60 * 60);

            console.log(`User: ${email}, Last Bonus: ${lastBonus}, Hours Since Last Bonus: ${hoursSinceLastBonus}`);

            if (hoursSinceLastBonus >= 24) {
                const currencyCode = `DAILY-${Math.random().toString(36).substr(2, 8).toUpperCase()}`;
                console.log(`Processing daily bonus for: ${email}`);

                try {
                    // Store bonus code
                    await db.collection("currency_codes").add({
                        email,
                        code: currencyCode,
                        claimed: false,
                        currencyAmount: 1000,
                        createdAt: admin.firestore.FieldValue.serverTimestamp(),
                        type: 'daily_bonus'
                    });

                    // Send email
                    const emailSent = await sendEmail(email, currencyCode, false);

                    if (emailSent) {
                        await userDoc.ref.update({
                            lastBonus: admin.firestore.FieldValue.serverTimestamp(),
                            lastDailyEmailSent: admin.firestore.FieldValue.serverTimestamp()
                        });
                        console.log(`Daily bonus email sent to: ${email}`);
                    } else {
                        console.error(`Failed to send daily bonus email to: ${email}`);
                    }
                } catch (error) {
                    console.error(`Error processing bonus for ${email}:`, error);
                }
            } else {
                console.log(`User ${email} not eligible yet (${hoursSinceLastBonus.toFixed(1)} hours since last bonus)`);
            }
        }
    } catch (error) {
        console.error("🚨 Error in daily bonus job:", error);
        throw error; // Rethrow to handle in calling function
    }
};

const runDailyBonusJob = async () => {
    console.log('Daily bonus job triggered at:', new Date().toISOString());
    try {
        await manuallyTriggerDailyBonus();
        console.log('Daily bonus job completed successfully.');
    } catch (error) {
        console.error('Error in daily bonus job:', error);
    }
};

// Run the job immediately when the server starts
runDailyBonusJob();

// Schedule the job to run every 24 hours
setInterval(runDailyBonusJob, DAILY_INTERVAL);

// Manual trigger endpoint
app.post('/api/trigger-daily-bonus', async (req, res) => {
    console.log('Manually triggering daily bonus email job...');
    try {
        await manuallyTriggerDailyBonus();
        res.json({ message: "Daily bonus job triggered successfully!" });
    } catch (error) {
        console.error("Error triggering daily bonus:", error);
        res.status(500).json({ 
            message: "Failed to trigger daily bonus", 
            error: error.message 
        });
    }
});

// Add test endpoint for direct daily bonus triggering
app.post('/api/test-daily-bonus', async (req, res) => {
    console.log('\n Testing daily bonus distribution...');
    try {
        const db = admin.firestore();
        const usersSnapshot = await db.collection("users").get();

        if (usersSnapshot.empty) {
            console.log(' No users found for daily bonus test.');
            return res.status(404).json({ message: 'No users found' });
        }

        const results = [];
        for (const userDoc of usersSnapshot.docs) {
            const userData = userDoc.data();
            const email = userData.email;
            console.log(`\nProcessing user: ${email}`);

            try {
                const currencyCode = `TEST-${Math.random().toString(36).substr(2, 8).toUpperCase()}`;
                
                // Store bonus code
                await db.collection("currency_codes").add({
                    email,
                    code: currencyCode,
                    claimed: false,
                    currencyAmount: 1000,
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    type: 'test_bonus'
                });

                // Send test email
                const emailSent = await sendEmail(email, currencyCode, false);
                console.log(` Email status for ${email}: ${emailSent ? '✅ Sent' : '❌ Failed'}`);

                results.push({
                    email,
                    success: emailSent,
                    code: currencyCode
                });

            } catch (error) {
                console.error(`Error processing ${email}:`, error);
                results.push({
                    email,
                    success: false,
                    error: error.message
                });
            }
        }

        res.json({ 
            message: "Test daily bonus completed",
            results
        });
    } catch (error) {
        console.error(" Error in test daily bonus:", error);
        res.status(500).json({ 
            message: "Test failed", 
            error: error.message 
        });
    }
});

// Update daily bonus route to enforce 24-hour wait
app.post('/api/send-currency-code', authenticateTokenWith2FA, async (req, res) => {
    const { email } = req.user;

    try {
        console.log(`\nProcessing daily bonus request for: ${email}`);
        const db = admin.firestore();
        const userRef = db.collection("users").doc(email);
        const userDoc = await userRef.get();

        if (!userDoc.exists) {
            console.log(` User document not found for: ${email}`);
            return res.status(404).json({ message: "User not found" });
        }

        // Get last bonus time with proper date handling
        const lastBonus = userDoc.data().lastBonus?.toDate() || new Date(0);
        const now = new Date();
        const hoursSinceLastBonus = (now - lastBonus) / (1000 * 60 * 60);
        
        console.log(`Hours since last bonus: ${hoursSinceLastBonus.toFixed(2)}`);

        if (hoursSinceLastBonus < 24) { // 24 hours
            const hoursRemaining = Math.ceil(24 - hoursSinceLastBonus);
            console.log(`Must wait ${hoursRemaining} more hours`);
            return res.status(400).json({ 
                message: `Please wait ${hoursRemaining} hours before claiming another bonus`,
                hoursRemaining
            });
        }


        // Generate new bonus code
        const currencyCode = `DAILY-${Math.random().toString(36).substr(2, 8).toUpperCase()}`;
        console.log(`Generated daily bonus code: ${currencyCode}`);
        
        // Store in Firestore
        await db.collection("currency_codes").add({
            email,
            code: currencyCode,
            claimed: false,
            currencyAmount: 1000,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            type: 'daily_bonus',
            emailSent: false
        });

        // Send email first
        console.log(`Attempting to send daily bonus email to: ${email}`);
        const emailSent = await sendEmail(email, currencyCode, false);

        if (!emailSent) {
            console.error(` Failed to send daily bonus email to: ${email}`);
            return res.status(500).json({ 
                message: "Failed to send daily bonus email",
                code: currencyCode // Still return code even if email fails
            });
        }

        // Only update last bonus time if email was sent
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
        console.error(" Error processing daily bonus:", error);
        res.status(500).json({ 
            message: "Failed to process daily bonus", 
            error: error.message 
        });
    }
});

// Claim currency code (Once per user)
app.post('/api/claim-currency-code', authenticateTokenWith2FA, async (req, res) => {
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
app.post('/api/update-balance', authenticateTokenWith2FA, async (req, res) => {
    const { email } = req.user;
    const { balance } = req.body;

    if (typeof balance !== 'number') {
        return res.status(400).json({ message: "Balance must be a number" });
    }

    try {
        await createOrUpdateUser(email, { 
            balance,
            lastBalanceUpdate: admin.firestore.FieldValue.serverTimestamp()
        });

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

// Update 2FA verification route with better naming
app.post('/api/verify-2fa', async (req, res) => {
    const { email, token, tempToken } = req.body;
    
    if (!email || !token || !tempToken) {
        return res.status(400).json({ 
            success: false,
            message: "Missing required fields" 
        });
    }

    try {
        // First verify the temporary token
        let decodedTemp;
        try {
            decodedTemp = jwt.verify(tempToken, process.env.JWT_SECRET);
            if (decodedTemp.email !== email) {
                throw new Error("Token email mismatch");
            }
        } catch (error) {
            return res.status(403).json({
                success: false,
                message: "Invalid temporary token"
            });
        }

        const db = admin.firestore();
        const userDoc = await db.collection("users").doc(email).get();
        
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

        // Issue final access token
        const finalToken = generateToken(email, decodedTemp.uid, true);

        // Log successful 2FA verification
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

        const db = admin.firestore();
        const userRef = db.collection("users").doc(email);

        const userDoc = await userRef.get();
        if (!userDoc.exists) {
            return res.status(404).json({
                success: false,
                message: "User not found"
            });
        }

        // Check if 2FA already enabled
        const userData = userDoc.data();
        if (userData.twoFactorEnabled) {
            return res.json({
                success: true,
                alreadyEnabled: true,
                message: "2FA already enabled"
            });
        }

        // Generate new secret
        const secret = speakeasy.generateSecret({
            length: 20,
            name: email,
            issuer: "Blackjack Game"
        });

        // Generate QR code but don't store it
        const qrCode = await qrcode.toDataURL(secret.otpauth_url);

        // Only store the necessary secret
        await userRef.update({
            twoFactorEnabled: true,
            twoFactorSecret: secret.base32, // Only store the base32 secret
            twoFactorSetupDate: admin.firestore.FieldValue.serverTimestamp()
        });

        // Send both secret and QR code to frontend
        return res.json({
            success: true,
            qrCode, // Send QR code for initial setup only
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

// Test route to see if server is working
app.get('/api/test', (req, res) => {
    res.json({ message: "Hello from the backend!" });
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
