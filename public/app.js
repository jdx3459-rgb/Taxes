const socket = io();
const $ = selector => document.querySelector(selector);
let mode = 'player'; let state = null;
const phaseLabel = { preflop: '翻前', flop: '翻牌圈', turn: '转牌圈', river: '河牌圈', complete: '本手结束' };

document.querySelectorAll('.mode').forEach(button => button.addEventListener('click', () => { mode = button.dataset.mode; document.querySelectorAll('.mode').forEach(b => b.classList.toggle('active', b === button)); const admin = mode === 'admin'; $('#password-label').childNodes[0].textContent = admin ? '管理员密码' : '房间密码'; $('#password').placeholder = admin ? '仅管理员知晓' : '向牌局主人获取'; }));
$('#entry-form').addEventListener('submit', event => { event.preventDefault(); $('#entry-error').textContent = ''; socket.emit('enter', { name: $('#name').value, password: $('#password').value, mode }); });
socket.on('entry-error', message => $('#entry-error').textContent = message);
socket.on('entered', () => { $('#gate').classList.add('hidden'); $('#table-view').classList.remove('hidden'); });
socket.on('room-cleared', () => { alert('管理员已清理房间信息。'); location.reload(); });
$('#leave').addEventListener('click', () => location.reload());
socket.on('state', next => { state = next; render(); });

