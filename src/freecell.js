import { dbExecute, dbQuery } from './data.js';
import { escapeHtml } from './htmlUtils.js';

const SUITS = ['clubs', 'diamonds', 'hearts', 'spades'];
const SUIT_SYMBOL = { clubs: '♣', diamonds: '♦', hearts: '♥', spades: '♠' };
const SUIT_NAME = { clubs: '梅花', diamonds: '方块', hearts: '红桃', spades: '黑桃' };
const RANK_LABEL = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K' };
const TIMER_MODE_KEY = 'workRecorder:freecellTimerOnDeal';
const AUTO_FOUNDATION_KEY = 'workRecorder:freecellAutoFoundation';
const COUNT_UNDO_KEY = 'workRecorder:freecellCountUndo';

let state = null;
let history = [];
let selected = null;
let timerHandle = null;
let messageTimer = null;
let closeListenerReady = false;
let pointerSelectionGuard = false;
let pointerDraggingReady = false;
let dragGesture = null;
let animationToken = 0;
let animationBusy = false;
let pendingDealAnimation = false;
let gameTransitionBusy = false;

function createDeck() {
  return SUITS.flatMap(suit => Array.from({ length: 13 }, (_, index) => ({
    id: `${suit}-${index + 1}`,
    suit,
    rank: index + 1,
    color: suit === 'diamonds' || suit === 'hearts' ? 'red' : 'black'
  })));
}

function shuffleDeck(deck, seed) {
  const next = [...deck];
  let value = seed >>> 0;
  const random = () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 4294967296;
  };
  for (let index = next.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [next[index], next[target]] = [next[target], next[index]];
  }
  return next;
}

function createDeal(seed = crypto.getRandomValues(new Uint32Array(1))[0]) {
  const columns = Array.from({ length: 8 }, () => []);
  shuffleDeck(createDeck(), seed).forEach((card, index) => columns[index % 8].push(card));
  return {
    seed,
    dealKey: String(seed),
    columns,
    freecells: [null, null, null, null],
    foundations: { clubs: [], diamonds: [], hearts: [], spades: [] },
    moveCount: 0,
    started: false,
    startedAt: null,
    elapsedBeforeStart: 0,
    won: false,
    recorded: false
  };
}

function cloneState(source = state) {
  return structuredClone(source);
}

function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

function elapsedSeconds() {
  if (!state?.started || !state.startedAt) return state?.elapsedBeforeStart || 0;
  return state.elapsedBeforeStart + Math.floor((Date.now() - state.startedAt) / 1000);
}

function updateTimer() {
  const timer = document.getElementById('freecell-timer');
  if (timer) timer.textContent = formatDuration(elapsedSeconds());
}

function startTimerIfNeeded() {
  if (state.started || state.won) return;
  state.started = true;
  state.startedAt = Date.now();
  updateTimer();
}

function stopTimer() {
  if (timerHandle) clearInterval(timerHandle);
  timerHandle = null;
}

function startTimerLoop() {
  stopTimer();
  timerHandle = setInterval(updateTimer, 500);
}

function showMessage(text, tone = 'neutral') {
  const element = document.getElementById('freecell-message');
  if (!element) return;
  element.textContent = text;
  element.dataset.tone = tone;
  element.classList.add('show');
  if (messageTimer) clearTimeout(messageTimer);
  messageTimer = setTimeout(() => element.classList.remove('show'), 2600);
}

function rankLabel(rank) {
  return RANK_LABEL[rank] || String(rank);
}

function renderCard(card, source, selectedCard = false) {
  if (!card) return '';
  const label = rankLabel(card.rank);
  const isCourt = card.rank >= 11;
  const sourceAttrs = `data-source-type="${source.sourceType}" data-source-index="${source.sourceIndex}"${source.cardIndex === undefined ? '' : ` data-card-index="${source.cardIndex}"`}`;
  const cardIndexStyle = source.cardIndex === undefined ? '' : ` style="--card-index:${source.cardIndex}"`;
  return `
    <button type="button" class="freecell-card ${card.color}${isCourt ? ' court-card' : ''}${selectedCard ? ' selected' : ''}" data-card-id="${card.id}" data-card-suit="${card.suit}" data-card-rank="${label}" ${sourceAttrs}${cardIndexStyle} aria-label="${SUIT_NAME[card.suit]} ${label}">
      <span class="freecell-card-corner freecell-card-corner-top"><b>${label}</b><i>${SUIT_SYMBOL[card.suit]}</i></span>
      <span class="freecell-card-center" aria-hidden="true"><span class="freecell-card-figure">${isCourt ? label : SUIT_SYMBOL[card.suit]}</span><span class="freecell-card-watermark">${SUIT_SYMBOL[card.suit]}</span></span>
      <span class="freecell-card-corner freecell-card-corner-bottom"><b>${label}</b><i>${SUIT_SYMBOL[card.suit]}</i></span>
    </button>
  `;
}

function reducedMotionEnabled() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

function cardElement(cardId) {
  return document.getElementById('freecell-board')?.querySelector(`[data-card-id="${cardId}"]`) || null;
}

