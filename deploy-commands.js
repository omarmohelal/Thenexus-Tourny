// deploy-commands.js
require('dotenv/config');
const {
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
} = require('discord.js');

const commands = [];

// /create-tournament
commands.push(
  new SlashCommandBuilder()
    .setName('create-tournament')
    .setDescription('Create a new tournament for this server.')
    .addStringOption(opt =>
      opt
        .setName('name')
        .setDescription('Tournament name')
        .setRequired(true),
    )
    .addIntegerOption(opt =>
      opt
        .setName('best_of')
        .setDescription('Best of how many games? (odd number: 1, 3, 5, ...)')
        .setRequired(true),
    )
    .addBooleanOption(opt =>
  opt
    .setName('link_challonge')
    .setDescription('Create & link a Challonge bracket automatically?')
    .setRequired(false)
)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
);

// /tournament-info
commands.push(
  new SlashCommandBuilder()
    .setName('tournament-info')
    .setDescription('Show current tournament info.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
);

// /start-tournament
commands.push(
  new SlashCommandBuilder()
    .setName('start-tournament')
    .setDescription('Start the current tournament (create round 1 matches).')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
);

// /set-winner
commands.push(
  new SlashCommandBuilder()
    .setName('set-winner')
    .setDescription('Set the winner for a match (use inside the match channel).')
    .addUserOption(opt =>
      opt
        .setName('winner')
        .setDescription('Player or team leader who won this match.')
        .setRequired(true),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
);
  // /export-participants
commands.push(
  new SlashCommandBuilder()
    .setName('export-participants')
    .setDescription('Export current tournament participants for Challonge bulk add.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
);
// /setup-entry
commands.push(
  new SlashCommandBuilder()
    .setName('setup-entry')
    .setDescription('Create an application portal (Apply + Rules) for 1v1 or 5v5.')
    .addStringOption(opt =>
      opt
        .setName('mode')
        .setDescription('Tournament mode')
        .setRequired(true)
        .addChoices(
          { name: '1v1', value: '1v1' },
          { name: '5v5', value: '5v5' },
        ),
    )
    .addChannelOption(opt =>
      opt
        .setName('channel')
        .setDescription('Public channel where players see the Apply & Rules buttons.')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true),
    )
    .addChannelOption(opt =>
      opt
        .setName('admin_channel')
        .setDescription('Admin-only channel where applications (Accept/Reject) will go.')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(false),
    )
    .addStringOption(opt =>
      opt
        .setName('start_time')
        .setDescription('Tournament start time to display (e.g. "5 Dec 2025 – 20:00 GMT+3").')
        .setRequired(false),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
);

// /bracket
commands.push(
  new SlashCommandBuilder()
    .setName('bracket')
    .setDescription('Render and show the current tournament bracket as PNG.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
);
commands.push(
  new SlashCommandBuilder()
    .setName('set-bracket-link')
    .setDescription('Attach a Challonge / website bracket URL to the current tournament.')
    .addStringOption(opt =>
      opt
        .setName('url')
        .setDescription('Full bracket URL, e.g. https://thenexus.challonge.com/TheNexusCup')
        .setRequired(true),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
);
// /add-player  (admin only)
commands.push(
  new SlashCommandBuilder()
    .setName('add-player')
    .setDescription('Manually add a player to the current tournament.')
    .addStringOption(opt =>
      opt.setName('ign')
        .setDescription('In-game name (required)')
        .setRequired(true),
    )
    .addUserOption(opt =>
      opt.setName('user')
        .setDescription('Discord user (optional)'),
    )
    .addStringOption(opt =>
      opt.setName('whatsapp')
        .setDescription('WhatsApp number (optional)'),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
);

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    if (!process.env.CLIENT_ID || !process.env.GUILD_ID) {
      console.error('Missing CLIENT_ID or GUILD_ID in .env');
      process.exit(1);
    }

    console.log('Started refreshing application (/) commands...');

    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands.map(c => c.toJSON()) },
    );

    console.log('Successfully reloaded application (/) commands.');
  } catch (error) {
    console.error(error);
  }
})();
