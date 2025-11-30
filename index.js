// index.js
// The Nexus Bot - tournament management with application portal, tickets, rules, and manual admin scoring
const fs = require('fs');
const path = require('path');
const STATE_FILE = path.join(__dirname, 'state.json');
require('dotenv/config');
const {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  PermissionsBitField,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  AttachmentBuilder,
} = require('discord.js');

const { renderBracketImage } = require('./bracket-image');

// In-memory storage (for production, replace with a real database)
const tournaments = new Map();   // key = guildId, value = Tournament object
const matches = new Map();       // key = matchId, value = Match object
const matchChannels = new Map(); // key = channelId, value = matchId

// entry portals config: key = `${guildId}:${mode}`
const entryPortals = new Map();  // value = { publicChannelId, adminChannelId, mode, startTime }

// player profiles: key = userId
const playerProfiles = new Map(); // value = { ign, whatsapp }
const teamProfiles = new Map();   // key = leaderId, value = { teamName, leaderIgn, leaderWhatsapp, playersText }

/**
 * Tournament shape (in-memory):
 * {
 *   id,
 *   shortCode,
 *   guildId,
 *   name,
 *   bestOf,
 *   status: 'registration' | 'running' | 'completed',
 *   players: [userId], // 1v1: players, 5v5: team leaders
 *   categoryId,
 *   lobbyChannelId,
 *   currentRound,
 *   matches: [matchId]
 * }
 *
 * Match shape:
 * {
 *   id,
 *   guildId,
 *   tournamentId,
 *   round,
 *   player1Id,
 *   player2Id,
 *   channelId,
 *   status: 'pending' | 'completed',
 *   winnerId: string | null
 * }
 */

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);

  client.user.setPresence({
    activities: [
      {
        name: "The Nexus Tournaments | dev: @nex0or",
        type: 0, 
      },
    ],
    status: 'online',
  });
});


// ---------- INTERACTION HANDLER ----------

client.on('interactionCreate', async interaction => {
  try {
    // Slash commands
    if (interaction.isChatInputCommand()) {
      switch (interaction.commandName) {
        case 'create-tournament':
          await handleCreateTournament(interaction);
          break;
        case 'tournament-info':
          await handleTournamentInfo(interaction);
          break;
        case 'start-tournament':
          await handleStartTournament(interaction);
          break;
        case 'set-winner':
          await handleSetWinner(interaction);
          break;
        case 'setup-entry':
          await handleSetupEntry(interaction);
          break;
        case 'bracket':
          await handleBracket(interaction);
          break;
        case 'add-player':
          await handleAddPlayer(interaction);
          break;
        case 'set-bracket-link':
          
          await handleSetBracketLink(interaction);
          break;
             case 'export-participants':
          await handleExportParticipants(interaction);
          break;
        default:
          break;
      }
      return;
    }


    // Buttons (apply / accept / reject / rules / bracket refresh)
    if (interaction.isButton()) {
      const customId = interaction.customId;

      // Bracket refresh
      if (customId === 'bracket_refresh') {
        const guild = interaction.guild;
        if (!guild) {
          return interaction.reply({
            content: 'Server only.',
            ephemeral: true,
          });
        }

        const tournament = tournaments.get(guild.id);
        if (!tournament) {
          return interaction.reply({
            content: 'No active tournament found.',
            ephemeral: true,
          });
        }

        await interaction.deferUpdate();

        const buffer = await renderBracketImage(
          guild,
          tournament,
          matches,
          playerProfiles,
          teamProfiles,
        );
        const attachment = new AttachmentBuilder(buffer, { name: 'bracket.png' });

        const embed = new EmbedBuilder()
          .setTitle(`${tournament.name} – Current Bracket`)
          .setColor(0x00ff41)
          .setImage('attachment://bracket.png');

        return interaction.editReply({
          embeds: [embed],
          files: [attachment],
          components: interaction.message.components,
        });
      }

      // Rules buttons
      if (customId.startsWith('rules:')) {
        const mode = customId.split(':')[1];
        const content = mode === '1v1' ? getRules1v1() : getRules5v5();
        return interaction.reply({
          content,
          ephemeral: true,
        });
      }

      // Other buttons (apply / accept / reject)
      const parts = customId.split(':');
      const action = parts[0];

      // Player application: open modal
      if (action === 'apply') {
        const mode = parts[1]; // '1v1' or '5v5'
        await showApplicationModal(interaction, mode);
        return;
      }

      // Admin accept/reject
      if (action === 'app_accept' || action === 'app_reject') {
        const mode = parts[1];   // '1v1' or '5v5'
        const targetId = parts[2]; // discord user id (player or leader)
        const isAccept = action === 'app_accept';
        await handleApplicationDecision(interaction, { mode, targetId, isAccept });
        return;
      }

      return;
    }

    // Modals (application submit)
    if (interaction.isModalSubmit()) {
      const [prefix, mode] = interaction.customId.split(':');
      if (prefix !== 'applymodal') return;

      if (mode === '1v1') {
        await handleApplication1v1(interaction);
        return;
      }
      if (mode === '5v5') {
        await handleApplication5v5(interaction);
        return;
      }
    }
  } catch (err) {
    console.error('Error in interaction handler:', err);
    if (!interaction.replied && !interaction.deferred) {
      interaction.reply({ content: 'Something went wrong.', ephemeral: true }).catch(() => {});
    }
  }
});

