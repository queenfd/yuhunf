// server.js - Versi lebih bersih, maxResults: 10

const express = require('express');
const { google } = require('googleapis');
const path = require('path');
const dotenv = require('dotenv');

if (process.env.NODE_ENV !== 'production') {
    console.log("MODE DEVELOPMENT: Memuat variabel dari .env file.");
    dotenv.config();
} else {
    console.log("MODE PRODUCTION: Mengandalkan variabel lingkungan dari sistem hosting.");
}

// Log penting untuk startup
console.log(`NODE_ENV: ${process.env.NODE_ENV}`);
console.log(`PORT akan digunakan (dari sistem atau fallback): ${process.env.PORT || 3011}`);

const app = express();
const port = process.env.PORT || 3011; // Fallback port jika tidak diset oleh environment

app.use(express.static(path.join(__dirname, 'public')));

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;
const OFFICE_GMAIL_REFRESH_TOKEN = process.env.OFFICE_GMAIL_REFRESH_TOKEN;

let essentialEnvVarsMissing = false;
if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !OFFICE_GMAIL_REFRESH_TOKEN) {
    console.error("FATAL ERROR: Variabel Google penting (ID, SECRET, REFRESH_TOKEN) tidak terdefinisi!");
    console.error(`  GOOGLE_CLIENT_ID: ${GOOGLE_CLIENT_ID ? 'DITEMUKAN' : 'TIDAK ADA / UNDEFINED'}`);
    console.error(`  GOOGLE_CLIENT_SECRET: ${GOOGLE_CLIENT_SECRET ? 'DITEMUKAN (SECRET)' : 'TIDAK ADA / UNDEFINED'}`);
    console.error(`  OFFICE_GMAIL_REFRESH_TOKEN: ${OFFICE_GMAIL_REFRESH_TOKEN ? 'DITEMUKAN (REFRESH TOKEN)' : 'TIDAK ADA / UNDEFINED'}`);
    essentialEnvVarsMissing = true;
} else {
    console.log("Kredensial Google (ID, Secret, Refresh Token) berhasil dimuat.");
}

let appOAuth2Client;
if (!essentialEnvVarsMissing) {
    appOAuth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIRECT_URI);
    appOAuth2Client.setCredentials({ refresh_token: OFFICE_GMAIL_REFRESH_TOKEN });
    console.log("OAuth2 client untuk akun kantor berhasil diinisialisasi.");
} else {
    console.error("OAuth2 client untuk akun kantor GAGAL diinisialisasi karena variabel penting hilang.");
}

function decodeBase64Url(base64Url) {
    if (!base64Url) return "";
    let base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) { base64 += '='; }
    try { return Buffer.from(base64, 'base64').toString('utf8'); }
    catch (e) { console.error("Error decoding base64:", e.message); return "(Error decoding content)"; }
}

function getEmailBody(payload) {
    let bodyData = { text: "", html: "" };
    if (!payload) { return ""; }
    function findBodyParts(parts) {
        if (!parts || !Array.isArray(parts)) return;
        for (let part of parts) {
            if (part.mimeType === 'text/plain' && part.body && part.body.data) {
                if (!bodyData.text) { bodyData.text = decodeBase64Url(part.body.data); }
            } else if (part.mimeType === 'text/html' && part.body && part.body.data) {
                if (!bodyData.html) { bodyData.html = decodeBase64Url(part.body.data); }
            } else if (part.parts && part.parts.length > 0) findBodyParts(part.parts);
        }
    }
    if (payload.mimeType === 'text/plain' && payload.body && payload.body.data) { bodyData.text = decodeBase64Url(payload.body.data); }
    else if (payload.mimeType === 'text/html' && payload.body && payload.body.data) { bodyData.html = decodeBase64Url(payload.body.data); }
    if (payload.parts && payload.parts.length > 0) findBodyParts(payload.parts);
    return bodyData.text ? bodyData.text : bodyData.html;
}

// Rute Otentikasi (Untuk Setup Awal Refresh Token - Bisa dikomentari/dihapus setelah setup)
app.get('/auth/google', (req, res) => {
    if (essentialEnvVarsMissing || !appOAuth2Client) return res.status(500).send("Server configuration error. Contact admin.");
    const scopes = ['https://www.googleapis.com/auth/gmail.readonly'];
    const authorizeUrl = appOAuth2Client.generateAuthUrl({ access_type: 'offline', scope: scopes, prompt: 'consent' });
    res.redirect(authorizeUrl);
});

