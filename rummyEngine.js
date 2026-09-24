// rummyEngine.js
// Core Indian 13-card Rummy rule engine — pure logic, no networking.
// Rules implemented: 2 decks + jokers (standard for 2-6 players),
// 1 printed joker (wild) drawn randomly per round, deal 13 cards,
// need min 2 sequences (1 pure, 1 with/without joker) to declare valid.

const SUITS = ['S', 'H', 'D', 'C']; // Spades, Hearts, Diamonds, Clubs
const RANKS = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
const RANK_VALUE = { A:1, '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10, J:10, Q:10, K:10 };

function buildDoubleDeckWithJokers() {
  const deck = [];
  for (let d = 0; d < 2; d++) {
    for (const s of SUITS) {
      for (const r of RANKS) {
        deck.push({ id: `${r}${s}_${d}`, rank: r, suit: s, isPrintedJoker: false });
      }
    }
    // 2 printed jokers per deck (standard)
    deck.push({ id: `PJ_${d}_1`, rank: 'JOKER', suit: null, isPrintedJoker: true });
    deck.push({ id: `PJ_${d}_2`, rank: 'JOKER', suit: null, isPrintedJoker: true });
  }
  return deck;
}

function shuffle(deck) {
  const arr = [...deck];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Deals a fresh round: returns { hands: {playerId: [cards]}, wildJokerRank, stock, discardTop }
function dealRound(playerIds) {
  const deck = shuffle(buildDoubleDeckWithJokers());
  const hands = {};
  playerIds.forEach(id => (hands[id] = []));

  for (let i = 0; i < 13; i++) {
    for (const id of playerIds) {
      hands[id].push(deck.pop());
    }
  }

  // wild joker card — flip one card, its rank becomes the wild joker rank
  let wildCard = deck.pop();
  while (wildCard.isPrintedJoker) {
    deck.unshift(wildCard); // put back at bottom, try again
    wildCard = deck.pop();
  }
  const wildJokerRank = wildCard.rank;

  const discardTop = [deck.pop()];

  return { hands, wildJokerRank, wildCardShown: wildCard, stock: deck, discard: discardTop };
}

function isWildJoker(card, wildJokerRank) {
  return card.isPrintedJoker || card.rank === wildJokerRank;
}

// --- Validation of a declared hand ---
// groups: array of arrays of cards, as the player has arranged them (must cover all 13 cards + the picked 14th minus discard, i.e. exactly 13 after discard)
// Returns { valid: bool, reason, deadwood, pureSequences, impureSequences, sets }

function isPureSequence(group, wildJokerRank) {
  // no jokers used, 3+ consecutive same suit
  if (group.length < 3) return false;
  if (group.some(c => isWildJoker(c, wildJokerRank))) return false;
  return isConsecutiveSameSuit(group);
}

function isConsecutiveSameSuit(group) {
  const suit = group[0].suit;
  if (!suit || group.some(c => c.suit !== suit)) return false;
  const order = RANKS; // A..K, note: rummy usually allows A low or high but not wrap Q-K-A-2
  const idxs = group.map(c => order.indexOf(c.rank)).sort((a, b) => a - b);
  for (let i = 1; i < idxs.length; i++) {
    if (idxs[i] !== idxs[i - 1] + 1) return false;
  }
  return true;
}

function isImpureSequence(group, wildJokerRank) {
  if (group.length < 3) return false;
  const naturals = group.filter(c => !isWildJoker(c, wildJokerRank));
  const jokers = group.filter(c => isWildJoker(c, wildJokerRank));
  if (jokers.length === 0) return isConsecutiveSameSuit(group);
  if (naturals.length === 0) return false; // all jokers isn't a real sequence
  const suit = naturals[0].suit;
  if (naturals.some(c => c.suit !== suit)) return false;
  // Check naturals can fit into a consecutive run of group.length with gaps filled by jokers
  const order = RANKS;
  const idxs = naturals.map(c => order.indexOf(c.rank)).sort((a, b) => a - b);
  // naturals must be unique ranks
  if (new Set(idxs).size !== idxs.length) return false;
  const span = idxs[idxs.length - 1] - idxs[0] + 1;
  if (span > group.length) return false;
  return true;
}

function isValidSet(group, wildJokerRank) {
  // 3-4 cards, same rank, different suits (jokers can substitute)
  if (group.length < 3 || group.length > 4) return false;
  const naturals = group.filter(c => !isWildJoker(c, wildJokerRank));
  const jokers = group.filter(c => isWildJoker(c, wildJokerRank));
  if (naturals.length === 0) return false;
  const rank = naturals[0].rank;
  if (naturals.some(c => c.rank !== rank)) return false;
  const suits = new Set(naturals.map(c => c.suit));
  if (suits.size !== naturals.length) return false; // no duplicate suits among naturals
  if (naturals.length + jokers.length !== group.length) return false;
  return true;
}

function deadwoodValue(card) {
  if (card.rank === 'A') return 10; // in loose deadwood counting A is often 10 unless in valid seq; simplified here
  if (['J','Q','K','10'].includes(card.rank)) return 10;
  return RANK_VALUE[card.rank] || 0;
}

function validateDeclaration(groups, wildJokerRank) {
  let allCards = [];
  groups.forEach(g => (allCards = allCards.concat(g)));
  if (allCards.length !== 13) {
    return { valid: false, reason: `Must declare exactly 13 cards, got ${allCards.length}`, points: 80 };
  }

  let pureCount = 0;
  let sequenceCount = 0;
  let deadwood = 0;
  const groupResults = [];

  for (const group of groups) {
    if (isPureSequence(group, wildJokerRank)) {
      pureCount++;
      sequenceCount++;
      groupResults.push({ type: 'pure_sequence', cards: group });
    } else if (isImpureSequence(group, wildJokerRank)) {
      sequenceCount++;
      groupResults.push({ type: 'impure_sequence', cards: group });
    } else if (isValidSet(group, wildJokerRank)) {
      groupResults.push({ type: 'set', cards: group });
    } else {
      // invalid group -> counts as deadwood
      groupResults.push({ type: 'invalid', cards: group });
      deadwood += group.reduce((sum, c) => sum + deadwoodValue(c), 0);
    }
  }

  if (pureCount < 1) {
    return { valid: false, reason: 'No pure sequence (without joker) — invalid declare', points: 80, groupResults };
  }
  if (sequenceCount < 2) {
    return { valid: false, reason: 'Need at least 2 sequences, one pure', points: 80, groupResults };
  }

  const validGroupsDeadwood = deadwood; // deadwood only from invalid groups here since seq/sets score 0
  return { valid: true, reason: 'Valid declaration', points: 0, deadwood: validGroupsDeadwood, groupResults };
}

// Score a losing player's hand if the declare was valid (best-effort auto arrangement not included —
// caller supplies groups the player formed; unarranged leftover cards count full deadwood)
function scoreLoserHand(handGroups, wildJokerRank) {
  let deadwood = 0;
  let hasPure = false;
  for (const group of handGroups) {
    if (isPureSequence(group, wildJokerRank)) { hasPure = true; continue; }
    if (isImpureSequence(group, wildJokerRank) && hasPure) continue; // only free if pure exists
    if (isValidSet(group, wildJokerRank) && hasPure) continue;
    deadwood += group.reduce((sum, c) => sum + deadwoodValue(c), 0);
  }
  return Math.min(deadwood, 80); // cap at 80 per standard rules
}

// ---------- AUTO ARRANGE ----------
// Greedy best-effort grouping: finds pure sequences first, then impure
// sequences using available jokers, then sets from what's left, and puts
// the rest as a sorted "deadwood" group. Good enough for a "Sort" button
// and for a live points/deadwood readout — not a guaranteed optimum.

const RANK_ORDER = RANKS.reduce((m, r, i) => ((m[r] = i), m), {});

function sortHandForDisplay(hand) {
  const suitOrder = { S: 0, H: 1, D: 2, C: 3 };
  return [...hand].sort((a, b) => {
    if (a.isPrintedJoker !== b.isPrintedJoker) return a.isPrintedJoker ? 1 : -1;
    if (a.suit !== b.suit) return (suitOrder[a.suit] ?? 9) - (suitOrder[b.suit] ?? 9);
    return RANK_ORDER[a.rank] - RANK_ORDER[b.rank];
  });
}

function autoArrangeHand(hand, wildJokerRank) {
  const jokers = hand.filter(c => isWildJoker(c, wildJokerRank));
  let naturals = hand.filter(c => !isWildJoker(c, wildJokerRank));
  const groups = [];
  let jokerPool = [...jokers];

  // 1) Pull out pure sequences (runs of 3+ same suit, consecutive ranks)
  const bySuit = {};
  naturals.forEach(c => (bySuit[c.suit] = bySuit[c.suit] || []).push(c));
  Object.values(bySuit).forEach(cards => {
    cards.sort((a, b) => RANK_ORDER[a.rank] - RANK_ORDER[b.rank]);
    let run = [cards[0]];
    for (let i = 1; i <= cards.length; i++) {
      const prev = cards[i - 1];
      const cur = cards[i];
      if (cur && RANK_ORDER[cur.rank] === RANK_ORDER[prev.rank] + 1) {
        run.push(cur);
      } else {
        if (run.length >= 3) {
          groups.push(run);
          run.forEach(c => (naturals = naturals.filter(x => x.id !== c.id)));
        }
        run = cur ? [cur] : [];
      }
    }
  });

  // 2) Try to use one joker to extend/complete a near-sequence from what's left, per suit
  const bySuit2 = {};
  naturals.forEach(c => (bySuit2[c.suit] = bySuit2[c.suit] || []).push(c));
  Object.values(bySuit2).forEach(cards => {
    if (jokerPool.length === 0) return;
    cards.sort((a, b) => RANK_ORDER[a.rank] - RANK_ORDER[b.rank]);
    for (let i = 0; i < cards.length - 1 && jokerPool.length > 0; i++) {
      const gap = RANK_ORDER[cards[i + 1].rank] - RANK_ORDER[cards[i].rank] - 1;
      if (gap === 1) {
        const jk = jokerPool.pop();
        groups.push([cards[i], jk, cards[i + 1]]);
        naturals = naturals.filter(x => x.id !== cards[i].id && x.id !== cards[i + 1].id);
        break;
      }
    }
  });

  // 3) Sets: same rank, different suits
  const byRank = {};
  naturals.forEach(c => (byRank[c.rank] = byRank[c.rank] || []).push(c));
  Object.values(byRank).forEach(cards => {
    if (cards.length >= 3) {
      const set = cards.slice(0, Math.min(4, cards.length));
      groups.push(set);
      set.forEach(c => (naturals = naturals.filter(x => x.id !== c.id)));
    }
  });

  // 4) Leftover naturals + unused jokers = deadwood group, sorted for readability
  const leftover = sortHandForDisplay([...naturals, ...jokerPool]);
  if (leftover.length) groups.push(leftover);

  const deadwood = naturals.reduce((s, c) => s + deadwoodValue(c), 0);
  return { groups, deadwood };
}

module.exports = {
  buildDoubleDeckWithJokers,
  shuffle,
  dealRound,
  isWildJoker,
  validateDeclaration,
  scoreLoserHand,
  deadwoodValue,
  sortHandForDisplay,
  autoArrangeHand,
};