// Handle screenshots in match channels (ticket channels)
client.on('messageCreate', async message => {
  try {
    if (message.author.bot) return;
    if (!message.guild) return;

    const matchId = matchChannels.get(message.channel.id);
    if (!matchId) return;

    const match = matches.get(matchId);
    if (!match) return;

    // Check if message has image attachments
    const hasImage = message.attachments.some(att => {
      const contentType = att.contentType || '';
      return contentType.startsWith('image/');
    });

    if (!hasImage) return;

    const tournament = tournaments.get(match.guildId);
    const p1 = `<@${match.player1Id}>`;
    const p2 = `<@${match.player2Id}>`;

    await message.channel.send(
      `@everyone A match screenshot has been posted.\n` +
      `Tournament: **${tournament?.name || 'Unknown'}**\n` +
      `Match ID: \`${match.id}\`\n` +
      `Round: **${match.round}**\n` +
      `Players: ${p1} vs ${p2}\n\n` +
      `Admins: please review the screenshot and use **/set-winner** in this channel to decide the winner manually.`
    );
  } catch (err) {
    console.error('Error in messageCreate handler:', err);
  }
});
async function handleExportParticipants(interaction) {
  const guild = interaction.guild;
  if (!guild) return;

  const tournament = tournaments.get(guild.id);
  if (!tournament) {
    return interaction.reply({
      content: 'No active tournament found for this server.',
      ephemeral: true,
    });
  }

  if (!Array.isArray(tournament.players) || tournament.players.length === 0) {
    return interaction.reply({
      content: 'No players/teams registered in this tournament yet.',
      ephemeral: true,
    });
  }

  // نبني لستة أسماء: لو في teamName نستخدمه، لو لا يبقا IGN، لو لا منشن الديسكورد
  const lines = [];

  for (const id of tournament.players) {
    const team = teamProfiles.get(id);
    const profile = playerProfiles.get(id);

    let name =
      team?.teamName ||
      profile?.ign ||
      null;

    if (!name) {
      const member = await guild.members.fetch(id).catch(() => null);
      name = member ? member.displayName : `Discord ID ${id}`;
    }

    lines.push(name);
  }

  const text = lines.join('\n');

  // نعمل ملف نصي عشان تقدر تفتحه وتعمل Copy/Paste في Bulk Add
  const buffer = Buffer.from(text, 'utf8');
  const attachment = new AttachmentBuilder(buffer, { name: 'participants.txt' });

  await interaction.reply({
    content:
      'Here is a text file with one participant per line.\n' +
      'Open it, copy all lines, then paste them into **Bulk Add** in Challonge.',
    files: [attachment],
    ephemeral: true,
  });
}

// ---------- SLASH COMMAND HANDLERS ----------

async function handleCreateTournament(interaction) {
  const guild = interaction.guild;
  if (!guild) return;

  const name = interaction.options.getString('name', true);
  const bestOf = interaction.options.getInteger('best_of', true);

  if (bestOf <= 0 || bestOf % 2 === 0) {
    return interaction.reply({
      content: 'Best of must be a positive odd number (1, 3, 5, ...).',
      ephemeral: true,
    });
  }

  const shortCode = `NX${Math.floor(1000 + Math.random() * 9000)}`;
const linkChallonge = interaction.options.getBoolean('link_challonge') ?? false;

  // Create category
  const category = await guild.channels.create({
    name: `🏆 ${name}`,
    type: ChannelType.GuildCategory,
  });

  // Create lobby channel
  const lobbyChannel = await guild.channels.create({
    name: 'tournament-lobby',
    type: ChannelType.GuildText,
    parent: category.id,
  });

  const tournament = {
    id: `${guild.id}-${Date.now()}`,
    shortCode,
    guildId: guild.id,
    name,
    bestOf,
    status: 'registration',
    players: [],
    categoryId: category.id,
    lobbyChannelId: lobbyChannel.id,
    currentRound: 1,
    matches: [],
    bracketUrl: null, 
  };

  tournaments.set(guild.id, tournament);
  saveState(); 
  await lobbyChannel.send(
    `Tournament **${name}** created!\n` +
    `Code: \`${shortCode}\`\n` +
    `Match format: **Best of ${bestOf}**.\n\n` 

  );

  await interaction.reply({
    content: `Tournament **${name}** created. Lobby: ${lobbyChannel}`,
    ephemeral: true,
  });
}

async function handleSetBracketLink(interaction) {
  const guild = interaction.guild;
  if (!guild) return;

  const tournament = tournaments.get(guild.id);
  if (!tournament) {
    return interaction.reply({
      content: 'No active tournament found for this server.',
      ephemeral: true,
    });
  }

  const url = interaction.options.getString('url', true).trim();

  // فحص بسيط إن ده لينك
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return interaction.reply({
      content: 'Please provide a valid URL starting with http:// or https://',
      ephemeral: true,
    });
  }

  tournament.bracketUrl = url;
  saveState();

  await interaction.reply({
    content: `Bracket link set for **${tournament.name}**:\n${url}`,
    ephemeral: true,
  });

  // لو عايز، نكتب برضو في اللوبّي للادمنز
  const lobbyChannel = guild.channels.cache.get(tournament.lobbyChannelId);
  if (lobbyChannel && lobbyChannel.isTextBased()) {
    lobbyChannel.send(
      `🔗 Bracket link updated for **${tournament.name}**:\n${url}`
    );
  }
}

