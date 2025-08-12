const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { google } = require('googleapis');
const { Octokit } = require('@octokit/rest');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const fs = require('fs').promises;
const path = require('path');
const settings = require('./settings.json');
const fetch = require('node-fetch');
const { format } = require('date-fns-tz');

// GMT+8 timezone constant
const GMT8_TIMEZONE = 'Asia/Singapore'; // Singapore is in GMT+8

// Helper function to format dates to GMT+8
function formatGMT8DateString(date) {
    return format(date, 'yyyy-MM-dd HH:mm:ss XXX', { timeZone: GMT8_TIMEZONE });
}

// Helper function to get current date in GMT+8
function getGMT8Date() {
    return new Date();
}


// FaJotform configuration
const JOTFORM_API_KEY = process.env.JOTFORM_API_KEY;
const JOTFORM_BASE_URL = 'https://api.jotform.com/v1';
const JOTFORM_TEMPLATE_ID = process.env.JOTFORM_TEMPLATE_ID; // Create one reusable form

// Notification channel
const NOTIFICATION_CHANNEL_ID = '1400401242064162826';

// Initialize Discord client
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

// OAuth configuration
const GOOGLE_OAUTH_SECRETS = process.env.GOOGLE_OAUTH_SECRETS;
let oauth_config = null;

if (GOOGLE_OAUTH_SECRETS) {
    oauth_config = JSON.parse(GOOGLE_OAUTH_SECRETS);
} else {
    console.error('❌ GOOGLE_OAUTH_SECRETS environment variable not set');
}

// Initialize services
let drive, octokit;
const app = express();
const upload = multer({ dest: 'uploads/' });

// Session configuration
app.use(session({
    secret: process.env.SESSION_SECRET || 'your-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: false, // Set to true in production with HTTPS
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

// Store submission data temporarily with unique tokens
const submissions = new Map();
const tokenToUserId = new Map(); // Maps tokens to user IDs

// Store fast commission percentages per project (default 50%)
const fastCommissionPercentages = new Map(); // Maps project names to percentages

// Store processing confirmation state to prevent duplicate actions
const processingConfirmations = new Map();
const processedSubmissions = new Set(); // Track submission IDs that have been processed
const processingSubmissions = new Set(); // Track submission IDs currently being processed
const processedTokens = new Set(); // Track session tokens that have been processed
const notificationsSent = new Set(); // Track notifications sent to prevent duplicate notifications
const userFolderCache = new Map(); // Cache folder IDs for each user submission to prevent duplicate folders

// Load fast commission percentages from GitHub backup
async function loadFastCommissionPercentages() {
    try {
        const { data } = await octokit.rest.repos.getContent({
            owner: settings.github.owner,
            repo: settings.github.repo,
            path: `${settings.github.backupPath}/fast_commission_settings.json`
        });

        const content = Buffer.from(data.content, 'base64').toString();
        const percentageData = JSON.parse(content);

        // Load percentages into memory
        for (const [projectName, percentage] of Object.entries(percentageData)) {
            fastCommissionPercentages.set(projectName.toLowerCase(), percentage);
        }

        console.log(`✅ Loaded ${fastCommissionPercentages.size} fast commission percentage settings from GitHub`);
    } catch (error) {
        if (error.status === 404) {
            console.log('No existing fast commission settings found in GitHub, starting fresh');
        } else {
            console.log('Error loading fast commission percentages from GitHub:', error.message);
        }
    }
}

// Save fast commission percentage to GitHub backup
async function saveFastCommissionPercentage(projectName, percentage) {
    try {
        // Update in-memory map
        fastCommissionPercentages.set(projectName.toLowerCase(), percentage);

        // Convert Map to plain object for JSON storage
        const percentageData = {};
        for (const [project, percent] of fastCommissionPercentages.entries()) {
            percentageData[project] = percent;
        }

        const content = Buffer.from(JSON.stringify(percentageData, null, 2)).toString('base64');

        // Try to get existing file to get SHA
        let sha;
        try {
            const { data: existing } = await octokit.rest.repos.getContent({
                owner: settings.github.owner,
                repo: settings.github.repo,
                path: `${settings.github.backupPath}/fast_commission_settings.json`
            });
            sha = existing.sha;
        } catch (error) {
            // File doesn't exist, will create new
        }

        await octokit.rest.repos.createOrUpdateFileContents({
            owner: settings.github.owner,
            repo: settings.github.repo,
            path: `${settings.github.backupPath}/fast_commission_settings.json`,
            message: `Update fast commission percentage for ${projectName}: ${percentage}% - ${new Date().toISOString()}`,
            content: content,
            sha: sha
        });

        console.log(`✅ Saved fast commission percentage for ${projectName}: ${percentage}% to GitHub`);
        return true;
    } catch (error) {
        console.error('Error saving fast commission percentage to GitHub:', error);
        return false;
    }
}

// Get fast commission percentage for a project (default 50%)
function getFastCommissionPercentage(projectName) {
    return fastCommissionPercentages.get(projectName.toLowerCase()) || 50;
}

// Initialize Google Drive with OAuth delegation
async function initializeGoogleDrive() {
    if (!oauth_config) {
        console.error('❌ OAuth configuration not available');
        return;
    }
    console.log('✅ Google Drive OAuth delegation configured');
}

// Create OAuth flow for user authentication
function createOAuthFlow() {
    if (!oauth_config) {
        throw new Error('OAuth configuration not available');
    }

    const oauth_flow = new google.auth.OAuth2(
        oauth_config.web.client_id,
        oauth_config.web.client_secret,
        oauth_config.web.redirect_uris[0]
    );

    return oauth_flow;
}

// Create Google Drive instance with user credentials
function createUserGoogleDrive(accessToken) {
    const oauth_client = new google.auth.OAuth2();
    oauth_client.setCredentials({ access_token: accessToken });

    return google.drive({ version: 'v3', auth: oauth_client });
}

// Initialize Jotform API
function initializeJotform() {
    if (!JOTFORM_API_KEY) {
        console.error('❌ JOTFORM_API_KEY environment variable not set');
        console.error('Please add your Jotform API key to environment variables');
        return false;
    }
    if (!JOTFORM_TEMPLATE_ID) {
        console.error('❌ JOTFORM_TEMPLATE_ID environment variable not set');
        console.error('Please create a template form and add its ID to environment variables');
        return false;
    }
    console.log('✅ Jotform API initialized');
    return true;
}

// Initialize GitHub
function initializeGitHub() {
    octokit = new Octokit({
        auth: process.env.GITHUB_PAT
    });
    console.log('GitHub initialized');
}

// Load backup data from GitHub
async function loadBackupFromGitHub() {
    try {
        const { data } = await octokit.rest.repos.getContent({
            owner: settings.github.owner,
            repo: settings.github.repo,
            path: `${settings.github.backupPath}/submissions.json`
        });

        const content = Buffer.from(data.content, 'base64').toString();
        return JSON.parse(content);
    } catch (error) {
        console.log('No existing backup found, starting fresh');
        return [];
    }
}

// Save backup to GitHub
async function saveBackupToGitHub(data) {
    try {
        const content = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');

        // Retry logic for concurrent updates
        let retries = 3;
        while (retries > 0) {
            try {
                // Try to get existing file to get SHA
                let sha;
                try {
                    const { data: existing } = await octokit.rest.repos.getContent({
                        owner: settings.github.owner,
                        repo: settings.github.repo,
                        path: `${settings.github.backupPath}/submissions.json`
                    });
                    sha = existing.sha;
                } catch (error) {
                    // File doesn't exist, will create new
                }

                await octokit.rest.repos.createOrUpdateFileContents({
                    owner: settings.github.owner,
                    repo: settings.github.repo,
                    path: `${settings.github.backupPath}/submissions.json`,
                    message: `Update submissions backup - ${new Date().toISOString()}`,
                    content: content,
                    sha: sha
                });

                console.log('Backup saved to GitHub');
                return; // Success, exit retry loop
            } catch (error) {
                if (error.status === 409 && retries > 1) {
                    console.log(`GitHub backup conflict, retrying... (${retries - 1} attempts left)`);
                    // Wait a bit before retry
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    retries--;
                } else {
                    throw error; // Re-throw if not a conflict or no retries left
                }
            }
        }
    } catch (error) {
        console.error('Failed to save backup to GitHub:', error);
    }
}

// Validate agent percentages
function validateAgentPercentages(agents) {
    const total = agents.reduce((sum, agent) => sum + parseFloat(agent.percentage || 0), 0);
    return Math.abs(total - 100) < 0.01; // Allow for small floating point errors
}

// Calculate commissions
function calculateCommissions(nettPrice, commissionRate, agents) {
    console.log('=== RAW INPUT TO CALCULATION ===');
    console.log('Raw nettPrice parameter:', nettPrice, 'Type:', typeof nettPrice);
    console.log('Raw commissionRate parameter:', commissionRate, 'Type:', typeof commissionRate);

    // Remove commas and other formatting from nett price
    const cleanNettPrice = String(nettPrice).replace(/,/g, '');
    const nett = parseFloat(cleanNettPrice);
    const rate = parseFloat(commissionRate);
    const totalCommission = (nett * rate) / 100;

    console.log('=== COMMISSION CALCULATION DEBUG ===');
    console.log('Nett Price:', nett);
    console.log('Commission Rate:', rate);
    console.log('Total Commission:', totalCommission);

    return agents.map(agent => {
        const agentPercentage = parseFloat(agent.percentage) || 0;
        const agentCommission = (totalCommission * agentPercentage) / 100;

        console.log(`Agent: ${agent.name}`);
        console.log(`Agent Percentage: ${agentPercentage}`);
        console.log(`Agent Commission: ${agentCommission}`);
        console.log('---');

        return {
            ...agent,
            commission: agentCommission.toFixed(2)
        };
    });
}

// Create submission form modal
function createSubmissionModal() {
    const modal = new ModalBuilder()
        .setCustomId('submission_form')
        .setTitle('Commission Submission Form');

    const components = [
        new TextInputBuilder()
            .setCustomId('project_name')
            .setLabel('Project Name')
            .setStyle(TextInputStyle.Short)
            .setRequired(true),

        new TextInputBuilder()
            .setCustomId('unit_no')
            .setLabel('Unit No.')
            .setStyle(TextInputStyle.Short)
            .setRequired(true),

        new TextInputBuilder()
            .setCustomId('spa_price')
            .setLabel('SPA Price')
            .setStyle(TextInputStyle.Short)
            .setRequired(true),

        new TextInputBuilder()
            .setCustomId('nett_price')
            .setLabel('Nett Purchased Price')
            .setStyle(TextInputStyle.Short)
            .setRequired(true),

        new TextInputBuilder()
            .setCustomId('commission_rate')
            .setLabel('Commission Rate (%)')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
    ];

    components.forEach((component, index) => {
        modal.addComponents(new ActionRowBuilder().addComponents(component));
    });

    return modal;
}

// Create agent details modal
function createAgentModal(step, existingAgent = {}) {
    const modal = new ModalBuilder()
        .setCustomId(`agent_form_${step}`)
        .setTitle(`Consultant Details - Step ${step}`);

    // Only 1 agent per modal to stay within Discord's 5 component limit
    const agentNum = step;

    if (agentNum <= 4) {
        const nameComponent = new TextInputBuilder()
            .setCustomId(`agent${agentNum}_name`)
            .setLabel(`Consultant ${agentNum} Name`)
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setValue(existingAgent.name || '');

        const codeComponent = new TextInputBuilder()
            .setCustomId(`agent${agentNum}_code`)
            .setLabel(`Consultant ${agentNum} Code`)
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setValue(existingAgent.code || '');

        const percentageComponent = new TextInputBuilder()
            .setCustomId(`agent${agentNum}_percentage`)
            .setLabel(`Consultant ${agentNum} Percentage (%)`)
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setValue(existingAgent.percentage ? existingAgent.percentage.toString() : '')
            .setPlaceholder('Portion from the total commission');

        modal.addComponents(
            new ActionRowBuilder().addComponents(nameComponent),
            new ActionRowBuilder().addComponents(codeComponent),
            new ActionRowBuilder().addComponents(percentageComponent)
        );
    }

    return modal;
}

// Create customer details modal
function createCustomerModal(existingData = {}) {
    const modal = new ModalBuilder()
        .setCustomId('customer_form')
        .setTitle('Customer & Date Details');

    const components = [
        new TextInputBuilder()
            .setCustomId('customer_name')
            .setLabel('Customer Name')
            .setStyle(TextInputStyle.Short)
            .setRequired(true),

        new TextInputBuilder()
            .setCustomId('customer_phone')
            .setLabel('Customer Phone')
            .setStyle(TextInputStyle.Short)
            .setRequired(true),

        new TextInputBuilder()
            .setCustomId('customer_address')
            .setLabel('Customer Address')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true),

        new TextInputBuilder()
            .setCustomId('spa_date')
            .setLabel('SPA Date (YYYY-MM-DD)')
            .setStyle(TextInputStyle.Short)
            .setRequired(true),

        new TextInputBuilder()
            .setCustomId('la_date')
            .setLabel('LA Date (YYYY-MM-DD)')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
    ];

    // Set values only if existing data exists
    if (existingData.customer_name) components[0].setValue(existingData.customer_name);
    if (existingData.customer_phone) components[1].setValue(existingData.customer_phone);
    if (existingData.customer_address) components[2].setValue(existingData.customer_address);
    if (existingData.spa_date) components[3].setValue(existingData.spa_date);
    if (existingData.la_date) components[4].setValue(existingData.la_date);

    components.forEach(component => {
        modal.addComponents(new ActionRowBuilder().addComponents(component));
    });

    return modal;
}

// Create file upload modal
function createFileUploadModal() {
    const modal = new ModalBuilder()
        .setCustomId('file_upload_form')
        .setTitle('Upload Commission Documents');

    const instructionComponent = new TextInputBuilder()
        .setCustomId('upload_instruction')
        .setLabel('Ready to upload documents')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setValue('After clicking Submit below, send a new message with your documents attached (PDF, DOC, DOCX, JPG, PNG). You can attach multiple files at once.')
        .setMaxLength(500);

    modal.addComponents(new ActionRowBuilder().addComponents(instructionComponent));

    return modal;
}

// Create document-specific upload modal
function createDocumentUploadModal(documentType, documentName) {
    const modal = new ModalBuilder()
        .setCustomId(`document_upload_${documentType}`)
        .setTitle(`Upload ${documentName}`);

    const instructionComponent = new TextInputBuilder()
        .setCustomId('upload_instruction')
        .setLabel(`Ready to upload ${documentName}`)
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setValue(`After clicking Submit below, send a new message with your ${documentName} attached (PDF, DOC, DOCX, JPG, PNG). You can attach multiple files for this document type.`)
        .setMaxLength(500);

    modal.addComponents(new ActionRowBuilder().addComponents(instructionComponent));

    return modal;
}

// Create confirmation embed
function createConfirmationEmbed(data) {
    const embed = new EmbedBuilder()
        .setTitle('📋 Commission Submission Confirmation')
        .setColor(0x00AE86)
        .addFields(
            { name: '🏢 Project Details', value: `**Project:** ${data.project_name}\n**Unit:** ${data.unit_no}\n**SPA Price:** RM${Number(String(data.spa_price).replace(/,/g, '')).toLocaleString()}\n**Nett Price:** RM${Number(String(data.nett_price).replace(/,/g, '')).toLocaleString()}\n**Commission Rate:** ${data.commission_rate}%\n\n`, inline: false },
            { name: '👤 Customer Details', value: `**Name:** ${data.customer_name}\n**Phone:** ${data.customer_phone}\n**Address:** ${data.customer_address}\n\n`, inline: false },
            { name: '📅 Important Dates', value: `**SPA Date:** ${data.spa_date}\n**LA Date:** ${data.la_date}\n\n`, inline: false }
        )
        .setTimestamp();

    // Add agent details
    const agentDetails = data.agents
        .filter(agent => agent.name)
        .map(agent => {
            const formattedCommission = Number(agent.commission).toLocaleString('en-US', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2
            });
            return `**${agent.name}** (${agent.code}): ${agent.percentage}% - RM${formattedCommission}`;
        })
        .join('\n');

    if (agentDetails) {
        embed.addFields({ name: '👥 Agent Commission Breakdown', value: `${agentDetails}\n\n`, inline: false });

        const totalCommission = data.agents.reduce((sum, agent) => sum + parseFloat(agent.commission || 0), 0);
        const formattedTotalCommission = totalCommission.toLocaleString('en-US', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        });
        embed.addFields({ name: '💰 Total Commission', value: `RM${formattedTotalCommission}\n\n`, inline: true });

        // Add Fast Commission section
        const fastCommissionPercentage = getFastCommissionPercentage(data.project_name);
        const fastCommissionAmount = (totalCommission * fastCommissionPercentage) / 100;

        // Calculate fast commission for each agent
        const fastCommissionDetails = data.agents
            .filter(agent => agent.name)
            .map(agent => {
                const agentFastCommission = (parseFloat(agent.commission) * fastCommissionPercentage) / 100;
                const formattedAgentFastCommission = agentFastCommission.toLocaleString('en-US', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2
                });
                return `**${agent.name}**: RM${formattedAgentFastCommission}`;
            })
            .join('\n');

        embed.addFields({ 
            name: `⚡ Fast Commission (${fastCommissionPercentage}%)`, 
            value: `${fastCommissionDetails}\n\n`, 
            inline: false 
        });

        const formattedFastCommissionAmount = fastCommissionAmount.toLocaleString('en-US', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        });
        embed.addFields({ 
            name: '💸 Total Fast Commission', 
            value: `RM${formattedFastCommissionAmount}\n\n`, 
            inline: true 
        });
    }

    return embed;
}