function createMotionClone(element, rect) {
  const clone = element.cloneNode(true);
  clone.classList.remove('selected', 'dragging', 'freecell-card-arriving', 'freecell-drag-card');
  clone.classList.add('freecell-motion-card');
  clone.removeAttribute('style');
  clone.setAttribute('aria-hidden', 'true');
  clone.tabIndex = -1;
  clone.style.width = `${rect.width}px`;
  clone.style.height = `${rect.height}px`;
  return clone;
}

function captureCards(cardIds) {
  return cardIds.map(cardId => {
    const element = cardElement(cardId);
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { cardId, rect, clone: createMotionClone(element, rect) };
  }).filter(Boolean);
}

function captureDragCards(gesture) {
  return Array.from(gesture.ghost?.querySelectorAll('.freecell-drag-card') || [], element => {
    const rect = element.getBoundingClientRect();
    return { cardId: element.dataset.cardId, rect, clone: createMotionClone(element, rect) };
  });
}

function cancelBoardAnimations() {
  animationToken += 1;
  animationBusy = false;
  document.querySelectorAll('.freecell-motion-card').forEach(element => {
    element.getAnimations().forEach(animation => animation.cancel());
    element.remove();
  });
  document.querySelectorAll('.freecell-card-arriving').forEach(element => element.classList.remove('freecell-card-arriving'));
  document.getElementById('freecell-board')?.classList.remove('freecell-animating');
}

function interruptBoardAnimation() {
  if (animationBusy) cancelBoardAnimations();
}

function beginBoardAnimation() {
  const token = ++animationToken;
  animationBusy = true;
  document.getElementById('freecell-board')?.classList.add('freecell-animating');
  return token;
}

function finishBoardAnimation(token) {
  if (token !== animationToken) return;
  animationBusy = false;
  document.getElementById('freecell-board')?.classList.remove('freecell-animating');
  const undoButton = document.getElementById('freecell-undo');
  if (undoButton) undoButton.disabled = history.length === 0 || state.won;
}

async function animateCapturedCards(captures, { duration = 155, delayStep = 0, deal = false } = {}) {
  if (!captures.length || reducedMotionEnabled()) return;
  const animations = captures.map((capture, index) => {
    const destination = cardElement(capture.cardId);
    if (!destination) return Promise.resolve();
    const endRect = destination.getBoundingClientRect();
    if (Math.abs(capture.rect.left - endRect.left) < 0.5 && Math.abs(capture.rect.top - endRect.top) < 0.5) {
      return Promise.resolve();
    }

    const clone = capture.clone;
    destination.classList.add('freecell-card-arriving');
    clone.style.left = `${capture.rect.left}px`;
    clone.style.top = `${capture.rect.top}px`;
    clone.style.zIndex = String(21000 + (deal ? captures.length - index : index));
    document.body.appendChild(clone);
    const animation = clone.animate([
      { left: `${capture.rect.left}px`, top: `${capture.rect.top}px` },
      { left: `${endRect.left}px`, top: `${endRect.top}px` }
    ], {
      duration,
      delay: index * delayStep,
      easing: deal ? 'cubic-bezier(.2,.72,.22,1)' : 'cubic-bezier(.22,.86,.3,1)',
      fill: 'both'
    });
    return animation.finished.catch(() => null).finally(() => {
      clone.remove();
      destination.classList.remove('freecell-card-arriving');
    });
  });
  await Promise.all(animations);
}

function dealCardIds() {
  const ids = [];
  const rows = Math.max(...state.columns.map(column => column.length));
  for (let row = 0; row < rows; row += 1) {
    state.columns.forEach(column => {
      if (column[row]) ids.push(column[row].id);
    });
  }
  return ids;
}

async function playDealAnimation() {
  const board = document.getElementById('freecell-board');
  if (!board || board.offsetParent === null) {
    pendingDealAnimation = true;
    return;
  }

  pendingDealAnimation = false;
  cancelBoardAnimations();
  const captures = captureCards(dealCardIds());
  const firstCard = captures[0];
  if (!firstCard) return;
  const boardRect = board.getBoundingClientRect();
  const origin = {
    left: boardRect.left + (boardRect.width - firstCard.rect.width) / 2,
    top: boardRect.top + 18,
    width: firstCard.rect.width,
    height: firstCard.rect.height
  };
  captures.forEach(capture => { capture.rect = origin; });
  const token = beginBoardAnimation();
  await animateCapturedCards(captures, { duration: 190, delayStep: 7, deal: true });
  finishBoardAnimation(token);
}

function selectedMatches(type, index, cardIndex = null) {
  return selected?.type === type && selected.index === index && (cardIndex === null || selected.cardIndex === cardIndex);
}