async function handleTournamentInfo(interaction) {
  const guild = interaction.guild;
  if (!guild) return;

  const tournament = tournaments.get(guild.id);
  if (!tournament) {
    return interaction.reply({
      content: 'No active tournament found for this server.',
      ephemeral: true,
    });
  }

  const allMatches = tournament.matches.map(id => matches.get(id)).filter(Boolean);
  const completed = allMatches.filter(m => m.status === 'completed').length;
  const totalMatches = allMatches.length;

  const statusLabel =
    tournament.status === 'registration' ? 'Registration' :
    tournament.status === 'running' ? 'Running' :
    'Completed';

  const playersPreview = tournament.players
    .slice(0, 20)
    .map(id => `<@${id}>`)
    .join(', ') || 'No players yet.';

  const morePlayers =
    tournament.players.length > 20
      ? `\n…and **${tournament.players.length - 20}** more.`
      : '';

  await interaction.reply({
    content:
      `Tournament: **${tournament.name}** (\`${tournament.shortCode}\`)\n` +
      `Status: **${statusLabel}**\n` +
      `Best of: **${tournament.bestOf}**\n` +
      `Players: **${tournament.players.length}**\n` +
      `Matches completed: **${completed}/${totalMatches}**\n` +
      `Current round: **${tournament.currentRound}**\n\n` +
      `Players:\n${playersPreview}${morePlayers}`,
    ephemeral: true,
  });
}

async function handleStartTournament(interaction) {
  const guild = interaction.guild;
  if (!guild) return;

  const tournament = tournaments.get(guild.id);
  if (!tournament) {
    return interaction.reply({
      content: 'There is no active tournament in this server.',
      ephemeral: true,
    });
  }

  // نسمح بالبدء فقط في مرحلة التسجيل
  if (tournament.status !== 'registration') {
    return interaction.reply({
      content: `This tournament is currently **${tournament.status}**. You can only start it while status is \`registration\`.`,
      ephemeral: true,
    });
  }

  // لازم على الأقل 2 لاعبين / تيم
  if (!Array.isArray(tournament.players) || tournament.players.length < 2) {
    return interaction.reply({
      content: 'You need at least **2 players/teams** to start the tournament.',
      ephemeral: true,
    });
  }

  try {
    // نعمل نسخة من الليست عشان منلعبش في الأصل
    const shuffled = [...tournament.players];

    // Shuffle بسيط (Random seeding)
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    // نفضي أي ماتشات قديمة
    tournament.matches = [];
    tournament.currentRound = 1;

    // نعمل ماتشات Round 1
    await createRoundMatches(guild, tournament, 1, shuffled);

    // نغير حالة البطولة
    tournament.status = 'running';
    saveState();

    const lobbyChannel = guild.channels.cache.get(tournament.lobbyChannelId);
    if (lobbyChannel && lobbyChannel.isTextBased()) {
      await lobbyChannel.send(
        `🟢 **${tournament.name}** has started!\n` +
        `Total players/teams: **${tournament.players.length}**\n` +
        `Current round: **${tournament.currentRound}**.`
      );
    }

    await interaction.reply({
      content: `Tournament **${tournament.name}** has been started. Round 1 matches have been created.`,
      ephemeral: true,
    });

    try {
      await handleBracket(interaction);
    } catch (err) {
      console.error('Failed to send bracket after start:', err);
    }
  } catch (err) {
    console.error('Error in handleStartTournament:', err);
    return interaction.reply({
      content: 'Something went wrong while starting the tournament. Please check the bot console logs.',
      ephemeral: true,
    });
  }
}


async function handleAddPlayer(interaction) {
  const guild = interaction.guild;
  if (!guild) return;

  // permissions: Admin / ManageGuild
  const member = await guild.members.fetch(interaction.user.id);
  if (
    !member.permissions.has(PermissionsBitField.Flags.ManageGuild) &&
    !member.permissions.has(PermissionsBitField.Flags.Administrator)
  ) {
    return interaction.reply({
      content: 'You do not have permission to add players.',
      ephemeral: true,
    });
  }

  const tournament = tournaments.get(guild.id);
  if (!tournament) {
    return interaction.reply({
      content: 'No active tournament found in this server.',
      ephemeral: true,
    });
  }

  if (tournament.status !== 'registration') {
    return interaction.reply({
      content: 'You can only add players while registration is open.',
      ephemeral: true,
    });
  }

  const ign = interaction.options.getString('ign', true);
  const user = interaction.options.getUser('user');              // اختياري
  const whatsapp = interaction.options.getString('whatsapp') || 'Not provided';

   let playerId;
  if (user) {
    playerId = user.id;
  } else {
    playerId = `ext_${Date.now()}_${Math.floor(Math.random() * 999999)}`;
  }

  if (tournament.players.includes(playerId)) {
    return interaction.reply({
      content: 'This player is already registered in the tournament.',
      ephemeral: true,
    });
  }


  // نحفظ بياناته في playerProfiles عشان البراكت و الماتش تيكست
  playerProfiles.set(playerId, {
    ign,
    whatsapp,
  });

  tournament.players.push(playerId);
  saveState();

  const lobbyChannel = guild.channels.cache.get(tournament.lobbyChannelId);
  if (lobbyChannel && lobbyChannel.isTextBased()) {
    let msg = `Admin **${interaction.user.tag}** added **${ign}** to **${tournament.name}**.\n`;
    if (user) msg += `Discord: <@${user.id}>\n`;
    msg += `Total players: **${tournament.players.length}**`;
    lobbyChannel.send(msg);
  }

  await interaction.reply({
    content: `Player **${ign}** has been added to the tournament${user ? ` (linked to ${user.tag})` : ''}.`,
    ephemeral: true,
  });
}


