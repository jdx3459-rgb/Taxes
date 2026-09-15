import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import crypto from 'node:crypto';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);
const PORT = Number(process.env.PORT || 3000);
const ROOM_PASSWORD = process.env.ROOM_PASSWORD;
const ROOM = 'main-table';
const SMALL_BLIND = 10;
const BIG_BLIND = 20;
const STARTING_STACK = 1000;

if (!ROOM_PASSWORD) {
  throw new Error('ROOM_PASSWORD is required. Set it in your environment before starting the server.');
}

app.use(express.static('public'));
app.get('/health', (_req, res) => res.json({ ok: true }));

const suits = ['♠', '♥', '♦', '♣'];
const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const rankValue = Object.fromEntries(ranks.map((rank, i) => [rank, i + 2]));

const game = {
  seats: Array(6).fill(null),
  watchers: new Map(),
  dealer: -1,
  hand: null,
  handNumber: 0,
  hostId: null
};

function makeDeck() {
  const deck = suits.flatMap(suit => ranks.map(rank => ({ rank, suit })));
  for (let index = deck.length - 1; index > 0; index--) {
    const swapIndex = crypto.randomInt(index + 1);
    [deck[index], deck[swapIndex]] = [deck[swapIndex], deck[index]];
  }
  return deck;
}

function cardLabel(card) { return `${card.rank}${card.suit}`; }
function nextSeat(from, predicate = () => true) {
  for (let offset = 1; offset <= 6; offset++) {
    const index = (from + offset + 6) % 6;
    if (game.seats[index] && predicate(game.seats[index], index)) return index;
  }
  return -1;
}
function playersInHand() { return game.seats.filter(player => player?.inHand); }
function activePlayers() { return playersInHand().filter(player => !player.folded); }
function toCall(player) { return Math.max(0, game.hand.currentBet - player.streetBet); }
function totalPot() { return (game.hand?.deadPot || 0) + playersInHand().reduce((sum, player) => sum + player.totalBet, 0); }
function handInProgress() { return Boolean(game.hand && game.hand.phase !== 'complete'); }
function seatedPlayers() { return game.seats.filter(player => player && player.chips > 0); }

function evaluateFive(cards) {
  const values = cards.map(c => rankValue[c.rank]).sort((a, b) => b - a);
  const counts = new Map();
  values.forEach(v => counts.set(v, (counts.get(v) || 0) + 1));
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const flush = cards.every(c => c.suit === cards[0].suit);
  const unique = [...new Set(values)].sort((a, b) => b - a);
  const straightHigh = unique.length === 5 && (unique[0] - unique[4] === 4 ? unique[0] : (unique.join(',') === '14,5,4,3,2' ? 5 : 0));
  const score = (kind, tie) => [kind, ...tie];
  if (flush && straightHigh) return score(8, [straightHigh]);
  if (groups[0][1] === 4) return score(7, [groups[0][0], groups[1][0]]);
  if (groups[0][1] === 3 && groups[1][1] === 2) return score(6, [groups[0][0], groups[1][0]]);
  if (flush) return score(5, values);
  if (straightHigh) return score(4, [straightHigh]);
  if (groups[0][1] === 3) return score(3, [groups[0][0], ...groups.slice(1).map(g => g[0])]);
  if (groups[0][1] === 2 && groups[1][1] === 2) return score(2, [Math.max(groups[0][0], groups[1][0]), Math.min(groups[0][0], groups[1][0]), groups[2][0]]);
  if (groups[0][1] === 2) return score(1, [groups[0][0], ...groups.slice(1).map(g => g[0])]);
  return score(0, values);
}
function compareScore(a, b) { for (let i = 0; i < a.length; i++) { if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0); } return 0; }
function bestHand(cards) {
  let best = null;
  for (let a = 0; a < 7; a++) for (let b = a + 1; b < 7; b++) {
    const five = cards.filter((_c, index) => index !== a && index !== b);
    const score = evaluateFive(five);
    if (!best || compareScore(score, best.score) > 0) best = { score, cards: five };
  }
  return best;
}
function handName(score) { return ['高牌', '一对', '两对', '三条', '顺子', '同花', '葫芦', '四条', '同花顺'][score[0]]; }