function renderBoard() {
  const board = document.getElementById('freecell-board');
  if (!board || !state) return;

  const freecells = state.freecells.map((card, index) => `
    <div class="freecell-slot freecell-free-slot" data-target-type="freecell" data-target-index="${index}">
      <span class="freecell-slot-label">空位 ${index + 1}</span>
      ${card ? renderCard(card, { sourceType: 'freecell', sourceIndex: index }, selectedMatches('freecell', index)) : '<span class="freecell-empty-mark">+</span>'}
    </div>
  `).join('');

  const foundations = SUITS.map((suit, index) => {
    const pile = state.foundations[suit];
    const card = pile[pile.length - 1];
    return `
      <div class="freecell-slot freecell-foundation-slot" data-target-type="foundation" data-target-index="${index}" data-target-suit="${suit}">
        <span class="freecell-slot-label">${SUIT_NAME[suit]}</span>
        ${card ? renderCard(card, { sourceType: 'foundation', sourceIndex: index }) : `<span class="freecell-foundation-mark">${SUIT_SYMBOL[suit]}</span>`}
      </div>
    `;
  }).join('');

  const columns = state.columns.map((column, columnIndex) => `
    <div class="freecell-column" data-target-type="column" data-target-index="${columnIndex}" style="--cards:${column.length}">
      ${column.length ? column.map((card, cardIndex) => renderCard(card, {
        sourceType: 'column',
        sourceIndex: columnIndex,
        cardIndex
      }, selectedMatches('column', columnIndex, cardIndex))).join('') : '<span class="freecell-column-empty">空列</span>'}
    </div>
  `).join('');

  board.innerHTML = `
    <div class="freecell-top-row">
      <div class="freecell-zone-group"><div class="freecell-zone-title">自由单元</div><div class="freecell-slots">${freecells}</div></div>
      <div class="freecell-zone-divider">FREECELL</div>
      <div class="freecell-zone-group align-right"><div class="freecell-zone-title">基础区 A → K</div><div class="freecell-slots">${foundations}</div></div>
    </div>
    <div class="freecell-columns">${columns}</div>
  `;

  board.querySelectorAll('.freecell-card').forEach(cardElement => {
    cardElement.addEventListener('pointerdown', onCardPointerDown);
    cardElement.addEventListener('click', onCardClick);
    cardElement.addEventListener('dblclick', onCardDoubleClick);
    cardElement.addEventListener('contextmenu', onCardContextMenu);
  });
  board.querySelectorAll('[data-target-type]').forEach(target => {
    target.addEventListener('click', onTargetClick);
  });

  document.getElementById('freecell-moves').textContent = String(state.moveCount);
  document.getElementById('freecell-remaining').textContent = String(52 - foundationCount());
  document.getElementById('freecell-undo').disabled = history.length === 0 || state.won;
  updateTimer();
}

function selectCardSource(source) {
  if (source.type === 'foundation') return;
  if (selected && selected.type === source.type && selected.index === source.index && selected.cardIndex === source.cardIndex) {
    selected = null;
  } else {
    selected = source;
  }
  renderBoard();
}

function onCardPointerDown(event) {
  if (event.button !== 0) return;
  interruptBoardAnimation();
  const cardElement = event.currentTarget;
  const source = sourceFromElement(cardElement);
  dragGesture = {
    pointerId: event.pointerId,
    source,
    cardId: cardElement.dataset.cardId,
    startX: event.clientX,
    startY: event.clientY,
    dragging: false,
    ghost: null
  };
  cardElement.setPointerCapture?.(event.pointerId);
  if (!selected) {
    selected = source;
    pointerSelectionGuard = cardElement.dataset.cardId;
    cardElement.classList.add('selected');
  }
  setTimeout(() => {
    if (pointerSelectionGuard === cardElement.dataset.cardId) pointerSelectionGuard = false;
  }, 450);
}

function sourceFromElement(element) {
  return {
    type: element.dataset.sourceType,
    index: Number(element.dataset.sourceIndex),
    cardIndex: element.dataset.cardIndex === undefined ? null : Number(element.dataset.cardIndex)
  };
}

function onCardClick(event) {
  event.stopPropagation();
  interruptBoardAnimation();
  const source = sourceFromElement(event.currentTarget);
  if (pointerSelectionGuard === event.currentTarget.dataset.cardId) {
    pointerSelectionGuard = false;
    return;
  }
  if (selected && !(selected.type === source.type && selected.index === source.index && selected.cardIndex === source.cardIndex)) {
    if (source.type === 'column') {
      if (selected.type === 'column' && selected.index === source.index) {
        selected = source;
        renderBoard();
        return;
      }
      attemptMove(selected, { type: 'column', index: source.index, suit: null });
      return;
    }
    if (source.type === 'foundation') {
      attemptMove(selected, { type: 'foundation', index: source.index, suit: event.currentTarget.dataset.cardSuit });
      return;
    }
  }
  selectCardSource(source);
}

function onTargetClick(event) {
  interruptBoardAnimation();
  const target = event.currentTarget;
  if (event.target.closest('.freecell-card')) return;
  if (!selected) return;
  attemptMove(selected, {
    type: target.dataset.targetType,
    index: Number(target.dataset.targetIndex),
    suit: target.dataset.targetSuit || null
  });
}

function onCardDoubleClick(event) {
  event.stopPropagation();
  interruptBoardAnimation();
  const source = sourceFromElement(event.currentTarget);
  if (!moveToFoundation(source)) showMessage('这张牌暂时不能进入基础区。', 'warning');
}

function onCardContextMenu(event) {
  event.preventDefault();
  event.stopPropagation();
  interruptBoardAnimation();
  const source = sourceFromElement(event.currentTarget);
  if (moveToFirstFreecell(source)) return;
  if (!moveToFoundation(source)) showMessage('没有可用空位，这张牌也不能进入基础区。', 'warning');
}