async function handleSetWinner(interaction) {
  const guild = interaction.guild;
  if (!guild) return;

  const member = await guild.members.fetch(interaction.user.id);
  if (
    !member.permissions.has(PermissionsBitField.Flags.ManageGuild) &&
    !member.permissions.has(PermissionsBitField.Flags.Administrator)
  ) {
    return interaction.reply({
      content: 'You do not have permission to set match winners.',
      ephemeral: true,
    });
  }

  const channel = interaction.channel;
  if (!channel || !channel.isTextBased()) {
    return interaction.reply({
      content: 'This command must be used inside a match channel.',
      ephemeral: true,
    });
  }

  const matchId = matchChannels.get(channel.id);
  if (!matchId) {
    return interaction.reply({
      content: 'This channel is not linked to an active match.',
      ephemeral: true,
    });
  }

  const match = matches.get(matchId);
  if (!match) {
    return interaction.reply({
      content: 'Match data not found.',
      ephemeral: true,
    });
  }

  const winner = interaction.options.getUser('winner', true);

  if (winner.id !== match.player1Id && winner.id !== match.player2Id) {
    return interaction.reply({
      content: 'The selected winner is not one of the players/teams in this match.',
      ephemeral: true,
    });
  }

  if (match.status === 'completed') {
    return interaction.reply({
      content: 'This match is already completed.',
      ephemeral: true,
    });
  }

  match.status = 'completed';
  match.winnerId = winner.id;
  saveState();

  await interaction.reply(
    `Winner set for match \`${match.id}\`.\n` +
    `Winner: <@${winner.id}>.\n` +
    `Round: **${match.round}**.`
  );

  const tournament = tournaments.get(match.guildId);
  if (!tournament) return;

  await maybeAdvanceTournament(guild, tournament);
}

// Application portal setup
async function handleSetupEntry(interaction) {
  const guild = interaction.guild;
  if (!guild) return;

  const member = await guild.members.fetch(interaction.user.id);
  if (
    !member.permissions.has(PermissionsBitField.Flags.ManageGuild) &&
    !member.permissions.has(PermissionsBitField.Flags.Administrator)
  ) {
    return interaction.reply({
      content: 'You do not have permission to setup the entry portal.',
      ephemeral: true,
    });
  }

  const mode = interaction.options.getString('mode', true); // '1v1' or '5v5'
  const channel = interaction.options.getChannel('channel', true);
  const adminChannelOption = interaction.options.getChannel('admin_channel');
  const startTime = interaction.options.getString('start_time') || null;

  if (!channel.isTextBased()) {
    return interaction.reply({
      content: 'Public channel must be a text channel.',
      ephemeral: true,
    });
  }

  let adminChannel = adminChannelOption || channel;
  if (!adminChannel.isTextBased()) {
    adminChannel = channel;
  }

  const description1v1 =
    'To apply, press the **Apply** button and fill in the form.\n\n' +
    '**Required:**\n' +
    '• IGN (In-Game Name)\n\n' +
    '**Optional:**\n' +
    '• WhatsApp number\n\n' +
    'Press the red **Rules** button for full 1v1 rules.';

  const description5v5 =
    'To apply, press the **Apply** button and fill in the form.\n\n' +
    '**Required:**\n' +
    '• Team Name\n' +
    '• Team Leader IGN\n' +
    '• Team Leader WhatsApp\n' +
    '• 5 Players (IGN + WhatsApp, one per line)\n\n' +
    'Press the red **Rules** button for team rules.';

  const embed = new EmbedBuilder()
    .setTitle(`The Nexus Cup – ${mode.toUpperCase()} Applications`)
    .setDescription(mode === '1v1' ? description1v1 : description5v5)
    .setColor(0x00ff41);

  if (startTime) {
    embed.addFields({
      name: 'Tournament start time',
      value: startTime,
    });
  }

  const applyButton = new ButtonBuilder()
    .setCustomId(`apply:${mode}`)
    .setLabel('Apply')
    .setStyle(ButtonStyle.Success);

  const rulesButton = new ButtonBuilder()
    .setCustomId(`rules:${mode}`)
    .setLabel('Rules')
    .setStyle(ButtonStyle.Danger);

  const row = new ActionRowBuilder().addComponents(applyButton, rulesButton);

  await channel.send({ embeds: [embed], components: [row] });

  entryPortals.set(`${guild.id}:${mode}`, {
    publicChannelId: channel.id,
    adminChannelId: adminChannel.id,
    mode,
    startTime,
  });

  await interaction.reply({
    content: `Entry portal created in ${channel} for **${mode.toUpperCase()}**. Admin applications will be sent to ${adminChannel}.`,
    ephemeral: true,
  });
}

// ---------- APPLICATION MODALS & DECISIONS ----------