function card(value, hidden = false) { if (hidden) return '<span class="card back">✦</span>'; const red = value && /[♥♦]/.test(value); return `<span class="card ${red ? 'red' : ''}"><b>${value?.slice(0, -1) || ''}</b><i>${value?.slice(-1) || ''}</i></span>`; }
function renderSeat(seat) {
  const node = $(`#seat-${seat}`); const player = state.seats[seat];
  if (!player) { node.className = `seat ${node.className.split(' ')[1]} empty`; node.innerHTML = '<div class="empty-dot">＋</div><span>空座位</span>'; return; }
  const isTurn = state.hand?.currentTurn === seat; const dealer = state.hand?.dealer === seat;
  node.className = `seat ${node.className.split(' ')[1]} ${isTurn ? 'turn' : ''} ${player.folded ? 'folded' : ''}`;
  const visibleCards = player.cards ? player.cards.map(c => card(c)).join('') : (player.inHand && !player.folded ? card('', true) + card('', true) : '');
  node.innerHTML = `<div class="seat-cards">${visibleCards}</div><div class="player-chip"><span class="avatar">${player.name[0]}</span><div><b>${player.name}${dealer ? '<em>D</em>' : ''}</b><small>${player.chips.toLocaleString()} 筹码${player.streetBet ? ` · ${player.streetBet} 注` : ''}</small></div>${player.allIn ? '<strong>ALL IN</strong>' : ''}</div>`;
}
function renderControls() {
  const container = $('#controls'); const hand = state.hand; const yourSeat = state.you.seat; const player = state.seats[yourSeat];
  container.classList.remove('lobby-controls');
  if (state.isAdmin) { container.classList.add('admin-controls'); container.innerHTML = '<b>管理员控制台</b><p>清理后会结束牌局、移除所有玩家与观战者，并重置筹码。</p><button id="clear-room">清理玩家信息</button>'; $('#clear-room').addEventListener('click', () => { if (confirm('确定清理所有玩家、观战者和本局筹码吗？')) socket.emit('clear-player-info'); }); return; }
  if (!state.you.seated) { container.innerHTML = '<p class="spectator-note">你正在观战。观战者不会看到未摊牌的底牌。</p>'; return; }
  const readyButton = `<button class="${player.ready ? 'ready active' : 'ready'}" id="ready">${player.ready ? '已自动准备 · 取消准备' : '准备下一手'}</button>`;
  const chipsButton = `<div class="chip-add"><span>补充筹码</span><button data-chips="500">+500</button><button data-chips="1000">+1000</button></div>`;
  if (!hand || hand.phase === 'complete') { container.classList.add('lobby-controls'); container.innerHTML = `<b class="ready-title">下一局</b><p class="spectator-note">${player.ready ? '已就绪，等待所有入座玩家准备。' : '准备后，所有入座玩家都就绪时自动开局。'}</p>${readyButton}${chipsButton}`; bindLobbyControls(); return; }
  if (!player.inHand) { container.classList.add('lobby-controls'); container.innerHTML = `<b class="ready-title">下一局</b><p class="spectator-note">你在本手暂时观战，将在下一手自动加入。</p>${readyButton}${chipsButton}`; bindLobbyControls(); return; }
  if (hand.currentTurn !== yourSeat) { container.innerHTML = '<p class="spectator-note">等待其他玩家操作…</p>'; return; }
  const call = Math.max(0, hand.currentBet - player.streetBet); const min = hand.currentBet + hand.minRaise; const max = player.streetBet + player.chips;
  container.innerHTML = `<p class="your-turn">轮到你了 <span>${call ? `跟注 ${call}` : '可过牌'}</span></p><div class="actions"><button id="fold" class="fold">弃牌</button>${call ? `<button id="call" class="call">跟注 ${Math.min(call, player.chips)}</button>` : '<button id="check" class="call">过牌</button>'}<button id="allin" class="allin">全下</button></div>${max >= min ? `<div class="raise"><input id="raise-value" type="range" min="${min}" max="${max}" value="${min}" /><button id="raise">加注至 <b id="raise-number">${min}</b></button></div>` : ''}`;
  $('#fold')?.addEventListener('click', () => socket.emit('action', { type: 'fold' })); $('#check')?.addEventListener('click', () => socket.emit('action', { type: 'check' })); $('#call')?.addEventListener('click', () => socket.emit('action', { type: 'call' })); $('#allin')?.addEventListener('click', () => socket.emit('action', { type: 'allin' }));
  $('#raise-value')?.addEventListener('input', event => $('#raise-number').textContent = event.target.value); $('#raise')?.addEventListener('click', () => socket.emit('action', { type: 'raise', raiseTo: $('#raise-value').value }));
}
function bindLobbyControls() {
  $('#ready')?.addEventListener('click', () => socket.emit('toggle-ready'));
  document.querySelectorAll('[data-chips]').forEach(button => button.addEventListener('click', () => socket.emit('add-chips', { amount: Number(button.dataset.chips) })));
}
function renderQuickChat() {
  const panel = $('#quick-chat');
  if (!state.you.seated || state.isAdmin) { panel.innerHTML = ''; return; }
  const messages = ['请尽快行动 ⏱', '轮到你了！', '下一手准备了吗？', '好牌！', '牛逼！'];
  panel.innerHTML = `<span>📣 快捷广播</span><div>${messages.map(text => `<button data-message="${text}">${text}</button>`).join('')}</div>`;
  panel.querySelectorAll('[data-message]').forEach(button => button.addEventListener('click', () => socket.emit('broadcast-message', { text: button.dataset.message })));
}
function render() {
  for (let i = 0; i < 6; i++) renderSeat(i);
  const hand = state.hand; $('#board').innerHTML = hand ? hand.board.map(c => card(c)).join('') : Array(5).fill(0).map(() => card('', true)).join('');
  $('#pot').innerHTML = `底池 <b>${hand?.pot?.toLocaleString() || 0}</b>`; $('#phase').textContent = phaseLabel[hand?.phase] || '等待下一手'; $('#message').textContent = hand?.message || '入座即自动准备；两位玩家即可开始。'; $('#watchers').textContent = state.watcherCount;
  $('#room-status').textContent = state.you.seated ? `已入座 · ${state.seats.filter(Boolean).length} / 6` : '观战中';
  const winner = $('#winner'); if (hand?.winners?.length) { winner.classList.remove('hidden'); winner.innerHTML = hand.winners.map(w => `<b>${w.name}</b> ${w.label} · +${w.amount}`).join('<br>'); } else winner.classList.add('hidden');
  $('#leaderboard-list').innerHTML = state.leaderboard.map(entry => `<li class="${entry.id === socket.id ? 'you' : ''}"><span>${entry.rank}</span><b>${entry.name}</b><em>${entry.chips.toLocaleString()}</em></li>`).join('');
  $('#announcement-feed').innerHTML = state.announcements.map(item => `<div><b>${item.from}</b>：${item.text}</div>`).join('');
  renderQuickChat();
  renderControls();
}