// Bot ready event
client.once('ready', async () => {
    console.log(`${client.user.tag} is online!`);

    // Initialize services
    await initializeGoogleDrive();
    initializeGitHub();
    initializeJotform();
    await loadFastCommissionPercentages();

    // First, clear ALL global commands to start fresh (multiple attempts for stubborn commands)
    for (let attempt = 1; attempt <= 2; attempt++) {
        const globalCommands = await client.application.commands.fetch();
        console.log(`🔍 Attempt ${attempt}: Found ${globalCommands.size} global commands`);

        for (const command of globalCommands.values()) {
            try {
                await client.application.commands.delete(command.id);
                console.log(`🗑️ Deleted global command: ${command.name}`);
            } catch (error) {
                console.log(`⚠️ Failed to delete ${command.name}:`, error.message);
            }
        }

        // Wait between attempts
        await new Promise(resolve => setTimeout(resolve, 2000));
    }

    // Final verification that no admin commands exist globally
    const finalGlobalCommands = await client.application.commands.fetch();
    const adminCommandsInGlobal = finalGlobalCommands.filter(cmd => cmd.name === 'admin-action');
    if (adminCommandsInGlobal.size > 0) {
        console.log('⚠️ WARNING: Still found admin commands globally, force deleting...');
        for (const cmd of adminCommandsInGlobal.values()) {
            try {
                await client.application.commands.delete(cmd.id);
                console.log('🗑️ Force deleted admin command:', cmd.name);
            } catch (error) {
                console.log('❌ Could not force delete:', error.message);
            }
        }
    }

    // Wait longer for Discord to process all deletions
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Register ONLY public commands globally (admin-action should NOT be here)
    const publicCommands = [
        new SlashCommandBuilder()
            .setName('fast-comm-submission')
            .setDescription('Submit commission claim with document upload'),
        new SlashCommandBuilder()
            .setName('check-my-upload')
            .setDescription('Check your submission status and uploaded documents')
    ];

    // Set global commands to ONLY the public commands (this replaces all global commands)
    await client.application.commands.set(publicCommands);
    console.log('✅ Public commands (fast-comm-submission, check-my-upload) registered globally');

    // Register admin commands ONLY in the specific admin guild
    const adminGuildId = "1118938632250732544"; // Your Discord server ID

    try {
        // Wait for guild to be available
        await client.guilds.fetch(adminGuildId);
        const guild = client.guilds.cache.get(adminGuildId);

        if (guild) {
            // Define admin commands for guild-only registration with proper permission restrictions
            const adminCommands = [
                new SlashCommandBuilder()
                    .setName('admin-action')
                    .setDescription('Admin actions for submission management (Admin only)')
                    .setDefaultMemberPermissions('0') // This hides the command from all users without Administrator permission
                    .addStringOption(option =>
                        option.setName('action')
                            .setDescription('Action to perform')
                            .setRequired(true)
                            .addChoices(
                                { name: 'Check Submissions', value: 'check_submissions' },
                                { name: 'List Recent', value: 'list' },
                                { name: 'Delete by Index', value: 'delete' },
                                { name: 'Bulk Delete', value: 'bulk_delete' },
                                { name: 'View Details', value: 'view' },
                                { name: 'Adjust Fast Commission %', value: 'adjust_fast_comm' },
                                { name: 'View Fast Commission Settings', value: 'view_fast_comm_settings' }
                            ))
                    .addStringOption(option =>
                        option.setName('user_id')
                            .setDescription('User ID to check (for check_submissions)')
                            .setRequired(false))
                    .addIntegerOption(option =>
                        option.setName('limit')
                            .setDescription('Number of recent submissions to show (for check_submissions, default: 10)')
                            .setRequired(false))
                    .addIntegerOption(option =>
                        option.setName('index')
                            .setDescription('Index number of submission (for delete/view)')
                            .setRequired(false))
                    .addStringOption(option =>
                        option.setName('indices')
                            .setDescription('Comma-separated indices for bulk delete (e.g., 1,3,5-8,12)')
                            .setRequired(false))
                    .addStringOption(option =>
                        option.setName('project_name')
                            .setDescription('Project name (for adjust_fast_comm)')
                            .setRequired(false))
                    .addNumberOption(option =>
                        option.setName('percentage')
                            .setDescription('Fast commission percentage 0-100 (for adjust_fast_comm)')
                            .setRequired(false)
                            .setMinValue(0)
                            .setMaxValue(100))
                    .addBooleanOption(option =>
                        option.setName('confirm')
                            .setDescription('Confirm bulk deletion (required for bulk delete)')
                            .setRequired(false))
            ];

            // Set admin commands ONLY in the guild (this replaces ALL guild commands)
            await guild.commands.set(adminCommands);
            console.log(`✅ Admin command (admin-action) registered ONLY in admin guild: ${guild.name}`);

            // Final verification that admin commands are NOT in global scope
            const finalGlobalCommands = await client.application.commands.fetch();
            const adminInGlobal = finalGlobalCommands.find(cmd => cmd.name === 'admin-action');
            if (adminInGlobal) {
                console.log('❌ WARNING: admin-action still found in global commands, force removing...');
                await client.application.commands.delete(adminInGlobal.id);
                console.log('✅ Force removed admin-action from global commands');
            } else {
                console.log('✅ CONFIRMED: admin-action is hidden from all users except in admin guild');
            }
        } else {
            console.log('❌ Admin guild not found - admin commands not registered');
        }
    } catch (error) {
        console.error('❌ Error setting up admin commands:', error);
    }

    console.log('✅ Command visibility properly configured:');
    console.log('  - fast-comm-submission: VISIBLE to all users globally');
    console.log('  - check-my-upload: VISIBLE to all users globally'); 
    console.log('  - admin-action: HIDDEN from regular users, only visible in admin guild');

    // Start express server
    const PORT = process.env.PORT || 5000;
    app.listen(PORT, '0.0.0.0', () => {
        // Universal host detection with PUBLIC_URL priority
        let serverUrl = '';
        if (process.env.PUBLIC_URL) {
            serverUrl = `https://${process.env.PUBLIC_URL}`;
        } else if (process.env.REPL_SLUG && process.env.REPL_OWNER) {
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
        console.log(`Express server running on port ${PORT}`);
        console.log(`Webhook test URL: ${serverUrl}/webhook/test`);
        console.log(`Webhook URL: ${serverUrl}/webhook/jotform`);
    });
});

// Handle message attachments
client.on('messageCreate', async message => {
    if (message.author.bot) return;

    const userId = message.author.id;
    const data = submissions.get(userId);

    // Check if user is in file upload state and message has attachments
    if (data && (data.status === 'awaiting_files' || data.status.startsWith('awaiting_')) && message.attachments.size > 0) {
        try {
            const uploadedFiles = [];

            // Process each attachment
            for (const attachment of message.attachments.values()) {
                // Check file type
                const allowedTypes = ['.pdf', '.doc', '.docx', '.jpg', '.jpeg', '.png'];
                const fileExt = attachment.name.toLowerCase().substring(attachment.name.lastIndexOf('.'));

                if (!allowedTypes.includes(fileExt)) {
                    await message.reply('❌ Unsupported file type. Please upload PDF, DOC, DOCX, JPG, or PNG files only.');
                    return;
                }

                // Download and upload to Google Drive
                const response = await fetch(attachment.url);
                const buffer = await response.buffer();

                // Save temporarily
                const tempPath = `uploads/${userId}_${Date.now()}_${attachment.name}`;
                await fs.writeFile(tempPath, buffer);

                // Upload to Google Drive
                const driveFile = await uploadToGoogleDrive(
                    tempPath,
                    `${userId}_${Date.now()}_${attachment.name}`,
                    attachment.contentType || 'application/octet-stream'
                );

                uploadedFiles.push({
                    originalName: attachment.name,
                    driveId: driveFile.id,
                    driveLink: driveFile.webViewLink
                });

                // Clean up temp file
                await fs.unlink(tempPath);
            }

            // Create confirmation buttons
            const confirmRow = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('proceed_with_files')
                        .setLabel('✅ Proceed')
                        .setStyle(ButtonStyle.Success),
                    new ButtonBuilder()
                        .setCustomId('cancel_files')
                        .setLabel('❌ Cancel')
                        .setStyle(ButtonStyle.Danger)
                );

            // Handle different upload modes
            if (data.status === 'awaiting_files') {
                // Original bulk upload mode
                data.uploadedFiles = uploadedFiles;
                data.status = 'files_uploaded';
                submissions.set(userId, data);

                await message.reply({
                    content: `✅ **${uploadedFiles.length} file(s) uploaded successfully to Google Drive!**\n\n📁 **Files:**\n${uploadedFiles.map(f => `• ${f.originalName}`).join('\n')}\n\nClick **Proceed** to complete your submission or **Cancel** to abort.`,
                    components: [confirmRow]
                });
            } else if (data.status.startsWith('awaiting_')) {
                // Document-specific upload mode
                const documentType = data.status.replace('awaiting_', '');

                // Update specific document in checklist
                if (!data.documentChecklist) {
                    data.documentChecklist = {
                        booking_form: { uploaded: false, files: [] },
                        spa: { uploaded: false, files: [] },
                        la: { uploaded: false, files: [] }
                    };
                }

                data.documentChecklist[documentType] = {
                    uploaded: true,
                    files: uploadedFiles
                };

                data.status = 'checklist_mode';
                submissions.set(userId, data);

                // Update checklist display
                await updateChecklistDisplay(message, data, userId);
            }

        } catch (error) {
            console.error('Error processing file attachments:', error);
            await message.reply('❌ Error uploading files to Google Drive. Please try again.');
        }
    }
});