async function showApplicationModal(interaction, mode) {
  if (mode === '1v1') {
    const modal = new ModalBuilder()
      .setCustomId('applymodal:1v1')
      .setTitle('1v1 Tournament Application');

    const ignInput = new TextInputBuilder()
      .setCustomId('ign')
      .setLabel('IGN (In-Game Name)')
      .setPlaceholder('Your in-game name')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    const whatsappInput = new TextInputBuilder()
      .setCustomId('whatsapp')
      .setLabel('WhatsApp Number (optional)')
      .setPlaceholder('Optional contact number')
      .setStyle(TextInputStyle.Short)
      .setRequired(false);

    const row1 = new ActionRowBuilder().addComponents(ignInput);
    const row2 = new ActionRowBuilder().addComponents(whatsappInput);

    modal.addComponents(row1, row2);
    await interaction.showModal(modal);
    return;
  }

  if (mode === '5v5') {
    const modal = new ModalBuilder()
      .setCustomId('applymodal:5v5')
      .setTitle('5v5 Team Application');

    const teamNameInput = new TextInputBuilder()
      .setCustomId('team_name')
      .setLabel('Team Name')
      .setPlaceholder('Team name / اسم التيم')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    const leaderIgnInput = new TextInputBuilder()
      .setCustomId('leader_ign')
      .setLabel('Leader IGN')
      .setPlaceholder('Leader in-game name')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    const leaderWhatsappInput = new TextInputBuilder()
      .setCustomId('leader_whatsapp')
      .setLabel('Leader WhatsApp')
      .setPlaceholder('Leader WhatsApp number')
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    const playersInput = new TextInputBuilder()
      .setCustomId('players')
      .setLabel('Players (IGN – WhatsApp)')
      .setPlaceholder('5 lines: IGN – WhatsApp')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true);

    const row1 = new ActionRowBuilder().addComponents(teamNameInput);
    const row2 = new ActionRowBuilder().addComponents(leaderIgnInput);
    const row3 = new ActionRowBuilder().addComponents(leaderWhatsappInput);
    const row4 = new ActionRowBuilder().addComponents(playersInput);

    modal.addComponents(row1, row2, row3, row4);
    await interaction.showModal(modal);
    return;
  }
}

async function handleApplication1v1(interaction) {
  const ign = interaction.fields.getTextInputValue('ign');
  const whatsapp = interaction.fields.getTextInputValue('whatsapp') || 'Not provided';

  // store profile for bracket image (IGN)
  playerProfiles.set(interaction.user.id, {
    ign,
    whatsapp,
  });
  saveState();
  const summary = new EmbedBuilder()
    .setTitle('New 1v1 Application')
    .setColor(0x00ff41)
    .addFields(
      { name: 'Discord user', value: `<@${interaction.user.id}>`, inline: true },
      { name: 'IGN', value: ign, inline: true },
      { name: 'WhatsApp', value: whatsapp, inline: true },
    )
    .setTimestamp();

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`app_accept:1v1:${interaction.user.id}`)
      .setLabel('Accept')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`app_reject:1v1:${interaction.user.id}`)
      .setLabel('Reject')
      .setStyle(ButtonStyle.Danger),
  );

  const portal = entryPortals.get(`${interaction.guild.id}:1v1`);
  let targetChannel = interaction.channel;
  if (portal) {
    const ch = interaction.client.channels.cache.get(portal.adminChannelId);
    if (ch && ch.isTextBased()) targetChannel = ch;
  }

  if (targetChannel && targetChannel.isTextBased()) {
    await targetChannel.send({ embeds: [summary], components: [buttons] });
  }

  await interaction.reply({
    content: 'Your 1v1 application has been submitted.',
    ephemeral: true,
  });
}

async function handleApplication5v5(interaction) {
  const teamName = interaction.fields.getTextInputValue('team_name');
  const leaderIgn = interaction.fields.getTextInputValue('leader_ign');
  const leaderWhatsapp = interaction.fields.getTextInputValue('leader_whatsapp');
  const players = interaction.fields.getTextInputValue('players');

  // store team profile linked to leader (Discord user)
  teamProfiles.set(interaction.user.id, {
    teamName,
    leaderIgn,
    leaderWhatsapp,
    playersText: players,
  });
  saveState();

  const summary = new EmbedBuilder()
    .setTitle('New 5v5 Team Application')
    .setColor(0x00ff41)
    .addFields(
      { name: 'Team name', value: teamName, inline: true },
      { name: 'Leader (Discord)', value: `<@${interaction.user.id}>`, inline: true },
      { name: 'Leader IGN', value: leaderIgn, inline: true },
      { name: 'Leader WhatsApp', value: leaderWhatsapp, inline: true },
      { name: 'Players (IGN – WhatsApp)', value: '```' + players + '```' },
    )
    .setTimestamp();

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`app_accept:5v5:${interaction.user.id}`)
      .setLabel('Accept')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`app_reject:5v5:${interaction.user.id}`)
      .setLabel('Reject')
      .setStyle(ButtonStyle.Danger),
  );

  const portal = entryPortals.get(`${interaction.guild.id}:5v5`);
  let targetChannel = interaction.channel;
  if (portal) {
    const ch = interaction.client.channels.cache.get(portal.adminChannelId);
    if (ch && ch.isTextBased()) targetChannel = ch;
  }

  if (targetChannel && targetChannel.isTextBased()) {
    await targetChannel.send({ embeds: [summary], components: [buttons] });
  }

  await interaction.reply({
    content: 'Your 5v5 team application has been submitted.',
    ephemeral: true,
  });
}