function createDragGhost(gesture, x, y) {
  const sourceCard = document.querySelector(`[data-card-id="${gesture.cardId}"]`);
  if (!sourceCard) return null;
  const rect = sourceCard.getBoundingClientRect();
  const board = document.getElementById('freecell-board');
  const step = Number.parseFloat(getComputedStyle(board).getPropertyValue('--card-step')) || 34;
  const cards = getSourceCards(gesture.source);
  const ghost = document.createElement('div');
  ghost.className = 'freecell-drag-ghost';
  ghost.style.width = `${rect.width}px`;
  ghost.style.height = `${rect.height + Math.max(0, cards.length - 1) * step}px`;
  gesture.offsetX = gesture.startX - rect.left;
  gesture.offsetY = gesture.startY - rect.top;
  gesture.cardIds = cards.map(card => card.id);
  cards.forEach((card, index) => {
    const element = cardElement(card.id);
    if (!element) return;
    const clone = element.cloneNode(true);
    clone.classList.remove('selected', 'dragging');
    clone.classList.add('freecell-drag-card');
    clone.removeAttribute('style');
    clone.tabIndex = -1;
    clone.style.top = `${index * step}px`;
    clone.style.width = `${rect.width}px`;
    clone.style.height = `${rect.height}px`;
    ghost.appendChild(clone);
    element.classList.add('dragging');
  });
  document.body.appendChild(ghost);
  moveDragGhost(ghost, x, y, gesture);
  return ghost;
}

function moveDragGhost(ghost, x, y, gesture = dragGesture) {
  if (!ghost) return;
  ghost.style.left = `${x - (gesture?.offsetX || 0)}px`;
  ghost.style.top = `${y - (gesture?.offsetY || 0)}px`;
}

function cleanupDragGesture() {
  if (!dragGesture) return;
  dragGesture.ghost?.remove();
  (dragGesture.cardIds || [dragGesture.cardId]).forEach(cardId => cardElement(cardId)?.classList.remove('dragging'));
  dragGesture = null;
  document.querySelectorAll('.freecell-drop-target').forEach(target => target.classList.remove('freecell-drop-target'));
}

function targetFromPoint(x, y) {
  const element = document.elementFromPoint(x, y);
  const target = element?.closest('[data-target-type]');
  if (!target) return null;
  return {
    type: target.dataset.targetType,
    index: Number(target.dataset.targetIndex),
    suit: target.dataset.targetSuit || null,
    element: target
  };
}

function setupPointerDragging() {
  if (pointerDraggingReady) return;
  document.addEventListener('pointermove', event => {
    if (!dragGesture || event.pointerId !== dragGesture.pointerId) return;
    const distance = Math.hypot(event.clientX - dragGesture.startX, event.clientY - dragGesture.startY);
    if (!dragGesture.dragging && distance >= 6) {
      dragGesture.dragging = true;
      selected = dragGesture.source;
      pointerSelectionGuard = dragGesture.cardId;
      const sourceCard = document.querySelector(`[data-card-id="${dragGesture.cardId}"]`);
      sourceCard?.classList.add('selected', 'dragging');
      dragGesture.ghost = createDragGhost(dragGesture, event.clientX, event.clientY);
    }
    if (!dragGesture.dragging) return;
    event.preventDefault();
    moveDragGhost(dragGesture.ghost, event.clientX, event.clientY, dragGesture);
    document.querySelectorAll('.freecell-drop-target').forEach(target => target.classList.remove('freecell-drop-target'));
    targetFromPoint(event.clientX, event.clientY)?.element.classList.add('freecell-drop-target');
  }, { passive: false });

  const finishDrag = event => {
    if (!dragGesture || event.pointerId !== dragGesture.pointerId) return;
    if (!dragGesture.dragging) {
      dragGesture = null;
      return;
    }
    event.preventDefault();
    const gesture = dragGesture;
    const target = targetFromPoint(event.clientX, event.clientY);
    const captures = captureDragCards(gesture);
    cleanupDragGesture();
    pointerSelectionGuard = gesture.cardId;
    setTimeout(() => {
      if (pointerSelectionGuard === gesture.cardId) pointerSelectionGuard = false;
    }, 450);
    if (!target) {
      renderBoard();
      showMessage('请把纸牌拖到牌列、自由单元或基础区。', 'warning');
      return;
    }
    attemptMove(gesture.source, target, { captures });
  };

  document.addEventListener('pointerup', finishDrag);
  document.addEventListener('pointercancel', event => {
    if (!dragGesture || event.pointerId !== dragGesture.pointerId) return;
    cleanupDragGesture();
    renderBoard();
  });
  pointerDraggingReady = true;
}

function getSourceCards(source) {
  if (source.type === 'freecell') {
    const card = state.freecells[source.index];
    return card ? [card] : [];
  }
  if (source.type === 'column') {
    const column = state.columns[source.index] || [];
    if (source.cardIndex < 0 || source.cardIndex >= column.length) return [];
    return column.slice(source.cardIndex);
  }
  return [];
}

function isDescendingAlternating(cards) {
  return cards.every((card, index) => index === cards.length - 1 || (
    card.rank === cards[index + 1].rank + 1 && card.color !== cards[index + 1].color
  ));
}

function canPlaceOnColumn(card, column) {
  if (!column.length) return true;
  const target = column[column.length - 1];
  return target.rank === card.rank + 1 && target.color !== card.color;
}