// Handle all interactions
client.on('interactionCreate', async interaction => {
    const userId = interaction.user.id;

    // Check if interaction is used in the allowed channel for ALL interaction types
    const ALLOWED_CHANNEL_ID = '1400381115285508156';
    if (interaction.channelId !== ALLOWED_CHANNEL_ID) {
        if (interaction.isCommand()) {
            await interaction.reply({
                content: `❌ This command can only be used in <#${ALLOWED_CHANNEL_ID}>`,
                ephemeral: true
            });
        } else if (interaction.isButton() || interaction.isModalSubmit()) {
            try {
                if (interaction.replied || interaction.deferred) {
                    await interaction.followUp({
                        content: `❌ This bot can only be used in <#${ALLOWED_CHANNEL_ID}>`,
                        ephemeral: true
                    });
                } else {
                    await interaction.reply({
                        content: `❌ This bot can only be used in <#${ALLOWED_CHANNEL_ID}>`,
                        ephemeral: true
                    });
                }
            } catch (error) {
                console.error('Error responding to interaction outside allowed channel:', error);
            }
        }
        return;
    }

    // Handle slash commands
    if (interaction.isCommand()) {

        if (interaction.commandName === 'admin-action') {
            // Check if user has admin permissions - only for bot owner or specific role
            const allowedUserId = '1223928653265973288'; // Bot owner ID
            const adminGuildId = '1118938632250732544';
            const allowedRoleId = '1404203519921356834'; // Specific role ID

            let hasAdminAccess = false;

            // Check if user is the bot owner
            if (interaction.user.id === allowedUserId) {
                hasAdminAccess = true;
            }
            // Check if user has the specific role in the admin guild
            else if (interaction.guildId === adminGuildId) {
                const member = await interaction.guild.members.fetch(interaction.user.id);
                hasAdminAccess = member.roles.cache.has(allowedRoleId);
            }

            if (!hasAdminAccess) {
                await interaction.reply({
                    content: '❌ You do not have permission to use this command.',
                    ephemeral: true
                });
                return;
            }

            try {
                const action = interaction.options.getString('action');

                if (action === 'check_submissions') {
                    const userIdFilter = interaction.options.getString('user_id');
                    const limit = interaction.options.getInteger('limit') || 10;
                    const backupData = await loadBackupFromGitHub();

                    let filteredData = backupData;
                    if (userIdFilter) {
                        filteredData = backupData.filter(submission => 
                            submission.user_id === userIdFilter || 
                            submission.username?.toLowerCase().includes(userIdFilter.toLowerCase())
                        );
                    }

                    const recentSubmissions = filteredData.slice(-limit).reverse();

                    if (recentSubmissions.length === 0) {
                        await interaction.reply({
                            content: userIdFilter ? 
                                `❌ No submissions found for user: ${userIdFilter}` : 
                                '❌ No submissions found in database.',
                            ephemeral: true
                        });
                        return;
                    }

                    const embed = new EmbedBuilder()
                        .setTitle('📊 Commission Submissions Data')
                        .setColor(0x0099FF)
                        .setDescription(`Showing ${recentSubmissions.length} submission(s)${userIdFilter ? ` for user: ${userIdFilter}` : ''}`)
                        .setTimestamp();

                    recentSubmissions.forEach((submission, index) => {
                        const submissionIndex = backupData.indexOf(submission);
                        const totalCommission = submission.agents
                            ?.filter(agent => agent.name)
                            ?.reduce((sum, agent) => sum + parseFloat(agent.commission || 0), 0) || 0;

                        embed.addFields({
                            name: `#${submissionIndex} - ${submission.project_name}`,
                            value: `**User:** ${submission.username} (${submission.user_id})\n**Unit:** ${submission.unit_no}\n**Nett Price:** RM${Number(String(submission.nett_price).replace(/,/g, '')).toLocaleString()}\n**Total Commission:** RM${totalCommission.toFixed(2)}\n**Submitted:** ${new Date(submission.submitted_at).toLocaleString()}`,
                            inline: false
                        });
                    });

                    await interaction.reply({
                        embeds: [embed],
                        ephemeral: true
                    });
                    return;
                }

                else if (action === 'adjust_fast_comm') {
                    const projectName = interaction.options.getString('project_name');
                    const percentage = interaction.options.getNumber('percentage');

                    if (!projectName || percentage === null) {
                        await interaction.reply({
                            content: '❌ Please provide both project_name and percentage for fast commission adjustment.',
                            ephemeral: true
                        });
                        return;
                    }

                    // Save the fast commission percentage
                    const saved = await saveFastCommissionPercentage(projectName, percentage);

                    if (saved) {
                        const embed = new EmbedBuilder()
                            .setTitle('✅ Fast Commission Percentage Updated')
                            .setColor(0x28A745)
                            .addFields(
                                { name: '🏢 Project Name', value: projectName, inline: true },
                                { name: '💰 Fast Commission %', value: `${percentage}%`, inline: true },
                                { name: '📋 Status', value: 'Setting saved successfully', inline: false }
                            )
                            .setTimestamp();

                        await interaction.reply({
                            embeds: [embed],
                            ephemeral: true
                        });
                    } else {
                        await interaction.reply({
                            content: '❌ Failed to save fast commission percentage. Please try again.',
                            ephemeral: true
                        });
                    }
                    return;
                }

                else if (action === 'view_fast_comm_settings') {
                    if (fastCommissionPercentages.size === 0) {
                        await interaction.reply({
                            content: '📋 **No custom fast commission settings found**\n\nAll projects will use the default 50% fast commission rate.\n\nUse `/admin-action` with `adjust_fast_comm` to set custom percentages for specific projects.',
                            ephemeral: true
                        });
                        return;
                    }

                    const embed = new EmbedBuilder()
                        .setTitle('💰 Fast Commission Settings')
                        .setColor(0x0099FF)
                        .setDescription('Custom fast commission percentages by project')
                        .setTimestamp();

                    const settings = Array.from(fastCommissionPercentages.entries());

                    // Group settings into fields (max 25 fields, each max 1024 chars)
                    const maxPerField = 10;
                    for (let i = 0; i < settings.length; i += maxPerField) {
                        const fieldSettings = settings.slice(i, i + maxPerField);
                        const fieldValue = fieldSettings
                            .map(([project, percentage]) => `**${project}**: ${percentage}%`)
                            .join('\n');

                        embed.addFields({
                            name: i === 0 ? '🏢 Project Settings' : `🏢 Project Settings (continued ${Math.floor(i / maxPerField) + 1})`,
                            value: fieldValue,
                            inline: false
                        });
                    }

                    embed.addFields({
                        name: '📋 Default Setting',
                        value: 'Projects not listed above use **50%** fast commission rate',
                        inline: false
                    });

                    await interaction.reply({
                        embeds: [embed],
                        ephemeral: true
                    });
                    return;
                }

                const index = interaction.options.getInteger('index');
                const confirmDelete = interaction.options.getBoolean('confirm');
                const backupData = await loadBackupFromGitHub();

                if (action === 'list') {
                    const recentSubmissions = backupData.slice(-20).reverse();

                    if (recentSubmissions.length === 0) {
                        await interaction.reply({
                            content: '❌ No submissions found in database.',
                            ephemeral: true
                        });
                        return;
                    }

                    const embed = new EmbedBuilder()
                        .setTitle('📝 Recent Submissions for Amendment')
                        .setColor(0xFF9900)
                        .setDescription('Use the index number with `/admin-action` to delete or view details')
                        .setTimestamp();

                    recentSubmissions.forEach((submission, displayIndex) => {
                        const actualIndex = backupData.indexOf(submission);
                        embed.addFields({
                            name: `Index: ${actualIndex}`,
                            value: `**Project:** ${submission.project_name}\n**User:** ${submission.username}\n**Date:** ${new Date(submission.submitted_at).toLocaleDateString()}`,
                            inline: true
                        });
                    });

                    await interaction.reply({
                        embeds: [embed],
                        ephemeral: true
                    });
                }

                else if (action === 'view') {
                    if (index === null || index < 0 || index >= backupData.length) {
                        await interaction.reply({
                            content: `❌ Invalid index. Please provide a valid index (0-${backupData.length - 1}).`,
                            ephemeral: true
                        });
                        return;
                    }

                    const submission = backupData[index];
                    const embed = createConfirmationEmbed(submission);
                    embed.setTitle(`📋 Submission Details - Index ${index}`);
                    embed.addFields({
                        name: '👤 Submission Info',
                        value: `**User:** ${submission.username} (${submission.user_id})\n**Submitted:** ${new Date(submission.submitted_at).toLocaleString()}`,
                        inline: false
                    });

                    await interaction.reply({
                        embeds: [embed],
                        ephemeral: true
                    });
                }

                else if (action === 'delete') {
                    if (index === null || index < 0 || index >= backupData.length) {
                        await interaction.reply({
                            content: `❌ Invalid index. Please provide a valid index (0-${backupData.length - 1}).`,
                            ephemeral: true
                        });
                        return;
                    }

                    const submissionToDelete = backupData[index];

                    // Create confirmation buttons
                    const confirmRow = new ActionRowBuilder()
                        .addComponents(
                            new ButtonBuilder()
                                .setCustomId(`confirm_delete_${index}`)
                                .setLabel('✅ Confirm Delete')
                                .setStyle(ButtonStyle.Danger),
                            new ButtonBuilder()
                                .setCustomId('cancel_delete')
                                .setLabel('❌ Cancel')
                                .setStyle(ButtonStyle.Secondary)
                        );

                    await interaction.reply({
                        content: `⚠️ **Confirm Deletion**\n\nAre you sure you want to delete this submission?\n\n**Project:** ${submissionToDelete.project_name}\n**User:** ${submissionToDelete.username}\n**Index:** ${index}\n\n**This action cannot be undone!**`,
                        components: [confirmRow],
                        ephemeral: true
                    });
                }

                else if (action === 'bulk_delete') {
                    const indices = interaction.options.getString('indices');
                    const confirmDelete = interaction.options.getBoolean('confirm');

                    if (!indices) {
                        await interaction.reply({
                            content: '❌ Please provide indices to delete.\n\n**Examples:**\n• Single: `1,3,5`\n• Range: `1-5` (deletes 1,2,3,4,5)\n• Mixed: `1,3,5-8,12`',
                            ephemeral: true
                        });
                        return;
                    }

                    if (!confirmDelete) {
                        await interaction.reply({
                            content: '❌ Bulk deletion requires confirmation. Set `confirm` to `true`.',
                            ephemeral: true
                        });
                        return;
                    }

                    // Parse indices from string
                    const indicesToDelete = [];
                    const parts = indices.split(',');

                    for (const part of parts) {
                        const trimmed = part.trim();
                        if (trimmed.includes('-')) {
                            // Handle range like "5-8"
                            const [start, end] = trimmed.split('-').map(n => parseInt(n.trim()));
                            if (!isNaN(start) && !isNaN(end) && start <= end) {
                                for (let i = start; i <= end; i++) {
                                    indicesToDelete.push(i);
                                }
                            }
                        } else {
                            // Handle single number
                            const num = parseInt(trimmed);
                            if (!isNaN(num)) {
                                indicesToDelete.push(num);
                            }
                        }
                    }

                    // Remove duplicates and sort in descending order (delete from end to avoid index shifting)
                    const uniqueIndices = [...new Set(indicesToDelete)].sort((a, b) => b - a);

                    // Validate all indices
                    const invalidIndices = uniqueIndices.filter(idx => idx < 0 || idx >= backupData.length);
                    if (invalidIndices.length > 0) {
                        await interaction.reply({
                            content: `❌ Invalid indices found: ${invalidIndices.join(', ')}\n\nValid range: 0-${backupData.length - 1}`,
                            ephemeral: true
                        });
                        return;
                    }

                    // Show what will be deleted
                    const submissionsToDelete = uniqueIndices.map(idx => ({
                        index: idx,
                        submission: backupData[idx]
                    }));

                    const deleteList = submissionsToDelete
                        .map(item => `• Index ${item.index}: ${item.submission.project_name} - ${item.submission.username}`)
                        .join('\n');

                    // Create final confirmation
                    const confirmRow = new ActionRowBuilder()
                        .addComponents(
                            new ButtonBuilder()
                                .setCustomId(`confirm_bulk_delete_${uniqueIndices.join(',')}`)
                                .setLabel('✅ Confirm Bulk Delete')
                                .setStyle(ButtonStyle.Danger),
                            new ButtonBuilder()
                                .setCustomId('cancel_delete')
                                .setLabel('❌ Cancel')
                                .setStyle(ButtonStyle.Secondary)
                        );

                    await interaction.reply({
                        content: `⚠️ **Confirm Bulk Deletion**\n\n**You are about to delete ${uniqueIndices.length} submission(s):**\n\n${deleteList}\n\n**This action cannot be undone!**`,
                        components: [confirmRow],
                        ephemeral: true
                    });
                }



            } catch (error) {
                console.error('Error in amend-submission command:', error);
                await interaction.reply({
                    content: '❌ Error processing amendment command.',
                    ephemeral: true
                });
            }
        }



        else if (interaction.commandName === 'fast-comm-submission') {
            const modal = createSubmissionModal();
            await interaction.showModal(modal);
        }



        else if (interaction.commandName === 'check-my-upload') {
            try {
                const backupData = await loadBackupFromGitHub();
                const userSubmissions = backupData.filter(submission => submission.user_id === userId);

                if (userSubmissions.length === 0) {
                    await interaction.reply({
                        content: '❌ **No submissions found**\n\nYou haven\'t submitted any commission claims yet. Use `/fast-comm-submission` to create your first submission.',
                        ephemeral: true
                    });
                    return;
                }

                // Create summary embed with all user submissions
                const embed = new EmbedBuilder()
                    .setTitle('📋 Your Commission Submissions')
                    .setColor(0x0099FF)
                    .setDescription(`Found ${userSubmissions.length} submission(s)`)
                    .setTimestamp();

                // Create buttons for each submission (max 25 buttons per interaction)
                const buttons = [];
                const maxButtons = Math.min(userSubmissions.length, 20); // Leave room for other buttons

                for (let i = 0; i < maxButtons; i++) {
                    const submission = userSubmissions[i];
                    const submissionIndex = backupData.indexOf(submission);
                    const totalCommission = submission.agents
                        ?.filter(agent => agent.name)
                        ?.reduce((sum, agent) => sum + parseFloat(agent.commission || 0), 0) || 0;

                    // Add to embed
                    embed.addFields({
                        name: `${i + 1}. ${submission.project_name}`,
                        value: `**Unit:** ${submission.unit_no}\n**Total Commission:** RM${totalCommission.toFixed(2)}\n**Submitted:** ${formatGMT8DateString(new Date(submission.submitted_at))}\n**Documents:** ${submission.uploadedFiles?.length || 0} file(s)`,
                        inline: true
                    });

                    // Create button for detailed view
                    buttons.push(
                        new ButtonBuilder()
                            .setCustomId(`view_submission_${submissionIndex}`)
                            .setLabel(`View ${submission.project_name}`)
                            .setStyle(ButtonStyle.Primary)
                    );
                }

                // Split buttons into rows (max 5 per row)
                const rows = [];
                for (let i = 0; i < buttons.length; i += 5) {
                    const rowButtons = buttons.slice(i, i + 5);
                    rows.push(new ActionRowBuilder().addComponents(rowButtons));
                }

                // Add refresh button
                if (rows.length > 0) {
                    const lastRow = rows[rows.length - 1];
                    if (lastRow.components.length < 5) {
                        lastRow.addComponents(
                            new ButtonBuilder()
                                .setCustomId('refresh_my_submissions')
                                .setLabel('🔄 Refresh')
                                .setStyle(ButtonStyle.Secondary)
                        );
                    } else {
                        rows.push(new ActionRowBuilder().addComponents(
                            new ButtonBuilder()
                                .setCustomId('refresh_my_submissions')
                                .setLabel('🔄 Refresh')
                                .setStyle(ButtonStyle.Secondary)
                        ));
                    }
                }

                if (userSubmissions.length > maxButtons) {
                    embed.setFooter({ text: `Showing ${maxButtons} of ${userSubmissions.length} submissions. Use 🔄 Refresh to see all.` });
                }

                await interaction.reply({
                    embeds: [embed],
                    components: rows,
                    ephemeral: true
                });

            } catch (error) {
                console.error('Error checking user submissions:', error);
                await interaction.reply({
                    content: '❌ Error retrieving your submission data. Please try again later.',
                    ephemeral: true
                });
            }
        }
        return;
    }

    // Handle modal submissions
    if (interaction.isModalSubmit()) {
        if (interaction.customId === 'submission_form') {
            // Store initial data
            const nettPriceInput = interaction.fields.getTextInputValue('nett_price');
            const commissionRateInput = interaction.fields.getTextInputValue('commission_rate');

            console.log('=== FORM INPUT DEBUG ===');
            console.log('Raw Nett Price Input:', nettPriceInput);
            console.log('Raw Commission Rate Input:', commissionRateInput);

            // Get existing data to preserve consultant information
            const existingData = submissions.get(userId);

            const data = {
                project_name: interaction.fields.getTextInputValue('project_name'),
                unit_no: interaction.fields.getTextInputValue('unit_no'),
                spa_price: interaction.fields.getTextInputValue('spa_price'),
                nett_price: nettPriceInput,
                commission_rate: commissionRateInput,
                agents: existingData?.agents || [], // Preserve existing consultant data
                submission_date: existingData?.submission_date || new Date().toISOString(),
                // Preserve other existing data if any
                customer_name: existingData?.customer_name,
                customer_phone: existingData?.customer_phone,
                customer_address: existingData?.customer_address,
                spa_date: existingData?.spa_date,
                la_date: existingData?.la_date
            };

            console.log('Stored data nett_price:', data.nett_price);
            console.log('Stored data commission_rate:', data.commission_rate);

            submissions.set(userId, data);

            // Check if we have existing consultants or customer data to determine next step
            const hasConsultants = data.agents && data.agents.some(agent => agent && agent.name);
            const hasCustomerDetails = data.customer_name && data.customer_phone && data.customer_address && data.spa_date && data.la_date;

            let buttons = [];
            let message = '';

            if (hasConsultants) {
                // User has consultant data, show options to continue editing or proceed
                message = '✅ **Project details updated!**\nYour consultant data has been preserved. Choose your next step:';

                buttons.push(
                    new ButtonBuilder()
                        .setCustomId('show_agent_form_1')
                        .setLabel('Edit Consultant 1')
                        .setStyle(ButtonStyle.Secondary)
                );

                if (data.agents[1] && data.agents[1].name) {
                    buttons.push(
                        new ButtonBuilder()
                            .setCustomId('show_agent_form_2')
                            .setLabel('Edit Consultant 2')
                            .setStyle(ButtonStyle.Secondary)
                    );
                }

                if (data.agents[2] && data.agents[2].name) {
                    buttons.push(
                        new ButtonBuilder()
                            .setCustomId('show_agent_form_3')
                            .setLabel('Edit Consultant 3')
                            .setStyle(ButtonStyle.Secondary)
                    );
                }

                if (data.agents[3] && data.agents[3].name) {
                    buttons.push(
                        new ButtonBuilder()
                            .setCustomId('show_agent_form_4')
                            .setLabel('Edit Consultant 4')
                            .setStyle(ButtonStyle.Secondary)
                    );
                }

                // Add new consultant option if less than 4
                if (data.agents.length < 4) {
                    const nextSlot = data.agents.findIndex(agent => !agent || !agent.name);
                    const nextConsultantNum = nextSlot === -1 ? data.agents.length + 1 : nextSlot + 1;
                    if (nextConsultantNum <= 4) {
                        buttons.push(
                            new ButtonBuilder()
                                .setCustomId(`show_agent_form_${nextConsultantNum}`)
                                .setLabel(`Add Consultant ${nextConsultantNum}`)
                                .setStyle(ButtonStyle.Primary)
                        );
                    }
                }

                if (hasCustomerDetails) {
                    buttons.push(
                        new ButtonBuilder()
                            .setCustomId('proceed_to_confirmation')
                            .setLabel('✅ Proceed to Confirmation')
                            .setStyle(ButtonStyle.Success)
                    );
                } else {
                    buttons.push(
                        new ButtonBuilder()
                            .setCustomId('show_customer_form')
                            .setLabel('Continue: Customer Details')
                            .setStyle(ButtonStyle.Primary)
                    );
                }
            } else {
                // No consultant data, show normal flow
                message = '✅ **Project details saved!**\nClick the button below to continue with consultant details.';
                buttons.push(
                    new ButtonBuilder()
                        .setCustomId('show_agent_form_1')
                        .setLabel('Continue: Add Consultant Details')
                        .setStyle(ButtonStyle.Primary)
                );
            }

            // Split buttons into rows (max 5 buttons per row)
            const rows = [];
            for (let i = 0; i < buttons.length; i += 5) {
                const rowButtons = buttons.slice(i, i + 5);
                rows.push(new ActionRowBuilder().addComponents(rowButtons));
            }

            await interaction.reply({
                content: message,
                components: rows,
                ephemeral: true
            });
        }

        else if (interaction.customId.startsWith('agent_form_')) {
            const step = parseInt(interaction.customId.split('_')[2]);
            const data = submissions.get(userId);

            if (!data) {
                const restartRow = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId('restart_submission')
                            .setLabel('🔄 Start New Submission')
                            .setStyle(ButtonStyle.Primary)
                    );

                await interaction.update({
                    content: '❌ **Session expired or missing data**\n\nYour session has timed out. Click below to start a new submission:',
                    components: [restartRow],
                    embeds: []
                });
                return;
            }

            // Initialize agents array if it doesn't exist
            if (!data.agents) {
                data.agents = [];
            }

            // Process only the current agent (step)
            try {
                const name = interaction.fields.getTextInputValue(`agent${step}_name`) || '';
                const code = interaction.fields.getTextInputValue(`agent${step}_code`) || '';
                const percentage = interaction.fields.getTextInputValue(`agent${step}_percentage`) || '0';

                if (name || code || percentage !== '0') {
                    data.agents[step-1] = { name, code, percentage: parseFloat(percentage) || 0 };
                }
            } catch (error) {
                console.error('Error processing agent form:', error);
            }

            // Check if we already have customer details (editing mode)
            const hasCustomerDetails = data.customer_name && data.customer_phone && data.customer_address && data.spa_date && data.la_date;

            if (step < 4) {
                // Show continue button for next agent or skip
                const buttons = [
                    new ButtonBuilder()
                        .setCustomId(`show_agent_form_${step + 1}`)
                        .setLabel(`Continue: Add Consultant ${step + 1}`)
                        .setStyle(ButtonStyle.Primary),
                    new ButtonBuilder()
                        .setCustomId('skip_to_customer')  
                        .setLabel('Skip to Customer Details')
                        .setStyle(ButtonStyle.Secondary)
                ];

                // Add Previous button (different logic for step 1)
                if (step === 1) {
                    buttons.push(
                        new ButtonBuilder()
                            .setCustomId('show_agent_form_back_1')
                            .setLabel('← Back to Project Details')
                            .setStyle(ButtonStyle.Secondary)
                    );
                } else {
                    buttons.push(
                        new ButtonBuilder()
                            .setCustomId(`show_agent_form_back_${step}`)
                            .setLabel(`← Previous Consultant`)
                            .setStyle(ButtonStyle.Secondary)
                    );
                }

                // Add confirmation button if customer details exist
                if (hasCustomerDetails) {
                    buttons.push(
                        new ButtonBuilder()
                            .setCustomId('proceed_to_confirmation')
                            .setLabel('✅ Proceed to Confirmation')
                            .setStyle(ButtonStyle.Success)
                    );
                }

                const continueRow = new ActionRowBuilder().addComponents(buttons);

                try {
                await interaction.update({
                    content: `✅ **Consultant ${step} details saved!**\nYou can add more consultants${hasCustomerDetails ? ', proceed to confirmation,' : ''} or proceed to customer details.`,
                    components: [continueRow]
                });
            } catch (error) {
                console.error('Discord API error during update:', error);
                if (error.status === 503) {
                    console.log('Discord API temporarily unavailable, retrying...');
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    try {
                        await interaction.editReply({
                            content: `✅ **Consultant ${step} details saved!**\nYou can add more consultants${hasCustomerDetails ? ', proceed to confirmation,' : ''} or proceed to customer details.`,
                            components: [continueRow]
                        });
                    } catch (retryError) {
                        console.error('Retry failed:', retryError);
                    }
                }
            }

            } else {
                // Show continue button for customer form or confirmation
                const buttons = [];

                if (hasCustomerDetails) {
                    buttons.push(
                        new ButtonBuilder()
                            .setCustomId('proceed_to_confirmation')
                            .setLabel('✅ Proceed to Confirmation')
                            .setStyle(ButtonStyle.Success)
                    );
                } else {
                    buttons.push(
                        new ButtonBuilder()
                            .setCustomId('show_customer_form')
                            .setLabel('Continue: Customer Details')
                            .setStyle(ButtonStyle.Primary)
                    );
                }

                 buttons.push(
                        new ButtonBuilder()
                            .setCustomId(`show_agent_form_back_${step}`)
                            .setLabel(`← Previous Consultant`)
                            .setStyle(ButtonStyle.Secondary)
                    );

                const continueRow = new ActionRowBuilder().addComponents(buttons);

                try {
                await interaction.update({
                    content: `✅ **All consultant details saved!**\nClick below to ${hasCustomerDetails ? 'proceed to confirmation' : 'add customer details'}.`,
                    components: [continueRow]
                });
            } catch (error) {
                console.error('Discord API error during update:', error);
                if (error.status === 503) {
                    console.log('Discord API temporarily unavailable, retrying...');
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    try {
                        await interaction.editReply({
                            content: `✅ **All consultant details saved!**\nClick below to ${hasCustomerDetails ? 'proceed to confirmation' : 'add customer details'}.`,
                            components: [continueRow]
                        });
                    } catch (retryError) {
                        console.error('Retry failed:', retryError);
                    }
                }
            }

            }

        }

        else if (interaction.customId === 'customer_form') {
            const data = submissions.get(userId);

            if (!data) {
                const restartRow = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId('restart_submission')
                            .setLabel('🔄 Start New Submission')
                            .setStyle(ButtonStyle.Primary)
                    );

                await interaction.update({
                    content: '❌ **Session expired or missing data**\n\nYour session has timed out. Click below to start a new submission:',
                    components: [restartRow],
                    embeds: []
                });
                return;
            }

            // Add customer data
            data.customer_name = interaction.fields.getTextInputValue('customer_name');
            data.customer_phone = interaction.fields.getTextInputValue('customer_phone');
            data.customer_address = interaction.fields.getTextInputValue('customer_address');
            data.spa_date = interaction.fields.getTextInputValue('spa_date');
            data.la_date = interaction.fields.getTextInputValue('la_date');

            // Filter out empty agents
            data.agents = data.agents.filter(agent => agent && agent.name);

            // Validate consultant percentages
             if (!validateAgentPercentages(data.agents)) {
            const currentTotal = data.agents.reduce((sum, agent) => sum + parseFloat(agent.percentage || 0), 0);

            const editRow = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('edit_agent_percentages')
                        .setLabel('✏️ Edit Consultant Percentages')
                        .setStyle(ButtonStyle.Primary),

                    new ButtonBuilder()
                        .setCustomId('cancel_submission')
                        .setLabel('❌ Cancel')
                        .setStyle(ButtonStyle.Danger)
                );

            await interaction.reply({
                content: `❌ **Consultant percentages must total exactly 100%!**\n\n💡 **Explanation:** Each consultant's percentage represents their portion of the total commission.\n\nCurrent total: **${currentTotal.toFixed(1)}%**\n\nClick below to edit your consultant percentages:`,
                components: [editRow],
                ephemeral: true
            });
            return;
        }

            // Calculate commissions
            data.agents = calculateCommissions(data.nett_price, data.commission_rate, data.agents);

            // Show confirmation
            const embed = createConfirmationEmbed(data);
            const confirmRow = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('confirm_submission')
                        .setLabel('✅ Confirm & Upload Documents')
                        .setStyle(ButtonStyle.Success),
                    new ButtonBuilder()
                        .setCustomId('edit_details')
                        .setLabel('✏️ Edit Details')
                        .setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder()
                        .setCustomId('cancel_submission')
                        .setLabel('❌ Cancel')
                        .setStyle(ButtonStyle.Danger)
                );

            await interaction.update({
                content: '',
                embeds: [embed],
                components: [confirmRow]
            });
        }

        else if (interaction.customId === 'file_upload_form') {
            await interaction.reply({
                content: '📎 **Ready for File Upload!**\n\n**Now attach your commission documents to your next message.**\n\nYou can attach multiple files (PDF, DOC, DOCX, JPG, PNG) by:\n• Click the paperclip (📎) icon\n• Select "Upload a File"\n• Choose your documents\n• Send the message\n\nI\'ll process your files automatically!',
                ephemeral: true
            });

            // Set user state to expect file upload
            const data = submissions.get(userId);
            submissions.set(userId, { ...data, status: 'awaiting_files' });
        }

        else if (interaction.customId.startsWith('document_upload_')) {
            const documentType = interaction.customId.split('_')[2];
            const documentNames = {
                booking: 'Booking Form',
                spa: 'SPA Document',
                la: 'LA Document'
            };

            await interaction.reply({
                content: `📎 **Ready to upload ${documentNames[documentType]}!**\n\n**Now attach your ${documentNames[documentType]} to your next message.**\n\nSupported formats: PDF, DOC, DOCX, JPG, PNG\n\nI'll process your files automatically and update the checklist!`,
                ephemeral: true
            });

            // Set user state to expect specific document upload
            const data = submissions.get(userId);
            submissions.set(userId, { ...data, status: `awaiting_${documentType}` });
        }
        return;
    }

    // Handle button interactions
    if (interaction.isButton()) {
        if (interaction.customId === 'show_agent_form_1') {
            const data = submissions.get(userId);
            const existingAgent = data && data.agents && data.agents[0] ? data.agents[0] : {};
            const agentModal = createAgentModal(1, existingAgent);
            await interaction.showModal(agentModal);
        }

         else if (interaction.customId === 'show_agent_form_back_2') {
            const data = submissions.get(userId);
            const existingAgent = data && data.agents && data.agents[0] ? data.agents[0] : {};
            const agentModal = createAgentModal(1, existingAgent);
            await interaction.showModal(agentModal);
        }

        else if (interaction.customId === 'show_agent_form_back_3') {
            const data = submissions.get(userId);
            const existingAgent = data && data.agents && data.agents[1] ? data.agents[1] : {};
            const agentModal = createAgentModal(2, existingAgent);
            await interaction.showModal(agentModal);
        }

        else if (interaction.customId === 'show_agent_form_back_4') {
            const data = submissions.get(userId);
            const existingAgent = data && data.agents && data.agents[2] ? data.agents[2] : {};
            const agentModal = createAgentModal(3, existingAgent);
            await interaction.showModal(agentModal);
        }

        else if (interaction.customId === 'show_agent_form_back_1') {
            // Handle going back from consultant 1 - show project form instead
            const data = submissions.get(userId);
            if (!data) {
                const restartRow = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId('restart_submission')
                            .setLabel('🔄 Start New Submission')
                            .setStyle(ButtonStyle.Primary)
                    );

                await interaction.update({
                    content: '❌ **Session expired or missing data**\n\nYour session has timed out. Click below to start a new submission:',
                    components: [restartRow],
                    embeds: []
                });
                return;
            }

            const modal = createSubmissionModal();
            // Pre-fill the modal with existing data
            modal.components[0].components[0].setValue(data.project_name || '');
            modal.components[1].components[0].setValue(data.unit_no || '');
            modal.components[2].components[0].setValue(data.spa_price || '');
            modal.components[3].components[0].setValue(data.nett_price || '');
            modal.components[4].components[0].setValue(data.commission_rate ? data.commission_rate.toString() : '');

            await interaction.showModal(modal);
        }

        else if (interaction.customId === 'show_agent_form_2') {
            const data = submissions.get(userId);
            const existingAgent = data && data.agents && data.agents[1] ? data.agents[1] : {};
            const agentModal = createAgentModal(2, existingAgent);
            await interaction.showModal(agentModal);
        }

        else if (interaction.customId === 'show_agent_form_3') {
            const data = submissions.get(userId);
            const existingAgent = data && data.agents && data.agents[2] ? data.agents[2] : {};
            const agentModal = createAgentModal(3, existingAgent);
            await interaction.showModal(agentModal);
        }

        else if (interaction.customId === 'show_agent_form_4') {
            const data = submissions.get(userId);
            const existingAgent = data && data.agents && data.agents[3] ? data.agents[3] : {};
            const agentModal = createAgentModal(4, existingAgent);
            await interaction.showModal(agentModal);
        }

        else if (interaction.customId === 'skip_to_customer' || interaction.customId === 'show_customer_form') {
            const data = submissions.get(userId);
            const customerModal = createCustomerModal(data);
            await interaction.showModal(customerModal);
        }

        else if (interaction.customId === 'confirm_submission') {
            const data = submissions.get(userId);

            // Check if already confirmed to prevent duplicate processing
            if (data && data.dataConfirmed && data.sessionToken) {
                await interaction.reply({
                    content: '✅ **Submission already confirmed!**\n\nYour submission is ready for document upload. Please use the form link to upload your documents.',
                    ephemeral: true
                });
                return;
            }

            // Prevent double-clicks
            const confirmKey = `confirm_${userId}`;
            if (processingConfirmations.has(confirmKey)) {
                await interaction.reply({
                    content: '⏳ Submission already being processed. Please wait...',
                    ephemeral: true
                });
                return;
            }

            // Mark as processing
            processingConfirmations.set(confirmKey, true);

            // Immediately respond to prevent timeout
            await interaction.deferUpdate();

            if (!data || !data.project_name) {
                const restartRow = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId('restart_submission')
                            .setLabel('🔄 Start New Submission')
                            .setStyle(ButtonStyle.Primary)
                    );

                await interaction.editReply({
                    content: '❌ **Session expired or missing data**\n\nYour session has timed out. Click below to start a new submission:',
                    components: [restartRow],
                    embeds: []
                });
                processingConfirmations.delete(confirmKey);
                return;
            }



            // Skip authentication check - proceed directly to document upload
            // OAuth will be handled silently in the background during file processing

            // Generate unique session token for this user
            const sessionToken = `token_${userId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

            // Mark data as confirmed but DON'T save to GitHub backup yet
            // Only save after successful document upload
            data.dataConfirmed = true;
            data.status = 'authenticated'; // Changed status to authenticated
            data.sessionToken = sessionToken;
            data.userId = userId; // Store user ID in data
            data.username = interaction.user.username; // Store username for later use
            submissions.set(userId, data);

            // Map token to user ID for webhook matching
            tokenToUserId.set(sessionToken, userId);

            try {
                // Check if Jotform is properly configured
                if (!JOTFORM_API_KEY || !JOTFORM_TEMPLATE_ID) {
                    throw new Error('Jotform not configured');
                }

                // Create Jotform for document uploads with unique token
                // Use prefilled form URL with unique session token embedded in project info for perfect matching
        // Use prefilled form URL with session token in the session_id field
        // Use prefilled form URL with user_id and price_token fields
        const formUrl = `https://form.jotform.com/${JOTFORM_TEMPLATE_ID}?user_id=${encodeURIComponent(data.userId)}&price_token=${encodeURIComponent(sessionToken)}`;

        console.log('Generated Jotform URL with session token:', sessionToken);
        console.log('Generated Jotform URL for:', data.project_name);
                const formData = await createJotformUpload(data, sessionToken);

                // Store form info
                data.jotform = formData;
                data.status = 'awaiting_form_completion';
                submissions.set(userId, data);

                const embed = new EmbedBuilder()
                    .setTitle('📋 Document Upload - Jotform')
                    .setColor(0xFF6600)
                    .setDescription('Your document upload form is ready!')
                    .addFields(
                        { name: '📝 What to do next:', value: '1. Click the "Upload Documents" button below\n2. Fill out the Jotform with your documents\n3. Submit the form\n4. Return here and click "Check Upload Status"', inline: false },
                        { name: '📋 Required Documents:', value: '• Booking Form\n• SPA Document\n• LA Document', inline: false },
                        { name: '📋 Project Info', value: `${data.project_name} - ${data.unit_no}`, inline: false }
                    )
                    .setFooter({ text: 'The form will automatically save your documents' });

                const actionRow = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setLabel('📝 Upload Documents')
                            .setStyle(ButtonStyle.Link)
                            .setURL(formData.formUrl),
                        new ButtonBuilder()
                            .setCustomId('check_upload_status')
                            .setLabel('🔄 Check Upload Status')
                            .setStyle(ButtonStyle.Primary),
                        new ButtonBuilder()
                            .setCustomId('cancel_submission')
                            .setLabel('❌ Cancel')
                            .setStyle(ButtonStyle.Danger)
                    );

                // Send as follow-up to make it persistent
                await interaction.editReply({
                    content: '✅ **Submission Processing...**',
                    embeds: [],
                    components: []
                });

                await interaction.followUp({
                    content: '✅ **Submission Confirmed!**\n\n📋 **Your commission data has been saved.**\n🎯 **Document upload form ready!**',
                    embeds: [embed],
                    components: [actionRow],
                    ephemeral: true
                });

            } catch (error) {
            console.error('Error creating Jotform:', error);
            console.error('Error details:', error.response?.data || error.message);

            // Check for specific error types
            if (error.response?.status === 403) {
                console.error('Permission denied - check Jotform API key');
            } else if (error.response?.status === 429) {
                console.error('Rate limit exceeded - implementing retry logic');

                // Implement exponential backoff retry
                for (let attempt = 1; attempt <= 3; attempt++) {
                    try {
                        console.log(`Retry attempt ${attempt}/3 after rate limit...`);
                        await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));

                        const retryFormData = await createJotformUpload(data);
                        data.jotform = retryFormData;
                        data.status = 'awaiting_form_completion';
                        submissions.set(userId, data);

                        // Success on retry
                        const embed = new EmbedBuilder()
                            .setTitle('📋 Document Upload - Jotform (Retry Success)')
                            .setColor(0xFF6600)
                            .setDescription('Your personalized Jotform has been created after retry!')
                            .addFields(
                                { name: '📝 What to do next:', value: '1. Click the "Upload Documents" button below\n2. Fill out the Jotform with your documents\n3. Submit the form\n4. Return here and click "Check Upload Status"', inline: false },
                                { name: '📋 Required Documents:', value: '• Booking Form\n• SPA Document\n• LA Document', inline: false }
                            )
                            .setFooter({ text: 'The form will automatically save your documents' });

                        const actionRow = new ActionRowBuilder()
                            .addComponents(
                                new ButtonBuilder()
                                    .setLabel('📝 Upload Documents')
                                    .setStyle(ButtonStyle.Link)
                                    .setURL(retryFormData.formUrl),
                                new ButtonBuilder()
                                    .setCustomId('check_upload_status')
                                    .setLabel('🔄 Check Upload Status')
                                    .setStyle(ButtonStyle.Primary),
                                new ButtonBuilder()
                                    .setCustomId('cancel_submission')
                                    .setLabel('❌ Cancel')
                                    .setStyle(ButtonStyle.Danger)
                            );

                        await interaction.editReply({
                            content: '✅ **Form Creation Successful After Retry!**\n\n📋 **Your commission data has been saved.**\n🎯 **Jotform created for document uploads!**',
                            embeds: [embed],
                            components: [actionRow]
                        });
                        return;
                    } catch (retryError) {
                        console.error(`Retry attempt ${attempt} failed:`, retryError);
                        if (attempt === 3) break;
                    }
                }
            }

                // Check if interaction is still valid (not expired)
                try {
                    // Since data is already saved, show user-friendly error with retry
                    const errorEmbed = new EmbedBuilder()
                        .setTitle('⚠️ Jotform Creation Error')
                        .setColor(0xFF6B6B)
                        .setDescription('There was a temporary issue creating your document upload form.')
                        .addFields(
                            { name: '✅ Your Data is Safe', value: '• All your submission details are preserved\n• Your commission data has been saved to GitHub\n• No need to re-enter any information', inline: false },
                            { name: '🔄 Next Steps', value: 'Use `/fast-comm-submission` command again. Your previous data will be preserved.', inline: false },
                            { name: '📋 Backup Info', value: `Saved at: ${new Date().toLocaleString()}\nUser: ${interaction.user.username}`, inline: false }
                        )
                        .setTimestamp();

                    const retryRow = new ActionRowBuilder()
                        .addComponents(
                            new ButtonBuilder()
                                .setCustomId('retry_jotform')
                                .setLabel('🔄 Retry Form Creation')
                                .setStyle(ButtonStyle.Primary),
                            new ButtonBuilder()
                                .setCustomId('view_preserved_data')
                                .setLabel('👁️ View My Data')
                                .setStyle(ButtonStyle.Secondary)
                        );

                    await interaction.editReply({
                        content: '💾 **Your Data Has Been Safely Preserved!**\n\n✅ **Submission confirmed and backed up**\n⚠️ **Form creation needs retry**',
                        embeds: [errorEmbed],
                        components: [retryRow],
                        ephemeral: true
                    });
                    processingConfirmations.delete(confirmKey);
                } catch (interactionError) {
                    console.error('Interaction expired, sending follow-up message:', interactionError);

                    // Interaction expired, send a follow-up message
                    try {
                        await interaction.followUp({
                            content: '💾 **Your Data Has Been Safely Preserved!**\n\n✅ **Submission confirmed and backed up to GitHub**\n⚠️ **Jotform creation failed temporarily**\n\n🔄 **To continue:** Use `/fast-comm-submission` command again. Your data is preserved and you won\'t need to re-enter it.',
                            ephemeral: true
                        });
                    } catch (followUpError) {
                        console.error('Both interaction update and followUp failed, logging data for user:', followUpError);
                        console.log(`User ${userId} (${interaction.user.username}) data preserved but UI failed. Backup saved to GitHub.`);
                    }
                } finally {
                    // Always clean up processing state
                    processingConfirmations.delete(confirmKey);
                }
            }
        }



        else if (interaction.customId === 'edit_details') {
            // Show edit options menu
            const editRow = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('edit_project_details')
                        .setLabel('📋 Edit Project Details')
                        .setStyle(ButtonStyle.Primary),
                    new ButtonBuilder()
                        .setCustomId('edit_agent_details')
                        .setLabel('👥 Edit Consultant Details')
                        .setStyle(ButtonStyle.Primary),
                    new ButtonBuilder()
                        .setCustomId('edit_customer_details')
                        .setLabel('👤 Edit Customer Details')
                        .setStyle(ButtonStyle.Primary)
                );

            const backRow = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('back_to_confirmation')
                        .setLabel('← Back to Confirmation')
                        .setStyle(ButtonStyle.Secondary)
                );

            await interaction.update({
                content: '✏️ **What would you like to edit?**\nChoose a section below:',
                embeds: [],
                components: [editRow, backRow]
            });
        }

        else if (interaction.customId === 'edit_project_details') {
            const modal = createSubmissionModal();
            await interaction.showModal(modal);
        }

        else if (interaction.customId === 'edit_agent_details') {
            // Show agent editing options
            const agentRow = new ActionRowBuilder()
                                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('show_agent_form_1')
                        .setLabel('Edit Consultant 1')
                        .setStyle(ButtonStyle.Primary),
                    new ButtonBuilder()
                        .setCustomId('show_agent_form_2')
                        .setLabel('Edit Consultant 2')
                        .setStyle(ButtonStyle.Primary),
                    new ButtonBuilder()
                        .setCustomId('show_agent_form_3')
                        .setLabel('Edit Consultant 3')
                        .setStyle(ButtonStyle.Primary),
                    new ButtonBuilder()
                        .setCustomId('show_agent_form_4')
                        .setLabel('Edit Consultant 4')
                        .setStyle(ButtonStyle.Primary)
                );

            const backRow = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('back_to_confirmation')
                        .setLabel('← Back to Confirmation')
                        .setStyle(ButtonStyle.Secondary)
                );

            await interaction.update({
                content: '👥 **Edit Consultant Details**\nChoose which consultant to edit:',
                components: [agentRow, backRow]
            });
        }

        else if (interaction.customId === 'edit_customer_details') {
            const customerModal = createCustomerModal();
            await interaction.showModal(customerModal);
        }

        else if (interaction.customId === 'edit_agent_percentages') {
            // Show agent editing options
            const data = submissions.get(userId);
            const agentButtons = [];

            // Only show buttons for agents that have names
            for (let i = 0; i < 4; i++){
                const agent = data.agents[i];
                if (agent && agent.name) {
                    agentButtons.push(
                        new ButtonBuilder()
                            .setCustomId(`show_agent_form_${i + 1}`)
                            .setLabel(`Edit ${agent.name} (${agent.percentage}%)`)
                            .setStyle(ButtonStyle.Primary)
                    );
                }
            }

            const agentRow = new ActionRowBuilder().addComponents(agentButtons.slice(0, 5));
            const rows = [agentRow];

            if (agentButtons.length > 5) {
                const secondRow = new ActionRowBuilder().addComponents(agentButtons.slice(5));
                rows.push(secondRow);
            }

            const backRow = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('show_customer_form')
                        .setLabel('← Back to Customer Form')
                        .setStyle(ButtonStyle.Secondary)
                );

            rows.push(backRow);

            const currentTotal = data.agents.reduce((sum, agent) => sum + parseFloat(agent.percentage || 0), 0);

            await interaction.update({
                content: `👥 **Edit Consultant Percentages**\n\nCurrent total: **${currentTotal.toFixed(1)}%** (needs to be 100%)\n\nChoose which consultant to edit:`,
                components: rows
            });
        }

        else if (interaction.customId === 'back_to_confirmation') {
            const data = submissions.get(userId);

            if (!data) {
                await interaction.update({
                    content: '❌ **Session expired or missing data**\n\nYour session has timed out. Click below to start a new submission:',
                    components: [],
                    embeds: []
                });
                return;
            }

            // Recalculate commissions in case agent data was changed
            data.agents = data.agents.filter(agent => agent && agent.name);
            if (data.agents.length > 0) {
                data.agents = calculateCommissions(data.nett_price, data.commission_rate, data.agents);
            }

            const embed = createConfirmationEmbed(data);
            const confirmRow = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('confirm_submission')
                        .setLabel('✅ Confirm & Upload Documents')
                        .setStyle(ButtonStyle.Success),
                    new ButtonBuilder()
                        .setCustomId('edit_details')
                        .setLabel('✏️ Edit Details')
                        .setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder()
                        .setCustomId('cancel_submission')
                        .setLabel('❌ Cancel')
                        .setStyle(ButtonStyle.Danger)
                );

            await interaction.update({
                content: '',
                embeds: [embed],
                components: [confirmRow]
            });
        }

        else if (interaction.customId === 'proceed_to_confirmation') {
            const data = submissions.get(userId);

            if (!data) {
                const restartRow = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId('restart_submission')
                            .setLabel('🔄 Start New Submission')
                            .setStyle(ButtonStyle.Primary)
                    );

                await interaction.update({
                    content: '❌ **Session expired or missing data**\n\nYour session has timed out. Click below to start a new submission:',
                    components: [restartRow]
                });
                return;
            }

            // Filter out empty agents
            data.agents = data.agents.filter(agent => agent && agent.name);

            // Validate consultant percentages
             if (!validateAgentPercentages(data.agents)) {
            const currentTotal = data.agents.reduce((sum, agent) => sum + parseFloat(agent.percentage || 0), 0);

            const editRow = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('edit_agent_percentages')
                        .setLabel('✏️ Edit Consultant Percentages')
                        .setStyle(ButtonStyle.Primary),
                    new ButtonBuilder()
                        .setCustomId('cancel_submission')
                        .setLabel('❌ Cancel')
                        .setStyle(ButtonStyle.Danger)
                );

            await interaction.update({
                content: `❌ **Consultant percentages must total exactly 100%!**\n\n💡 **Explanation:** Each consultant's percentage represents their portion of the total commission.\n\nCurrent total: **${currentTotal.toFixed(1)}%**\n\nClick below to edit your consultant percentages:`,
                components: [editRow]
            });
            return;
        }

            // Calculate commissions
            data.agents = calculateCommissions(data.nett_price, data.commission_rate, data.agents);

            // Show confirmation
            const embed = createConfirmationEmbed(data);
            const confirmRow = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('confirm_submission')
                        .setLabel('✅ Confirm & Upload Documents')
                        .setStyle(ButtonStyle.Success),
                    new ButtonBuilder()
                        .setCustomId('edit_details')
                        .setLabel('✏️ Edit Details')
                        .setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder()
                        .setCustomId('cancel_submission')
                        .setLabel('❌ Cancel')
                        .setStyle(ButtonStyle.Danger)
                );

            await interaction.update({
                content: '',
                embeds: [embed],
                components: [confirmRow]
            });
        }

        else if (interaction.customId === 'proceed_with_files') {
            const data = submissions.get(userId);

            await interaction.update({
                content: '🎉 **Submission Complete!**\n\nThank you for your commission submission. Your documents have been uploaded and your data has been saved.\n\n✅ **Status:** Complete\n📁 **Documents:** Successfully uploaded',
                components: []
            });

            // Clean up
            submissions.delete(userId);
        }

        else if (interaction.customId === 'cancel_files') {
            const data = submissions.get(userId);

            await interaction.update({
                content: '❌ **File upload cancelled.**\n\nYou can restart the submission process with `/fast-comm-submission` if needed.',
                components: []
            });

            // Clean up
            submissions.delete(userId);
        }

        else if (interaction.customId === 'cancel_submission') {
            submissions.delete(userId);
            await interaction.update({
                content: '❌ Submission cancelled.',
                embeds: [],
                components: []
            });
        }

        else if (interaction.customId.startsWith('confirm_delete_')) {

            try {
                const index = parseInt(interaction.customId.split('_')[2]);
                const backupData = await loadBackupFromGitHub();

                if (index < 0 || index >= backupData.length) {                    await interaction.update({
                        content: '❌ Invalid submission index.',
                        components: []
                    });
                    return;
                }

                const deletedSubmission = backupData[index];
                backupData.splice(index, 1);
                await saveBackupToGitHub(backupData);

                await interaction.update({
                    content: `✅ **Submission Deleted Successfully**\n\n**Project:** ${deletedSubmission.project_name}\n**User:** ${deletedSubmission.username}\n**Previous Index:** ${index}\n\nBackup updated in GitHub.`,
                    components: []
                });

            } catch (error) {
                console.error('Error deleting submission:', error);
                await interaction.update({
                    content: '❌ Error deleting submission from GitHub backup.',
                    components: []
                });
            }
        }

        else if (interaction.customId.startsWith('confirm_bulk_delete_')) {

            try {
                const indicesString = interaction.customId.replace('confirm_bulk_delete_', '');
                const indices = indicesString.split(',').map(str => parseInt(str.trim())).sort((a, b) => b - a);
                const backupData = await loadBackupFromGitHub();

                // Validate indices again
                const invalidIndices = indices.filter(idx => idx < 0 || idx >= backupData.length);
                if (invalidIndices.length > 0) {
                    await interaction.update({
                        content: `❌ Some indices are now invalid: ${invalidIndices.join(', ')}\n\nPlease try again with valid indices.`,
                        components: []
                    });
                    return;
                }

                // Delete submissions (from highest index to lowest to avoid index shifting)
                const deletedSubmissions = [];
                for (const index of indices) {
                    deletedSubmissions.push({
                        index: index,
                        project: backupData[index].project_name,
                        user: backupData[index].username
                    });
                    backupData.splice(index, 1);
                }

                await saveBackupToGitHub(backupData);

                const deletedList = deletedSubmissions
                    .map(item => `• Index ${item.index}: ${item.project} - ${item.user}`)
                    .join('\n');

                await interaction.update({
                    content: `✅ **Bulk Deletion Successful**\n\n**Deleted ${deletedSubmissions.length} submission(s):**\n\n${deletedList}\n\nBackup updated in GitHub.`,
                    components: []
                });

            } catch (error) {
                console.error('Error bulk deleting submissions:', error);
                await interaction.update({
                    content: '❌ Error bulk deleting submissions from GitHub backup.',
                    components: []
                });
            }
        }

        else if (interaction.customId === 'cancel_delete') {
            await interaction.update({
                content: '❌ Deletion cancelled.',
                components: []
            });
        }



        else if (interaction.customId === 'upload_booking_form') {
            await interaction.reply({
                content: '📝 **Ready to upload Booking Form!**\n\n**Now attach your Booking Form documents to your next message.**\n\nSupported formats: PDF, DOC, DOCX, JPG, PNG\n\nI\'ll process your files automatically and update the checklist!',
                ephemeral: true
            });

            // Set user state to expect specific document upload
            const data = submissions.get(userId);
            submissions.set(userId, { ...data, status: 'awaiting_booking_form' });
        }

        else if (interaction.customId === 'upload_spa') {
            await interaction.reply({
                content: '📄 **Ready to upload SPA Document!**\n\n**Now attach your SPA documents to your next message.**\n\nSupported formats: PDF, DOC, DOCX, JPG, PNG\n\nI\'ll process your files automatically and update the checklist!',
                ephemeral: true
            });

            // Set user state to expect specific document upload
            const data = submissions.get(userId);
            submissions.set(userId, { ...data, status: 'awaiting_spa' });
        }

        else if (interaction.customId === 'upload_la') {
            await interaction.reply({
                content: '📑 **Ready to upload LA Document!**\n\n**Now attach your LA documents to your next message.**\n\nSupported formats: PDF, DOC, DOCX, JPG, PNG\n\nI\'ll process your files automatically and update the checklist!',
                ephemeral: true
            });

            // Set user state to expect specific document upload
            const data = submissions.get(userId);
            submissions.set(userId, { ...data, status: 'awaiting_la' });
        }

        else if (interaction.customId === 'check_upload_status') {
            const data = submissions.get(userId);

            if (!data || !data.jotform) {
                await interaction.reply({
                    content: '❌ No form data found. Please restart the submission process.',
                    ephemeral: true
                });
                return;
            }

            // Prevent multiple simultaneous status checks
            const statusCheckKey = `status_check_${userId}`;
            if (processingConfirmations.has(statusCheckKey)) {
                await interaction.reply({
                    content: '⏳ Status check already in progress. Please wait...',
                    ephemeral: true
                });
                return;
            }

            // Mark status check as in progress
            processingConfirmations.set(statusCheckKey, true);

            try {
                await interaction.deferUpdate();

                // Check if already completed via webhook for THIS specific user AND has actual files
                if (data.status === 'completed' && data.jotformSubmissionId && data.uploadedFiles && data.uploadedFiles.length > 0) {
                    await interaction.followUp({
                        content: `🎉 **Commission Submission Complete!**\n\nCongratulations! Your claim submission is under review. Please be patient, we have notified our admin to proceed with your application.\n\n✅ **Status:** Complete\n📁 **Documents:** Successfully uploaded\n📋 **Notification:** Sent to admin channel\n\n📄 **Files Uploaded:** ${data.uploadedFiles.length} document(s)`,
                        ephemeral: true
                    });
                    submissions.delete(userId);
                    return;
                }

                // Check if user already has files uploaded (prevent duplicate processing)
                if (data.uploadedFiles && data.uploadedFiles.length > 0) {
                    await interaction.editReply({
                        content: `🎉 **Commission Submission Complete!**\n\nCongratulations! Your claim submission is under review. Please be patient, we have notified our admin to proceed with your application.\n\n✅ **Status:** Complete\n📁 **Documents:** Successfully uploaded\n📋 **Notification:** Sent to admin channel\n\n📄 **Files Uploaded:** ${data.uploadedFiles.length} document(s)`,
                        embeds: [],
                        components: []
                    });
                    data.status = 'completed';
                    submissions.set(userId, data);
                    processingConfirmations.delete(statusCheckKey);
                    return;
                }

                // Check if this specific submission was already processed via webhook
                if (data.jotformSubmissionId && processedSubmissions.has(data.jotformSubmissionId)) {
                    console.log('Submission already processed globally:', data.jotformSubmissionId);
                    await interaction.editReply({
                        content: `🎉 **Commission Submission Complete!**\n\nCongratulations! Your claim submission is already processed.\n\n✅ **Status:** Complete\n📁 **Documents:** Already uploaded\n📋 **Notification:** Already sent`,
                        embeds: [],
                        components: []
                    });
                    data.status = 'completed';
                    submissions.set(userId, data);
                    processingConfirmations.delete(statusCheckKey);
                    return;
                }

                // Check for submissions with matching session token (perfect matching)
                const hasNewSubmissions = await checkForTokenBasedJotformSubmissions(data.jotform.formId, data);

                if (hasNewSubmissions) {
                    // Show progress bar first
                    const progressEmbed = new EmbedBuilder()
                        .setTitle('⏳ Processing Your Documents')
                        .setColor(0xFF6600)
                        .setDescription('Your files are being transferred to server...')
                        .addFields(
                            { name: '📁 Status', value: '🔄 Downloading from Jotform...', inline: false },
                            { name: '🎯 Project', value: `${data.project_name} - ${data.unit_no}`, inline: false },
                            { name: '📄 Submission ID', value: hasNewSubmissions.submissionId, inline: false }
                        )
                        .setFooter({ text: 'Please wait while we process your documents' });

                    await interaction.editReply({
                        content: '📤 **File Upload in Progress...**',
                        embeds: [progressEmbed],
                        components: []
                    });

                    // Check if this submission was already processed by this user
                    if (data.jotformSubmissionId === hasNewSubmissions.submissionId && data.uploadedFiles && data.uploadedFiles.length > 0) {
                        await interaction.editReply({
                            content: `🎉 **Commission Submission Complete!**\n\nCongratulations! Your claim submission is under review. Please be patient, we have notified our admin to proceed with your application.\n\n✅ **Status:** Complete\n📁 **Documents:** Successfully uploaded\n📋 **Notification:** Sent to admin channel\n\n📄 **Files Uploaded:** ${data.uploadedFiles.length} document(s)`,
                            embeds: [],
                            components: []
                        });
                        processingConfirmations.delete(statusCheckKey);
                        return;
                    }

                    // Check if this submission ID was already processed globally (prevent duplicate processing)
                    if (processedSubmissions.has(hasNewSubmissions.submissionId)) {
                        console.log('Submission already processed globally:', hasNewSubmissions.submissionId);
                        await interaction.editReply({
                            content: `🎉 **Commission Submission Complete!**\n\nCongratulations! Your claim submission is already processed.\n\n✅ **Status:** Complete\n📁 **Documents:** Already uploaded\n📋 **Notification:** Already sent`,
                            embeds: [],
                            components: []
                        });
                        processingConfirmations.delete(statusCheckKey);
                        return;
                    }

                    // Process the completion with REAL submission ID and update progress
                    try {
                        // Update progress: Starting transfer
                        progressEmbed.setFields(
                            { name: '📁 Status', value: '📤 Uploading to server...', inline: false },
                            { name: '🎯 Project', value: `${data.project_name} - ${data.unit_no}`, inline: false },
                            { name: '📄 Submission ID', value: hasNewSubmissions.submissionId, inline: false }
                        );

                        await interaction.editReply({
                            content: '📤 **File Upload in Progress...**',
                            embeds: [progressEmbed],
                            components: []
                        });

                        const uploadedFiles = await transferJotformFilesToGoogleDrive(hasNewSubmissions.submissionId, data);

                        // Only proceed if files were actually uploaded
                        if (uploadedFiles && uploadedFiles.length > 0) {
                            // Update progress: Saving to backup
                            progressEmbed.setFields(
                                { name: '📁 Status', value: '💾 Saving to backup...', inline: false },
                                { name: '🎯 Project', value: `${data.project_name} - ${data.unit_no}`, inline: false },
                                { name: '📄 Files Transferred', value: `${uploadedFiles.length} document(s)`, inline: false }
                            );

                            await interaction.editReply({
                                content: '💾 **Finalizing Upload...**',
                                embeds: [progressEmbed],
                                components: []
                            });

                            data.uploadedFiles = uploadedFiles;
                            data.jotformSubmissionId = hasNewSubmissions.submissionId;

                            // NOW save to GitHub backup (only after successful file upload)
                            const backupData = await loadBackupFromGitHub();
                            const submissionData = {
                                ...data,
                                user_id: userId,
                                username: data.username || 'Unknown User',
                                submitted_at: getGMT8Date().toISOString(),
                                uploadedFiles: uploadedFiles
                            };
                            backupData.push(submissionData);
                            await saveBackupToGitHub(backupData);

                            // Update progress: Sending notifications
                            progressEmbed.setFields(
                                { name: '📁 Status', value: '📨 Sending notifications...', inline: false },
                                { name: '🎯 Project', value: `${data.project_name} - ${data.unit_no}`, inline: false },
                                { name: '📄 Files Transferred', value: `${uploadedFiles.length} document(s)`, inline: false }
                            );

                            await interaction.editReply({
                                content: '📨 **Sending Notifications...**',
                                embeds: [progressEmbed],
                                components: []
                            });

                            // Send notification to channel
                            await sendSubmissionNotification(data, hasNewSubmissions.submissionId);
                            data.status = 'completed';
                            submissions.set(userId, data);

                            // Final completion message
                            await interaction.editReply({
                                content: `🎉 **Commission Submission Complete!**\n\nCongratulations! Your claim submission is under review. Please be patient, we have notified our admin to proceed with your application.\n\n✅ **Status:** Complete\n📁 **Documents:** Successfully uploaded\n📋 **Notification:** Sent to admin channel\n\n📄 **Files Uploaded:** ${uploadedFiles.length} document(s)`,
                                embeds: [],
                                components: []
                            });

                            // Clean up
                            submissions.delete(userId);
                            processingConfirmations.delete(statusCheckKey);
                            return;
                        } else {
                            // Files failed to upload
                            await interaction.editReply({
                                content: '❌ **File Upload Failed**\n\nDocuments were submitted to Jotform but failed to transfer to server. Please try again or contact support.',
                                embeds: [],
                                components: []
                            });
                            processingConfirmations.delete(statusCheckKey);
                            return;
                        }
                    } catch (uploadError) {
                        console.error('Error during upload processing:', uploadError);

                        const errorEmbed = new EmbedBuilder()
                            .setTitle('❌ Upload Processing Failed')
                            .setColor(0xFF0000)
                            .setDescription('There was an error processing your documents.')
                            .addFields(
                                { name: '🔍 Error Details', value: uploadError.message || 'Unknown error occurred', inline: false },
                                { name: '🔄 What to do next', value: 'Please try checking status again or contact support', inline: false }
                            );

                        const retryRow = new ActionRowBuilder()
                            .addComponents(
                                new ButtonBuilder()
                                    .setCustomId('check_upload_status')
                                    .setLabel('🔄 Try Again')
                                    .setStyle(ButtonStyle.Primary),
                                new ButtonBuilder()
                                    .setCustomId('back_to_form_view')
                                    .setLabel('← Back to Form')
                                    .setStyle(ButtonStyle.Secondary)
                            );

                        await interaction.editReply({
                            content: '❌ **Upload Processing Error**',
                            embeds: [errorEmbed],
                            components: [retryRow]
                        });
                        processingConfirmations.delete(statusCheckKey);
                        return;
                    }
                } else {
                    const backRow = new ActionRowBuilder()
                        .addComponents(
                            new ButtonBuilder()
                                .setCustomId('check_upload_status')
                                .setLabel('🔄 Check Again (Auto-refresh in 30s)')
                                .setStyle(ButtonStyle.Primary),
                            new ButtonBuilder()
                                .setLabel('📝 Upload Documents')
                                .setStyle(ButtonStyle.Link)
                                .setURL(data.jotform.formUrl),
                            new ButtonBuilder()
                                .setCustomId('back_to_form_view')
                                .setLabel('← Back to Form Info')
                                .setStyle(ButtonStyle.Secondary)
                        );

                    await interaction.editReply({
                        content: '⏳ **No form submission detected yet**\n\nPlease complete the Jotform first, then check status again.\n\n📝 If you haven\'t submitted the form yet, click the "Upload Documents" button below.\n\n🔔 **Note:** The system will auto-check every 30 seconds, or you can manually check again.',
                        embeds: [],
                        components: [backRow]
                    });

                                        // Auto-refresh after 30 seconds
                    setTimeout(async () => {
                        try {
                            const laterData = submissions.get(userId);
                            if (laterData && laterData.status === 'awaiting_form_completion') {
                                const hasSubmissions = await checkForTokenBasedJotformSubmissions(laterData.jotform.formId, laterData);
                                if (hasSubmissions) {
                                    // Process completion automatically
                                    const uploadedFiles = await transferJotformFilesToGoogleDrive(hasSubmissions.submissionId, laterData);

                                    if (uploadedFiles && uploadedFiles.length > 0) {
                                        laterData.uploadedFiles = uploadedFiles;
                                        laterData.jotformSubmissionId = hasSubmissions.submissionId;

                                        // Save to GitHub backup
                                        const backupData = await loadBackupFromGitHub();
                                        const submissionData = {
                                            ...laterData,
                                            user_id: userId,
                                            username: laterData.username || 'Unknown User',
                                            submitted_at: getGMT8Date().toISOString(),
                                            uploadedFiles: uploadedFiles
                                        };
                                        backupData.push(submissionData);
                                        await saveBackupToGitHub(backupData);

                                        await sendSubmissionNotification(laterData, hasSubmissions.submissionId);
                                        laterData.status = 'completed';
                                        submissions.set(userId, laterData);

                                        console.log('Auto-processed submission for user:', userId);
                                    }
                                }
                            }
                        } catch (autoError) {
                            console.error('Auto-check error:', autoError);
                        }
                    }, 30000);
                }
            } catch (error) {
                console.error('Error checking form status:', error);
                await interaction.followUp({
                    content: '❌ Error checking form status. Please try again.',
                    ephemeral: true
                });
            } finally {
                // Always clean up status check processing state
                processingConfirmations.delete(statusCheckKey);
            }
        }

        else if (interaction.customId === 'complete_submission') {
            const data = submissions.get(userId);

            await interaction.update({
                content: '🎉 **Commission Submission Complete!**\n\nThank you for your submission. All documents have been uploaded and your data has been saved.\n\n✅ **Status:** Complete\n📁 **All Documents:** Successfully uploaded',
                embeds: [],
                components: []
            });

            // Clean up
            submissions.delete(userId);
        }

        else if (interaction.customId === 'view_preserved_data') {
            const data = submissions.get(userId);

            if (!data || !data.project_name) {
                await interaction.reply({
                    content: '❌ No preserved data found in session.',
                    ephemeral: true
                });
                return;
            }

            // Show the preserved data
            const embed = createConfirmationEmbed(data);
            embed.setTitle('💾 Your Preserved Data');
            embed.setColor(0x28A745);
            embed.addFields({ 
                name: '✅ Status', 
                value: `Data Confirmed: ${data.dataConfirmed ? 'Yes' : 'No'}\nBackup Saved: ${data.backupSaved ? 'Yes' : 'No'}\nPreserved for: ${interaction.user.username}`, 
                inline: false 
            });

            const actionRow = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('retry_jotform')
                        .setLabel('🔄 Retry Form Creation')
                        .setStyle(ButtonStyle.Primary),
                    new ButtonBuilder()
                        .setCustomId('back_to_confirmation')
                        .setLabel('← Edit Details')
                        .setStyle(ButtonStyle.Secondary)
                );

            await interaction.reply({
                content: '📋 **Your preserved submission data:**',
                embeds: [embed],
                components: [actionRow],
                ephemeral: true
            });
        }

        else if (interaction.customId === 'retry_jotform') {
            await interaction.deferUpdate();

            const data = submissions.get(userId);

            if (!data || !data.project_name) {
                const restartRow = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId('restart_submission')
                            .setLabel('🔄 Start New Submission')
                            .setStyle(ButtonStyle.Primary)
                    );

                await interaction.editReply({
                    content: '❌ **Session expired or missing data**\n\nYour session has timed out. Use `/fast-comm-submission` to start fresh:',
                    components: [restartRow],
                    embeds: []
                });
                return;
            }

            try {
                // Add a delay to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, 1000));

                // Retry creating Jotform for document uploads
                const formData = await createJotformUpload(data);

                // Store form info
                data.jotform = formData;
                data.status = 'awaiting_form_completion';
                submissions.set(userId, data);

                const embed = new EmbedBuilder()
                    .setTitle('📋 Document Upload - Jotform')
                    .setColor(0xFF6600)
                    .setDescription('Your personalized Jotform has been created successfully!')
                    .addFields(
                        { name: '📝 What to do next:', value: '1. Click the "Upload Documents" button below\n2. Fill out the Jotform with your documents\n3. Submit the form\n4. Return here and click "Check Upload Status"', inline: false },
                        { name: '📋 Required Documents:', value: '• Booking Form\n• SPA Document\n• LA Document', inline: false }
                    )
                    .setFooter({ text: 'The form will automatically save your documents' });

                const actionRow = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setLabel('📝 Upload Documents')
                            .setStyle(ButtonStyle.Link)
                            .setURL(formData.formUrl),
                        new ButtonBuilder()
                            .setCustomId('check_upload_status')
                            .setLabel('🔄 Check Upload Status')
                            .setStyle(ButtonStyle.Primary),
                        new ButtonBuilder()
                            .setCustomId('cancel_submission')
                            .setLabel('❌ Cancel')
                            .setStyle(ButtonStyle.Danger)
                    );

                await interaction.editReply({
                    content: '✅ **Form Creation Successful!**\n\n📋 **Your commission data has been saved.**\n🎯 **Jotform created for document uploads!**',
                    embeds: [embed],
                    components: [actionRow],
                    ephemeral: true
                });

            } catch (error) {
                console.error('Retry Google Form creation failed:', error);

                try {
                    const errorEmbed = new EmbedBuilder()
                        .setTitle('⚠️ Form Creation Still Failing')
                        .setColor(0xFF6B6B)
                        .setDescription('The Jotform creation is experiencing persistent issues.')
                        .addFields(
                            { name: '📋 Your Data Status', value: '✅ All submission data preserved in GitHub backup', inline: false },
                            { name: '🔄 What to try:', value: 'Use `/fast-comm-submission` again - your data will be restored automatically', inline: false },
                            { name: '🆘 If issues persist:', value: 'Check your Jotform API key and permissions', inline: false }
                        )
                        .setTimestamp();

                    const alternativeRow = new ActionRowBuilder()
                        .addComponents(
                            new ButtonBuilder()
                                .setCustomId('retry_jotform')
                                .setLabel('🔄 Try Again')
                                .setStyle(ButtonStyle.Primary),
                            new ButtonBuilder()
                                .setCustomId('cancel_submission')
                                .setLabel('❌ Cancel Session')
                                .setStyle(ButtonStyle.Danger)
                        );

                    await interaction.editReply({
                        content: '❌ **Form Creation Failed Again**\n\n💾 **Your data is still safe in GitHub backup!**',
                        embeds: [errorEmbed],
                        components: [alternativeRow]
                    });
                } catch (updateError) {
                    console.error('Interaction update failed, sending followUp:', updateError);
                    await interaction.followUp({
                        content: '❌ **Form Creation Failed**\n\n✅ Your data is preserved in GitHub backup.\n🔄 Try `/fast-comm-submission` again - your data will be restored.',
                        ephemeral: true
                    });
                }
            }
        }

        else if (interaction.customId === 'open_file_upload') {
            const modal = createFileUploadModal();
            await interaction.showModal(modal);
        }

        else if (interaction.customId === 'back_to_form_view') {
            const data = submissions.get(userId);

            if (!data || !data.jotform) {
                await interaction.reply({
                    content: '❌ No form data found. Please restart the submission process.',
                    ephemeral: true
                });
                return;
            }

            const embed = new EmbedBuilder()
                .setTitle('📋 Document Upload - Jotform')
                .setColor(0xFF6600)
                .setDescription('Your document upload form is ready!')
                .addFields(
                    { name: '📝 What to do next:', value: '1. Click the "Upload Documents" button below\n2. Fill out the Jotform with your documents\n3. Submit the form\n4. Return here and click "Check Upload Status"', inline: false },
                    { name: '📋 Required Documents:', value: '• Booking Form\n• SPA Document\n• LA Document', inline: false },
                    { name: '📋 Project Info', value: `${data.project_name} - ${data.unit_no}`, inline: false }
                )
                .setFooter({ text: 'The form will automatically save your documents' });

            const actionRow = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setLabel('📝 Upload Documents')
                        .setStyle(ButtonStyle.Link)
                        .setURL(data.jotform.formUrl),
                    new ButtonBuilder()
                        .setCustomId('check_upload_status')
                        .setLabel('🔄 Check Upload Status')
                        .setStyle(ButtonStyle.Primary),
                    new ButtonBuilder()
                        .setCustomId('cancel_submission')
                        .setLabel('❌ Cancel')
                        .setStyle(ButtonStyle.Danger)
                );

            await interaction.update({
                content: '✅ **Back to Form Information**\n\n📋 **Your commission data has been saved.**\n🎯 **Document upload form ready!**',
                embeds: [embed],
                components: [actionRow]
            });
        }

        else if (interaction.customId === 'restart_submission') {
            submissions.delete(userId);
            await interaction.reply({
                content: '🔄 **Starting a new submission!**\n\nPlease use `/fast-comm-submission` command to start over.',
                ephemeral: true
            });
        }

        else if (interaction.customId.startsWith('view_submission_')) {
            try {
                const submissionIndex = parseInt(interaction.customId.split('_')[2]);
                const backupData = await loadBackupFromGitHub();

                if (submissionIndex < 0 || submissionIndex >= backupData.length) {
                    await interaction.reply({
                        content: '❌ Submission not found. It may have been deleted.',
                        ephemeral: true
                    });
                    return;
                }

                const submission = backupData[submissionIndex];

                // Verify this submission belongs to the user
                if (submission.user_id !== userId) {
                    await interaction.reply({
                        content: '❌ You can only view your own submissions.',
                        ephemeral: true
                    });
                    return;
                }

                // Create detailed submission embed
                const embed = createConfirmationEmbed(submission);
                embed.setTitle(`📋 Submission Details: ${submission.project_name}`);
                embed.setColor(0x28A745);

                // Add document status
                if (submission.uploadedFiles && submission.uploadedFiles.length > 0) {
                    const fileList = submission.uploadedFiles
                        .map(file => `✅ [${file.originalName || file.finalName}](${file.driveLink})`)
                        .join('\n');

                    embed.addFields({ name: `📂 Uploaded Documents (${submission.uploadedFiles.length})`, value: fileList.length > 1024 ? fileList.substring(0, 1020) + '...' : fileList, inline: false });
                } else {
                    embed.addFields({ name: '📂 Documents Status', value: '❌ No documents uploaded', inline: false });
                }

                // Add submission metadata
                embed.addFields({
                    name: '📊 Submission Information',
                    value: `**Submission ID:** ${submission.jotformSubmissionId || 'N/A'}\n**Submitted:** ${formatGMT8DateString(new Date(submission.submitted_at))}\n**Status:** Complete`,
                    inline: false
                });

                // Back button
                const backRow = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId('back_to_my_submissions')
                            .setLabel('← Back to My Submissions')
                            .setStyle(ButtonStyle.Secondary)
                    );

                await interaction.reply({
                    embeds: [embed],
                    components: [backRow],
                    ephemeral: true
                });

            } catch (error) {
                console.error('Error viewing submission details:', error);
                await interaction.reply({
                    content: '❌ Error loading submission details. Please try again.',
                    ephemeral: true
                });
            }
        }

        else if (interaction.customId === 'back_to_my_submissions' || interaction.customId === 'refresh_my_submissions') {
            try {
                const backupData = await loadBackupFromGitHub();
                const userSubmissions = backupData.filter(submission => submission.user_id === userId);

                if (userSubmissions.length === 0) {
                    await interaction.update({
                        content: '❌ **No submissions found**\n\nYou haven\'t submitted any commission claims yet. Use `/fast-comm-submission` to create your first submission.',
                        embeds: [],
                        components: []
                    });
                    return;
                }

                // Create summary embed with all user submissions
                const embed = new EmbedBuilder()
                    .setTitle('📋 Your Commission Submissions')
                    .setColor(0x0099FF)
                    .setDescription(`Found ${userSubmissions.length} submission(s)`)
                    .setTimestamp();

                // Create buttons for each submission
                const buttons = [];
                const maxButtons = Math.min(userSubmissions.length, 20);

                for (let i = 0; i < maxButtons; i++) {
                    const submission = userSubmissions[i];
                    const submissionIndex = backupData.indexOf(submission);
                    const totalCommission = submission.agents
                        ?.filter(agent => agent.name)
                        ?.reduce((sum, agent) => sum + parseFloat(agent.commission || 0), 0) || 0;

                    // Add to embed
                    embed.addFields({
                        name: `${i + 1}. ${submission.project_name}`,
                        value: `**Unit:** ${submission.unit_no}\n**Total Commission:** RM${totalCommission.toFixed(2)}\n**Submitted:** ${formatGMT8DateString(new Date(submission.submitted_at))}\n**Documents:** ${submission.uploadedFiles?.length || 0} file(s)`,
                        inline: true
                    });

                    // Create button for detailed view
                    buttons.push(
                        new ButtonBuilder()
                            .setCustomId(`view_submission_${submissionIndex}`)
                            .setLabel(`View ${submission.project_name}`)
                            .setStyle(ButtonStyle.Primary)
                    );
                }

                // Split buttons into rows
                const rows = [];
                for (let i = 0; i < buttons.length; i += 5) {
                    const rowButtons = buttons.slice(i, i + 5);
                    rows.push(new ActionRowBuilder().addComponents(rowButtons));
                }

                // Add refresh button
                if (rows.length > 0) {
                    const lastRow = rows[rows.length - 1];
                    if (lastRow.components.length < 5) {
                        lastRow.addComponents(
                            new ButtonBuilder()
                                .setCustomId('refresh_my_submissions')
                                .setLabel('🔄 Refresh')
                                .setStyle(ButtonStyle.Secondary)
                        );
                    } else {
                        rows.push(new ActionRowBuilder().addComponents(
                            new ButtonBuilder()
                                .setCustomId('refresh_my_submissions')
                                .setLabel('🔄 Refresh')
                                .setStyle(ButtonStyle.Secondary)
                        ));
                    }
                }

                if (userSubmissions.length > maxButtons) {
                    embed.setFooter({ text: `Showing ${maxButtons} of ${userSubmissions.length} submissions. Use 🔄 Refresh to see all.` });
                }

                await interaction.update({
                    content: '',
                    embeds: [embed],
                    components: rows
                });

            } catch (error) {
                console.error('Error refreshing submissions:', error);
                await interaction.followUp({
                    content: '❌ Error refreshing submission data. Please try again.',
                    ephemeral: true
                });
            }
        }

        return;
    }
});

