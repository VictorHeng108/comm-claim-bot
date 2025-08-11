const { google } = require('googleapis');
const express = require('express');
const fs = require('fs');
const path = require('path');

// Try to import open package safely
let open = null;
try {
    open = require('open');
} catch (error) {
    console.log('⚠️  open package not available, browser will not auto-open');
}

// Try to get OAuth config from environment variable first
let oauth_config = null;

if (process.env.GOOGLE_OAUTH_SECRETS) {
    try {
        oauth_config = JSON.parse(process.env.GOOGLE_OAUTH_SECRETS);
        console.log('✅ Using OAuth config from GOOGLE_OAUTH_SECRETS environment variable');
    } catch (error) {
        console.error('❌ Error parsing GOOGLE_OAUTH_SECRETS:', error.message);
        console.error('❌ Please check your GOOGLE_OAUTH_SECRETS format in Replit Secrets');
    }
}

// If not found in environment, try to read from the client secret file
if (!oauth_config) {
    const possiblePaths = [
        path.join(__dirname, 'attached_assets', 'client_secret_1081980984936-knd7cdhe0h3vpn6pcseofg84q782kl6b.apps.googleusercontent.com_1753896437586.json'),
        path.join(__dirname, 'attached_assets', 'client_secret_1081980984936-knd7cdhe0h3vpn6pcseofg84q782kl6b.apps.googleusercontent.com_1753895441695.json')
    ];

    for (const clientSecretPath of possiblePaths) {
        try {
            if (fs.existsSync(clientSecretPath)) {
                const clientSecretContent = fs.readFileSync(clientSecretPath, 'utf8');
                oauth_config = JSON.parse(clientSecretContent);
                console.log('✅ Using OAuth config from client secret file:', path.basename(clientSecretPath));
                console.log('⚠️  IMPORTANT: Add this JSON to your GOOGLE_OAUTH_SECRETS secret in Replit:');
                console.log(JSON.stringify(oauth_config, null, 2));
                break;
            }
        } catch (error) {
            console.log('❌ Failed to read client secret file:', path.basename(clientSecretPath));
        }
    }

    if (!oauth_config) {
        console.error('❌ No OAuth configuration found!');
        console.error('❌ Please either:');
        console.error('   1. Set GOOGLE_OAUTH_SECRETS in your Replit Secrets, OR');
        console.error('   2. Ensure client secret file exists in attached_assets folder');
        process.exit(1);
    }
}

const app = express();
const PORT = 3003;

// Detect current environment and construct redirect URI dynamically
function getRedirectUri() {
    // Check for custom domain/host first
    if (process.env.OAUTH_REDIRECT_URI) {
        return process.env.OAUTH_REDIRECT_URI;
    }
    
    // Check if we're on Replit
    if (process.env.REPL_SLUG && process.env.REPL_OWNER) {
        return `https://${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co/oauth2callback`;
    }
    
    // Check if we're on Railway
    if (process.env.RAILWAY_PUBLIC_DOMAIN) {
        return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/oauth2callback`;
    }
    
    // Default to localhost for local development
    return `http://localhost:${PORT}/oauth2callback`;
}

const DYNAMIC_REDIRECT_URI = getRedirectUri();

// Create OAuth2 client with dynamic redirect URI
const oauth2Client = new google.auth.OAuth2(
    oauth_config.web.client_id,
    oauth_config.web.client_secret,
    DYNAMIC_REDIRECT_URI
);

// Define the scopes you need for Google Drive
const SCOPES = [
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/drive.file'
];

// Generate the auth URL
const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent' // This ensures we get a refresh token
});

console.log('🚀 Starting OAuth token setup...');
console.log(`📋 Visit this URL to authorize the application: ${authUrl}`);