async function handleApplicationDecision(interaction, { mode, targetId, isAccept }) {
  const guild = interaction.guild;
  if (!guild) {
    return interaction.reply({ content: 'This can only be used in a server.', ephemeral: true });
  }

  const member = await guild.members.fetch(interaction.user.id);
  if (
    !member.permissions.has(PermissionsBitField.Flags.ManageGuild) &&
    !member.permissions.has(PermissionsBitField.Flags.Administrator)
  ) {
    return interaction.reply({
      content: 'You do not have permission to accept or reject applications.',
      ephemeral: true,
    });
  }

  // Disable buttons on the message
  const msg = interaction.message;
  const components = msg.components.map(row => {
    const r = ActionRowBuilder.from(row);
    r.components = r.components.map(comp => {
      const b = ButtonBuilder.from(comp);
      b.setDisabled(true);
      return b;
    });
    return r;
  });

  const decisionText = isAccept ? '✅ Accepted' : '❌ Rejected';

  await interaction.update({
    content: decisionText + ' by ' + `<@${interaction.user.id}>`,
    components,
  });

  // DM the applicant
  try {
    const user = await client.users.fetch(targetId);
    if (isAccept) {
      await user.send(
        `Your application for **${mode.toUpperCase()}** tournament has been **ACCEPTED** on **${guild.name}**.`
      );
    } else {
      await user.send(
        `Your application for **${mode.toUpperCase()}** tournament has been **REJECTED** on **${guild.name}**.`
      );
    }
  } catch (e) {
    console.warn('Could not DM user about application decision:', e.message);
  }

  // For 1v1, if accepted and tournament is in registration, add to tournament players automatically
  if (isAccept && mode === '1v1') {
    const t = tournaments.get(guild.id);
    if (t && t.status === 'registration') {
      if (!t.players.includes(targetId)) {
        t.players.push(targetId);
        const lobbyChannel = guild.channels.cache.get(t.lobbyChannelId);
        if (lobbyChannel && lobbyChannel.isTextBased()) {
          lobbyChannel.send(
            `<@${targetId}> has been **accepted** into tournament **${t.name}**. ` +
            `Total players now: **${t.players.length}**`
          );
        }
      }
    }
  }

  // For 5v5 we now also auto-add the *team leader* as tournament participant.
  // The bracket image will display the **team name** instead of the player name.
  if (isAccept && mode === '5v5') {
    const t2 = tournaments.get(guild.id);
    if (t2 && t2.status === 'registration') {
      if (!t2.players.includes(targetId)) {
        t2.players.push(targetId);
        const lobbyChannel2 = guild.channels.cache.get(t2.lobbyChannelId);
        const teamProfile = teamProfiles.get(targetId);
        const label = teamProfile?.teamName || `<@${targetId}>`;
        if (lobbyChannel2 && lobbyChannel2.isTextBased()) {
          lobbyChannel2.send(
            `Team **${label}** has been **accepted** into tournament **${t2.name}**. ` +
            `Total teams/slots now: **${t2.players.length}**`
          );
        }
      }
    }
  }
}

// ---------- BRACKET HANDLERS ----------
async function handleBracket(interaction) {
  const guild = interaction.guild;
  if (!guild) {
    return interaction.reply({
      content: 'This command can only be used in a server.',
      ephemeral: true,
    });
  }

  const tournament = tournaments.get(guild.id);
  if (!tournament) {
    return interaction.reply({
      content: 'No active tournament found for this server.',
      ephemeral: true,
    });
  }

  // 1) لو فيه لينك ويب (Challonge مثلاً) نستخدمه ونرجع
  if (tournament.bracketUrl) {
    const embed = new EmbedBuilder()
      .setTitle(`${tournament.name} – Bracket`)
      .setDescription(
        [
          'Full interactive bracket is available on the website:',
          tournament.bracketUrl,
          '',
          'You can open it in your browser to see rounds, seeds, and final placements (1st / 2nd / 3rd).',
        ].join('\n')
      )
      .setColor(0x00ff41);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('Open bracket')
        .setStyle(ButtonStyle.Link)
        .setURL(tournament.bracketUrl),
    );

    return interaction.reply({
      embeds: [embed],
      components: [row],
    });
  }

  // 2) لو مفيش لينك متسجل، نرجع للنظام القديم (صورة PNG) كـ fallback
  await interaction.deferReply();

  const buffer = await renderBracketImage(
    guild,
    tournament,
    matches,
    playerProfiles,
    teamProfiles,
  );
  const attachment = new AttachmentBuilder(buffer, {
    name: 'bracket.png',
  });

  const embed = new EmbedBuilder()
    .setTitle(`${tournament.name} – Current Bracket`)
    .setColor(0x00ff41)
    .setImage('attachment://bracket.png');

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('bracket_refresh')
      .setLabel('Refresh bracket')
      .setStyle(ButtonStyle.Primary),
  );

  await interaction.editReply({
    embeds: [embed],
    files: [attachment],
    components: [row],
  });
}


// ---------- TOURNAMENT HELPERS ----------