function supermoveCapacity(targetColumnIndex) {
  const emptyFreecells = state.freecells.filter(card => !card).length;
  const emptyColumns = state.columns.filter(column => column.length === 0).length;
  const targetIsEmpty = state.columns[targetColumnIndex].length === 0;
  return (emptyFreecells + 1) * (2 ** Math.max(0, emptyColumns - (targetIsEmpty ? 1 : 0)));
}

function canMoveToFoundation(card, suit = card.suit) {
  if (suit !== card.suit) return false;
  const pile = state.foundations[suit];
  return card.rank === pile.length + 1;
}

function pushHistory() {
  history.push(cloneState());
}

function removeSource(source, count) {
  if (source.type === 'freecell') state.freecells[source.index] = null;
  else state.columns[source.index].splice(source.cardIndex, count);
}

async function completeMoveAnimation(captures, token, runAutoFoundation, animationOptions = {}) {
  try {
    await animateCapturedCards(captures, animationOptions);
    if (token !== animationToken) return;
    if (runAutoFoundation) await autoMoveSafeCards(token);
  } finally {
    if (token === animationToken) {
      finishBoardAnimation(token);
      checkWin();
    }
  }
}

function applyMove(source, target, cards, { skipAuto = false, captures = null } = {}) {
  interruptBoardAnimation();
  const motionCaptures = captures || captureCards(cards.map(card => card.id));
  const token = beginBoardAnimation();
  pushHistory();
  startTimerIfNeeded();
  removeSource(source, cards.length);
  if (target.type === 'freecell') state.freecells[target.index] = cards[0];
  else if (target.type === 'column') state.columns[target.index].push(...cards);
  else state.foundations[target.suit].push(cards[0]);
  state.moveCount += 1;
  selected = null;
  renderBoard();
  completeMoveAnimation(motionCaptures, token, !skipAuto && autoFoundationEnabled());
  return true;
}

function attemptMove(source, target, options = {}) {
  if (state.won) return false;
  interruptBoardAnimation();
  const cards = getSourceCards(source);
  if (!cards.length) return false;
  if (!isDescendingAlternating(cards)) {
    showMessage('只能移动红黑交替、点数连续递减的牌组。', 'warning');
    return false;
  }
  if (source.type === 'column' && target.type === 'column' && source.index === target.index) return false;

  if (target.type === 'freecell') {
    if (cards.length !== 1 || state.freecells[target.index]) {
      showMessage('每个自由单元只能放一张牌。', 'warning');
      return false;
    }
  } else if (target.type === 'foundation') {
    if (cards.length !== 1 || !canMoveToFoundation(cards[0], target.suit)) {
      showMessage('基础区需要按同花色从 A 到 K 依次排列。', 'warning');
      return false;
    }
  } else if (target.type === 'column') {
    if (!canPlaceOnColumn(cards[0], state.columns[target.index])) {
      showMessage('牌桌需要按红黑交替、点数递减排列。', 'warning');
      return false;
    }
    if (cards.length > supermoveCapacity(target.index)) {
      showMessage(`当前空位最多只能同时移动 ${supermoveCapacity(target.index)} 张牌。`, 'warning');
      return false;
    }
  }

  return applyMove(source, target, cards, options);
}

function moveToFoundation(source) {
  const cards = getSourceCards(source);
  if (cards.length !== 1 || !canMoveToFoundation(cards[0])) return false;
  return applyMove(source, { type: 'foundation', suit: cards[0].suit }, cards);
}

function moveToFirstFreecell(source) {
  const cards = getSourceCards(source);
  const targetIndex = state.freecells.findIndex(card => !card);
  if (cards.length !== 1 || targetIndex < 0) return false;
  return applyMove(source, { type: 'freecell', index: targetIndex }, cards);
}

function foundationTop(suit) {
  const pile = state.foundations[suit];
  return pile.length ? pile[pile.length - 1].rank : 0;
}

function safeForAutoFoundation(card) {
  if (!canMoveToFoundation(card)) return false;
  if (card.rank <= 2) return true;
  const opposite = card.color === 'red' ? ['clubs', 'spades'] : ['diamonds', 'hearts'];
  const sameColorSibling = SUITS.find(suit => suit !== card.suit && ((suit === 'diamonds' || suit === 'hearts') === (card.color === 'red')));
  const oppositeMin = Math.min(...opposite.map(foundationTop));
  return oppositeMin >= card.rank - 1 || (oppositeMin >= card.rank - 2 && foundationTop(sameColorSibling) >= card.rank - 3);
}

function nextSafeFoundationMove() {
  for (let index = 0; index < state.freecells.length; index += 1) {
    const card = state.freecells[index];
    if (card && safeForAutoFoundation(card)) return { source: { type: 'freecell', index, cardIndex: null }, card };
  }
  for (let index = 0; index < state.columns.length; index += 1) {
    const column = state.columns[index];
    const card = column[column.length - 1];
    if (card && safeForAutoFoundation(card)) return { source: { type: 'column', index, cardIndex: column.length - 1 }, card };
  }
  return null;
}