// Handle the OAuth callback - using the actual callback path from client config
app.get('/oauth2callback', async (req, res) => {
    const { code } = req.query;

    if (!code) {
        return res.send('❌ No authorization code received');
    }

    try {
        // Exchange the authorization code for tokens
        const { tokens } = await oauth2Client.getToken(code);

        console.log('\n✅ SUCCESS! Here are your OAuth tokens:');
        console.log('\n📋 ADD THESE TO YOUR REPLIT SECRETS:');
        console.log('Key: COMPANY_DRIVE_ACCESS_TOKEN');
        console.log(`Value: ${tokens.access_token}`);
        console.log('\nKey: COMPANY_DRIVE_REFRESH_TOKEN');
        console.log(`Value: ${tokens.refresh_token}`);

        res.send(`
            <html>
                <head><title>OAuth Success</title></head>
                <body style="font-family: Arial; padding: 40px; text-align: center;">
                    <h1 style="color: green;">✅ Success!</h1>
                    <p>Check your console for the tokens.</p>
                    <p><strong>Copy the tokens from your console and add them to your Replit Secrets.</strong></p>
                    <h3>Steps to add to Secrets:</h3>
                    <ol style="text-align: left; max-width: 600px; margin: 0 auto;">
                        <li><strong>For Replit:</strong> Go to Tools → Secrets in your workspace</li>
                        <li><strong>For other platforms:</strong> Set environment variables in your hosting platform</li>
                        <li>Add: <code>COMPANY_DRIVE_ACCESS_TOKEN</code><br>Value: <code>${tokens.access_token}</code></li>
                        <li>Add: <code>COMPANY_DRIVE_REFRESH_TOKEN</code><br>Value: <code>${tokens.refresh_token}</code></li>
                    </ol>
                    <p>You can close this window now.</p>
                </body>
            </html>
        `);

        // Close the server after success
        setTimeout(() => {
            console.log('\n🔒 Setup complete. Server closing...');
            console.log('\n📋 NEXT STEPS:');
            console.log('1. Copy the tokens above to your environment variables/secrets');
            console.log('2. Key: COMPANY_DRIVE_ACCESS_TOKEN');
            console.log('3. Key: COMPANY_DRIVE_REFRESH_TOKEN');
            console.log('4. Your Discord bot will now be able to upload to your Google Drive!');
            console.log('\n🌐 PLATFORM-SPECIFIC INSTRUCTIONS:');
            console.log('• Replit: Tools → Secrets');
            console.log('• Vercel: Environment Variables in dashboard');
            console.log('• Railway: Variables in project settings');
            console.log('• Render: Environment in service settings');
            console.log('• Local: Create .env file or export variables');
            process.exit(0);
        }, 5000);

    } catch (error) {
        console.error('❌ Error getting tokens:', error);
        res.send('❌ Error getting tokens. Check console for details.');
    }
});

app.listen(PORT, '0.0.0.0', () => {
    // Universal host detection
    let serverUrl = '';
    if (process.env.REPL_SLUG && process.env.REPL_OWNER) {
        serverUrl = `https://${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co`;
    } else if (process.env.VERCEL_URL) {
        serverUrl = `https://${process.env.VERCEL_URL}`;
    } else if (process.env.RAILWAY_PUBLIC_DOMAIN) {
        serverUrl = `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
    } else if (process.env.RENDER_EXTERNAL_URL) {
        serverUrl = process.env.RENDER_EXTERNAL_URL;
    } else {
        serverUrl = `http://localhost:${PORT}`;
    }

    console.log(`🌐 OAuth server running on port ${PORT}`);
    console.log(`🌐 Server accessible at: ${serverUrl}`);
    console.log(`🌐 Redirect URI configured: ${DYNAMIC_REDIRECT_URI}`);
    console.log('\n📋 STEPS:');
    console.log('1. Click the URL below to authorize:');
    console.log(`🔗 ${authUrl}`);
    console.log('2. Sign in with your Google account that has access to your company drive');
    console.log('3. Copy the tokens from console');
    console.log('4. Add them to your environment variables/secrets');
    console.log('\n💡 IMPORTANT: Make sure your Google Cloud Console has this redirect URI:');
    console.log(`   ${DYNAMIC_REDIRECT_URI}`);

    // Auto-open browser (optional) - only if open package is available
    if (open) {
        setTimeout(() => {
            console.log('\n🔗 Attempting to open browser automatically...');
            try {
                open(authUrl).catch(err => {
                    console.log('⚠️  Could not auto-open browser:', err.message);
                    console.log('🔗 Please manually visit the URL above');
                });
            } catch (error) {
                console.log('⚠️  Could not auto-open browser:', error.message);
                console.log('🔗 Please manually visit the URL above');
            }
        }, 2000);
    } else {
        console.log('🔗 Please manually visit the URL above (auto-open not available)');
    }
});