async function createRoundMatches(guild, tournament, round, playerIds) {
  const category = guild.channels.cache.get(tournament.categoryId);
  if (!category || category.type !== ChannelType.GuildCategory) {
    throw new Error('Tournament category missing.');
  }

  const playersCount = playerIds.length;
  let matchIndex = 1;

  // Create category per round for better organization
  const roundCategory = await guild.channels.create({
    name: `🏆 ${tournament.name} – Round ${round}`,
    type: ChannelType.GuildCategory,
  });

  for (let i = 0; i < playersCount; i += 2) {
    const p1 = playerIds[i];
    const p2 = playerIds[i + 1];

    const matchId = `${tournament.shortCode}-R${round}-M${matchIndex}`;
    matchIndex++;

    const match = {
      id: matchId,
      guildId: guild.id,
      tournamentId: tournament.id,
      round,
      player1Id: p1,
      player2Id: p2 || null,
      channelId: null,
      status: 'pending',
      winnerId: null,
    };

    // ----- BYE CASE -----
    if (!p2) {
      match.status = 'completed';
      match.winnerId = p1;
      matches.set(matchId, match);
      tournament.matches.push(matchId);

      const lobbyChannel = guild.channels.cache.get(tournament.lobbyChannelId);
      if (lobbyChannel && lobbyChannel.isTextBased()) {
        const p1Profile = playerProfiles.get(p1);
        const p1Team = teamProfiles.get(p1);

        // نحدد اللابل: اسم تيم > IGN > منشن لو موجود > "Unknown"
        let label =
          p1Team?.teamName ||
          (p1Profile?.ign || null);

        if (!label) {
          const member = await guild.members.fetch(p1).catch(() => null);
          label = member ? member.displayName : 'Unknown player';
        }

        lobbyChannel.send(
          `**${label}** gets a **bye** in Round ${round} and automatically advances.`
        );
      }
      continue;
    }

    // ----- PERMISSIONS OVERWRITES -----
    const overwrites = [
      {
        id: guild.roles.everyone.id,
        deny: [PermissionsBitField.Flags.ViewChannel],
      },
      {
        id: client.user.id,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
        ],
      },
    ];

    // نضيف p1 لو هو عضو في السيرفر
    const p1Member = await guild.members.fetch(p1).catch(() => null);
    if (p1Member) {
      overwrites.push({
        id: p1,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
        ],
      });
    }

    // نضيف p2 لو موجود وعضو
    const p2Member = await guild.members.fetch(p2).catch(() => null);
    if (p2Member) {
      overwrites.push({
        id: p2,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
        ],
      });
    }

    const channel = await guild.channels.create({
      name: `match-r${round}-m${matchIndex - 1}`,
      type: ChannelType.GuildText,
      parent: roundCategory.id,
      permissionOverwrites: overwrites,
    });

    match.channelId = channel.id;
    matches.set(matchId, match);
    tournament.matches.push(matchId);
    matchChannels.set(channel.id, matchId);
  saveState();

    // ---------- NICE LABELS FOR MESSAGE ----------
    const p1Profile = playerProfiles.get(p1);
    const p2Profile = playerProfiles.get(p2);

    const p1Team = teamProfiles.get(p1);
    const p2Team = teamProfiles.get(p2);

    // p1 label
    let p1Label = p1Team?.teamName || p1Profile?.ign || null;
    if (!p1Label) {
      const m = p1Member || (await guild.members.fetch(p1).catch(() => null));
      p1Label = m ? m.displayName : 'Unknown player';
    }
    const p1Mention = p1Member ? ` (<@${p1}>)` : '';

    // p2 label
    let p2Label = p2Team?.teamName || p2Profile?.ign || null;
    if (!p2Label) {
      const m = p2Member || (await guild.members.fetch(p2).catch(() => null));
      p2Label = m ? m.displayName : 'Unknown player';
    }
    const p2Mention = p2Member ? ` (<@${p2}>)` : '';

    await channel.send(
      `Match ticket for tournament **${tournament.name}**.\n` +
      `Match ID: \`${match.id}\`\n` +
      `Round: **${round}**\n` +
      `Players/Teams: **${p1Label}**${p1Mention} vs **${p2Label}**${p2Mention}\n\n` +
      `Total players in this tournament: **${tournament.players.length}**\n\n` +
      `Flow:\n` +
      `1. Play your match (Best of **${tournament.bestOf}**).\n` +
      `2. Post the **screenshot** of the result in this channel.\n` +
      `3. The bot will ping **@everyone** when a screenshot is posted.\n` +
      `4. Admins will review and use \`/set-winner\` here to set the final winner.`
    );
  }
}


