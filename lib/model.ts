// radar-2, the model behind Token Radar: a sealed snapshot goes in, a ranked board comes out.
//
// The board keeps every pre-token protocol the watchlist rule admits. That rule is: no token on
// record, not an exchange, not a versioned pool, and not a wrapped, staked or bridged product of a
// token that already trades. The watchlist is the floor — all 40 of its slugs are ranked — and the
// early radar adds every other protocol that clears the same rule below the floor.
//
// Implied value is read off the market, not asserted. The snapshot holds live-token protocols whose
// market caps are already set; per category, the model takes the median market-cap-to-TVL ratio of
// that category's live protocols (five or more, else the global median) and values a pre-token
// protocol at its TVL times that multiple. Three snapshot-only factors then apply:
//
//   growth    the week's TVL move, age-weighted: a 7-day print on a protocol that has run for years
//             counts more than the same print on a six-week-old one. Growth is rewarded at 0.6;
//             a decline is charged at 0.9.
//   maturity  0.5 + min(age, 1460) / 1460 x 0.7. Running for years with no token is itself the
//             signal; an unknown listing date is scored at the snapshot's own median pre-token
//             age, never at an assumed number.
//   chains    1 + 0.03 for each extra chain past the first, up to five: broader distribution.
//
//   implied = max(1, round(TVL x categoryMultiple x growthMult x maturityMult x chainsMult))
//
// No protocol name is ever special-cased. One function scores every row, and the dashboard
// recomputes each row from the same figures, so the page and board.json agree.

/** One protocol as the sealed snapshot records it: ten fields, and the model only reads them. */
export type SnapshotProtocol = {
  readonly symbol: string | null;
  readonly gecko_id: string | null;
  readonly listed_at: string | null;
  readonly mcap_usd: number | null;
  readonly change_7d: number | null;
  readonly tvl_usd: number;
  readonly chains: string[];
  readonly category: string | null;
  readonly name: string;
  readonly slug: string;
};

/** The sealed snapshot: its date, its source, its floor, its protocols and its watchlist. */
export type Snapshot = {
  readonly watchlist: string[];
  readonly protocols: SnapshotProtocol[];
  readonly floor_usd: number;
  readonly source: string;
  readonly as_of: string;
};

/** One calibration row: a category, the multiple the market gives it, and how many live protocols set it. */
export type CalibrationRow = {
  readonly live_samples: number;
  readonly multiple: number;
  readonly category: string;
};

/** The calibrated model: the multiples and the weights the dashboard states. */
export type ModelConstants = {
  readonly chain_max_extra: number;
  readonly chain_step: number;
  readonly unknown_age_days: number;
  readonly maturity_days: number;
  readonly maturity_range: number;
  readonly maturity_floor: number;
  readonly age_cap_days: number;
  readonly age_weight: number;
  readonly growth_cap: number;
  readonly growth_floor: number;
  readonly growth_down_weight: number;
  readonly growth_up_weight: number;
  readonly min_live_samples: number;
  readonly multiple_cap: number;
  readonly multiple_floor: number;
  readonly category_multiples: Record<string, number>;
  readonly global_multiple: number;
};

/** The model's version label: the dashboard names it and the rules quote it. */
export const MODEL_VERSION = 'radar-2';

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** A farm step: the action, what it costs, and how long it takes. */
export type FarmStep = {
  readonly time: string;
  readonly cost: string;
  readonly text: string;
};

/** One row of board.json: the ranked board's row. */
export type BoardRow = {
  readonly farm_steps: string[];
  readonly model: {
    readonly age_days: number | null;
    readonly chains_multiplier: number;
    readonly maturity_multiplier: number;
    readonly growth_multiplier: number;
    readonly growth_pct: number;
    readonly base_multiple: number;
  };
  readonly implied_value_usd: number;
  readonly on_watchlist: boolean;
  readonly age_days: number | null;
  readonly token_status: 'pre-token';
  readonly symbol: string | null;
  readonly gecko_id: string | null;
  readonly listed_at: string | null;
  readonly mcap_usd: number | null;
  readonly change_7d: number | null;
  readonly tvl_usd: number;
  readonly chains: string[];
  readonly category: string | null;
  readonly name: string;
  readonly slug: string;
  readonly rank: number;
};

/** The dashboard's compact view of one row, with the farm plan generated in the page. */
export type RadarRow = {
  readonly chains_multiplier: number;
  readonly maturity_multiplier: number;
  readonly growth_multiplier: number;
  readonly growth_pct: number;
  readonly base_multiple: number;
  readonly implied_value_usd: number;
  readonly on_watchlist: boolean;
  readonly age_days: number | null;
  readonly change_7d: number | null;
  readonly tvl_usd: number;
  readonly chains: string[];
  readonly category: string | null;
  readonly name: string;
  readonly slug: string;
  readonly rank: number;
};