// Upload file directly to company Google Drive with organized folder structure
async function uploadToCompanyGoogleDrive(filePath, fileName, mimeType, userData = null) {
    try {
        // Use your existing OAuth config
        if (!oauth_config) {
            throw new Error('Google OAuth not configured. Check GOOGLE_OAUTH_SECRETS environment variable.');
        }

        // Create OAuth client with your credentials
        const oauth_client = new google.auth.OAuth2(
            oauth_config.web.client_id,
            oauth_config.web.client_secret,
            oauth_config.web.redirect_uris[0]
        );

        // Set credentials - you'll need to get these tokens once
        const accessToken = process.env.COMPANY_DRIVE_ACCESS_TOKEN;
        const refreshToken = process.env.COMPANY_DRIVE_REFRESH_TOKEN;

        if (!accessToken || !refreshToken) {
            throw new Error('Please set COMPANY_DRIVE_ACCESS_TOKEN and COMPANY_DRIVE_REFRESH_TOKEN in Secrets. Run get_oauth_tokens.js to get them.');
        }

        oauth_client.setCredentials({ 
            access_token: accessToken,
            refresh_token: refreshToken
        });

        const companyDrive = google.drive({ version: 'v3', auth: oauth_client });

        // Create organized folder structure: Discord Uploads > Agent Claim Request > [Date - Username]
        const discordUploadsFolder = await createOrGetCompanyFolder(companyDrive, 'Discord Uploads');
        const agentClaimFolder = await createOrGetCompanySubFolder(companyDrive, 'Agent Claim Request', discordUploadsFolder);

        // Create unique folder for this submission if userData is provided
        let targetFolderId = agentClaimFolder;
        if (userData && userData.username) {
            // Create a more specific cache key including session token for uniqueness
            const sessionToken = userData.sessionToken || 'no_token';
            const cacheKey = `${userData.userId}_${userData.project_name}_${userData.unit_no}_${sessionToken}`;

            // Check if we already have a folder for this submission
            if (userFolderCache.has(cacheKey)) {
                targetFolderId = userFolderCache.get(cacheKey);
                console.log('✅ Using cached submission folder for:', cacheKey);
            } else {
                const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
                const projectName = userData.project_name?.replace(/[^a-zA-Z0-9]/g, '_') || 'Project';
                const unitNo = userData.unit_no?.replace(/[^a-zA-Z0-9]/g, '_') || 'Unit';

                // Use consistent folder naming without time component to prevent duplicates
                const userFolderName = `${today} - ${userData.username} - ${projectName} - ${unitNo}`;
                targetFolderId = await createOrGetCompanySubFolder(companyDrive, userFolderName, agentClaimFolder);

                // Cache the folder ID for this submission
                userFolderCache.set(cacheKey, targetFolderId);
                console.log('✅ Created/cached submission folder:', userFolderName);
            }
        }

        const fileMetadata = {
            name: fileName,
            parents: [targetFolderId]
        };

        const media = {
            mimeType: mimeType,
            body: require('fs').createReadStream(filePath)
        };

        const response = await companyDrive.files.create({
            resource: fileMetadata,
            media: media,
            fields: 'id, name, webViewLink'
        });

        console.log('✅ File uploaded to company Google Drive:', response.data.name);
        console.log('✅ Folder structure: Discord Uploads > Agent Claim Request > ' + (userData?.username ? `${new Date().toISOString().split('T')[0]} - ${userData.username}` : 'Agent Claim Request'));
        return response.data;
    } catch (error) {
        console.error('❌ Error uploading to company Google Drive:', error);
        throw error;
    }
}