function publicState(viewerId) {
  const revealAll = game.hand?.phase === 'showdown' || game.hand?.phase === 'complete';
  return {
    seats: game.seats.map((player, seat) => player && ({
      id: player.id, name: player.name, chips: player.chips, seat, inHand: player.inHand, ready: player.ready, queued: player.queued,
      folded: player.folded, allIn: player.allIn, streetBet: player.streetBet,
      cards: (player.id === viewerId || revealAll) && player.cards ? player.cards.map(cardLabel) : null
    })),
    watcherCount: game.watchers.size,
    leaderboard: game.seats.filter(Boolean).sort((a, b) => b.chips - a.chips).map((player, index) => ({ rank: index + 1, name: player.name, chips: player.chips, id: player.id })),
    hostId: game.hostId,
    hand: game.hand && {
      phase: game.hand.phase, board: game.hand.board.map(cardLabel), pot: game.hand.settledPot ?? totalPot(), dealer: game.dealer,
      currentTurn: game.hand.currentTurn, currentBet: game.hand.currentBet, minRaise: game.hand.minRaise,
      message: game.hand.message, winners: game.hand.winners
    },
    you: game.seats.find(player => player?.id === viewerId) ? (() => {
      const player = game.seats.find(p => p?.id === viewerId);
      return { seated: true, seat: game.seats.findIndex(p => p?.id === viewerId), ready: player.ready, inHand: player.inHand, queued: player.queued, chips: player.chips };
    })() : { seated: false }
  };
}
function broadcast() { for (const socket of io.in(ROOM).sockets.values()) socket.emit('state', publicState(socket.id)); }
function announce(message) { if (game.hand) game.hand.message = message; broadcast(); }
function resetStreet() { playersInHand().forEach(player => { player.streetBet = 0; player.acted = false; }); game.hand.currentBet = 0; game.hand.minRaise = BIG_BLIND; }
function dealBoard(count) { game.hand.board.push(...game.hand.deck.splice(0, count)); }
function takeChips(player, amount) { const paid = Math.min(player.chips, Math.max(0, amount)); player.chips -= paid; player.streetBet += paid; player.totalBet += paid; if (player.chips === 0) player.allIn = true; return paid; }
function eligibleTurn(from) { return nextSeat(from, player => player.inHand && !player.folded && !player.allIn); }
function bettingComplete() {
  const contenders = activePlayers();
  return contenders.length <= 1 || contenders.every(player => player.allIn || (player.acted && player.streetBet === game.hand.currentBet));
}
function finishHand(message) {
  const alive = activePlayers();
  const pot = totalPot();
  game.hand.settledPot = pot;
  if (alive.length === 1) {
    alive[0].chips += pot;
    game.hand.winners = [{ id: alive[0].id, name: alive[0].name, amount: pot, label: '其余玩家弃牌' }];
  } else {
    while (game.hand.board.length < 5) dealBoard(1);
    const rated = alive.map(player => ({ player, result: bestHand([...player.cards, ...game.hand.board]) }));
    const top = rated.reduce((best, item) => !best || compareScore(item.result.score, best.result.score) > 0 ? item : best, null);
    const winners = rated.filter(item => compareScore(item.result.score, top.result.score) === 0);
    const share = Math.floor(pot / winners.length);
    let remainder = pot % winners.length;
    game.hand.winners = winners.map(item => ({ id: item.player.id, name: item.player.name, amount: share + (remainder-- > 0 ? 1 : 0), label: handName(item.result.score) }));
    game.hand.winners.forEach(winner => { const player = game.seats.find(p => p?.id === winner.id); player.chips += winner.amount; });
  }
  game.hand.phase = 'complete'; game.hand.currentTurn = -1; game.hand.message = message || '本手结束';
  playersInHand().forEach(player => { player.inHand = false; player.ready = false; player.folded = false; player.allIn = false; player.streetBet = 0; player.totalBet = 0; });
  game.seats.filter(Boolean).forEach(player => { player.queued = false; });
  broadcast();
}
function advancePhase() {
  if (activePlayers().length <= 1) return finishHand();
  const phases = ['preflop', 'flop', 'turn', 'river'];
  const current = phases.indexOf(game.hand.phase);
  if (current === 3) return finishHand('摊牌，底池已分配');
  game.hand.phase = phases[current + 1];
  dealBoard(current === 0 ? 3 : 1); resetStreet();
  game.hand.currentTurn = eligibleTurn(game.dealer);
  if (game.hand.currentTurn === -1) return advancePhase();
  game.hand.message = `${['翻牌', '转牌', '河牌'][current]}圈开始`;
  broadcast();
}
function moveForward(fromSeat) { if (bettingComplete()) return advancePhase(); game.hand.currentTurn = eligibleTurn(fromSeat); broadcast(); }

function startHand() {
  const ready = seatedPlayers();
  if (ready.length < 2) return;
  game.dealer = nextSeat(game.dealer, player => player.chips > 0);
  const deck = makeDeck();
  game.seats.forEach(player => { if (player) Object.assign(player, { inHand: player.ready && player.chips > 0, ready: false, queued: false, folded: false, allIn: false, cards: player.ready && player.chips > 0 ? [deck.pop(), deck.pop()] : [], streetBet: 0, totalBet: 0, acted: false }); });
  const small = nextSeat(game.dealer, player => player.inHand);
  const big = nextSeat(small, player => player.inHand);
  game.hand = { deck, board: [], phase: 'preflop', currentBet: BIG_BLIND, minRaise: BIG_BLIND, currentTurn: -1, message: `第 ${++game.handNumber} 手开始`, winners: null, deadPot: 0 };
  takeChips(game.seats[small], SMALL_BLIND); takeChips(game.seats[big], BIG_BLIND);
  game.hand.currentTurn = eligibleTurn(big);
  broadcast();
}