function animationPause(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function autoMoveSafeCards(token) {
  let move = nextSafeFoundationMove();
  while (move && token === animationToken) {
    if (!reducedMotionEnabled()) await animationPause(18);
    if (token !== animationToken) return;
    const captures = captureCards([move.card.id]);
    pushHistory();
    removeSource(move.source, 1);
    state.foundations[move.card.suit].push(move.card);
    state.moveCount += 1;
    renderBoard();
    await animateCapturedCards(captures, { duration: 130 });
    move = nextSafeFoundationMove();
  }
}

function foundationCount() {
  return SUITS.reduce((total, suit) => total + state.foundations[suit].length, 0);
}

function autoFoundationEnabled() {
  return document.getElementById('freecell-auto-foundation')?.checked !== false;
}

function countUndoEnabled() {
  return document.getElementById('freecell-count-undo')?.checked !== false;
}

async function finishCurrentGame(result, reason = '') {
  if (!state?.started || state.recorded) return;
  state.recorded = true;
  const endedAt = new Date().toISOString();
  const startedAt = new Date((state.startedAt || Date.now()) - state.elapsedBeforeStart * 1000).toISOString();
  await dbExecute(
    'INSERT INTO freecell_games (deal_key, result, duration_seconds, move_count, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)',
    [state.dealKey, result, elapsedSeconds(), state.moveCount, startedAt, endedAt]
  );
  if (reason) console.info(`FreeCell game ended: ${reason}`);
}

async function checkWin() {
  if (state.won || foundationCount() !== 52) return;
  state.won = true;
  stopTimer();
  await finishCurrentGame('won', 'win');
  renderBoard();
  await showWinDialog();
}

async function showWinDialog() {
  const stats = await loadStatistics();
  window.showModal('这一局完成了', `
    <div class="freecell-win-dialog">
      <div class="freecell-win-mark">♠</div>
      <strong>${formatDuration(elapsedSeconds())}</strong>
      <span>${state.moveCount} 步完成 · 当前胜率 ${stats.winRate}</span>
      <div class="freecell-win-grid">
        <div><small>已玩</small><b>${stats.played}</b></div>
        <div><small>胜局</small><b>${stats.won}</b></div>
        <div><small>最佳</small><b>${stats.best}</b></div>
      </div>
    </div>
  `, null, async () => {
    await newGame('after-win');
    return true;
  }, { btnText: '再玩一局' });
}

async function newGame(reason = 'switch') {
  if (state?.started && !state.won && !state.recorded) await finishCurrentGame('lost', reason);
  cancelBoardAnimations();
  state = createDeal();
  history = [];
  selected = null;
  if (timerOnDealEnabled()) startTimerIfNeeded();
  startTimerLoop();
  renderBoard();
  playDealAnimation();
  showMessage(`新牌局 #${state.dealKey} 已发好。`);
}

async function restartGame() {
  if (!state) return;
  const seed = state.seed;
  if (state.started && !state.won && !state.recorded) await finishCurrentGame('lost', 'restart');
  cancelBoardAnimations();
  state = createDeal(seed);
  history = [];
  selected = null;
  if (timerOnDealEnabled()) startTimerIfNeeded();
  startTimerLoop();
  renderBoard();
  playDealAnimation();
  showMessage('已恢复本局初始牌面。');
}

function setGameTransitionBusy(isBusy) {
  gameTransitionBusy = isBusy;
  const newGameButton = document.getElementById('freecell-new-game');
  const restartButton = document.getElementById('freecell-restart');
  if (newGameButton) newGameButton.disabled = isBusy;
  if (restartButton) restartButton.disabled = isBusy;
}

function showGameConfirmation({ title, message, confirmText, action }) {
  if (!state || gameTransitionBusy) return;
  interruptBoardAnimation();
  renderBoard();
  setGameTransitionBusy(true);
  const release = () => setGameTransitionBusy(false);
  window.showModal(title, `<div class="freecell-confirm-message">${message}</div>`, null, async () => {
    try {
      await action();
      return true;
    } finally {
      release();
    }
  }, { danger: true, btnText: confirmText, onCancel: release });
}

function requestNewGame(reason = 'new-game') {
  const recordsLoss = state?.started && !state.won && !state.recorded;
  showGameConfirmation({
    title: '开始新游戏',
    message: recordsLoss
      ? '当前牌局会记录为未胜。确认后才会生成一副新牌。'
      : '确认后将结束当前牌面，并生成一副新牌。',
    confirmText: '开始新游戏',
    action: () => newGame(reason)
  });
}

function requestRestartGame() {
  const recordsLoss = state?.started && !state.won && !state.recorded;
  showGameConfirmation({
    title: '重开本局',
    message: recordsLoss
      ? '当前尝试会记录为未胜。确认后才会恢复本局初始牌面。'
      : '确认后将放弃当前进度，并恢复本局初始牌面。',
    confirmText: '确认重开',
    action: restartGame
  });
}

function undoMove() {
  if (!history.length || state.won) return;
  interruptBoardAnimation();
  const captures = captureCards(Array.from(document.querySelectorAll('#freecell-board .freecell-card'), element => element.dataset.cardId));
  const token = beginBoardAnimation();
  const elapsed = elapsedSeconds();
  const wasStarted = state.started;
  const moveCount = state.moveCount;
  state = history.pop();
  if (countUndoEnabled()) state.moveCount = moveCount + 1;
  if (wasStarted) {
    state.started = true;
    state.elapsedBeforeStart = elapsed;
    state.startedAt = Date.now();
  }
  selected = null;
  renderBoard();
  completeMoveAnimation(captures, token, false, { duration: 120 });
  showMessage(countUndoEnabled() ? '已撤销上一步，本次撤销计为 1 步。' : '已撤销上一步。');
}

function findHint() {
  const fallbackFreecellMoves = [];
  for (let columnIndex = 0; columnIndex < state.columns.length; columnIndex += 1) {
    const column = state.columns[columnIndex];
    if (!column.length) continue;
    const cardIndex = column.length - 1;
    const source = { type: 'column', index: columnIndex, cardIndex };
    const card = column[cardIndex];
    if (canMoveToFoundation(card)) return { source, text: `${rankLabel(card.rank)}${SUIT_SYMBOL[card.suit]} 可以进入基础区。` };
    const freeIndex = state.freecells.findIndex(item => !item);
    if (freeIndex >= 0) fallbackFreecellMoves.push({ source, text: `${rankLabel(card.rank)}${SUIT_SYMBOL[card.suit]} 可以暂存到自由单元。` });
    for (let targetIndex = 0; targetIndex < state.columns.length; targetIndex += 1) {
      if (targetIndex !== columnIndex && canPlaceOnColumn(card, state.columns[targetIndex])) {
        return { source, text: `${rankLabel(card.rank)}${SUIT_SYMBOL[card.suit]} 可以移动到第 ${targetIndex + 1} 列。` };
      }
    }
  }
  for (let index = 0; index < state.freecells.length; index += 1) {
    const card = state.freecells[index];
    if (!card) continue;
    if (canMoveToFoundation(card)) return { source: { type: 'freecell', index, cardIndex: null }, text: `${rankLabel(card.rank)}${SUIT_SYMBOL[card.suit]} 可以进入基础区。` };
    for (let targetIndex = 0; targetIndex < state.columns.length; targetIndex += 1) {
      if (canPlaceOnColumn(card, state.columns[targetIndex])) return { source: { type: 'freecell', index, cardIndex: null }, text: `${rankLabel(card.rank)}${SUIT_SYMBOL[card.suit]} 可以移回第 ${targetIndex + 1} 列。` };
    }
  }
  return fallbackFreecellMoves[0] || null;
}

function showHint() {
  interruptBoardAnimation();
  const hint = findHint();
  if (!hint) {
    showMessage('暂时没有发现直接移动，可以尝试整理空列。', 'warning');
    return;
  }
  selected = hint.source;
  renderBoard();
  showMessage(hint.text, 'success');
}

function timerOnDealEnabled() {
  return document.getElementById('freecell-timer-on-deal')?.checked === true;
}

function formatHistoryDate(value) {
  const date = new Date(value || '');
  if (Number.isNaN(date.getTime())) return value || '';
  return date.toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  });
}