// Legacy function - now redirects to company drive
async function uploadToGoogleDrive(filePath, fileName, mimeType, userData = null) {
    return await uploadToCompanyGoogleDrive(filePath, fileName, mimeType, userData);
}

// Create Jotform URL with prefilled data (using template form)
async function createJotformUpload(data, sessionToken) {
    try {
        if (!JOTFORM_TEMPLATE_ID) {
            throw new Error('JOTFORM_TEMPLATE_ID not configured');
        }

        // Get webhook URL from environment variable or construct from Replit
        let webhookUrl = process.env.WEBHOOK_URL;

        if (!webhookUrl) {
            // Construct webhook URL from platform-specific environment variables
            if (process.env.REPL_SLUG && process.env.REPL_OWNER) {
                webhookUrl = `https://${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co/webhook/jotform`;
                console.log('Constructed Replit webhook URL:', webhookUrl);
            } else if (process.env.VERCEL_URL) {
                webhookUrl = `https://${process.env.VERCEL_URL}/webhook/jotform`;
                console.log('Constructed Vercel webhook URL:', webhookUrl);
            } else if (process.env.RAILWAY_PUBLIC_DOMAIN) {
                webhookUrl = `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/webhook/jotform`;
                console.log('Constructed Railway webhook URL:', webhookUrl);
            } else if (process.env.RENDER_EXTERNAL_URL) {
                const renderUrl = process.env.RENDER_EXTERNAL_URL.replace(/\/$/, ''); // Remove trailing slash
                webhookUrl = `${renderUrl}/webhook/jotform`;
                console.log('Constructed Render webhook URL:', webhookUrl);
            } else {
                throw new Error('WEBHOOK_URL environment variable is required. Please set it to your public domain with /webhook/jotform endpoint');
            }
        }

        console.log('Using webhook URL:', webhookUrl);

        // Set webhook for the template form (one-time setup)
        try {
            // First, delete any existing webhooks
            const existingWebhooksResponse = await fetch(`${JOTFORM_BASE_URL}/form/${JOTFORM_TEMPLATE_ID}/webhooks`, {
                headers: {
                    'APIKEY': JOTFORM_API_KEY
                }
            });

            if (existingWebhooksResponse.ok) {
                const existingWebhooks = await existingWebhooksResponse.json();
                console.log('Existing webhooks:', existingWebhooks.content?.length || 0);

                // Delete existing webhooks if any
                if (existingWebhooks.content && existingWebhooks.content.length > 0) {
                    for (const webhook of existingWebhooks.content) {
                        try {
                            const deleteResponse = await fetch(`${JOTFORM_BASE_URL}/form/${JOTFORM_TEMPLATE_ID}/webhooks/${webhook.id}`, {
                                method: 'DELETE',
                                headers: {
                                    'APIKEY': JOTFORM_API_KEY
                                }
                            });

                            if (deleteResponse.ok) {
                                console.log('🗑️ Deleted existing webhook:', webhook.id);
                            } else {
                                const deleteResult = await deleteResponse.json();
                                console.log('Failed to delete webhook:', webhook.id, deleteResult);
                            }

                            // Add delay between deletions
                            await new Promise(resolve => setTimeout(resolve, 500));
                        } catch (deleteError) {
                            console.log('Failed to delete webhook:', webhook.id, deleteError.message);
                        }
                    }

                    // Wait a bit after deletions before adding new webhook
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }

            // Now set the new webhook
            const webhookResponse = await fetch(`${JOTFORM_BASE_URL}/form/${JOTFORM_TEMPLATE_ID}/webhooks`, {
                method: 'POST',
                headers: {
                    'APIKEY': JOTFORM_API_KEY,
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: `webhookURL=${encodeURIComponent(webhookUrl)}`
            });

            const webhookResult = await webhookResponse.json();

            if (webhookResponse.ok) {
                console.log('✅ Webhook successfully set for Jotform:', webhookUrl);
                console.log('✅ Webhook ID:', webhookResult.content);
            } else {
                // Check if webhook already exists (this is actually OK)
                if (webhookResponse.status === 400 && webhookResult.message && webhookResult.message.includes('already in WebHooks List')) {
                    console.log('✅ Webhook already exists for this form - this is fine!');
                    console.log('🔗 Webhook URL:', webhookUrl);
                } else {
                    console.error('❌ Failed to set webhook:', webhookResponse.status, webhookResult);
                    console.error('❌ Response body:', JSON.stringify(webhookResult, null, 2));

                    // Check if it's a permission issue
                    if (webhookResponse.status === 403) {
                        console.error('❌ Permission denied. Check if your Jotform API key has webhook permissions.');
                    } else if (webhookResponse.status === 400) {
                        console.error('❌ Bad request. Check if webhook URL is valid and accessible.');
                    }
                }
            }
        } catch (webhookError) {
            console.error('❌ Webhook setup error:', webhookError.message);
        }

        // Use prefilled form URL with unique session token embedded in project info for perfect matching
        // Use prefilled form URL with user_id and price_token fields
        const formUrl = `https://form.jotform.com/${JOTFORM_TEMPLATE_ID}?user_id=${encodeURIComponent(data.userId)}&price_token=${encodeURIComponent(sessionToken)}`;

        console.log('Generated Jotform URL with session token:', sessionToken);
        console.log('Generated Jotform URL for:', data.project_name);
        return { 
            formId: JOTFORM_TEMPLATE_ID, 
            formUrl: formUrl,
            isTemplate: true,
            webhookUrl: webhookUrl,
            sessionToken: sessionToken
        };

    } catch (error) {
        console.error('Error creating Jotform URL:', error);
        throw error;
    }
}

// Check if Jotform has submissions
async function checkJotformSubmissions(formId) {
    try {
        const response = await fetch(`${JOTFORM_BASE_URL}/form/${formId}/submissions`, {
            headers: {
                'APIKEY': JOTFORM_API_KEY
            }
        });

        if (!response.ok) {
            throw new Error(`Jotform API error: ${response.status} ${response.statusText}`);
        }

        const result = await response.json();
        return result.content && result.content.length > 0;
    } catch (error) {
        console.error('Error checking Jotform submissions:', error);
        return false;
    }
}

// Check for token-based Jotform submissions (no time window - perfect matching)
async function checkForTokenBasedJotformSubmissions(formId, userData) {
    try {
        const response = await fetch(`${JOTFORM_BASE_URL}/form/${formId}/submissions?limit=20&orderby=created_at`, {
            headers: {
                'APIKEY': JOTFORM_API_KEY
            }
        });

        if (!response.ok) {
            throw new Error(`Jotform API error: ${response.status} ${response.statusText}`);
        }

        const result = await response.json();

        if (!result.content || result.content.length === 0) {
            console.log('No submissions found in form');
            return false;
        }

        console.log(`Found ${result.content.length} total submission(s) in form`);
        console.log('Looking for submissions with session token:', userData.sessionToken);

        // First try: Look for session token in session_id field or other answers
        for (const submission of result.content) {
            const answers = submission.answers;

            // Check each answer for the session token
            for (const questionId in answers) {
                const answer = answers[questionId];

                // Check if this is the session_id field specifically
                if (answer.name === 'session_id' && answer.answer === userData.sessionToken) {
                    console.log('✅ Found submission with matching session_id field:', submission.id);
                    return {
                        submissionId: submission.id,
                        hasFiles: true
                    };
                }

                // Also check other text fields that might contain the token
                if (answer.answer && typeof answer.answer === 'string') {
                    const answerText = answer.answer;

                    if (answerText.includes(userData.sessionToken)) {
                        console.log('✅ Found submission with matching session token:', submission.id);
                        console.log('✅ Session token:', userData.sessionToken);
                        console.log('✅ User project:', userData.project_name, '-', userData.unit_no);
                        return {
                            submissionId: submission.id,
                            hasFiles: true
                        };
                    }
                }
            }
        }

        console.log('❌ No submissions found with session token:', userData.sessionToken);
        return false;
    } catch (error) {
        console.error('Error checking for token-based Jotform submissions:', error);
        return false;
    }
}

// Create or get existing folder in company Google Drive
async function createOrGetCompanyFolder(companyDrive, folderName) {
    try {
        // Search for existing folder
        const response = await companyDrive.files.list({
            q: `name='${folderName}' and mimeType='application/vnd.google-apps.folder'`,
            spaces: 'drive'
        });

        if (response.data.files.length > 0) {
            console.log('✅ Found existing folder:', folderName);
            return response.data.files[0].id;
        }

        // Create new folder
        const folder = await companyDrive.files.create({
            resource: {
                name: folderName,
                mimeType: 'application/vnd.google-apps.folder'
            },
            fields: 'id'
        });

        console.log('✅ Created folder:', folderName);
        return folder.data.id;
    } catch (error) {
        console.error('❌ Error with folder:', error);
        throw error;
    }
}

// Create or get existing subfolder within a parent folder
async function createOrGetCompanySubFolder(companyDrive, folderName, parentFolderId) {
    try {
        // Search for existing subfolder within the parent folder
        const response = await companyDrive.files.list({
            q: `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and '${parentFolderId}' in parents`,
            spaces: 'drive'
        });

        if (response.data.files.length > 0) {
            console.log('✅ Found existing subfolder:', folderName);
            return response.data.files[0].id;
        }

        // Create new subfolder within parent
        const folder = await companyDrive.files.create({
            resource: {
                name: folderName,
                mimeType: 'application/vnd.google-apps.folder',
                parents: [parentFolderId]
            },
            fields: 'id'
        });

        console.log('✅ Created subfolder:', folderName, 'in parent:', parentFolderId);
        return folder.data.id;
    } catch (error) {
        console.error('❌ Error with subfolder:', error);
        throw error;
    }
}

// Create or get existing folder for user (legacy support)
async function createOrGetFolderForUser(userDrive, folderName) {
    try {
        // Search for existing folder
        const response = await userDrive.files.list({
            q: `name='${folderName}' and mimeType='application/vnd.google-apps.folder'`,
            spaces: 'drive'
        });

        if (response.data.files.length > 0) {
            return response.data.files[0].id;
        }

        // Create new folder
        const folderMetadata = {
            name: folderName,
            mimeType: 'application/vnd.google-apps.folder'
        };

        const folder = await userDrive.files.create({
            resource: folderMetadata,
            fields: 'id'
        });

        console.log('Created Google Drive folder for user:', folderName);

        return folder.data.id;
    } catch (error) {
        console.error('Error creating/getting folder for user:', error);
        throw error;
    }
}

// Legacy function
async function createOrGetFolder(folderName, driveInstance = null) {
    try {
        const driveToUse = driveInstance || drive;

        if (!driveToUse) {
            throw new Error('No Google Drive instance available');
        }

        // Search for existing folder
        const response = await driveToUse.files.list({
            q: `name='${folderName}' and mimeType='application/vnd.google-apps.folder'`,
            spaces: 'drive'
        });

        if (response.data.files.length > 0) {
            return response.data.files[0].id;
        }

        // Create new folder
        const folderMetadata = {
            name: folderName,
            mimeType: 'application/vnd.google-apps.folder'
        };

        const folder = await driveToUse.files.create({
            resource: folderMetadata,
            fields: 'id'
        });

        console.log('Created Google Drive folder:', folderName);

        return folder.data.id;
    } catch (error) {
        console.error('Error creating/getting folder:', error);
        throw error;
    }
}

// HTML upload form
app.get('/upload/:userId', (req, res) => {
    const userId = req.params.userId;
    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <title>Commission Document Upload</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
            body { font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; background-color: #f5f5f5; }
            .container { background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
            h1 { color: #333; text-align: center; margin-bottom: 30px; }
            .upload-area { border: 2px dashed #ddd; border-radius: 8px; padding: 40px; text-align: center; margin: 20px 0; }
            .upload-area:hover { border-color: #007bff; }
            input[type="file"] { margin: 20px 0; }
            button { background: #007bff; color: white; padding: 12px 24px; border: none; border-radius: 5px; cursor: pointer; font-size: 16px; width: 100%; }
            button:hover { background: #0056b3; }
            .status { margin-top: 20px; padding: 10px; border-radius: 5px; }
            .success { background: #d4edda; color: #155724; border: 1px solid #c3e6cb; }
            .error { background: #f8d7da; color: #721c24; border: 1px solid #f5c6cb; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>📁 Commission Document Upload</h1>
            <p><strong>User ID:</strong> ${userId}</p>

            <form id="uploadForm" enctype="multipart/form-data">
                <div class="upload-area">
                    <p>📄 Select your commission documents</p>
                    <input type="file" name="documents" multiple accept=".pdf,.doc,.docx,.jpg,.jpeg,.png" required>
                    <p><small>Supported formats: PDF, DOC, DOCX, JPG, PNG</small></p>
                </div>

                <button type="submit">🚀 Upload Documents</button>
            </form>

            <div id="status"></div>
        </div>

        <script>
            document.getElementById('uploadForm').addEventListener('submit', async (e) => {
                e.preventDefault();

                const formData = new FormData(e.target);
                const statusDiv = document.getElementById('status');
                const button = e.target.querySelector('button');

                button.disabled = true;
                button.textContent = '⏳ Uploading...';
                statusDiv.innerHTML = '';

                try {
                    const response = await fetch('/upload/${userId}', {
                        method: 'POST',
                        body: formData
                    });

                    const result = await response.json();

                    if (result.success) {
                        statusDiv.innerHTML = '<div class="status success">✅ Files uploaded successfully! You can now return to Discord and click "Complete Submission".</div>';
                        button.textContent = '✅ Upload Complete';
                    } else {
                        throw new Error(result.message);
                    }
                } catch (error) {
                    statusDiv.innerHTML = '<div class="status error">❌ Upload failed: ' + error.message + '</div>';
                    button.disabled = false;
                    button.textContent = '🚀 Upload Documents';
                }
            });
        </script>
    </body>
    </html>
    `;

    res.send(html);
});

// OAuth routes
app.get('/oauth2callback', async (req, res) => {
    try {
        const userId = req.query.state;
        const code = req.query.code;

        if (!code) {
            return res.status(400).send('Authorization code not provided');
        }

        const oauth_flow = createOAuthFlow();
        const { tokens } = await oauth_flow.getToken(code);

        // Store user credentials in session
        req.session.userId = userId;
        req.session.credentials = tokens;

        // Update user's submission data with access token
        const userData = submissions.get(userId);
        if (userData) {
            userData.googleAccessToken = tokens.access_token;
            userData.status = 'authenticated';
            submissions.set(userId, userData);
        }

        res.send(`
            <html>
                <head>
                    <title>Authentication Success</title>
                    <style>
                        body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
                        .success { color: #28a745; }
                        .container { max-width: 500px; margin: 0 auto; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h1 class="success">✅ Authentication Successful!</h1>
                        <p>You have successfully connected your Google account.</p>
                        <p><strong>You can now close this tab and return to Discord.</strong></p>
                        <p>Your files will be uploaded to your personal Google Drive.</p>
                    </div>
                    <script>
                        setTimeout(() => {
                            window.close();
                        }, 5000);
                    </script>
                </body>
            </html>
        `);
    } catch (error) {
        console.error('OAuth callback error:', error);
        res.status(500).send('Authentication failed. Please try again.');
    }
});

// === OAuth Home Page & Privacy Policy Routes ===

// Home page - shown as "Application home page" in Google OAuth consent screen
app.get('/', (req, res) => {
  res.send(`
    <html>
      <head><title>Discord Bot Drive Uploader</title></head>
      <body>
        <h1>Discord Bot Drive Uploader</h1>
        <p>This application uploads files from Discord or Jotform directly to Google Drive for company use.</p>
        <p>No other data is stored or shared.</p>
        <p><a href="/privacy">Privacy Policy</a></p>
      </body>
    </html>
  `);
});

// Privacy policy page - shown as "Application privacy policy link" in Google OAuth consent screen
app.get('/privacy', (req, res) => {
  res.send(`
    <html>
      <head><title>Privacy Policy</title></head>
      <body>
        <h1>Privacy Policy</h1>
        <p>This app is used internally by the company to upload files to Google Drive.</p>
        <p>We only collect and process files explicitly uploaded by the user via Discord or Jotform.</p>
        <p>No personal data is sold, shared, or used for advertising purposes.</p>
        <p>All data is stored securely in Google Drive and is accessible only by authorized company members.</p>
      </body>
    </html>
  `);
});

// Express route for file upload
app.post('/upload/:userId', upload.array('documents'), async (req, res) => {
    try {
        const userId = req.params.userId;
        const userData = submissions.get(userId);

        if (!userData || !userData.googleAccessToken) {
            return res.status(401).json({
                success: false,
                message: 'Please authenticate with Google first'
            });
        }

        const uploadedFiles = [];
        const userDrive = createUserGoogleDrive(userData.googleAccessToken);

        for (const file of req.files) {
            const driveFile = await uploadToUserGoogleDrive(
                userDrive,
                file.path,
                `${userId}_${Date.now()}_${file.originalname}`,
                file.mimetype
            );

            uploadedFiles.push({
                originalName: file.originalname,
                driveId: driveFile.id,
                driveLink: driveFile.webViewLink
            });

            // Clean up local file
            await fs.unlink(file.path);
        }

        res.json({ 
            success: true, 
            message: 'Files uploaded successfully to your Google Drive',
            files: uploadedFiles
        });
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to upload files'
        });
    }
});

// Webhook endpoint for Jotform submissions
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Debug endpoint to check Jotform webhooks
app.get('/debug/webhooks', async (req, res) => {
    try {
        if (!JOTFORM_TEMPLATE_ID || !JOTFORM_API_KEY) {
            return res.json({ error: 'Jotform not configured' });
        }

        const response = await fetch(`${JOTFORM_BASE_URL}/form/${JOTFORM_TEMPLATE_ID}/webhooks`, {
            headers: {
                'APIKEY': JOTFORM_API_KEY
            }
        });

        const webhooks = await response.json();

        res.json({
            templateFormId: JOTFORM_TEMPLATE_ID,
            expectedWebhookUrl: process.env.WEBHOOK_URL,
            currentWebhooks: webhooks.content,
            status: response.ok ? 'OK' : 'ERROR'
        });
    } catch (error) {
        res.json({ error: error.message });
    }
});

app.post('/webhook/jotform', async (req, res) => {
    try {
        console.log('Webhook received:', req.body);

        // Get submission data from webhook
        const submissionId = req.body.submissionID;
        const formId = req.body.formID;
        const rawRequest = req.body.rawRequest || {};

        // Extract session token from submission
        const sessionToken = rawRequest.session_token || rawRequest.price_token || '';
        const extractedUserId = rawRequest.user_id || '';

        console.log('Processing webhook for:', { submissionId, formId, sessionToken, extractedUserId });

        // Multiple layer protection against duplicates
        if (processedSubmissions.has(submissionId)) {
            console.log('Submission already processed:', submissionId);
            res.status(200).json({ success: true, message: 'Already processed' });
            return;
        }

        if (processingSubmissions.has(submissionId)) {
            console.log('Submission currently being processed:', submissionId);
            res.status(200).json({ success: true, message: 'Currently processing' });
            return;
        }

        // Check if this session token was already processed
        if (sessionToken && processedTokens.has(sessionToken)) {
            console.log('Session token already processed:', sessionToken);
            res.status(200).json({ success: true, message: 'Token already processed' });
            return;
        }

        // IMMEDIATELY mark as processed to prevent any race conditions
        processedSubmissions.add(submissionId);
        processingSubmissions.add(submissionId);
        if (sessionToken) {
            processedTokens.add(sessionToken);
        }

        // Find user session using unique token (perfect 1:1 matching)
        let userData = null;
        let matchedUserId = null;

        if (sessionToken) {
            // Perfect token-based matching - no ambiguity
            matchedUserId = tokenToUserId.get(sessionToken);
            if (matchedUserId) {
                userData = submissions.get(matchedUserId);
                if (userData && userData.sessionToken === sessionToken && userData.status === 'awaiting_form_completion') {
                    console.log('✅ Perfect token match found:', matchedUserId);
                    console.log('✅ Session token:', sessionToken);
                    console.log('✅ User project:', userData.project_name, '-', userData.unit_no);

                    // Additional check: if user already has uploaded files, skip this
                    if (userData.uploadedFiles && userData.uploadedFiles.length > 0) {
                        console.log('❌ User already has uploaded files, skipping duplicate processing');
                        processingSubmissions.delete(submissionId);
                        res.status(200).json({ success: true, message: 'User already has files' });
                        return;
                    }
                } else {
                    console.log('❌ Token found but user session invalid:', matchedUserId);
                    userData = null;
                    matchedUserId = null;
                }
            } else {
                console.log('❌ Session token not found in token map:', sessionToken);
            }
        } else {
            console.log('❌ No session token provided in webhook');
        }

        if (userData && matchedUserId) {
            try {
                // Download and transfer files from Jotform to Google Drive
                const uploadedFiles = await transferJotformFilesToGoogleDrive(submissionId, userData);

                // Only proceed if files were actually transferred
                if (uploadedFiles && uploadedFiles.length > 0) {
                    // Update user data with Google Drive file info
                    userData.uploadedFiles = uploadedFiles;
                    userData.jotformSubmissionId = submissionId;

                    // NOW save to GitHub backup (only after successful file upload)
                    const backupData = await loadBackupFromGitHub();
                    const submissionData = {
                        ...userData,
                        user_id: matchedUserId,
                        username: userData.username || 'Unknown User',
                        submitted_at: getGMT8Date().toISOString(),
                        uploadedFiles: uploadedFiles
                    };
                    backupData.push(submissionData);
                    await saveBackupToGitHub(backupData);

                    // Send notification to channel with file info
                    await sendSubmissionNotification(userData, submissionId);

                    // Update user's submission status to completed
                    userData.status = 'completed';
                    submissions.set(matchedUserId, userData);

                    // Clean up token mapping after successful processing
                    tokenToUserId.delete(userData.sessionToken);

                    console.log('✅ Webhook processed successfully for user:', matchedUserId);
                    console.log('✅ Files transferred to Google Drive:', uploadedFiles.length);
                    console.log('✅ Session token cleaned up:', userData.sessionToken);
                } else {
                    console.log('❌ No files were transferred - not marking as completed');
                    // Remove from processed sets if no files were transferred
                    processedSubmissions.delete(submissionId);
                    if (sessionToken) {
                        processedTokens.delete(sessionToken);
                    }
                }
            } catch (processingError) {
                console.error('Error during webhook processing:', processingError);
                // Remove from processed sets if processing failed so it can be retried
                processedSubmissions.delete(submissionId);
                if (sessionToken) {
                    processedTokens.delete(sessionToken);
                }
            } finally {
                // Always remove from currently processing set
                processingSubmissions.delete(submissionId);
            }
        } else {
            console.log('❌ No matching user session found for submission:', submissionId);
            console.log('❌ Session token provided:', sessionToken);
            console.log('❌ Available sessions:', Array.from(submissions.keys()));
            console.log('❌ Available tokens:', Array.from(tokenToUserId.keys()));

            // Remove from processing sets since we're not processing this one
            processingSubmissions.delete(submissionId);
            processingSubmissions.delete(submissionId);
            if (sessionToken) {
                processedTokens.delete(sessionToken);
            }
        }

        res.status(200).json({ success: true, message: 'Webhook processed' });
    } catch (error) {
        console.error('Webhook error:', error);
        // Clean up processing state on error
        const submissionId = req.body.submissionID;
        const sessionToken = req.body.rawRequest?.session_token || req.body.rawRequest?.price_token || '';

        if (submissionId) {
            processingSubmissions.delete(submissionId);
            processingSubmissions.delete(submissionId);
        }
        if (sessionToken) {
            processedTokens.delete(sessionToken);
        }
        res.status(500).json({ success: false, error: error.message });
    }
});



// Transfer files from Jotform to Google Drive
async function transferJotformFilesToGoogleDrive(submissionId, userData) {
    try {
        console.log('Starting file transfer for submission:', submissionId);

        // Check if this submission ID has already been processed
        if (processedSubmissions.has(submissionId)) {
            console.log('Submission already processed, skipping transfer for:', submissionId);
            return userData.uploadedFiles || [];
        }

        // Additional check: if user already has uploaded files, skip this
        if (userData.uploadedFiles && userData.uploadedFiles.length > 0) {
            console.log('User already has uploaded files, skipping transfer for:', submissionId);
            processedSubmissions.add(submissionId); // Mark as processed
            return userData.uploadedFiles;
        }

        // Mark as being processed to prevent concurrent processing
        if (processingSubmissions.has(submissionId)) {
            console.log('Submission currently being processed, waiting for:', submissionId);
            return [];
        }
        processingSubmissions.add(submissionId);

        // Get submission details from Jotform API
        const submissionResponse = await fetch(`${JOTFORM_BASE_URL}/submission/${submissionId}`, {
            headers: {
                'APIKEY': JOTFORM_API_KEY
            }
        });

        if (!submissionResponse.ok) {
            throw new Error(`Failed to fetch submission: ${submissionResponse.status}`);
        }

        const submissionData = await submissionResponse.json();
        const answers = submissionData.content.answers;

        console.log('Submission data received, processing files...');

        const uploadedFiles = [];

        // Process each answer to find file uploads
        for (const questionId in answers){
            const answer = answers[questionId];

            // Check if this answer contains file uploads
            if (answer.type === 'control_fileupload' && answer.answer) {
                const files = Array.isArray(answer.answer) ? answer.answer : [answer.answer];

                for (const fileUrl of files) {
                    if (fileUrl && fileUrl.trim()) {
                        try {
                            console.log('Downloading file from Jotform:', fileUrl);

                            // Download file from Jotform with proper authentication
                            // Ensure authenticated access to Jotform file
                            const authedUrl = fileUrl.includes('?') 
                                ? `${fileUrl}&apikey=${JOTFORM_API_KEY}`
                                : `${fileUrl}?apikey=${JOTFORM_API_KEY}`;

                            const fileResponse = await fetch(authedUrl, {
                                headers: {
                                    'APIKEY': JOTFORM_API_KEY,
                                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                                    'Accept': '*/*'
                                }
                            });
                            
                            if (!fileResponse.ok) {
                                console.error('Failed to download file:', fileUrl, 'Status:', fileResponse.status);
                                continue;
                            }

                            // Get content type from response headers
                            const contentType = fileResponse.headers.get('content-type') || 'application/octet-stream';
                            console.log('File content type from server:', contentType);

                            // Use buffer() method for proper binary handling - this preserves original file integrity
                            const fileBuffer = await fileResponse.buffer();

                            // Validate file size and content
                            if (fileBuffer.length === 0) {
                                console.error('Downloaded file is empty:', fileUrl);
                                continue;
                            }

                            // Check if we got an HTML error page instead of the actual file
                            const fileStart = fileBuffer.toString('utf8', 0, Math.min(200, fileBuffer.length)).toLowerCase();
                            if (fileStart.includes('<!doctype html') || fileStart.includes('<html') || fileStart.includes('access denied')) {
                                console.error('Downloaded HTML error page instead of file:', fileUrl);
                                console.error('File content preview:', fileStart);
                                continue;
                            }

                            console.log('Downloaded file size:', fileBuffer.length, 'bytes');

                            // Extract filename from Content-Disposition header or URL
                            let originalFilename = `document_${Date.now()}`;
                            
                            // Try to extract original filename from Content-Disposition header
                            const contentDisposition = fileResponse.headers.get('content-disposition');
                            if (contentDisposition && /filename=/i.test(contentDisposition)) {
                                const filenameMatch = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
                                if (filenameMatch && filenameMatch[1]) {
                                    originalFilename = filenameMatch[1].replace(/['"]/g, '');
                                    originalFilename = decodeURIComponent(originalFilename);
                                }
                            } else {
                                // Fallback to URL-based filename extraction
                                const urlParts = fileUrl.split('/');
                                originalFilename = urlParts[urlParts.length - 1] || `document_${Date.now()}`;
                                // Remove query parameters and decode URL encoding
                                originalFilename = decodeURIComponent(originalFilename.split('?')[0]);
                            }

                            // Keep original filename as much as possible - minimal sanitization
                            let cleanFilename = originalFilename.replace(/[<>:"/\\|?*]/g, '_');
                            if (!cleanFilename || cleanFilename.length === 0 || cleanFilename === '_') {
                                cleanFilename = `document_${Date.now()}.bin`;
                            }

                            console.log('Processing file:', cleanFilename, 'Original:', originalFilename);

                            // Create a descriptive filename but preserve original extension
                            const projectName = userData.project_name?.replace(/[^a-zA-Z0-9]/g, '_') || 'project';
                            const timestamp = new Date().toISOString().split('T')[0];
                            const uniqueId = Date.now() + '_' + Math.random().toString(36).substr(2, 9);
                            const finalFilename = `${projectName}_${userData.unit_no || 'unit'}_${timestamp}_${uniqueId}_${cleanFilename}`;

                            // Save temporarily with unique path to avoid conflicts
                            const tempPath = path.join('uploads', `temp_${uniqueId}_${cleanFilename}`);

                            // Ensure uploads directory exists
                            try {
                                await fs.mkdir('uploads', { recursive: true });
                            } catch (dirError) {
                                console.log('Uploads directory already exists or created');
                            }

                            // Write file directly from buffer - no additional processing to avoid corruption
                            await fs.writeFile(tempPath, fileBuffer);

                            // Simple file size verification only
                            const stats = await fs.stat(tempPath);
                            if (stats.size !== fileBuffer.length) {
                                console.error('File size mismatch after writing:', stats.size, 'vs', fileBuffer.length);
                                try {
                                    await fs.unlink(tempPath);
                                } catch (unlinkError) {
                                    console.error('Failed to cleanup corrupted temp file:', unlinkError);
                                }
                                continue;
                            }

                            console.log('File written successfully, size:', stats.size, 'bytes');

                            // Use server-provided content type or detect from extension
                            let mimeType = contentType;
                            
                            // Only override if content type is generic
                            if (mimeType === 'application/octet-stream' || mimeType === 'application/binary') {
                                const extension = cleanFilename.toLowerCase().split('.').pop();
                                switch (extension) {
                                    case 'pdf': mimeType = 'application/pdf'; break;
                                    case 'doc': mimeType = 'application/msword'; break;
                                    case 'docx': mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'; break;
                                    case 'xlsx': mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'; break;
                                    case 'xls': mimeType = 'application/vnd.ms-excel'; break;
                                    case 'jpg':
                                    case 'jpeg': mimeType = 'image/jpeg'; break;
                                    case 'png': mimeType = 'image/png'; break;
                                    case 'gif': mimeType = 'image/gif'; break;
                                    case 'txt': mimeType = 'text/plain'; break;
                                    default: mimeType = 'application/octet-stream'; break;
                                }
                            }

                            // Upload to Google Drive with organized folder structure
                            console.log('Uploading to Google Drive:', finalFilename);
                            console.log('MIME type:', mimeType);
                            console.log('File size:', stats.size, 'bytes');
                            
                            const enhancedUserData = {
                                ...userData,
                                username: userData.username || 'Unknown User'
                            };
                            
                            const driveFile = await uploadToCompanyGoogleDrive(tempPath, finalFilename, mimeType, enhancedUserData);

                            uploadedFiles.push({
                                originalName: originalFilename, // Store actual original filename
                                cleanName: cleanFilename,
                                finalName: finalFilename,
                                driveId: driveFile.id,
                                driveLink: driveFile.webViewLink,
                                jotformUrl: fileUrl,
                                questionId: questionId,
                                fileSize: stats.size,
                                mimeType: mimeType
                            });

                            // Clean up temp file after successful upload
                            try {
                                await fs.unlink(tempPath);
                                console.log('Temp file cleaned up:', tempPath);
                            } catch (cleanupError) {
                                console.error('Failed to cleanup temp file:', tempPath, cleanupError);
                                // Continue anyway since upload was successful
                            }

                            console.log('✅ File successfully transferred:', finalFilename);
                            console.log('✅ Original filename:', originalFilename);
                            console.log('✅ File size:', stats.size, 'bytes');
                            console.log('✅ Google Drive ID:', driveFile.id);

                        } catch (fileError) {
                            console.error('Error processing individual file:', fileError);
                            // Continue with other files even if one fails
                        }
                    }
                }
            }
        }

        console.log(`File transfer completed. ${uploadedFiles.length} files transferred to Google Drive.`);

        // Mark as processed only after successful transfer
        if (uploadedFiles.length > 0) {
            processedSubmissions.add(submissionId);
        }

        return uploadedFiles;

    } catch (error) {
        console.error('Error transferring files from Jotform to Google Drive:', error);
        return []; // Return empty array instead of throwing to prevent webhook failure
    } finally {
        // Always clean up processing state
        processingSubmissions.delete(submissionId);
    }
}

// Send notification to channel when documents are submitted
async function sendSubmissionNotification(userData, submissionId) {
    try {
        // Prevent duplicate notifications
        const notificationKey = `${submissionId}_${userData.userId}`;
        if (notificationsSent.has(notificationKey)) {
            console.log('Notification already sent for:', notificationKey);
            return;
        }
        notificationsSent.add(notificationKey);

        const channel = client.channels.cache.get(NOTIFICATION_CHANNEL_ID);
        if (!channel) {
            console.error('Notification channel not found:', NOTIFICATION_CHANNEL_ID);
            return;
        }

        const totalCommission = userData.agents
            ?.filter(agent => agent.name)
            ?.reduce((sum, agent) => sum + parseFloat(agent.commission || 0), 0) || 0;

        // Calculate fast commission based on project-specific percentage
        const fastCommissionPercentage = getFastCommissionPercentage(userData.project_name);
        const fastCommissionAmount = (totalCommission * fastCommissionPercentage) / 100;

        const embed = new EmbedBuilder()
            .setTitle('📋 New Commission Submission Completed')
            .setColor(0x28A745)
            .addFields(
                { name: '🏢 Project', value: `${userData.project_name} - ${userData.unit_no}`, inline: true },
                { name: '👤 Customer', value: userData.customer_name, inline: true },
                { name: '💰 Total Commission', value: `RM${totalCommission.toFixed(2)}`, inline: true },
                { name: '⚡ Fast Commission', value: `RM${fastCommissionAmount.toFixed(2)} (${fastCommissionPercentage}%)`, inline: true },
                { name: '📝 Submission ID', value: submissionId, inline: true },
                { name: '📅 Submitted', value: new Date().toLocaleString(), inline: true }
            )
            .setTimestamp();

        if (userData.agents && userData.agents.length > 0) {
            const agentDetails = userData.agents
                .filter(agent => agent.name)
                .map(agent => `**${agent.name}**: RM${agent.commission}`)
                .join('\n');
            embed.addFields({ name: '👥 Agent Commissions', value: agentDetails, inline: false });
        }

        // Add Google Drive file information
        if (userData.uploadedFiles && userData.uploadedFiles.length > 0) {
            const fileList = userData.uploadedFiles
                .map(file => `📁 [${file.originalName}](${file.driveLink})`)
                .join('\n');

            embed.addFields({ 
                name: `📂 Documents Uploaded to Google Drive (${userData.uploadedFiles.length})`, 
                value: fileList.length > 1024 ? fileList.substring(0, 1020) + '...' : fileList, 
                inline: false 
            });
        } else {
            embed.addFields({ 
                name: '📂 Documents', 
                value: '⚠️ No files were transferred to Google Drive', 
                inline: false 
            });
        }

        await channel.send({
            content: '🎉 **New Commission Submission!**',
            embeds: [embed]
        });

        console.log('Notification sent to channel for submission:', submissionId);
    } catch (error) {
        console.error('Error sending notification:', error);
    }
}

// Update checklist display
async function updateChecklistDisplay(message, data, userId) {
    const checklist = data.documentChecklist;

    // Create updated embed
    const embed = new EmbedBuilder()
        .setTitle('📋 Document Upload Checklist')
        .setColor(0xFF9900)
        .setDescription('Please upload all required documents:')
        .addFields(
            { 
                name: '📝 Booking Form', 
                value: checklist.booking_form?.uploaded ? `✅ Uploaded (${checklist.booking_form.files.length} file(s))` : '❌ Not uploaded', 
                inline: true 
            },
            { 
                name: '📄 SPA', 
                value: checklist.spa?.uploaded ? `✅ Uploaded (${checklist.spa.files.length} file(s))` : '❌ Not uploaded', 
                inline: true 
            },
            { 
                name: '📑 LA', 
                value: checklist.la?.uploaded ? `✅ Uploaded (${checklist.la.files.length} file(s))` : '❌ Not uploaded', 
                inline: true 
            }
        )
        .setFooter({ text: 'Click the buttons below to upload each document type' });

    const docRow1 = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('upload_booking_form')
                .setLabel('📝 Upload Booking Form')
                .setStyle(checklist.booking_form?.uploaded ? ButtonStyle.Secondary : ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId('upload_spa')
                .setLabel('📄 Upload SPA')
                .setStyle(checklist.spa?.uploaded ? ButtonStyle.Secondary : ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId('upload_la')
                .setLabel('📑 Upload LA')
                .setStyle(checklist.la?.uploaded ? ButtonStyle.Secondary : ButtonStyle.Primary)
        );

    // Check if all documents are uploaded
    const allUploaded = checklist.booking_form?.uploaded && checklist.spa?.uploaded && checklist.la?.uploaded;

    const docRow2 = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('complete_submission')
                .setLabel('✅ Complete Submission')
                .setStyle(ButtonStyle.Success)
                .setDisabled(!allUploaded),
            new ButtonBuilder()
                .setCustomId('cancel_submission')
                .setLabel('❌ Cancel')
                .setStyle(ButtonStyle.Danger)
        );

    try {
        // Find the original checklist message and update it
        const channel = message.channel;
        const messages = await channel.messages.fetch({ limit: 20 });

        const checklistMessage = messages.find(msg => 
            msg.author.id === message.client.user.id && 
            msg.embeds.length > 0 && 
            msg.embeds[0].title === '📋 Document Upload Checklist'
        );

        if (checklistMessage) {
            await checklistMessage.edit({
                content: '✅ **Submission Confirmed!**\n\n📋 **Your commission data has been saved.**\n\n**Next Step:** Upload all required documents using the checklist below:',
                embeds: [embed],
                components: [docRow1, docRow2]
            });
        }
    } catch (error) {
        console.error('Error updating checklist display:', error);
    }

    await message.reply({
        content: `✅ **Document uploaded successfully!**\n\n${allUploaded ? '🎉 **All documents uploaded!** You can now complete your submission.' : '📋 **Please upload remaining documents to complete your submission.**'}`,
        ephemeral: true
    });
}

// Login to Discord
client.login(process.env.DISCORD_TOKEN);
