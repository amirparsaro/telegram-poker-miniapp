import random
from typing import List, Tuple, Optional, Dict
from dataclasses import dataclass, field

# Card representation:
# rank: 2..14 (14 = Ace)
# suit: 's' (spades ♠), 'h' (hearts ♥), 'd' (diamonds ♦), 'c' (clubs ♣)

SUIT_SYMBOLS = {'s': '♠', 'h': '♥', 'd': '♦', 'c': '♣'}
SUIT_COLORS = {'s': 'black', 'h': 'red', 'd': 'blue', 'c': 'green'}
RANK_NAMES = {
    2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10',
    11: 'J', 12: 'Q', 13: 'K', 14: 'A'
}

def card_to_dict(card: Tuple[int, str]) -> dict:
    rank, suit = card
    return {
        "rank": rank,
        "suit": suit,
        "rank_name": RANK_NAMES.get(rank, str(rank)),
        "suit_symbol": SUIT_SYMBOLS.get(suit, suit),
        "code": f"{RANK_NAMES.get(rank, str(rank))}{suit}"
    }

class Deck:
    def __init__(self):
        self.cards: List[Tuple[int, str]] = []
        self.reset()

    def reset(self):
        self.cards = [(rank, suit) for rank in range(2, 15) for suit in ['s', 'h', 'd', 'c']]
        random.shuffle(self.cards)

    def draw(self, count: int = 1) -> List[Tuple[int, str]]:
        drawn = [self.cards.pop() for _ in range(min(count, len(self.cards)))]
        return drawn

# Hand evaluation algorithms for 7 cards (standard Texas Hold'em)
from itertools import combinations

HAND_HIGH_CARD = 0
HAND_ONE_PAIR = 1
HAND_TWO_PAIR = 2
HAND_THREE_OF_A_KIND = 3
HAND_STRAIGHT = 4
HAND_FLUSH = 5
HAND_FULL_HOUSE = 6
HAND_FOUR_OF_A_KIND = 7
HAND_STRAIGHT_FLUSH = 8
HAND_ROYAL_FLUSH = 9

HAND_DESCRIPTIONS = {
    HAND_HIGH_CARD: "High Card",
    HAND_ONE_PAIR: "One Pair",
    HAND_TWO_PAIR: "Two Pair",
    HAND_THREE_OF_A_KIND: "Three of a Kind",
    HAND_STRAIGHT: "Straight",
    HAND_FLUSH: "Flush",
    HAND_FULL_HOUSE: "Full House",
    HAND_FOUR_OF_A_KIND: "Four of a Kind",
    HAND_STRAIGHT_FLUSH: "Straight Flush",
    HAND_ROYAL_FLUSH: "Royal Flush"
}

def eval_5_cards(cards: List[Tuple[int, str]]) -> Tuple[int, List[int]]:
    ranks = sorted([c[0] for c in cards], reverse=True)
    suits = [c[1] for c in cards]
    is_flush = len(set(suits)) == 1

    unique_ranks = sorted(list(set(ranks)), reverse=True)
    is_straight = False
    straight_high = 0

    if len(unique_ranks) == 5:
        if ranks[0] - ranks[4] == 4:
            is_straight = True
            straight_high = ranks[0]
        elif ranks == [14, 5, 4, 3, 2]: # Ace-low (Wheel)
            is_straight = True
            straight_high = 5

    if is_flush and is_straight:
        if straight_high == 14:
            return (HAND_ROYAL_FLUSH, [14])
        return (HAND_STRAIGHT_FLUSH, [straight_high])

    # Count rank occurrences
    counts: Dict[int, int] = {}
    for r in ranks:
        counts[r] = counts.get(r, 0) + 1
    
    # Sort by frequency descending, then rank descending
    sorted_by_freq = sorted(counts.items(), key=lambda item: (item[1], item[0]), reverse=True)
    freqs = [item[1] for item in sorted_by_freq]
    freq_ranks = [item[0] for item in sorted_by_freq]

    if freqs == [4, 1]:
        return (HAND_FOUR_OF_A_KIND, freq_ranks)
    if freqs == [3, 2]:
        return (HAND_FULL_HOUSE, freq_ranks)
    if is_flush:
        return (HAND_FLUSH, ranks)
    if is_straight:
        return (HAND_STRAIGHT, [straight_high])
    if freqs == [3, 1, 1]:
        return (HAND_THREE_OF_A_KIND, freq_ranks)
    if freqs == [2, 2, 1]:
        return (HAND_TWO_PAIR, freq_ranks)
    if freqs == [2, 1, 1, 1]:
        return (HAND_ONE_PAIR, freq_ranks)
    return (HAND_HIGH_CARD, ranks)

def evaluate_hand(cards: List[Tuple[int, str]]) -> Tuple[int, List[int], str]:
    best_score = (-1, [])
    for combo in combinations(cards, 5):
        score = eval_5_cards(list(combo))
        if score > best_score:
            best_score = score
    rank_type, tiebreakers = best_score
    return (rank_type, tiebreakers, HAND_DESCRIPTIONS[rank_type])