async function maybeAdvanceTournament(guild, tournament) {
  const currentRound = tournament.currentRound;

  const roundMatches = tournament.matches
    .map(id => matches.get(id))
    .filter(m => m && m.round === currentRound);

  if (roundMatches.length === 0) return;

  const anyPending = roundMatches.some(m => m.status !== 'completed');
  if (anyPending) return;

  const winners = roundMatches.map(m => m.winnerId).filter(Boolean);

  if (winners.length <= 1) {
    tournament.status = 'completed';

    const championId = winners[0] || roundMatches[0]?.winnerId;
    const lobbyChannel = guild.channels.cache.get(tournament.lobbyChannelId);

    const teamProfile = teamProfiles.get(championId);
    const label = teamProfile?.teamName || `<@${championId}>`;

    if (lobbyChannel && lobbyChannel.isTextBased()) {
      lobbyChannel.send(
        `🏆 Tournament **${tournament.name}** has finished!\n` +
        `Champion: ${label}`
      );
    }
    return;
  }

  tournament.currentRound += 1;

  const lobbyChannel = guild.channels.cache.get(tournament.lobbyChannelId);
  if (lobbyChannel && lobbyChannel.isTextBased()) {
    const winnerLabels = winners.map(id => {
      const tp = teamProfiles.get(id);
      return tp?.teamName || `<@${id}>`;
    });

    lobbyChannel.send(
      `Round **${tournament.currentRound}** is starting.\n` +
      `Qualified players/teams: ${winnerLabels.join(', ')}`
    );
  }

  await createRoundMatches(guild, tournament, tournament.currentRound, winners);
}
// ---------- PERSISTENCE HELPERS (JSON on disk) ----------

function mapToObject(map) {
  const obj = {};
  for (const [k, v] of map.entries()) {
    obj[k] = v;
  }
  return obj;
}

function objectToMap(obj) {
  const map = new Map();
  if (!obj) return map;
  for (const [k, v] of Object.entries(obj)) {
    map.set(k, v);
  }
  return map;
}

function saveState() {
  try {
    const data = {
      tournaments: mapToObject(tournaments),
      matches: mapToObject(matches),
      matchChannels: mapToObject(matchChannels),
      entryPortals: mapToObject(entryPortals),
      playerProfiles: mapToObject(playerProfiles),
      teamProfiles: mapToObject(teamProfiles),
    };

    fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2), 'utf8');
    // console.log('State saved to disk.');
  } catch (err) {
    console.error('Failed to save state:', err);
  }
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;

    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    if (!raw) return;
    const data = JSON.parse(raw);

    if (data.tournaments) {
      const loaded = objectToMap(data.tournaments);
      tournaments.clear();
      for (const [k, v] of loaded) tournaments.set(k, v);
    }

    if (data.matches) {
      const loaded = objectToMap(data.matches);
      matches.clear();
      for (const [k, v] of loaded) matches.set(k, v);
    }

    if (data.matchChannels) {
      const loaded = objectToMap(data.matchChannels);
      matchChannels.clear();
      for (const [k, v] of loaded) matchChannels.set(k, v);
    }

    if (data.entryPortals) {
      const loaded = objectToMap(data.entryPortals);
      entryPortals.clear();
      for (const [k, v] of loaded) entryPortals.set(k, v);
    }

    if (data.playerProfiles) {
      const loaded = objectToMap(data.playerProfiles);
      playerProfiles.clear();
      for (const [k, v] of loaded) playerProfiles.set(k, v);
    }

    if (data.teamProfiles) {
      const loaded = objectToMap(data.teamProfiles);
      teamProfiles.clear();
      for (const [k, v] of loaded) teamProfiles.set(k, v);
    }

    console.log('State loaded from disk.');
  } catch (err) {
    console.error('Failed to load state:', err);
  }
}

// ---------- RULES TEXT ----------

function getRules1v1() {
  return (
    '## 🔥 1v1 Rules / قوانين البطولة 1v1\n\n' +
    '**Winner is / الفائز هو:**\n' +
    '- Most **Kills** at **10:00** minutes – الأكثر Kills بعد 10 دقايق\n' +
    '- **Mid lane ONLY** – اللعب هيكون ميد لين فقط\n' +
    '- If tie at 10:00 → first kill **after 10:00** wins – في حالة التعادل أول Kill بعد الدقيقة 10 هو الفائز\n' +
    '- Or surrender from one player – أو الاستسلام من أحد اللاعبين\n' +
    '- Or destroying the enemy **Nexus** – أو تدمير الـ Nexus\n\n' +
    '**🚫 Forbidden / ممنوعات مهمة:**\n' +
    '- No Jungle at all – ممنوع دخول الجانجل نهائيًا\n' +
    '- No River – ممنوع دخول النهر (River)\n' +
    '- No farming any other lane – ممنوع فارم أي لين تاني\n' +
    '- No jungle/river farm – ممنوع تجمع فارم من Jungle أو River بأي شكل\n' +
    '- No Toxic / flame / insults – ممنوع Toxic / سب / شتائم\n' +
    '- No Mastery / Emote spam – ممنوع رفع Mastery أو Spam Emotes\n\n' +
    '➡️ **Any rule break = instant loss / أي مخالفة = خسارة مباشرة!!**\n\n' +
    '**Remake / إعادة الماتش:**\n' +
    '- Admins can remake only if there is **server issue** or **net issue**\n' +
    '- لازم المشكلة تكون مثبتة بفيديو أو Screenshot.'
  );
}

function getRules5v5() {
  return (
    '## 🛡️ 5v5 Team Rules\n\n' +
    '- No special in-game rules (normal competitive match).\n' +
    '- **No remakes** by default.\n' +
    '- The whole team must be ready **before match time**.\n' +
    '- If any player is late more than **15 minutes** after scheduled time → match is counted as a **loss** for that team.\n' +
    '- Follow staff/admin instructions in match channels at all times.'
  );
}

client.login(process.env.DISCORD_TOKEN);