async function loadStatistics() {
  const rows = await dbQuery("SELECT result, duration_seconds, move_count, ended_at FROM freecell_games ORDER BY ended_at ASC, id ASC");
  const played = rows.length;
  const wonRows = rows.filter(row => row.result === 'won');
  const won = wonRows.length;
  const bestSeconds = won ? Math.min(...wonRows.map(row => Number(row.duration_seconds) || 0)) : null;
  const averageSeconds = won ? Math.round(wonRows.reduce((sum, row) => sum + (Number(row.duration_seconds) || 0), 0) / won) : null;
  let maxWinStreak = 0;
  let currentWinStreak = 0;
  rows.forEach(row => {
    if (row.result === 'won') {
      currentWinStreak += 1;
      maxWinStreak = Math.max(maxWinStreak, currentWinStreak);
    } else currentWinStreak = 0;
  });
  return {
    rows,
    played,
    won,
    lost: played - won,
    winRate: played ? `${Math.round((won / played) * 100)}%` : '--',
    best: bestSeconds === null ? '--:--' : formatDuration(bestSeconds),
    average: averageSeconds === null ? '--:--' : formatDuration(averageSeconds),
    maxWinStreak,
    currentWinStreak
  };
}

async function showStatistics() {
  const stats = await loadStatistics();
  const recent = [...stats.rows].reverse().slice(0, 8);
  window.showModal('空当接龙统计', `
    <div class="freecell-stats-dialog">
      <div class="freecell-stats-grid">
        <div><span>历史胜率</span><strong>${stats.winRate}</strong></div>
        <div><span>已玩 / 胜局</span><strong>${stats.played} / ${stats.won}</strong></div>
        <div><span>最佳时间</span><strong>${stats.best}</strong></div>
        <div><span>胜局平均</span><strong>${stats.average}</strong></div>
        <div><span>最多连胜</span><strong>${stats.maxWinStreak}</strong></div>
        <div><span>当前连胜</span><strong>${stats.currentWinStreak}</strong></div>
      </div>
      <div class="freecell-history-title">最近牌局</div>
      <div class="freecell-history-list">
        ${recent.length ? recent.map(row => `
          <div class="freecell-history-row ${row.result}">
            <span>${row.result === 'won' ? '胜利' : '未胜'}</span>
            <strong>${formatDuration(row.duration_seconds)}</strong>
            <em>${Number(row.move_count) || 0} 步</em>
            <small>${escapeHtml(formatHistoryDate(row.ended_at))}</small>
          </div>
        `).join('') : '<div class="freecell-history-empty">还没有历史牌局。完成第一次有效移动后，结果会记录在这里。</div>'}
      </div>
      <button id="freecell-reset-statistics" type="button" class="btn btn-ghost freecell-reset-statistics">清空游戏历史</button>
    </div>
  `, body => {
    body.querySelector('#freecell-reset-statistics')?.addEventListener('click', async () => {
      if (!confirm('确定清空所有空当接龙历史记录吗？')) return;
      await dbExecute('DELETE FROM freecell_games');
      document.getElementById('global-modal-overlay').style.display = 'none';
      showMessage('游戏统计已清空。');
    });
  }, async () => true, { btnText: '关闭' });
}

