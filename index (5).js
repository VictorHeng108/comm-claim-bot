const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { google } = require('googleapis');
const { Octokit } = require('@octokit/rest');
const express = require('express');
const multer = require('multer');
const fs = require('fs').promises;
const path = require('path');
const settings = require('./settings.json');
const fetch = require('node-fetch');

// Initialize Discord client
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

// Initialize services
let drive, forms, octokit;
const app = express();
const upload = multer({ dest: 'uploads/' });

// Store submission data temporarily
const submissions = new Map();

// Initialize Google Drive with Service Account
async function initializeGoogleDrive() {
    try {
        const serviceAccount = JSON.parse(process.env.G_DRIVE_SERVICE_ACCOUNT || '{}');

        const auth = new google.auth.GoogleAuth({
            credentials: serviceAccount,
            scopes: [
                'https://www.googleapis.com/auth/drive.file',
                'https://www.googleapis.com/auth/drive',
                'https://www.googleapis.com/auth/forms.body',
                'https://www.googleapis.com/auth/forms',
                'https://www.googleapis.com/auth/forms',
                'https://www.googleapis.com/auth/drive.metadata'
            ]
        });

        drive = google.drive({ version: 'v3', auth });
        forms = google.forms({ version: 'v1', auth });
        console.log('Google Drive and Forms API initialized with Service Account');
    } catch (error) {
        console.error('Failed to initialize Google Drive:', error);
        console.error('Make sure G_DRIVE_SERVICE_ACCOUNT environment variable is set with your Service Account JSON');
    }
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
            .setRequired(true)
            .setValue(existingData.customer_name || ''),

        new TextInputBuilder()
            .setCustomId('customer_phone')
            .setLabel('Customer Phone')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setValue(existingData.customer_phone || ''),

        new TextInputBuilder()
            .setCustomId('customer_address')
            .setLabel('Customer Address')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setValue(existingData.customer_address || ''),

        new TextInputBuilder()
            .setCustomId('spa_date')
            .setLabel('SPA Date (YYYY-MM-DD)')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setValue(existingData.spa_date || ''),

        new TextInputBuilder()
            .setCustomId('la_date')
            .setLabel('LA Date (YYYY-MM-DD)')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setValue(existingData.la_date || '')
    ];

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
            { name: '🏢 Project Details', value: `**Project:** ${data.project_name}\n**Unit:** ${data.unit_no}\n**SPA Price:** RM${data.spa_price}\n**Nett Price:** RM${Number(String(data.nett_price).replace(/,/g, '')).toLocaleString()}\n**Commission Rate:** ${data.commission_rate}%`, inline: false },
            { name: '👤 Customer Details', value: `**Name:** ${data.customer_name}\n**Phone:** ${data.customer_phone}\n**Address:** ${data.customer_address}`, inline: false },
            { name: '📅 Important Dates', value: `**SPA Date:** ${data.spa_date}\n**LA Date:** ${data.la_date}`, inline: false }
        )
        .setTimestamp();

    // Add agent details
    const agentDetails = data.agents
        .filter(agent => agent.name)
        .map(agent => `**${agent.name}** (${agent.code}): ${agent.percentage}% - RM${agent.commission}`)
        .join('\n');

    if (agentDetails) {
        embed.addFields({ name: '👥 Agent Commission Breakdown', value: agentDetails, inline: false });

        const totalCommission = data.agents.reduce((sum, agent) => sum + parseFloat(agent.commission || 0), 0);
        embed.addFields({ name: '💰 Total Commission', value: `RM${totalCommission.toFixed(2)}`, inline: true });
    }

    return embed;
}