function maybeStartHand() {
  if (handInProgress()) return broadcast();
  const seated = seatedPlayers();
  if (seated.length >= 2 && seated.every(player => player.ready)) return startHand();
  broadcast();
}

function removePlayer(id) {
  const seat = game.seats.findIndex(player => player?.id === id);
  game.watchers.delete(id);
  if (seat === -1) return;
  const wasTurn = game.hand?.currentTurn === seat;
  if (game.hand && game.hand.phase !== 'complete') game.hand.deadPot += game.seats[seat].totalBet;
  game.seats[seat] = null;
  if (game.hostId === id) game.hostId = game.seats.find(player => player)?.id || null;
  if (game.hand?.phase !== 'complete' && game.hand?.phase !== 'showdown') {
    if (activePlayers().length <= 1) finishHand('玩家离桌，本手结束');
    else if (wasTurn) moveForward(seat);
  }
  if (!handInProgress()) maybeStartHand();
  else broadcast();
}

io.on('connection', socket => {
  socket.on('enter', ({ password, name, mode }) => {
    if (typeof password !== 'string' || !crypto.timingSafeEqual(Buffer.from(password.padEnd(64).slice(0, 64)), Buffer.from(ROOM_PASSWORD.padEnd(64).slice(0, 64))) || password.length !== ROOM_PASSWORD.length) return socket.emit('entry-error', '密码不正确');
    const safeName = String(name || '').trim().slice(0, 16);
    if (!safeName) return socket.emit('entry-error', '请输入 1–16 个字符的昵称');
    socket.join(ROOM);
    if (mode === 'player') {
      const seat = game.seats.findIndex(player => !player);
      if (seat === -1) { game.watchers.set(socket.id, safeName); socket.emit('entry-error', '座位已满，已切换为观战'); }
      else { game.seats[seat] = { id: socket.id, name: safeName, chips: STARTING_STACK, ready: false, queued: handInProgress(), inHand: false, folded: false, allIn: false, cards: [], streetBet: 0, totalBet: 0, acted: false }; if (!game.hostId) game.hostId = socket.id; }
    } else game.watchers.set(socket.id, safeName);
    socket.emit('entered'); broadcast();
  });
  socket.on('toggle-ready', () => {
    const player = game.seats.find(player => player?.id === socket.id);
    if (!player || player.inHand) return;
    player.ready = !player.ready;
    if (handInProgress()) player.queued = true;
    maybeStartHand();
  });
  socket.on('add-chips', ({ amount }) => {
    const player = game.seats.find(player => player?.id === socket.id);
    const chips = Number(amount);
    if (!player || player.inHand || ![500, 1000, 2000].includes(chips)) return;
    player.chips += chips;
    broadcast();
  });
  socket.on('start-hand', () => {
    maybeStartHand();
  });
  socket.on('action', ({ type, raiseTo }) => {
    const seat = game.seats.findIndex(player => player?.id === socket.id);
    const player = game.seats[seat];
    if (!player || !game.hand || game.hand.currentTurn !== seat || game.hand.phase === 'complete') return;
    const call = toCall(player);
    if (type === 'fold') { player.folded = true; player.acted = true; game.hand.message = `${player.name} 弃牌`; }
    else if (type === 'check' && call === 0) { player.acted = true; game.hand.message = `${player.name} 过牌`; }
    else if (type === 'call' && call > 0) { takeChips(player, call); player.acted = true; game.hand.message = `${player.name}${player.allIn ? ' 全下' : ' 跟注'}`; }
    else if (type === 'allin' && player.chips > 0) {
      const amount = player.streetBet + player.chips; takeChips(player, player.chips);
      if (amount > game.hand.currentBet) { game.hand.minRaise = amount - game.hand.currentBet; game.hand.currentBet = amount; playersInHand().forEach(p => { if (p !== player && !p.folded && !p.allIn) p.acted = false; }); }
      player.acted = true; game.hand.message = `${player.name} 全下`;
    } else if (type === 'raise') {
      const target = Math.floor(Number(raiseTo)); const max = player.streetBet + player.chips;
      if (!Number.isFinite(target) || target < game.hand.currentBet + game.hand.minRaise || target > max) return;
      takeChips(player, target - player.streetBet); game.hand.minRaise = target - game.hand.currentBet; game.hand.currentBet = target;
      playersInHand().forEach(p => { if (p !== player && !p.folded && !p.allIn) p.acted = false; }); player.acted = true; game.hand.message = `${player.name} 加注至 ${target}`;
    } else return;
    moveForward(seat);
  });
  socket.on('disconnect', () => removePlayer(socket.id));
});

httpServer.listen(PORT, () => console.log(`Private poker room listening on :${PORT}`));
