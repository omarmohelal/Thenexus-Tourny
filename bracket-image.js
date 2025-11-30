// bracket-image.js
// Renders a tournament bracket similar to Challonge + final results panel (1st / 2nd / 3rd)

const { createCanvas } = require('canvas');

/**
 * @param {import('discord.js').Guild} guild
 * @param {Object} tournament
 * @param {Map<string, Object>} matches
 * @param {Map<string, Object>} playerProfiles
 * @param {Map<string, Object>} teamProfiles
 */
async function renderBracketImage(guild, tournament, matches, playerProfiles, teamProfiles) {
  // Collect matches for this tournament
  const allMatches = [];
  for (const m of matches.values()) {
    if (m && m.tournamentId === tournament.id) {
      allMatches.push(m);
    }
  }

  // If no matches yet, show simple placeholder
  if (allMatches.length === 0) {
    const canvas = createCanvas(900, 500);
    const ctx = canvas.getContext('2d');

    drawBackground(ctx, canvas.width, canvas.height);

    ctx.fillStyle = '#e5e7eb';
    ctx.font = '30px sans-serif';
    ctx.fillText('No matches created yet.', 60, 260);

    return canvas.toBuffer('image/png');
  }

  // Group matches by round
  const roundsMap = new Map();
  for (const m of allMatches) {
    if (!roundsMap.has(m.round)) roundsMap.set(m.round, []);
    roundsMap.get(m.round).push(m);
  }

  const rounds = Array.from(roundsMap.keys()).sort((a, b) => a - b);

  const matchesPerRound = rounds.map(r => roundsMap.get(r).length);
  const maxMatchesInAnyRound = Math.max(...matchesPerRound);

  // Layout constants
  const colWidth = 260;
  const rowHeight = 120;

  const marginX = 60;
  const marginTop = 110;          // space for title
  const marginY = 60;

  const baseWidth = marginX * 2 + colWidth * rounds.length;
  const baseHeight = marginY * 2 + rowHeight * maxMatchesInAnyRound;

  // Extra height for final results panel
  const showWinnersPanel = tournament.status === 'completed';
  const winnersPanelHeight = showWinnersPanel ? 150 : 0;

  const width = baseWidth;
  const height = baseHeight + winnersPanelHeight;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  drawBackground(ctx, width, height);

  // ---------- Title ----------
  ctx.fillStyle = '#22c55e';
  ctx.font = '30px sans-serif';
  ctx.fillText(tournament.name || 'The Nexus Tournament', marginX, 50);

  ctx.fillStyle = '#9ca3af';
  ctx.font = '17px sans-serif';
  ctx.fillText(
    `Best of ${tournament.bestOf} • Current round: ${tournament.currentRound}`,
    marginX,
    80
  );

  // Helper: get nice label for a player or a team
  async function getLabelForId(id) {
    if (!id) return 'TBD';

    // If team profile exists -> team name
    const team = teamProfiles.get(id);
    if (team && team.teamName) return team.teamName;

    const profile = playerProfiles.get(id);
    if (profile && profile.ign) return profile.ign;

    try {
      const member = await guild.members.fetch(id);
      return member.displayName || member.user.username;
    } catch {
      return 'Unknown';
    }
  }

  // ---------- Draw bracket per round ----------
  for (let colIndex = 0; colIndex < rounds.length; colIndex++) {
    const roundNumber = rounds[colIndex];
    const list = roundsMap.get(roundNumber) || [];
    const colX = marginX + colIndex * colWidth;

    // Round header
    ctx.fillStyle = '#fbbf24';
    ctx.font = '20px sans-serif';
    ctx.fillText(`Round ${roundNumber}`, colX, marginTop - 25);

    for (let i = 0; i < list.length; i++) {
      const m = list[i];

      const boxX = colX;
      const boxY = marginTop + marginY + i * rowHeight;

      const boxWidth = colWidth - 40;
      const boxHeight = rowHeight - 40;

      // Card background
      drawMatchCard(ctx, boxX, boxY, boxWidth, boxHeight, m);

      // Labels
      const p1Label = await getLabelForId(m.player1Id);
      const p2Label = m.player2Id ? await getLabelForId(m.player2Id) : 'BYE';

      const innerPad = 12;
      let textX = boxX + innerPad;
      let textY = boxY + innerPad + 4;

      ctx.fillStyle = '#e5e7eb';
      ctx.font = '13px sans-serif';
      ctx.fillText(`Match: ${m.id}`, textX, textY);

      textY += 20;
      ctx.font = '14px sans-serif';
      ctx.fillStyle = m.winnerId === m.player1Id ? '#22c55e' : '#e5e7eb';
      ctx.fillText(p1Label, textX, textY);

      textY += 20;
      ctx.fillStyle =
        m.player2Id && m.winnerId === m.player2Id ? '#22c55e' : '#e5e7eb';
      ctx.fillText(p2Label, textX, textY);

      textY += 22;
      ctx.fillStyle = '#9ca3af';
      ctx.font = '12px sans-serif';
      ctx.fillText(`Status: ${m.status}`, textX, textY);

      // Connector line to next column
      if (colIndex < rounds.length - 1) {
        const nextColX = marginX + (colIndex + 1) * colWidth;
        const fromX = boxX + boxWidth;
        const fromY = boxY + boxHeight / 2;

        ctx.strokeStyle = '#4b5563';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(fromX, fromY);
        ctx.lineTo(nextColX - 25, fromY);
        ctx.stroke();
      }
    }
  }

  // ---------- Winners panel (1st / 2nd / 3rd) ----------
  if (showWinnersPanel) {
    await drawWinnersPanel(ctx, {
      canvasWidth: width,
      canvasHeight: height,
      panelHeight: winnersPanelHeight,
      marginX,
      tournament,
      rounds,
      roundsMap,
      getLabelForId,
    });
  }

  return canvas.toBuffer('image/png');
}