app.get('/oauth2callback', async (req, res) => {
    if (essentialEnvVarsMissing || !appOAuth2Client) return res.status(500).send("Server configuration error. Contact admin.");
    const code = req.query.code;
    if (!code) return res.status(400).send('Authorization code not found.');
    try {
        const { tokens } = await appOAuth2Client.getToken(code);
        if (tokens.refresh_token) {
            console.log("!!! REFRESH TOKEN BARU DITERIMA (UNTUK SETUP JIKA PERLU) !!!");
            console.log(tokens.refresh_token);
            res.send(`<h1>Refresh Token Baru Diterima & Dicetak di Konsol Server</h1><p>Refresh Token: ${tokens.refresh_token}</p><p>Harap simpan ini dengan aman dan update environment variable OFFICE_GMAIL_REFRESH_TOKEN jika perlu.</p>`);
        } else {
            res.send("Tidak ada refresh token baru diterima. Access token (sementara): " + tokens.access_token);
        }
    } catch (error) {
        console.error('Error getting oAuth tokens:', error.message, error.response ? error.response.data : '');
        res.status(500).send('Error during OAuth callback. Check server logs.');
    }
});

// Rute API untuk mengambil email
app.get('/api/emails', async (req, res) => {
    if (essentialEnvVarsMissing || !appOAuth2Client) {
        console.error("/api/emails: Cannot process. Essential env vars missing or OAuth2 client not initialized.");
        return res.status(500).json({ error: "Server configuration error. Please contact administrator." });
    }
    const recipientEmail = req.query.recipient;
    if (!recipientEmail) return res.status(400).json({ error: 'Recipient email query parameter is required.' });
    try {
        const accessToken = await appOAuth2Client.getAccessToken();
        if (!accessToken.token) return res.status(500).json({ error: "Failed to get access token for office account." });
        
        const gmail = google.gmail({ version: 'v1', auth: appOAuth2Client });
        let gmailQuery = `to:${recipientEmail}`;
        
        const listMessagesResponse = await gmail.users.messages.list({ 
            userId: 'me', 
            q: gmailQuery, 
            maxResults: 10 // Mengambil 10 email teratas
        });

        const messages = listMessagesResponse.data.messages;
        if (!messages || messages.length === 0) return res.json([]);
        
        const emailDetailsPromises = messages.map(async (message) => {
            const msg = await gmail.users.messages.get({ userId: 'me', id: message.id, format: 'full' });
            let subject = '', from = '', to = '', date = '';
            if (msg.data.payload && msg.data.payload.headers) {
                msg.data.payload.headers.forEach(header => {
                    if (header.name.toLowerCase() === 'subject') subject = header.value;
                    if (header.name.toLowerCase() === 'from') from = header.value;
                    if (header.name.toLowerCase() === 'to') to = header.value;
                    if (header.name.toLowerCase() === 'date') date = header.value;
                });
            }
            const emailBodyContent = getEmailBody(msg.data.payload);
            return { id: msg.data.id, threadId: msg.data.threadId, subject, from, to, date, body: emailBodyContent || msg.data.snippet || '(No content available)' };
        });
        let detailedEmails = await Promise.all(emailDetailsPromises);
        res.json(detailedEmails);
    } catch (error) {
        console.error('Error fetching emails from Gmail for office account:', error.message, error.stack);
        if (error.response && (error.response.status === 401 || error.response.status === 403)) {
             return res.status(500).json({ error: "Authentication error with office Gmail account. Check server configuration." });
        }
        res.status(500).json({ error: 'Failed to fetch emails. Check server logs.' });
    }
});

// Rute Status
app.get('/api/auth/status', (req, res) => {
    if (!essentialEnvVarsMissing && appOAuth2Client) {
        res.json({ isAuthenticated: true, message: "Server ready with office account credentials." });
    } else {
        res.json({ isAuthenticated: false, message: "Server not ready, environment configuration issue." });
    }
});

// Event listener untuk refresh token
if (appOAuth2Client) {
    appOAuth2Client.on('tokens', (tokens) => {
        if (tokens.refresh_token) console.warn("WARNING: New refresh token received via event. This is unexpected if initial refresh token is set.");
        // console.log("Access token (re)newed via event.");
    });
}

// --- Jalankan Server ---
app.listen(port, async () => {
    console.log(`Backend server (Office Account Mode) attempting to run on internal port: ${port}`);
    
    if (essentialEnvVarsMissing || !appOAuth2Client) {
        console.error("SERVER FAILED CRITICAL INITIALIZATION. Check environment variables for Google credentials.");
    } else {
        console.log("Attempting to get initial access token at startup...");
        try {
            const initialToken = await appOAuth2Client.getAccessToken();
            if (initialToken && initialToken.token) {
                console.log("Successfully obtained initial access token using refresh token. Gmail connection ready.");
            } else {
                console.warn("Failed to obtain initial access token (no token in response). Check OFFICE_GMAIL_REFRESH_TOKEN and Google API Client config.");
            }
        } catch (e) {
            console.error("FATAL ERROR during startup (getAccessToken):", e.message);
            console.error("Ensure OFFICE_GMAIL_REFRESH_TOKEN, GOOGLE_CLIENT_ID, and GOOGLE_CLIENT_SECRET are valid and Gmail API is enabled.");
        }
    }
    console.log(`Frontend should be accessible via your public URL (e.g., https://yourdomain.com/app.html) which proxies to this internal port: ${port}.`);
});