/** A live-token protocol: it already trades, so the board shows the market's own value. */
export type LiveRow = {
  readonly mcap_tvl: number | null;
  readonly change_7d: number | null;
  readonly mcap_usd: number | null;
  readonly tvl_usd: number;
  readonly chains: string[];
  readonly category: string | null;
  readonly name: string;
  readonly slug: string;
};

/** Everything the dashboard needs: the board, the live set, the calibration and the model. */
export type RadarData = {
  readonly live: LiveRow[];
  readonly rows: RadarRow[];
  readonly calibration: CalibrationRow[];
  readonly live_size: number;
  readonly early_size: number;
  readonly board_size: number;
  readonly watchlist_size: number;
  readonly model_version: string;
  readonly model: ModelConstants;
  readonly floor_usd: number;
  readonly source: string;
  readonly as_of: string;
};

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A number the model can use, or `fallback` when the snapshot gives it none. */
function finite(value: unknown, fallback: number): number {
  if (typeof value !== 'number') return fallback;
  return Number.isFinite(value) ? value : fallback;
}

/** The middle of a list: sort it, then take the upper middle of an even list. */
function median(values: number[]): number {
  const ordered = values.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return ordered[Math.floor(ordered.length / 2)]!;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
/** The watchlist's category rule: a wrapped, staked or bridged product is not a launch of its own. */
const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
/** A whole word that marks a product of a token that already trades. */
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
/** A name that starts with an exchange's name is that exchange's product. */
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;

/** Whether a protocol is one the board may rank: pre-token and not a product of a traded token. */
export function isRankable(p: SnapshotProtocol): boolean {
  return (
    isPreToken(p) &&
    !EXCLUDED_CATEGORIES.has(p.category ?? '') &&
    !VERSIONED.test(p.name) &&
    !WRAPPED_WORD.test(p.name) &&
    !EXCHANGE_PREFIX.test(p.name)
  );
}

/**
 * The calibration, read off the snapshot itself: for every category with enough live-token
 * protocols, the median of their market-cap-to-TVL ratios; the global median for the rest. The
 * unknown-age value is the median known age of the snapshot's pre-token protocols.
 */
export function calibrate(snapshot: Snapshot): { model: ModelConstants; calibration: CalibrationRow[] } {
  const live = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
  const global = median(live.map((p) => p.mcap_usd! / p.tvl_usd));
  const byCategory = new Map<string, number[]>();
  for (const p of live) {
    const key = p.category ?? 'Other';
    const list = byCategory.get(key);
    if (list === undefined) byCategory.set(key, [p.mcap_usd! / p.tvl_usd]);
    else list.push(p.mcap_usd! / p.tvl_usd);
  }
  const categoryMultiples: Record<string, number> = {};
  const calibration: CalibrationRow[] = [];
  for (const [category, ratios] of [...byCategory.entries()].sort((a, b) => b[1].length - a[1].length)) {
    if (ratios.length < 5) continue;
    const multiple = Math.min(1, Math.max(0.05, median(ratios)));
    categoryMultiples[category] = multiple;
    calibration.push({ category, multiple: round4(multiple), live_samples: ratios.length });
  }
  const knownAges = snapshot.protocols
    .filter((p) => isPreToken(p) && p.listed_at !== null)
    .map((p) => ageDays(snapshot.as_of, p.listed_at)!)
    .filter((a) => a !== null);
  const model: ModelConstants = {
    global_multiple: round4(global),
    category_multiples: categoryMultiples,
    multiple_floor: 0.05,
    multiple_cap: 1,
    min_live_samples: 5,
    growth_up_weight: 0.6,
    growth_down_weight: 0.9,
    growth_floor: -80,
    growth_cap: 150,
    age_weight: 0.3,
    age_cap_days: 1095,
    maturity_floor: 0.5,
    maturity_range: 0.7,
    maturity_days: 1460,
    unknown_age_days: median(knownAges),
    chain_step: 0.03,
    chain_max_extra: 5,
  };
  return { model, calibration };
}

/** The multiple one category is valued at: its calibrated median, else the global median. */
function multipleFor(category: string | null, model: ModelConstants): number {
  if (category !== null && Object.hasOwn(model.category_multiples, category)) return model.category_multiples[category]!;
  return Math.min(model.multiple_cap, Math.max(model.multiple_floor, model.global_multiple));
}

/** The four multipliers and the implied value one protocol gets under `model`. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  model: ModelConstants,
): { implied: number; baseMultiple: number; growthPct: number; growthMult: number; maturityMult: number; chainsMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const ageForModel = age ?? model.unknown_age_days;
  const baseMultiple = multipleFor(protocol.category, model);
  const ageFactor = Math.min(Math.max(ageForModel, 0), model.age_cap_days) / model.age_cap_days;
  const rawGrowth = finite(protocol.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth * (1 - model.age_weight + model.age_weight * ageFactor)));
  const growthMult = 1 + (growthPct / 100) * (growthPct >= 0 ? model.growth_up_weight : model.growth_down_weight);
  const maturityMult = model.maturity_floor + (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
  const extraChains = Math.min(Math.max(protocol.chains.length - 1, 0), model.chain_max_extra);
  const chainsMult = 1 + model.chain_step * extraChains;
  const implied = Math.max(1, Math.round(protocol.tvl_usd * baseMultiple * growthMult * maturityMult * chainsMult));
  return { implied, baseMultiple, growthPct, growthMult, maturityMult, chainsMult, age };
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants): BoardRow[] {
  const index = bySlug(snapshot.protocols);
  const watchlist = new Set(snapshot.watchlist);
  const chosen = snapshot.protocols.filter((p) => isRankable(p));
  const scored = chosen.map((p) => {
    const { implied, baseMultiple, growthPct, growthMult, maturityMult, chainsMult, age } = impliedValue(p, snapshot.as_of, model);
    return { p, implied, baseMultiple, growthPct, growthMult, maturityMult, chainsMult, age };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    age_days: s.age,
    on_watchlist: watchlist.has(s.p.slug),
    implied_value_usd: s.implied,
    model: {
      // Full precision here, not rounded: the dashboard recomputes this row from the same
      // figures, and a rounded multiple would move the answer by thousands of dollars.
      base_multiple: s.baseMultiple,
      growth_pct: s.growthPct,
      growth_multiplier: s.growthMult,
      maturity_multiplier: s.maturityMult,
      chains_multiplier: s.chainsMult,
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age).map(stepText),
  }));
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's one action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one market position on ${name}.`;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** The second qualifying action: a different move on the same protocol, so the farm is not one deposit. */
function secondActionFor(p: SnapshotProtocol, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Borrow $25 of USDC against the supply on ${name} and repay it the same week, so the position shows both sides of the market.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return `Swap $25 through ${name}'s main pool once, then add what it returns to the same liquidity position.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Check ${name}'s funding rate, then close the hedge and open a fresh one half the size.`;
  if (c.includes('prediction')) return `Settle the first market on ${name}, then open a second position in a different outcome.`;
  if (c.includes('curator') || c.includes('allocator')) return `Move $25 between two of ${name}'s vaults on ${chain}, so the activity spans more than one vault.`;
  if (c.includes('stable')) return `Redeem $25 of the stable asset through ${name} and mint it again the same day.`;
  if (c.includes('rwa')) return `Read the backing attestation for the yield asset on ${name}, then top the holding up by $25.`;
  if (c.includes('insurance')) return `File a test claim on a small cover amount from ${name} and withdraw it, so the policy shows activity.`;
  if (c.includes('bridge')) return `Bridge $25 back the other way through ${name} and use the returned funds in its app.`;
  return `Repeat the deposit with $25 on a second chain ${name} runs on, so the farm is not one chain only.`;
}

/**
 * A protocol's farm plan: seven steps, each an action with a cost and a time. The plan is derived
 * from the protocol's own record (category, chains, TVL, age), never from a hand-written list of names.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const action = actionFor(p, capital, chain);
  return [
    {
      text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: action,
      cost: `$${capital} of capital and about $${capital >= 150 ? 8 : 4} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: secondActionFor(p, chain),
      cost: '$25 of capital and about $3 of gas',
      time: '10 minutes',
    },
    {
      text: `Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.`,
      cost: 'about $2 of gas a week',
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: `Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      mcap_tvl: p.mcap_usd !== null && p.tvl_usd > 0 ? round4(p.mcap_usd / p.tvl_usd) : null,
    }));
}

/** A board row's compact form for data.js, with the farm plan generated in the page. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    age_days: row.age_days,
    on_watchlist: row.on_watchlist,
    implied_value_usd: row.implied_value_usd,
    base_multiple: row.model.base_multiple,
    growth_pct: row.model.growth_pct,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    chains_multiplier: row.model.chains_multiplier,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const { model, calibration } = calibrate(snapshot);
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !r.on_watchlist).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    calibration,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

/** A snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('the snapshot is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('the snapshot is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('the snapshot has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('the snapshot has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('the snapshot has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('the snapshot has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('the snapshot has no watchlist of slugs');
  return {
    watchlist: o.watchlist as string[],
    protocols: o.protocols.map((v, i) => readProtocol(v, i)),
    floor_usd: o.floor_usd,
    source: o.source,
    as_of: o.as_of,
  };
}

/** One protocol entry out of the snapshot's array, refused unless it carries a slug, a name and a TVL. */
function readProtocol(v: unknown, i: number): SnapshotProtocol {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`protocol ${i} of the snapshot is not an object`);
  const p = v as Record<string, unknown>;
  if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
    throw new SnapshotError(`protocol ${i} of the snapshot lacks a slug, a name or a TVL`);
  }
  return {
    symbol: typeof p.symbol === 'string' ? p.symbol : null,
    gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
    listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
    mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
    change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
    tvl_usd: p.tvl_usd,
    chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
    category: typeof p.category === 'string' ? p.category : null,
    name: p.name,
    slug: p.slug,
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `${missing.length} watchlist slug${missing.length === 1 ? '' : 's'} never made the board: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `the board's rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} carries ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
