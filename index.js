const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");
const cron = require('node-cron');
require('dotenv').config();

// Initialize Firebase Admin
try {
    const serviceAccount = require("./blackjack-7de19-firebase-adminsdk.json");
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: "https://blackjack-7de19.firebaseio.com"
    });
    console.log("Firebase Admin SDK initialized successfully!");

    // Test Firestore connection only
    (async () => {
        try {
            const testRef = admin.firestore().collection("test_collection");
            await testRef.add({
                testField: "Hello, Firestore!",
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
            });
            console.log(" Firestore write test successful!");
        } catch (error) {
            console.error(" Firestore write test failed:", error);
            process.exit(1);
        }
    })();
} catch (error) {
    console.error(" Firebase Admin SDK initialization failed:", error);
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
    const { firebaseToken } = req.body;

    if (!firebaseToken) {
        return res.status(400).json({ message: "No token provided" });
    }

    try {
        // Verify Firebase Token
        const decodedToken = await admin.auth().verifyIdToken(firebaseToken);
        const email = decodedToken.email;
        console.log(`\nLogin attempt for: ${email}`);

        // Check Firestore for existing user
        console.log(`Checking user existence in Firestore for: ${email}`);
        const db = admin.firestore();
        const userRef = db.collection("users").doc(email);
        const userDoc = await userRef.get();

        // Check if user exists
        const isNewUser = !userDoc.exists;
        console.log(`User exists in Firestore: ${!isNewUser ? 'Yes ' : 'No '}`);

        // Generate JWT
        const token = jwt.sign({ email }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN });
        console.log(`JWT generated for: ${email}`);

        if (isNewUser) {
            console.log(`\nProcessing new user registration: ${email}`);

            try {
                // Generate welcome code
                const welcomeCode = `WELCOME-${Math.random().toString(36).substr(2, 8).toUpperCase()}`;
                console.log(`Generated welcome code: ${welcomeCode}`);

                // Create user document in Firestore
                await userRef.set({
                    email,
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    balance: 0,
                    lastBonus: null,
                    isNewUser: true,
                    welcomeEmailSent: false
                });
                console.log(`User document created for: ${email}`);

                // Store welcome bonus code
                await db.collection("currency_codes").add({
                    email,
                    code: welcomeCode,
                    claimed: false,
                    currencyAmount: 1000,
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    type: 'welcome_bonus'
                });
                console.log(`Welcome bonus code stored: ${welcomeCode}`);

                // Send welcome email
                console.log(`\nAttempting to send welcome email to: ${email}`);
                const emailSent = await sendEmail(email, welcomeCode, true);
                console.log(`Email sent status: ${emailSent ? ' Success' : 'Failed'}`);

                // Update email status in user document
                await userRef.update({
                    welcomeEmailSent: emailSent,
                    welcomeEmailAttemptedAt: admin.firestore.FieldValue.serverTimestamp()
                });

                if (!emailSent) {
                    console.error(`\nWelcome email failed for ${email}`);
                    console.error('Email Configuration:', {
                        user: process.env.EMAIL_USER,
                        recipient: email,
                        code: welcomeCode
                    });
                }

                console.log(`\nNew user setup completed for: ${email}`);
                return res.json({
                    message: "Welcome to Blackjack!",
                    token,
                    welcomeCode,
                    isNewUser: true,
                    emailSent
                });
            } catch (error) {
                console.error(`\nError creating new user ${email}:`, error);
                throw error;
            }
        }

        console.log(`\nReturning user logged in: ${email}`);
        res.json({
            message: "Login successful!",
            token,
            isNewUser: false
        });
    } catch (error) {
        console.error("\nLogin error:", error);
        res.status(403).json({
            message: "Login failed",
            error: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
});

// Updated verify-token route with welcome email handling
app.post('/api/verify-token', async (req, res) => {
    const { firebaseToken } = req.body;

    if (!firebaseToken) {
        return res.status(400).json({ message: "No token provided" });
    }

    try {
        const decodedToken = await admin.auth().verifyIdToken(firebaseToken);
        const email = decodedToken.email;
        console.log(`Processing token verification for: ${email}`);

        // Check if user exists
        const db = admin.firestore();
        const userRef = db.collection("users").doc(email);
        const userDoc = await userRef.get();

        // Generate JWT
        const token = jwt.sign({ email }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN });

        if (!userDoc.exists) {
            console.log(`New user detected during verification: ${email}`);
            try {
                // Generate welcome bonus code
                const welcomeCode = `WELCOME-${Math.random().toString(36).substr(2, 8).toUpperCase()}`;
                console.log(`Generated welcome code: ${welcomeCode}`);

                // Create new user document
                await userRef.set({
                    email,
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    balance: 0,
                    lastBonus: null,
                    isNewUser: true
                });
                console.log(`Created user document for: ${email}`);

                // Store welcome bonus code
                await db.collection("currency_codes").add({
                    email,
                    code: welcomeCode,
                    claimed: false,
                    currencyAmount: 1000,
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    type: 'welcome_bonus'
                });
                console.log(`Stored welcome bonus code: ${welcomeCode}`);

                // Send welcome email
                const emailSent = await sendEmail(email, welcomeCode, true);
                console.log(`Welcome email sent status: ${emailSent ? 'Success' : 'Failed'}`);

                return res.json({
                    message: "Token verified successfully!",
                    token,
                    isNewUser: true,
                    welcomeCode,
                    emailSent
                });
            } catch (error) {
                console.error(`Error processing new user: ${error}`);
                throw error;
            }
        }

        console.log(`Existing user verified: ${email}`);
        res.json({
            message: "Token verified successfully!",
            token,
            isNewUser: false
        });
    } catch (error) {
        console.error("Error verifying token:", error);
        res.status(403).json({
            message: "Invalid token",
            error: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
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

// Core daily bonus function
const manuallyTriggerDailyBonus = async () => {
    console.log('\n Running daily bonus email job...');
    try {
        const db = admin.firestore();
        const usersSnapshot = await db.collection("users").get();

        if (usersSnapshot.empty) {
            console.log('No users found for daily bonus email.');
            return;
        }

        for (const userDoc of usersSnapshot.docs) {
            const userData = userDoc.data();
            const email = userData.email;
            const lastBonus = userData.lastBonus?.toDate() || new Date(0);
            const hoursSinceLastBonus = (new Date() - lastBonus) / (1000 * 60 * 60);

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
                    console.error(` Error processing bonus for ${email}:`, error);
                }
            } else {
                console.log(`User ${email} not eligible yet (${hoursSinceLastBonus.toFixed(1)} hours since last bonus)`);
            }
        }
    } catch (error) {
        console.error("Error in daily bonus job:", error);
        throw error; // Rethrow to handle in calling function
    }
};

// Schedule the daily job
const dailyBonusJob = cron.schedule('0 0 * * *', async () => {
    await manuallyTriggerDailyBonus();
});

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
app.post('/api/send-currency-code', authenticateToken, async (req, res) => {
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

// Test route to see if server is working
app.get('/api/test', (req, res) => {
    res.json({ message: "Hello from the backend!" });
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
