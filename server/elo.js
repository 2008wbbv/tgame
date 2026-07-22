// Standard Elo, same shape chess.com and FIDE use.

export const K_FACTOR = 32;

/** Probability that `a` beats `b`. */
export function expectedScore(a, b) {
  return 1 / (1 + 10 ** ((b - a) / 400));
}

/**
 * @param scoreA 1 = A won, 0.5 = draw, 0 = A lost
 * @returns new ratings, rounded to integers
 */
export function updateElo(ratingA, ratingB, scoreA, k = K_FACTOR) {
  const expA = expectedScore(ratingA, ratingB);
  const expB = expectedScore(ratingB, ratingA);
  return {
    a: Math.round(ratingA + k * (scoreA - expA)),
    b: Math.round(ratingB + k * (1 - scoreA - expB)),
  };
}

/**
 * Decides a race. More missions solved wins; on a tie the faster total time
 * wins; if both are still identical it is a draw.
 * @returns 1 = p1 won, 0.5 = draw, 0 = p2 won
 */
export function scoreRace(p1, p2) {
  if (p1.solved !== p2.solved) return p1.solved > p2.solved ? 1 : 0;
  if (p1.solved === 0) return 0.5; // neither did anything
  if (p1.finishedAt !== p2.finishedAt) return p1.finishedAt < p2.finishedAt ? 1 : 0;
  return 0.5;
}

export const RANKS = [
  [0, 'Intern'],
  [1000, 'Junior'],
  [1200, 'Sysadmin'],
  [1400, 'Senior'],
  [1600, 'SRE'],
  [1800, 'Principal'],
  [2000, 'Root Wizard'],
];

export function rankFor(elo) {
  let name = RANKS[0][1];
  for (const [floor, label] of RANKS) if (elo >= floor) name = label;
  return name;
}