// Bot ready event
client.once('ready', async () => {
    console.log(`${client.user.tag} is online!`);

    // Initialize services
    await initializeGoogleDrive();
    initializeGitHub();

    // Register public commands globally
    const publicCommands = [
        new SlashCommandBuilder()
            .setName('fast-comm-submission')
            .setDescription('Submit commission claim with document upload')
    ];

    // Register public commands globally
    for (const command of publicCommands) {
        await client.application.commands.create(command);
    }

    // Register admin commands only in your specific Discord server
    const adminGuildId = "1118938632250732544"; // Your Discord server ID
    const guild = client.guilds.cache.get(adminGuildId);

    if (guild) {
        // Define admin commands for guild-only registration
        const adminCommands = [
            new SlashCommandBuilder()
                .setName('check-comm-submit')
                .setDescription('Check commission submission data (Admin only)')
                .addStringOption(option =>
                    option.setName('user_id')
                        .setDescription('User ID to check (optional)')
                        .setRequired(false))
                .addIntegerOption(option =>
                    option.setName('limit')
                        .setDescription('Number of recent submissions to show (default: 10)')
                        .setRequired(false)),

            new SlashCommandBuilder()
                .setName('amend-submission')
                .setDescription('Delete or amend submission data (Admin only)')
                .addStringOption(option =>
                    option.setName('action')
                        .setDescription('Action to perform')
                        .setRequired(true)
                        .addChoices(
                            { name: 'List Recent', value: 'list' },
                            { name: 'Delete by Index', value: 'delete' },
                            { name: 'View Details', value: 'view' }
                        ))
                .addIntegerOption(option =>
                    option.setName('index')
                        .setDescription('Index number of submission (for delete/view)')
                        .setRequired(false))
        ];

        // Replace all guild commands at once to prevent duplicates
        await guild.commands.set(adminCommands);
        console.log(`✅ Admin commands registered only in: ${guild.name}`);
    } else {
        console.log('❌ Admin guild not found - admin commands not registered');
    }

    console.log('✅ Public commands registered globally');

    // Start express server
    const port = process.env.PORT || 3000;
    app.listen(port, '0.0.0.0', () => {
        console.log(`Express server running on port ${port}`);
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

    // Handle slash commands
    if (interaction.isCommand()) {
        if (interaction.commandName === 'check-comm-submit') {

            try {
                const backupData = await loadBackupFromGitHub();
                const userIdFilter = interaction.options.getString('user_id');
                const limit = interaction.options.getInteger('limit') || 10;

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

            } catch (error) {
                console.error('Error checking submissions:', error);
                await interaction.reply({
                    content: '❌ Error retrieving submission data from GitHub.',
                    ephemeral: true
                });
            }
        }

        else if (interaction.commandName === 'amend-submission') {

            try {
                const action = interaction.options.getString('action');
                const index = interaction.options.getInteger('index');
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
                        .setDescription('Use the index number with `/amend-submission` to delete or view details')
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

            const data = {
                project_name: interaction.fields.getTextInputValue('project_name'),
                unit_no: interaction.fields.getTextInputValue('unit_no'),
                spa_price: interaction.fields.getTextInputValue('spa_price'),
                nett_price: nettPriceInput,
                commission_rate: commissionRateInput,
                agents: [],
                submission_date: new Date().toISOString()
            };

            console.log('Stored data nett_price:', data.nett_price);
            console.log('Stored data commission_rate:', data.commission_rate);

            submissions.set(userId, data);

            // Show continue button instead of modal
            const continueRow = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('show_agent_form_1')
                        .setLabel('Continue: Add Consultant Details')
                        .setStyle(ButtonStyle.Primary)
                );

            await interaction.reply({
                content: '✅ **Project details saved!**\nClick the button below to continue with consultant details.',
                components: [continueRow],
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
                        .setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder()
                        .setCustomId(`show_agent_form_back_${step}`)
                        .setLabel(`Previous Consultant`)
                        .setStyle(ButtonStyle.Secondary)
                ];

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

                await interaction.update({
                    content: `✅ **Consultant ${step} details saved!**\nYou can add more consultants${hasCustomerDetails ? ', proceed to confirmation,' : ''} or proceed to customer details.`,
                    components: [continueRow]
                });
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
                            .setLabel(`Previous Consultant`)
                            .setStyle(ButtonStyle.Secondary)
                    );

                const continueRow = new ActionRowBuilder().addComponents(buttons);

                await interaction.update({
                    content: `✅ **All consultant details saved!**\nClick below to ${hasCustomerDetails ? 'proceed to confirmation' : 'add customer details'}.`,
                    components: [continueRow]
                });
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
                content: `📎 **Ready to upload ${documentNames[documentType]}!**\n\n**Now attach your ${documentNames[documentType]} to your next message.**\n\nSupported formats: PDF, DOC, DOCX, JPG, PNG\n\nI\'ll process your files automatically and update the checklist!`,
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
            // Immediately respond to prevent timeout
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

                await interaction.update({
                    content: '❌ **Session expired or missing data**\n\nYour session has timed out. Click below to start a new submission:',
                    components: [restartRow],
                    embeds: []
                });
                return;
            }

            // Save to GitHub backup FIRST to preserve user data
            const backupData = await loadBackupFromGitHub();
            const submissionData = {
                ...data,
                user_id: userId,
                username: interaction.user.username,
                submitted_at: new Date().toISOString()
            };
            backupData.push(submissionData);
            await saveBackupToGitHub(backupData);

            // Mark data as confirmed and preserved
            data.dataConfirmed = true;
            data.backupSaved = true;
            submissions.set(userId, data);

            try {
                // Create Google Form for document uploads
                const formData = await createDocumentUploadForm(data);

                // Store form info
                data.googleForm = formData;
                data.status = 'awaiting_form_completion';
                submissions.set(userId, data);

                const embed = new EmbedBuilder()
                    .setTitle('📋 Document Upload - Google Form')
                    .setColor(0x4285F4)
                    .setDescription('Your personalized Google Form has been created!')
                    .addFields(
                        { name: '📝 What to do next:', value: '1. Click the "Upload Documents" button below\n2. Fill out the Google Form with your documents\n3. Submit the form\n4. Return here and click "Check Upload Status"', inline: false },
                        { name: '📋 Required Documents:', value: '• Booking Form\n• SPA Document\n• LA Document', inline: false }
                    )
                    .setFooter({ text: 'The form will automatically save your documents to Google Drive' });

                const actionRow = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId('open_google_form')
                            .setLabel('📝 Upload Documents')
                            .setStyle(ButtonStyle.Link)
                            .setURL(formData.responseUrl),
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
                    content: '✅ **Submission Confirmed!**\n\n📋 **Your commission data has been saved.**\n🎯 **Google Form created for document uploads!**',
                    embeds: [embed],
                    components: [actionRow]
                });

            } catch (error) {
            console.error('Error creating Google Form:', error);
            console.error('Error details:', error.response?.data || error.message);

            // Check for specific error types
            if (error.response?.status === 403) {
                console.error('Permission denied - check service account permissions');
            } else if (error.response?.status === 429) {
                console.error('Rate limit exceeded - implementing retry logic');

                // Implement exponential backoff retry
                for (let attempt = 1; attempt <= 3; attempt++) {
                    try {
                        console.log(`Retry attempt ${attempt}/3 after rate limit...`);
                        await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));

                        const retryFormData = await createDocumentUploadForm(data);
                        data.googleForm = retryFormData;
                        data.status = 'awaiting_form_completion';
                        submissions.set(userId, data);

                        // Success on retry
                        const embed = new EmbedBuilder()
                            .setTitle('📋 Document Upload - Google Form (Retry Success)')
                            .setColor(0x4285F4)
                            .setDescription('Your personalized Google Form has been created after retry!')
                            .addFields(
                                { name: '📝 What to do next:', value: '1. Click the "Upload Documents" button below\n2. Fill out the Google Form with your documents\n3. Submit the form\n4. Return here and click "Check Upload Status"', inline: false },
                                { name: '📋 Required Documents:', value: '• Booking Form\n• SPA Document\n• LA Document', inline: false }
                            )
                            .setFooter({ text: 'The form will automatically save your documents to Google Drive' });

                        const actionRow = new ActionRowBuilder()
                            .addComponents(
                                new ButtonBuilder()
                                    .setCustomId('open_google_form')
                                    .setLabel('📝 Upload Documents')
                                    .setStyle(ButtonStyle.Link)
                                    .setURL(retryFormData.responseUrl),
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
                            content: '✅ **Form Creation Successful After Retry!**\n\n📋 **Your commission data has been saved.**\n🎯 **Google Form created for document uploads!**',
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

            // Fallback to ready-made Google Form
            const fallbackFormUrl = "https://docs.google.com/forms/d/e/1FAIpQLSc_EXAMPLE_FORM_ID/viewform";

                // Check if interaction is still valid (not expired)
                try {
                    // Since data is already saved, show user-friendly error with retry
                    const errorEmbed = new EmbedBuilder()
                        .setTitle('⚠️ Google Form Creation Error')
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
                                .setCustomId('retry_google_form')
                                .setLabel('🔄 Retry Form Creation')
                                .setStyle(ButtonStyle.Primary),
                            new ButtonBuilder()
                                .setCustomId('view_preserved_data')
                                .setLabel('👁️ View My Data')
                                .setStyle(ButtonStyle.Secondary),
                            new ButtonBuilder()
                                .setCustomId('cancel_submission')
                                .setLabel('❌ Cancel')
                                .setStyle(ButtonStyle.Danger)
                        );

                    await interaction.update({
                        content: '💾 **Your Data Has Been Safely Preserved!**\n\n✅ **Submission confirmed and backed up**\n⚠️ **Form creation needs retry**',
                        embeds: [errorEmbed],
                        components: [retryRow]
                    });
                } catch (interactionError) {
                    console.error('Interaction expired, sending follow-up message:', interactionError);

                    // Interaction expired, send a follow-up message
                    try {
                        await interaction.followUp({
                            content: '💾 **Your Data Has Been Safely Preserved!**\n\n✅ **Submission confirmed and backed up to GitHub**\n⚠️ **Google Form creation failed temporarily**\n\n🔄 **To continue:** Use `/fast-comm-submission` command again. Your data is preserved and you won\'t need to re-enter it.',
                            ephemeral: true
                        });
                    } catch (followUpError) {
                        console.error('Both interaction update and followUp failed, logging data for user:', followUpError);
                        console.log(`User ${userId} (${interaction.user.username}) data preserved but UI failed. Backup saved to GitHub.`);
                    }
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
                    components: [restartRow],
                    embeds: []
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
                content: '🎉 **Submission Complete!**\n\nThank you for your commission submission. Your documents have been uploaded and your data has been saved.\n\n✅ **Status:** Complete\n📁 **Documents:** Uploaded to Google Drive',
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

                if (index < 0 || index >= backupData.length) {
                    await interaction.update({
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

            if (!data || !data.googleForm) {
                await interaction.reply({
                    content: '❌ No form data found. Please restart the submission process.',
                    ephemeral: true
                });
                return;
            }

            try {
                const hasResponses = await checkFormResponses(data.googleForm.formId);

                if (hasResponses) {
                    await interaction.update({
                        content: '🎉 **Commission Submission Complete!**\n\nThank you for your submission! Your documents have been uploaded via Google Form and your data has been saved.\n\n✅ **Status:** Complete\n📁 **Documents:** Uploaded to Google Drive via Google Form\n📋 **Form:** Your responses have been recorded',
                        embeds: [],
                        components: []
                    });

                    // Clean up
                    submissions.delete(userId);
                } else {
                    await interaction.reply({
                        content: '⏳ **No form submission detected yet**\n\nPlease complete the Google Form first, then check status again.\n\n📝 If you haven\'t submitted the form yet, click the "Upload Documents" button above.',
                        ephemeral: true
                    });
                }
            } catch (error) {
                console.error('Error checking form status:', error);
                await interaction.reply({
                    content: '❌ Error checking form status. Please try again.',
                    ephemeral: true
                });
            }
        }

        else if (interaction.customId === 'complete_submission') {
            const data = submissions.get(userId);

            await interaction.update({
                content: '🎉 **Commission Submission Complete!**\n\nThank you for your submission. All documents have been uploaded and your data has been saved.\n\n✅ **Status:** Complete\n📁 **All Documents:** Uploaded to Google Drive',
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
                        .setCustomId('retry_google_form')
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

        else if (interaction.customId === 'retry_google_form') {
            const data = submissions.get(userId);

            if (!data || !data.project_name) {
                const restartRow = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId('restart_submission')
                            .setLabel('🔄 Start New Submission')
                            .setStyle(ButtonStyle.Primary)
                    );

                await interaction.update({
                    content: '❌ **Session expired or missing data**\n\nYour session has timed out. Use `/fast-comm-submission` to start fresh:',
                    components: [restartRow],
                    embeds: []
                });
                return;
            }

            try {
                // Add a small delay to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, 1000));

                // Retry creating Google Form for document uploads
                const formData = await createDocumentUploadForm(data);

                // Store form info
                data.googleForm = formData;
                data.status = 'awaiting_form_completion';
                submissions.set(userId, data);

                const embed = new EmbedBuilder()
                    .setTitle('📋 Document Upload - Google Form')
                    .setColor(0x4285F4)
                    .setDescription('Your personalized Google Form has been created successfully!')
                    .addFields(
                        { name: '📝 What to do next:', value: '1. Click the "Upload Documents" button below\n2. Fill out the Google Form with your documents\n3. Submit the form\n4. Return here and click "Check Upload Status"', inline: false },
                        { name: '📋 Required Documents:', value: '• Booking Form\n• SPA Document\n• LA Document', inline: false }
                    )
                    .setFooter({ text: 'The form will automatically save your documents to Google Drive' });

                const actionRow = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId('open_google_form')
                            .setLabel('📝 Upload Documents')
                            .setStyle(ButtonStyle.Link)
                            .setURL(formData.responseUrl),
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
                    content: '✅ **Form Creation Successful!**\n\n📋 **Your commission data has been saved.**\n🎯 **Google Form created for document uploads!**',
                    embeds: [embed],
                    components: [actionRow]
                });

            } catch (error) {
                console.error('Retry Google Form creation failed:', error);

                try {
                    const errorEmbed = new EmbedBuilder()
                        .setTitle('⚠️ Form Creation Still Failing')
                        .setColor(0xFF6B6B)
                        .setDescription('The Google Form creation is experiencing persistent issues.')
                        .addFields(
                            { name: '📋 Your Data Status', value: '✅ All submission data preserved in GitHub backup', inline: false },
                            { name: '🔄 What to try:', value: 'Use `/fast-comm-submission` again - your data will be restored automatically', inline: false },
                            { name: '🆘 If issues persist:', value: 'Check your Google service account permissions for Forms API', inline: false }
                        )
                        .setTimestamp();

                    const alternativeRow = new ActionRowBuilder()
                        .addComponents(
                            new ButtonBuilder()
                                .setCustomId('retry_google_form')
                                .setLabel('🔄 Try Again')
                                .setStyle(ButtonStyle.Primary),
                            new ButtonBuilder()
                                .setCustomId('cancel_submission')
                                .setLabel('❌ Cancel Session')
                                .setStyle(ButtonStyle.Danger)
                        );

                    await interaction.update({
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

        else if (interaction.customId === 'restart_submission') {
            submissions.delete(userId);
            await interaction.reply({
                content: '🔄 **Starting a new submission!**\n\nPlease use `/fast-comm-submission` command to start over.',
                ephemeral: true
            });
        }

        return;
    }
});

// Upload file to Google Drive
async function uploadToGoogleDrive(filePath, fileName, mimeType) {
    try {
        // Create folder if it doesn't exist
        const folderId = await createOrGetFolder(settings.googleDrive.folderName);

        const fileMetadata = {
            name: fileName,
            parents: [folderId]
        };

        const media = {
            mimeType: mimeType,
            body: require('fs').createReadStream(filePath)
        };

        const response = await drive.files.create({
            resource: fileMetadata,
            media: media,
            fields: 'id, name, webViewLink'
        });

        console.log('File uploaded to Google Drive:', response.data.name);
        return response.data;
    } catch (error) {
        console.error('Error uploading to Google Drive:', error);
        throw error;
    }
}

// Create Google Form for document uploads
async function createDocumentUploadForm(userData) {
    try {
        const formTitle = `Commission Documents - ${userData.project_name} (${userData.unit_no})`;

        // Step 1: Create the form with only the title
        const form = await forms.forms.create({
            requestBody: {
                info: {
                    title: formTitle
                }
            }
        });

        const formId = form.data.formId;

        // Step 2: Add description and file upload questions using batchUpdate
        const folderId = await createOrGetFolder(settings.googleDrive.folderName);

        const requests = [
            // Update form description
            {
                updateFormInfo: {
                    info: {
                        title: formTitle,
                        description: `Please upload your commission documents for:\n\nProject: ${userData.project_name}\nUnit: ${userData.unit_no}\nCustomer: ${userData.customer_name}\n\nRequired Documents: Booking Form, SPA, LA`
                    },
                    updateMask: 'description'
                }
            },
            // Add Booking Form question
            {
                createItem: {
                    item: {
                        title: 'Booking Form',
                        description: 'Upload your Booking Form document (PDF, DOC, DOCX, JPG, PNG)',
                        questionItem: {
                            question: {
                                required: true,
                                fileUploadQuestion: {
                                    folderId: folderId,
                                    types: ['PDF', 'DOCUMENT', 'PRESENTATION', 'DRAWING', 'IMAGE'],
                                    maxFiles: 5,
                                    maxFileSize: 10485760 // 10MB
                                }
                            }
                        }
                    },
                    location: { index: 0 }
                }
            },
            // Add SPA Document question
            {
                createItem: {
                    item: {
                        title: 'SPA Document',
                        description: 'Upload your SPA document (PDF, DOC, DOCX, JPG, PNG)',
                        questionItem: {
                            question: {
                                required: true,
                                fileUploadQuestion: {
                                    folderId: folderId,
                                    types: ['PDF', 'DOCUMENT', 'PRESENTATION', 'DRAWING', 'IMAGE'],
                                    maxFiles: 5,
                                    maxFileSize: 10485760 // 10MB
                                }
                            }
                        }
                    },
                    location: { index: 1 }
                }
            },
            // Add LA Document question
            {
                createItem: {
                    item: {
                        title: 'LA Document',
                        description: 'Upload your LA document (PDF, DOC, DOCX, JPG, PNG)',
                        questionItem: {
                            question: {
                                required: true,
                                fileUploadQuestion: {
                                    folderId: folderId,
                                    types: ['PDF', 'DOCUMENT', 'PRESENTATION', 'DRAWING', 'IMAGE'],
                                    maxFiles: 5,
                                    maxFileSize: 10485760 // 10MB
                                }
                            }
                        }
                    },
                    location: { index: 2 }
                }
            }
        ];

        await forms.forms.batchUpdate({
            formId: formId,
            requestBody: { requests }
        });

        // Step 3: Publish the form (required for new API behavior)
        await forms.forms.setPublishSettings({
            formId: formId,
            requestBody: {
                publishedSettings: {
                    responderInputRequired: false
                }
            }
        });

        // Step 4: Make form publicly accessible
        await drive.permissions.create({
            fileId: formId,
            requestBody: {
                role: 'writer',
                type: 'anyone'
            }
        });

        const formUrl = `https://docs.google.com/forms/d/${formId}/edit`;
        const responseUrl = `https://docs.google.com/forms/d/${formId}/viewform`;

        console.log('Created and published Google Form:', formTitle);
        return { formId, formUrl, responseUrl };

    } catch (error) {
        console.error('Error creating Google Form:', error);
        throw error;
    }
}

// Check if form has responses
async function checkFormResponses(formId) {
    try {
        const responses = await forms.forms.responses.list({
            formId: formId
        });

        return responses.data.responses && responses.data.responses.length > 0;
    } catch (error) {
        console.error('Error checking form responses:', error);
        return false;
    }
}

// Create or get existing folder
async function createOrGetFolder(folderName) {
    try {
        // Search for existing folder
        const response = await drive.files.list({
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

        const folder = await drive.files.create({
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

// Express route for file upload
app.post('/upload/:userId', upload.array('documents'), async (req, res) => {
    try {
        const userId = req.params.userId;
        const uploadedFiles = [];

        for (const file of req.files) {
            const driveFile = await uploadToGoogleDrive(
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
            message: 'Files uploaded successfully to Google Drive',
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