function drawBackground(ctx, width, height) {
  // dark gradient background like esports panels
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, '#020617'); // slate-950
  gradient.addColorStop(1, '#020617');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
}

// Draw single match card
function drawMatchCard(ctx, x, y, w, h, match) {
  ctx.save();

  // card background
  ctx.fillStyle = '#020617';
  ctx.strokeStyle = '#4b5563';
  ctx.lineWidth = 2;
  roundRect(ctx, x, y, w, h, 12);
  ctx.fill();
  ctx.stroke();

  // highlight border if completed
  if (match.status === 'completed') {
    ctx.strokeStyle = '#22c55e';
    ctx.lineWidth = 3;
    roundRect(ctx, x - 2, y - 2, w + 4, h + 4, 14);
    ctx.stroke();
  }

  ctx.restore();
}

// Draw rounded rect helper
function roundRect(ctx, x, y, width, height, radius) {
  if (typeof radius === 'number') {
    radius = { tl: radius, tr: radius, br: radius, bl: radius };
  } else {
    radius = Object.assign(
      { tl: 0, tr: 0, br: 0, bl: 0 },
      radius
    );
  }
  ctx.beginPath();
  ctx.moveTo(x + radius.tl, y);
  ctx.lineTo(x + width - radius.tr, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius.tr);
  ctx.lineTo(x + width, y + height - radius.br);
  ctx.quadraticCurveTo(
    x + width,
    y + height,
    x + width - radius.br,
    y + height
  );
  ctx.lineTo(x + radius.bl, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius.bl);
  ctx.lineTo(x, y + radius.tl);
  ctx.quadraticCurveTo(x, y, x + radius.tl, y);
  ctx.closePath();
}

/**
 * Draws final results panel (1st / 2nd / 3rd) at the bottom of the canvas.
 */
async function drawWinnersPanel(
  ctx,
  {
    canvasWidth,
    canvasHeight,
    panelHeight,
    marginX,
    tournament,
    rounds,
    roundsMap,
    getLabelForId,
  }
) {
  if (!rounds.length) return;

  const finalRound = Math.max(...rounds);
  const finalMatches = roundsMap.get(finalRound) || [];
  const finalMatch = finalMatches.find(m => m.status === 'completed');

  if (!finalMatch || !finalMatch.winnerId || !finalMatch.player1Id || !finalMatch.player2Id) {
    return;
  }

  const championId = finalMatch.winnerId;
  const runnerUpId =
    finalMatch.winnerId === finalMatch.player1Id
      ? finalMatch.player2Id
      : finalMatch.player1Id;

  // Determine 3rd place: losers of semi-finals
  const semiRound = finalRound - 1;
  const semiMatches = roundsMap.get(semiRound) || [];
  const thirdCandidates = [];

  for (const m of semiMatches) {
    if (m.status !== 'completed') continue;
    if (!m.winnerId || !m.player1Id || !m.player2Id) continue;
    const loserId = m.winnerId === m.player1Id ? m.player2Id : m.player1Id;
    if (loserId) thirdCandidates.push(loserId);
  }

  const panelY = canvasHeight - panelHeight + 20;
  const boxWidth = canvasWidth - marginX * 2;

  // Panel background
  ctx.save();
  ctx.fillStyle = '#020617';
  ctx.strokeStyle = '#4b5563';
  ctx.lineWidth = 2;
  roundRect(ctx, marginX, panelY, boxWidth, panelHeight - 40, 16);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#e5e7eb';
  ctx.font = '18px sans-serif';
  ctx.fillText('Final Results', marginX + 20, panelY + 28);

  // Columns (1st / 2nd / 3rd)
  const innerX = marginX + 20;
  const innerY = panelY + 50;
  const colGap = 30;
  const colWidth = (boxWidth - 40 - colGap * 2) / 3;

  const championLabel = await getLabelForId(championId);
  const runnerLabel = await getLabelForId(runnerUpId);

  // FIRST
  drawResultColumn(ctx, {
    x: innerX,
    y: innerY,
    width: colWidth,
    title: '1st Place',
    color: '#facc15',
    nameLines: [championLabel],
  });

  // SECOND
  drawResultColumn(ctx, {
    x: innerX + colWidth + colGap,
    y: innerY,
    width: colWidth,
    title: '2nd Place',
    color: '#e5e7eb',
    nameLines: [runnerLabel],
  });

  // THIRD (can be 1 or 2 players)
  const thirdNames = [];
  for (const id of thirdCandidates) {
    thirdNames.push(await getLabelForId(id));
  }
  if (!thirdNames.length) thirdNames.push('—');

  drawResultColumn(ctx, {
    x: innerX + (colWidth + colGap) * 2,
    y: innerY,
    width: colWidth,
    title: '3rd Place',
    color: '#f97316',
    nameLines: thirdNames,
  });

  ctx.restore();
}

function drawResultColumn(ctx, { x, y, width, title, color, nameLines }) {
  ctx.save();

  // Small top bar with color
  ctx.fillStyle = color;
  roundRect(ctx, x, y, width, 8, 6);
  ctx.fill();

  ctx.fillStyle = '#e5e7eb';
  ctx.font = '15px sans-serif';
  ctx.fillText(title, x, y + 28);

  ctx.font = '14px sans-serif';
  let lineY = y + 50;
  for (const line of nameLines) {
    ctx.fillText(line, x, lineY);
    lineY += 20;
  }

  ctx.restore();
}

module.exports = { renderBracketImage };