function showRules() {
  window.showModal('空当接龙规则', `
    <div class="freecell-rules-dialog">
      <section><strong>目标</strong><p>把 52 张牌分别按花色，从 A 到 K 移入右上角四个基础区。</p></section>
      <section><strong>牌桌</strong><p>牌列必须按点数递减，并且红黑花色交替，例如黑 8 下方可以放红 7。空列可以放任意牌或合法牌组。</p></section>
      <section><strong>自由单元</strong><p>左上角四个空位各能临时保存一张牌。空位和空列越多，一次能移动的连续牌组越长。</p></section>
      <section><strong>多牌移动</strong><p>可移动数量为（空自由单元数 + 1）× 2 的可用空列数次方。目标本身为空列时，不计入中转空列。</p></section>
      <section><strong>操作</strong><p>单击牌再单击目标，或直接拖动。双击送往基础区；右击优先送入自由单元，空位已满时尝试送入基础区。每张自动收牌都是独立一步，也需要单独撤销。Ctrl+Z 撤销，F2 新游戏。</p></section>
      <section><strong>计时与统计</strong><p>默认从第一步有效移动开始计时。撤销默认计入步数，可在牌桌上方关闭。开始后的新局或重开会把上一局记为未胜；未移动直接换局不计入统计。</p></section>
    </div>
  `, null, async () => true, { btnText: '知道了' });
}

function setupKeyboard() {
  document.addEventListener('keydown', event => {
    const view = document.getElementById('subview-freecell');
    if (!view || view.style.display === 'none') return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      undoMove();
    } else if (event.key === 'F2') {
      event.preventDefault();
      requestNewGame('shortcut');
    } else if (event.key.toLowerCase() === 'h') {
      event.preventDefault();
      showHint();
    }
  });
}

export function initFreeCellModule() {
  const board = document.getElementById('freecell-board');
  if (!board || board.dataset.initialized === '1') return;
  const autoToggle = document.getElementById('freecell-auto-foundation');
  const timerToggle = document.getElementById('freecell-timer-on-deal');
  const countUndoToggle = document.getElementById('freecell-count-undo');
  autoToggle.checked = localStorage.getItem(AUTO_FOUNDATION_KEY) !== '0';
  timerToggle.checked = localStorage.getItem(TIMER_MODE_KEY) === '1';
  countUndoToggle.checked = localStorage.getItem(COUNT_UNDO_KEY) !== '0';
  const persistOption = (input, key, settingsId) => {
    localStorage.setItem(key, input.checked ? '1' : '0');
    const settingsInput = document.getElementById(settingsId);
    if (settingsInput) settingsInput.checked = input.checked;
  };
  autoToggle.addEventListener('change', () => persistOption(autoToggle, AUTO_FOUNDATION_KEY, 'setting-freecell-auto-foundation'));
  timerToggle.addEventListener('change', () => persistOption(timerToggle, TIMER_MODE_KEY, 'setting-freecell-timer-on-deal'));
  countUndoToggle.addEventListener('change', () => persistOption(countUndoToggle, COUNT_UNDO_KEY, 'setting-freecell-count-undo'));
  const optionsMenu = document.querySelector('.freecell-options-menu');
  document.addEventListener('pointerdown', event => {
    if (optionsMenu?.open && !optionsMenu.contains(event.target)) optionsMenu.open = false;
  });
  document.getElementById('freecell-new-game')?.addEventListener('click', () => requestNewGame('new-game'));
  document.getElementById('freecell-restart')?.addEventListener('click', requestRestartGame);
  document.getElementById('freecell-undo')?.addEventListener('click', undoMove);
  document.getElementById('freecell-hint')?.addEventListener('click', showHint);
  document.getElementById('freecell-rules')?.addEventListener('click', () => {
    if (optionsMenu) optionsMenu.open = false;
    showRules();
  });
  document.getElementById('freecell-statistics')?.addEventListener('click', () => {
    if (optionsMenu) optionsMenu.open = false;
    showStatistics();
  });
  document.getElementById('nav-freecell')?.addEventListener('click', () => {
    requestAnimationFrame(() => {
      if (pendingDealAnimation) playDealAnimation();
    });
  });
  setupKeyboard();
  setupPointerDragging();
  if (!closeListenerReady) {
    const appWindow = window.__TAURI__.window.getCurrentWindow();
    appWindow.onCloseRequested(async event => {
      if (!state?.started || state.won || state.recorded) return;
      event.preventDefault();
      await finishCurrentGame('lost', 'app-close');
      await appWindow.destroy();
    });
    closeListenerReady = true;
  }
  state = createDeal();
  if (timerOnDealEnabled()) startTimerIfNeeded();
  startTimerLoop();
  renderBoard();
  pendingDealAnimation = true;
  requestAnimationFrame(() => playDealAnimation());
  board.dataset.initialized = '1';
}
