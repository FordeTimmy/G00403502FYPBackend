
# Blackjack Web App – Backend (API)

This is the backend for the Blackjack Web App. It is built using Node.js and Express and supports user authentication, token verification, email-based reward distribution, and database interactions via Firebase Admin SDK.

## Tech Stack

- Node.js with Express
- Firebase Admin SDK
- JSON Web Tokens (JWT)
- Nodemailer
- Render (Deployment)
- Supertest and Jest

## Key Endpoints

- `POST /api/verify-token` – Verifies Firebase ID tokens
- `POST /api/send-reward-email` – Sends daily reward codes by email
- `POST /api/claim-currency-code` – Validates reward code and updates balance

## Getting Started

### 1. Clone the Repository

git clone https://github.com/FordeTimmy/G00403502FYPBackend.git
cd G00403502FYPBackend

### 2. Install Dependencies
npm install

### 3. Run the Server
npm run dev

### 4. Add Environment Variables
Create a .env file in the root directory:
JWT_SECRET=your_jwt_secret
FIREBASE_PROJECT_ID=your_project_id
GOOGLE_APPLICATION_CREDENTIALS=./firebase-adminsdk.json
EMAIL_USER=your_email@example.com
EMAIL_PASS=your_email_password

### Firebase Setup
Add firebase-adminsdk.json to your project.
Ensure Firestore has the users and currency_codes collections.
Enable Email/Password in Firebase Authentication.

Testing
npm test

### Deployed game
https://ace-up.vercel.app/game
