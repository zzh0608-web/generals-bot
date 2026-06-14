interface Env {
  GENERALS_BASE_URL?: string;
  COUNT_PER_PAGE?: string;
  PLAYER_MAX_PAGES?: string;
  RECENT_MAX_PAGES?: string;
  RECENT_PROFILE_LIMIT?: string;
  PAGE_BATCH_SIZE?: string;
  PROFILE_BATCH_SIZE?: string;
  PROFILE_ALIAS_LIMIT?: string;
}

type ModeName = "duel" | "ffa" | "bigteam" | "custom";

interface Player {
  name: string;
  currentName: string;
  stars: number | null;
  kills: number | null;
}

interface Replay {
  raw: Record<string, unknown>;
  replayId: string;
  startedMs: number | null;
  replayType: string;
  ladderId: string;
  ranking: Player[];
}

interface FetchResult {
  replays: Replay[];
  pages: number;
  truncated: boolean;
  reason: string;
  elapsedMs: number;
}

interface Limits {
  countPerPage: number;
  playerMaxPages: number;
  recentMaxPages: number;
  recentProfileLimit: number;
  pageBatchSize: number;
  profileBatchSize: number;
  profileAliasLimit: number;
}

interface ProfileInfo {
  username: string;
  stars: Record<string, number | null>;
  ranks: Record<string, number | null>;
  found: boolean;
}

interface OpponentStats {
  name: string;
  games: number;
  wins: number;
  losses: number;
  myFirst: number;
  oppFirst: number;
  bestReplayStars: number | null;
  latestMs: number | null;
  modes: string[];
}

interface RecentGameRow {
  replayId: string;
  startedMs: number | null;
  mode: string;
  result: string;
  rank: string;
  myStars: number | null;
  strongestOpponent: string;
  strongestStars: number | null;
}

interface PeriodStats {
  kind: "period";
  username: string;
  label: string;
  mode: string | null;
  profile: ProfileInfo;
  summary: {
    total: number;
    wins: number;
    losses: number;
    winRate: number | null;
  };
  modes: Array<{
    mode: string;
    title: string;
    total: number;
    wins: number;
    losses: number;
    winRate: number | null;
  }>;
  opponents: OpponentStats[];
  recentGames: RecentGameRow[];
  fetched: FetchResultSummary;
  warnings: string[];
}

interface FetchResultSummary {
  pages: number;
  truncated: boolean;
  reason: string;
  elapsedMs: number;
}

interface RecentPlayerRow {
  name: string;
  currentStars: number | null;
  replayStars: number | null;
  games: number;
  latestMs: number | null;
}

class ApiError extends Error {
  constructor(message: string, readonly status = 500) {
    super(message);
    this.name = "ApiError";
  }
}

const DEFAULT_BASE_URL = "https://generals.io";
const USER_AGENT = "generals-stats-worker/1.0 (+https://workers.cloudflare.com)";
const MAIN_LADDERS = ["duel", "ffa", "bigteam"];
const MEMORY_CACHE_MAX = 600;

const MODE_CONFIG: Record<ModeName, { title: string; ladder: string | null; types: string[]; ladders: string[] }> = {
  duel: {
    title: "1v1",
    ladder: "duel",
    types: ["1v1", "duel"],
    ladders: ["duel"],
  },
  ffa: {
    title: "FFA",
    ladder: "ffa",
    types: ["classic", "ffa"],
    ladders: ["ffa"],
  },
  bigteam: {
    title: "BigTeam",
    ladder: "bigteam",
    types: ["bigteam", "big_team", "big-team"],
    ladders: ["bigteam"],
  },
  custom: {
    title: "Custom",
    ladder: null,
    types: ["custom", "private", "custom map"],
    ladders: ["custom"],
  },
};

const memoryCache = new Map<string, { expiresAt: number; data: unknown }>();

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    try {
      if (url.pathname.startsWith("/api/")) {
        return await handleApi(request, env);
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        return jsonError("Method not allowed", 405);
      }

      return new Response(HOME_HTML, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          ...securityHeaders(),
        },
      });
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 500;
      const message = error instanceof Error ? error.message : "Unknown error";
      return jsonError(message, status);
    }
  },
} satisfies ExportedHandler<Env>;

async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (request.method !== "GET") {
    return jsonError("Only GET is supported", 405);
  }

  const path = url.pathname;
  const limits = readLimits(env);
  const generatedAt = Date.now();

  if (path === "/api/health") {
    return jsonOk({ ok: true, generatedAt, service: "generals-stats-worker", limits });
  }

  if (path === "/api/profile") {
    const username = readName(url, "username");
    const profile = await profileInfo(env, username);
    return jsonOk({ ok: true, generatedAt, query: { username }, data: profile });
  }

  if (path === "/api/today") {
    const username = readName(url, "username");
    const hours = readInt(url, "hours", 24, 1, 24 * 365);
    const sinceMs = Date.now() - hours * 60 * 60 * 1000;
    const data = await playerPeriodStats(env, limits, username, sinceMs, `过去 ${hours} 小时游戏数据`, null);
    return jsonOk({ ok: true, generatedAt, query: { username, hours }, data });
  }

  if (path === "/api/winrate") {
    const username = readName(url, "username");
    const days = readInt(url, "days", 30, 1, 3650);
    const mode = normalizeMode(readString(url, "mode", "duel"));
    const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
    const data = await playerPeriodStats(env, limits, username, sinceMs, `最近 ${days} 天`, mode);
    return jsonOk({ ok: true, generatedAt, query: { username, days, mode }, data });
  }

  if (path === "/api/duel") {
    const p1 = readName(url, "p1");
    const p2 = readName(url, "p2");
    const days = readInt(url, "days", 90, 1, 3650);
    const data = await duelStats(env, limits, p1, p2, days);
    return jsonOk({ ok: true, generatedAt, query: { p1, p2, days }, data });
  }

  if (path === "/api/recent") {
    const mode = normalizeMode(readString(url, "mode", "duel"));
    if (mode === "custom") {
      throw new ApiError("recent does not support custom mode", 400);
    }
    const minutes = readInt(url, "minutes", 60, 1, 7 * 24 * 60);
    const limit = readInt(url, "limit", 10, 1, 100);
    const data = await recentTopStats(env, limits, mode, minutes, limit);
    return jsonOk({ ok: true, generatedAt, query: { mode, minutes, limit }, data });
  }

  return jsonError("Unknown API route", 404);
}

function readLimits(env: Env): Limits {
  return {
    countPerPage: envInt(env.COUNT_PER_PAGE, 200, 20, 200),
    playerMaxPages: envInt(env.PLAYER_MAX_PAGES, 10, 1, 80),
    recentMaxPages: envInt(env.RECENT_MAX_PAGES, 8, 1, 200),
    recentProfileLimit: envInt(env.RECENT_PROFILE_LIMIT, 36, 1, 600),
    pageBatchSize: envInt(env.PAGE_BATCH_SIZE, 4, 1, 6),
    profileBatchSize: envInt(env.PROFILE_BATCH_SIZE, 5, 1, 6),
    profileAliasLimit: envInt(env.PROFILE_ALIAS_LIMIT, 1, 1, 4),
  };
}

function envInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function readString(url: URL, key: string, fallback = ""): string {
  const value = url.searchParams.get(key);
  return value === null ? fallback : value.trim();
}

function readName(url: URL, key: string): string {
  const value = readString(url, key);
  if (!value) throw new ApiError(`Missing ${key}`, 400);
  if (value.length > 80) throw new ApiError(`${key} is too long`, 400);
  return value;
}

function readInt(url: URL, key: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(key);
  if (raw === null || raw.trim() === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) throw new ApiError(`${key} must be an integer`, 400);
  if (value < min || value > max) throw new ApiError(`${key} must be between ${min} and ${max}`, 400);
  return value;
}

function normalizeMode(raw: string): ModeName {
  const value = raw.trim().toLowerCase();
  if (value === "1v1") return "duel";
  if (value === "big") return "bigteam";
  if (value in MODE_CONFIG) return value as ModeName;
  throw new ApiError("mode must be one of duel, 1v1, ffa, bigteam, big, custom", 400);
}

async function playerPeriodStats(
  env: Env,
  limits: Limits,
  username: string,
  sinceMs: number,
  label: string,
  mode: ModeName | null,
): Promise<PeriodStats> {
  const [profile, fetched] = await Promise.all([
    profileInfo(env, username).catch(() => emptyProfile(username)),
    fetchPlayerReplays(env, limits, username, sinceMs, null),
  ]);

  const games = mode ? fetched.replays.filter((replay) => isMode(replay, mode)) : fetched.replays;
  const summary = winCounts(games, username);
  const warnings: string[] = [];
  if (fetched.truncated) {
    warnings.push(`查询已提前停止：${fetched.reason}。结果基于已获取的数据统计。`);
  }
  if (summary.total === 0 && !profile.found) {
    warnings.push("未能确认该用户存在，或该用户在当前范围内没有可用 replay。");
  }

  return {
    kind: "period",
    username,
    label,
    mode,
    profile,
    summary,
    modes: modeStats(games, username),
    opponents: opponentStats(games, username, 5),
    recentGames: recentGames(games, username, 6),
    fetched: summarizeFetch(fetched),
    warnings,
  };
}

async function duelStats(env: Env, limits: Limits, p1: string, p2: string, days: number) {
  const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const [p1Profile, p2Profile, fetched] = await Promise.all([
    profileInfo(env, p1).catch(() => emptyProfile(p1)),
    profileInfo(env, p2).catch(() => emptyProfile(p2)),
    fetchPlayerReplays(env, limits, p1, sinceMs, null),
  ]);

  const games = fetched.replays.filter((replay) => playerInReplay(replay, p2) && ["duel", "custom"].includes(modeKey(replay)));
  const p1Wins = games.filter((replay) => {
    const winner = replayWinner(replay);
    return winner !== null && playerMatches(winner, p1);
  }).length;
  const p2Wins = games.filter((replay) => {
    const winner = replayWinner(replay);
    return winner !== null && playerMatches(winner, p2);
  }).length;
  const decisive = p1Wins + p2Wins;
  const other = games.length - decisive;
  const warnings: string[] = [];

  if (fetched.truncated) {
    warnings.push(`查询已提前停止：${fetched.reason}。结果基于已获取的数据统计。`);
  }
  if (!p1Profile.found) warnings.push(`未能确认玩家存在：${p1}`);
  if (!p2Profile.found) warnings.push(`未能确认玩家存在：${p2}`);

  return {
    kind: "duel",
    p1,
    p2,
    days,
    profiles: { p1: p1Profile, p2: p2Profile },
    summary: {
      games: games.length,
      p1Wins,
      p2Wins,
      p1WinRate: rate(p1Wins, decisive),
      p2WinRate: rate(p2Wins, decisive),
      other,
    },
    byMode: ["duel", "custom"].map((mode) => {
      const subset = games.filter((replay) => modeKey(replay) === mode);
      const a = subset.filter((replay) => {
        const winner = replayWinner(replay);
        return winner !== null && playerMatches(winner, p1);
      }).length;
      const b = subset.filter((replay) => {
        const winner = replayWinner(replay);
        return winner !== null && playerMatches(winner, p2);
      }).length;
      return {
        mode,
        title: modeTitle(mode),
        total: subset.length,
        p1Wins: a,
        p2Wins: b,
        p1WinRate: rate(a, a + b),
        p2WinRate: rate(b, a + b),
      };
    }),
    recentGames: games.slice(0, 8).map((replay) => {
      const p1InGame = playerInReplay(replay, p1);
      const p2InGame = playerInReplay(replay, p2);
      const winner = replayWinner(replay);
      let result = winner?.name ?? "?";
      if (winner && playerMatches(winner, p1)) result = `${p1} 胜`;
      else if (winner && playerMatches(winner, p2)) result = `${p2} 胜`;
      else if (winner) result = `第一名 ${playerDisplay(winner)}`;
      return {
        replayId: replay.replayId,
        startedMs: replay.startedMs,
        mode: modeTitle(modeKey(replay)),
        result,
        p1Stars: p1InGame?.stars ?? null,
        p2Stars: p2InGame?.stars ?? null,
      };
    }),
    fetched: summarizeFetch(fetched),
    warnings,
  };
}

async function recentTopStats(env: Env, limits: Limits, mode: ModeName, minutes: number, topN: number) {
  const sinceMs = Date.now() - minutes * 60 * 1000;
  const fetched = await fetchRecentReplaysSince(env, limits, sinceMs);
  const replays = fetched.replays.filter((replay) => isMode(replay, mode));
  const players = new Map<string, { name: string; games: number; replayStars: number | null; currentStars: number | null; latestMs: number | null; aliases: Set<string> }>();

  for (const replay of replays) {
    for (const player of replay.ranking) {
      const name = playerDisplay(player);
      if (!name) continue;
      const key = canon(name);
      if (!key) continue;
      const rec = players.get(key) ?? {
        name,
        games: 0,
        replayStars: null,
        currentStars: null,
        latestMs: null,
        aliases: new Set<string>(),
      };
      rec.games += 1;
      if (player.stars !== null && (rec.replayStars === null || player.stars > rec.replayStars)) {
        rec.replayStars = player.stars;
      }
      for (const alias of [player.currentName, player.name, name]) {
        if (alias) rec.aliases.add(alias);
      }
      if (replay.startedMs !== null && (rec.latestMs === null || replay.startedMs > rec.latestMs)) {
        rec.latestMs = replay.startedMs;
        rec.name = name;
      }
      players.set(key, rec);
    }
  }

  const allPlayers = Array.from(players.values());
  const candidateLimit = Math.min(allPlayers.length, limits.recentProfileLimit);
  const candidates = allPlayers
    .sort((a, b) => (b.latestMs ?? 0) - (a.latestMs ?? 0) || b.games - a.games)
    .slice(0, candidateLimit);

  const ladder = MODE_CONFIG[mode].ladder;
  await mapInBatches(candidates, limits.profileBatchSize, async (candidate) => {
    candidate.currentStars = await lookupCurrentStar(env, candidate.name, candidate.aliases, ladder, limits.profileAliasLimit);
  });

  const ranked = candidates
    .filter((player) => player.currentStars !== null)
    .sort((a, b) => (b.currentStars ?? -1) - (a.currentStars ?? -1) || b.games - a.games || (b.latestMs ?? 0) - (a.latestMs ?? 0))
    .slice(0, topN);

  const warnings: string[] = [];
  if (fetched.truncated) {
    warnings.push(`查询已提前停止：${fetched.reason}。结果基于已获取的数据统计。`);
  }
  if (allPlayers.length > candidates.length) {
    warnings.push(`为控制 Worker 请求数，只补查最近活跃的 ${candidates.length} 名玩家当前星数；未补查者不参与当前星排名。`);
  }
  const missingProfiles = candidates.filter((player) => player.currentStars === null).length;
  if (missingProfiles > 0) {
    warnings.push(`${missingProfiles} 名候选无法取得该模式当前星数，已排除，避免使用旧 replay 星数误排。`);
  }

  return {
    kind: "recent",
    mode,
    title: modeTitle(mode),
    minutes,
    topN,
    overview: {
      games: replays.length,
      players: allPlayers.length,
      checkedProfiles: candidates.length,
      missingProfiles,
    },
    players: ranked.map<RecentPlayerRow>((player) => ({
      name: player.name,
      currentStars: player.currentStars,
      replayStars: player.replayStars,
      games: player.games,
      latestMs: player.latestMs,
    })),
    fetched: summarizeFetch(fetched),
    warnings,
  };
}

async function fetchPlayerReplays(
  env: Env,
  limits: Limits,
  username: string,
  sinceMs: number | null,
  beforeMs: number | null,
): Promise<FetchResult> {
  const started = Date.now();
  const offsets = Array.from({ length: limits.playerMaxPages }, (_, index) => index * limits.countPerPage);
  const collected: Replay[] = [];
  let pages = 0;
  let truncated = false;
  let reason = "";
  let stoppedBeforeLimit = false;

  for (let index = 0; index < offsets.length; index += limits.pageBatchSize) {
    const batch = offsets.slice(index, index + limits.pageBatchSize);
    const results = await Promise.all(batch.map((offset) => fetchPlayerPage(env, limits, username, offset, sinceMs, beforeMs)));
    let stop = false;
    for (const page of results.sort((a, b) => a.offset - b.offset)) {
      pages += 1;
      collected.push(...page.replays);
      if (page.rawCount < limits.countPerPage) stop = true;
      if (sinceMs !== null && page.startedMs.length > 0 && Math.min(...page.startedMs) < sinceMs) stop = true;
    }
    if (stop) {
      stoppedBeforeLimit = true;
      break;
    }
  }

  if (!stoppedBeforeLimit && pages >= limits.playerMaxPages) {
    truncated = true;
    reason = `达到最大分页 ${limits.playerMaxPages} 页`;
  }

  const seen = new Set<string>();
  const unique: Replay[] = [];
  for (const replay of collected) {
    const key = `${replay.replayId}:${replay.startedMs ?? 0}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(replay);
  }
  unique.sort((a, b) => (b.startedMs ?? 0) - (a.startedMs ?? 0));

  return {
    replays: unique,
    pages,
    truncated,
    reason,
    elapsedMs: Date.now() - started,
  };
}

async function fetchPlayerPage(
  env: Env,
  limits: Limits,
  username: string,
  offset: number,
  sinceMs: number | null,
  beforeMs: number | null,
): Promise<{ offset: number; rawCount: number; replays: Replay[]; startedMs: number[] }> {
  const params: Record<string, string | number> = { u: username, offset, count: limits.countPerPage };
  if (sinceMs !== null) params.startedAfter = sinceMs;
  if (beforeMs !== null) params.startedBefore = beforeMs;

  const data = await generalsJson(env, "/api/replaysForUsername", params, 45);
  const raw = Array.isArray(data) ? data : [];
  const parsed = raw.filter(isRecord).map(parseReplay);
  const startedMs = parsed.map((replay) => replay.startedMs).filter((value): value is number => value !== null);
  const replays = parsed.filter((replay) => {
    if (sinceMs !== null && replay.startedMs !== null && replay.startedMs < sinceMs) return false;
    if (beforeMs !== null && replay.startedMs !== null && replay.startedMs >= beforeMs) return false;
    return Boolean(playerInReplay(replay, username));
  });

  return { offset, rawCount: raw.length, replays, startedMs };
}

async function fetchRecentReplaysSince(env: Env, limits: Limits, sinceMs: number): Promise<FetchResult> {
  const started = Date.now();
  const offsets = Array.from({ length: limits.recentMaxPages }, (_, index) => index * limits.countPerPage);
  const collected: Replay[] = [];
  let pages = 0;
  let truncated = false;
  let reason = "";
  let stoppedBeforeLimit = false;

  for (let index = 0; index < offsets.length; index += limits.pageBatchSize) {
    const batch = offsets.slice(index, index + limits.pageBatchSize);
    const results = await Promise.all(batch.map((offset) => fetchRecentPage(env, limits, offset)));
    let stop = false;

    for (const page of results.sort((a, b) => a.offset - b.offset)) {
      pages += 1;
      for (const replay of page.replays) {
        if (replay.startedMs === null || replay.startedMs >= sinceMs) {
          collected.push(replay);
        }
      }
      if (page.rawCount < limits.countPerPage) stop = true;
      if (page.startedMs.length > 0 && Math.min(...page.startedMs) < sinceMs) stop = true;
    }

    if (stop) {
      stoppedBeforeLimit = true;
      break;
    }
  }

  if (!stoppedBeforeLimit && pages >= limits.recentMaxPages) {
    truncated = true;
    reason = `达到最大分页 ${limits.recentMaxPages} 页`;
  }

  collected.sort((a, b) => (b.startedMs ?? 0) - (a.startedMs ?? 0));
  return {
    replays: collected,
    pages,
    truncated,
    reason,
    elapsedMs: Date.now() - started,
  };
}

async function fetchRecentPage(
  env: Env,
  limits: Limits,
  offset: number,
): Promise<{ offset: number; rawCount: number; replays: Replay[]; startedMs: number[] }> {
  const data = await generalsJson(env, "/api/replays", { count: limits.countPerPage, offset }, 20);
  const raw = Array.isArray(data) ? data : [];
  const replays = raw.filter(isRecord).map(parseReplay);
  const startedMs = replays.map((replay) => replay.startedMs).filter((value): value is number => value !== null);
  return { offset, rawCount: raw.length, replays, startedMs };
}

async function profileInfo(env: Env, username: string): Promise<ProfileInfo> {
  const data = await generalsJson(env, "/api/starsAndRanks", { u: username, client: "true" }, 180);
  const obj = isRecord(data) ? data : {};
  const starsObj = isRecord(obj.stars) ? obj.stars : {};
  const ranksObj = isRecord(obj.ranks) ? obj.ranks : {};
  const stars: Record<string, number | null> = {};
  const ranks: Record<string, number | null> = {};

  for (const ladder of MAIN_LADDERS) {
    stars[ladder] = toFloat(starsObj[ladder]);
    ranks[ladder] = toIntOrNull(ranksObj[ladder]);
  }

  return {
    username,
    stars,
    ranks,
    found: Object.values(stars).some((value) => value !== null) || Object.values(ranks).some((value) => value !== null),
  };
}

function emptyProfile(username: string): ProfileInfo {
  return {
    username,
    stars: { duel: null, ffa: null, bigteam: null },
    ranks: { duel: null, ffa: null, bigteam: null },
    found: false,
  };
}

async function lookupCurrentStar(
  env: Env,
  name: string,
  aliases: Set<string>,
  ladder: string | null,
  aliasLimit: number,
): Promise<number | null> {
  if (!ladder) return null;
  const ordered = uniqueStrings([name, ...Array.from(aliases)]).slice(0, aliasLimit);
  for (const candidate of ordered) {
    try {
      const profile = await profileInfo(env, candidate);
      const star = profile.stars[ladder];
      if (star !== null) return star;
    } catch {
      // Try the next known alias.
    }
  }
  return null;
}

async function generalsJson(
  env: Env,
  path: string,
  params: Record<string, string | number | boolean | null | undefined>,
  cacheTtlSeconds: number,
): Promise<unknown> {
  const base = (env.GENERALS_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const url = new URL(path, base);

  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }

  const cacheKey = url.toString();
  const cached = memoryCache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.data;
  }

  const response = await fetch(cacheKey, {
    headers: {
      "accept": "application/json,text/plain,*/*",
      "referer": "https://generals.io/",
      "user-agent": USER_AGENT,
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new ApiError(`generals.io HTTP ${response.status}: ${body.slice(0, 180)}`, 502);
  }

  const text = await response.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ApiError(`generals.io returned non-JSON response: ${text.slice(0, 180)}`, 502);
  }

  remember(cacheKey, data, cacheTtlSeconds);
  return data;
}

function remember(key: string, data: unknown, ttlSeconds: number): void {
  if (memoryCache.size >= MEMORY_CACHE_MAX) {
    const first = memoryCache.keys().next().value;
    if (first) memoryCache.delete(first);
  }
  memoryCache.set(key, { data, expiresAt: Date.now() + ttlSeconds * 1000 });
}

function parseReplay(obj: Record<string, unknown>): Replay {
  const ranking: Player[] = [];
  const rawRanking = obj.ranking;

  if (Array.isArray(rawRanking)) {
    for (const item of rawRanking) {
      if (isRecord(item)) {
        const name = stringValue(item.name ?? item.username ?? item.currentName ?? item.current_name);
        const currentName = stringValue(item.currentName ?? item.current_name);
        const stars = toFloat(item.stars);
        const kills = toIntOrNull(item.kills);
        if (name || currentName) {
          ranking.push({ name: name || currentName, currentName, stars, kills });
        }
      } else if (typeof item === "string") {
        ranking.push({ name: item, currentName: "", stars: null, kills: null });
      }
    }
  }

  if (ranking.length === 0 && Array.isArray(obj.usernames)) {
    const stars = Array.isArray(obj.stars) ? obj.stars : [];
    obj.usernames.forEach((name, index) => {
      const display = stringValue(name);
      if (display) {
        ranking.push({
          name: display,
          currentName: "",
          stars: index < stars.length ? toFloat(stars[index]) : null,
          kills: null,
        });
      }
    });
  }

  const replay: Replay = {
    raw: obj,
    replayId: stringValue(obj.id ?? obj.replay_id),
    startedMs: toMs(obj.started ?? obj.start ?? obj.startedAt ?? obj.timestamp),
    replayType: stringValue(obj.type ?? obj.game_type ?? obj.gameType).trim().toLowerCase(),
    ladderId: stringValue(obj.ladder_id ?? obj.ladder).trim().toLowerCase(),
    ranking,
  };

  return replay;
}

function modeKey(replay: Replay): string {
  const type = replay.replayType.toLowerCase();
  const ladder = replay.ladderId.toLowerCase();

  for (const [key, config] of Object.entries(MODE_CONFIG)) {
    if (config.types.includes(type) || config.ladders.includes(ladder)) {
      return key;
    }
  }

  return type || ladder || "unknown";
}

function modeTitle(key: string): string {
  return key in MODE_CONFIG ? MODE_CONFIG[key as ModeName].title : key;
}

function isMode(replay: Replay, mode: ModeName): boolean {
  return modeKey(replay) === mode;
}

function playerIndex(replay: Replay, username: string): number | null {
  const index = replay.ranking.findIndex((player) => playerMatches(player, username));
  return index >= 0 ? index : null;
}

function playerInReplay(replay: Replay, username: string): Player | null {
  const index = playerIndex(replay, username);
  return index === null ? null : replay.ranking[index];
}

function replayWinner(replay: Replay): Player | null {
  return replay.ranking[0] ?? null;
}

function playerMatches(player: Player, username: string): boolean {
  const target = canon(username);
  return canon(player.name) === target || canon(player.currentName) === target;
}

function playerDisplay(player: Player): string {
  return player.currentName || player.name;
}

function winCounts(games: Replay[], username: string) {
  let total = 0;
  let wins = 0;
  let losses = 0;

  for (const replay of games) {
    const won = playerWonWithWinner(replay, username);
    if (won === null) continue;
    total += 1;
    if (won) wins += 1;
    else losses += 1;
  }

  return { total, wins, losses, winRate: rate(wins, total) };
}

function playerWonWithWinner(replay: Replay, username: string): boolean | null {
  if (playerIndex(replay, username) === null) return null;
  const winner = replayWinner(replay);
  return winner ? playerMatches(winner, username) : false;
}

function modeStats(games: Replay[], username: string): PeriodStats["modes"] {
  const stats = new Map<string, { total: number; wins: number; losses: number }>();

  for (const replay of games) {
    const won = playerWonWithWinner(replay, username);
    if (won === null) continue;
    const key = modeKey(replay);
    const current = stats.get(key) ?? { total: 0, wins: 0, losses: 0 };
    current.total += 1;
    if (won) current.wins += 1;
    else current.losses += 1;
    stats.set(key, current);
  }

  return Array.from(stats.entries())
    .sort((a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0]))
    .map(([mode, item]) => ({
      mode,
      title: modeTitle(mode),
      total: item.total,
      wins: item.wins,
      losses: item.losses,
      winRate: rate(item.wins, item.total),
    }));
}

function opponentStats(games: Replay[], username: string, topN: number): OpponentStats[] {
  const stats = new Map<string, OpponentStats>();

  for (const replay of games) {
    const myIndex = playerIndex(replay, username);
    if (myIndex === null) continue;
    const keyMode = modeKey(replay);

    replay.ranking.forEach((player, index) => {
      if (index === myIndex || playerMatches(player, username)) return;
      const name = playerDisplay(player);
      if (!name) return;
      const key = canon(name);
      const rec = stats.get(key) ?? {
        name,
        games: 0,
        wins: 0,
        losses: 0,
        myFirst: 0,
        oppFirst: 0,
        bestReplayStars: null,
        latestMs: null,
        modes: [],
      };

      rec.games += 1;
      if (myIndex < index) rec.wins += 1;
      else if (myIndex > index) rec.losses += 1;
      if (myIndex === 0) rec.myFirst += 1;
      if (index === 0) rec.oppFirst += 1;
      if (!rec.modes.includes(keyMode)) rec.modes.push(keyMode);
      if (player.stars !== null && (rec.bestReplayStars === null || player.stars > rec.bestReplayStars)) {
        rec.bestReplayStars = player.stars;
      }
      if (replay.startedMs !== null && (rec.latestMs === null || replay.startedMs > rec.latestMs)) {
        rec.latestMs = replay.startedMs;
        rec.name = name;
      }

      stats.set(key, rec);
    });
  }

  return Array.from(stats.values())
    .sort((a, b) => (b.bestReplayStars ?? -1) - (a.bestReplayStars ?? -1) || b.games - a.games || (b.latestMs ?? 0) - (a.latestMs ?? 0))
    .slice(0, topN);
}

function recentGames(games: Replay[], username: string, limit: number): RecentGameRow[] {
  return games.slice(0, limit).map((replay) => {
    const my = playerInReplay(replay, username);
    const myIndex = playerIndex(replay, username);
    const strongest = replay.ranking
      .filter((player) => !playerMatches(player, username))
      .sort((a, b) => (b.stars ?? -1) - (a.stars ?? -1))[0] ?? null;
    const result = playerWonWithWinner(replay, username) ? "胜" : "负";
    return {
      replayId: replay.replayId,
      startedMs: replay.startedMs,
      mode: modeTitle(modeKey(replay)),
      result,
      rank: myIndex === null ? "?" : `第 ${myIndex + 1}/${replay.ranking.length}`,
      myStars: my?.stars ?? null,
      strongestOpponent: strongest ? playerDisplay(strongest) : "?",
      strongestStars: strongest?.stars ?? null,
    };
  });
}

function summarizeFetch(result: FetchResult): FetchResultSummary {
  return {
    pages: result.pages,
    truncated: result.truncated,
    reason: result.reason,
    elapsedMs: result.elapsedMs,
  };
}

function rate(part: number, total: number): number | null {
  return total > 0 ? part / total : null;
}

function canon(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean).join(" ");
}

function toFloat(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function toIntOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number.parseInt(String(value), 10);
  return Number.isFinite(number) ? number : null;
}

function toMs(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") {
    return value < 10_000_000_000 ? Math.trunc(value * 1000) : Math.trunc(value);
  }
  const text = String(value).trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) {
    const number = Number(text);
    return number < 10_000_000_000 ? number * 1000 : number;
  }
  const parsed = Date.parse(text.endsWith("Z") ? text : text.replace(" ", "T"));
  return Number.isFinite(parsed) ? parsed : null;
}

function stringValue(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const text = String(value || "").trim();
    const key = canon(text);
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

async function mapInBatches<T>(items: T[], batchSize: number, mapper: (item: T) => Promise<void>): Promise<void> {
  for (let index = 0; index < items.length; index += batchSize) {
    await Promise.all(items.slice(index, index + batchSize).map(mapper));
  }
}

function jsonOk(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...corsHeaders(),
      ...securityHeaders(),
    },
  });
}

function jsonError(message: string, status = 500): Response {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...corsHeaders(),
      ...securityHeaders(),
    },
  });
}

function corsHeaders(): HeadersInit {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type",
  };
}

function securityHeaders(): HeadersInit {
  return {
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
  };
}

const HOME_HTML = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Generals.io Stats</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f8f6;
      --surface: #ffffff;
      --ink: #171815;
      --muted: #676b61;
      --line: #dadfd6;
      --soft: #eef2ec;
      --accent: #00a676;
      --accent-dark: #007a58;
      --danger: #bd3d2a;
      --warn: #946300;
      --shadow: 0 18px 55px rgba(26, 31, 26, 0.10);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
    }

    button,
    input,
    select {
      font: inherit;
    }

    .shell {
      min-height: 100svh;
      display: grid;
      grid-template-rows: auto 1fr;
    }

    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 18px;
      padding: 18px clamp(18px, 4vw, 54px);
      border-bottom: 1px solid rgba(23, 24, 21, 0.08);
      background: rgba(247, 248, 246, 0.88);
      backdrop-filter: blur(14px);
      position: sticky;
      top: 0;
      z-index: 10;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
    }

    .mark {
      width: 32px;
      height: 32px;
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 3px;
    }

    .mark span {
      background: var(--ink);
      border-radius: 3px;
    }

    .mark span:nth-child(2),
    .mark span:nth-child(5),
    .mark span:nth-child(7) {
      background: var(--accent);
    }

    .brand h1 {
      margin: 0;
      font-size: 18px;
      line-height: 1;
    }

    .brand p {
      margin: 3px 0 0;
      color: var(--muted);
      font-size: 12px;
    }

    .top-actions {
      display: flex;
      gap: 10px;
      align-items: center;
    }

    .status {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 11px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: var(--surface);
      color: var(--muted);
      font-size: 13px;
      white-space: nowrap;
    }

    .status::before {
      content: "";
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--accent);
      box-shadow: 0 0 0 5px rgba(0, 166, 118, 0.14);
    }

    .layout {
      display: grid;
      grid-template-columns: minmax(280px, 0.78fr) minmax(0, 1.22fr);
      gap: clamp(22px, 4vw, 54px);
      padding: clamp(24px, 5vw, 64px);
      align-items: start;
    }

    .intro {
      position: sticky;
      top: 96px;
      min-height: calc(100svh - 150px);
      display: grid;
      align-content: space-between;
      gap: 32px;
    }

    .intro-copy {
      animation: rise 520ms ease both;
    }

    .eyebrow {
      margin: 0 0 14px;
      color: var(--accent-dark);
      font-weight: 700;
      font-size: 13px;
    }

    .intro h2 {
      margin: 0;
      max-width: 12ch;
      font-size: clamp(44px, 8vw, 86px);
      line-height: 0.92;
      letter-spacing: 0;
    }

    .intro .lead {
      max-width: 520px;
      margin: 22px 0 0;
      color: var(--muted);
      font-size: 18px;
      line-height: 1.65;
    }

    .map-plane {
      display: grid;
      grid-template-columns: repeat(8, minmax(18px, 1fr));
      gap: 8px;
      max-width: 520px;
      padding: 14px;
      border: 1px solid var(--line);
      background: var(--surface);
      box-shadow: var(--shadow);
      transform: rotate(-1deg);
      animation: floatIn 720ms ease both;
    }

    .tile {
      aspect-ratio: 1;
      background: var(--soft);
      border-radius: 5px;
      transition: transform 160ms ease, background 160ms ease;
    }

    .tile:nth-child(5n),
    .tile:nth-child(17),
    .tile:nth-child(38) {
      background: #dfe9e2;
    }

    .tile:nth-child(12),
    .tile:nth-child(29),
    .tile:nth-child(44) {
      background: var(--accent);
      transform: scale(1.04);
    }

    .tile:hover {
      transform: translateY(-2px);
      background: #cfdad1;
    }

    .workspace {
      display: grid;
      gap: 18px;
      animation: rise 640ms 80ms ease both;
    }

    .tabs {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      border: 1px solid var(--line);
      background: var(--surface);
      padding: 4px;
      border-radius: 8px;
      box-shadow: 0 10px 24px rgba(26, 31, 26, 0.06);
    }

    .tab {
      border: 0;
      border-radius: 6px;
      padding: 11px 12px;
      background: transparent;
      color: var(--muted);
      cursor: pointer;
      transition: background 160ms ease, color 160ms ease, transform 160ms ease;
    }

    .tab:hover {
      color: var(--ink);
    }

    .tab.active {
      color: var(--surface);
      background: var(--ink);
    }

    .tool {
      border: 1px solid var(--line);
      background: var(--surface);
      box-shadow: var(--shadow);
      border-radius: 8px;
      overflow: hidden;
    }

    .forms {
      padding: 22px;
      border-bottom: 1px solid var(--line);
    }

    .form {
      display: none;
      grid-template-columns: repeat(12, 1fr);
      gap: 12px;
      align-items: end;
    }

    .form.active {
      display: grid;
    }

    .field {
      display: grid;
      gap: 7px;
    }

    .field.span-2 { grid-column: span 2; }
    .field.span-3 { grid-column: span 3; }
    .field.span-4 { grid-column: span 4; }
    .field.span-5 { grid-column: span 5; }
    .field.span-6 { grid-column: span 6; }

    label {
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
    }

    input,
    select {
      width: 100%;
      height: 44px;
      border: 1px solid var(--line);
      border-radius: 7px;
      padding: 0 12px;
      background: #fbfcfa;
      color: var(--ink);
      outline: none;
      transition: border 160ms ease, box-shadow 160ms ease;
    }

    input:focus,
    select:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 4px rgba(0, 166, 118, 0.14);
    }

    .submit {
      grid-column: span 2;
      height: 44px;
      border: 0;
      border-radius: 7px;
      background: var(--accent);
      color: white;
      font-weight: 800;
      cursor: pointer;
      transition: transform 160ms ease, background 160ms ease;
    }

    .submit:hover {
      transform: translateY(-1px);
      background: var(--accent-dark);
    }

    .result {
      min-height: 430px;
      padding: 22px;
    }

    .empty {
      min-height: 386px;
      display: grid;
      place-items: center;
      text-align: center;
      color: var(--muted);
    }

    .empty strong {
      display: block;
      color: var(--ink);
      font-size: 20px;
      margin-bottom: 8px;
    }

    .loading {
      min-height: 386px;
      display: grid;
      place-items: center;
      color: var(--muted);
    }

    .spinner {
      width: 34px;
      height: 34px;
      border: 3px solid var(--line);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 760ms linear infinite;
      margin: 0 auto 14px;
    }

    .result-head {
      display: flex;
      justify-content: space-between;
      gap: 18px;
      align-items: flex-start;
      margin-bottom: 20px;
    }

    .result-head h3 {
      margin: 0;
      font-size: 26px;
      line-height: 1.1;
    }

    .result-head p {
      margin: 7px 0 0;
      color: var(--muted);
    }

    .copy {
      border: 1px solid var(--line);
      border-radius: 7px;
      background: var(--surface);
      height: 38px;
      padding: 0 12px;
      cursor: pointer;
      color: var(--ink);
      white-space: nowrap;
    }

    .metrics {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 10px;
      margin: 18px 0;
    }

    .metric {
      border-top: 1px solid var(--line);
      padding-top: 12px;
    }

    .metric span {
      display: block;
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 5px;
    }

    .metric strong {
      font-size: 22px;
    }

    .warnings {
      display: grid;
      gap: 8px;
      margin: 14px 0 18px;
    }

    .warning {
      border-left: 3px solid var(--warn);
      background: #fff8e5;
      color: #5e4705;
      padding: 10px 12px;
      border-radius: 5px;
      font-size: 13px;
    }

    .section-title {
      margin: 24px 0 10px;
      font-size: 15px;
      color: var(--muted);
      font-weight: 800;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
      table-layout: fixed;
    }

    th,
    td {
      padding: 11px 8px;
      text-align: left;
      border-bottom: 1px solid var(--line);
      vertical-align: top;
      overflow-wrap: anywhere;
    }

    th {
      color: var(--muted);
      font-size: 12px;
      font-weight: 800;
    }

    .pill {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 3px 8px;
      background: var(--soft);
      font-size: 12px;
      color: var(--muted);
    }

    .error {
      min-height: 386px;
      display: grid;
      place-items: center;
      color: var(--danger);
      text-align: center;
      padding: 20px;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    @keyframes rise {
      from { opacity: 0; transform: translateY(16px); }
      to { opacity: 1; transform: translateY(0); }
    }

    @keyframes floatIn {
      from { opacity: 0; transform: rotate(-1deg) translateY(22px); }
      to { opacity: 1; transform: rotate(-1deg) translateY(0); }
    }

    @media (max-width: 920px) {
      .layout {
        grid-template-columns: 1fr;
      }

      .intro {
        position: static;
        min-height: auto;
      }

      .intro h2 {
        max-width: 100%;
        font-size: 48px;
      }

      .map-plane {
        display: none;
      }
    }

    @media (max-width: 720px) {
      .topbar {
        align-items: flex-start;
        flex-direction: column;
      }

      .tabs {
        grid-template-columns: repeat(2, 1fr);
      }

      .field,
      .field.span-2,
      .field.span-3,
      .field.span-4,
      .field.span-5,
      .field.span-6,
      .submit {
        grid-column: 1 / -1;
      }

      .metrics {
        grid-template-columns: repeat(2, 1fr);
      }

      .result-head {
        flex-direction: column;
      }
    }

    @media (max-width: 460px) {
      .layout {
        padding: 18px;
      }

      .intro h2 {
        font-size: 40px;
      }

      .metrics {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <main class="shell">
    <header class="topbar">
      <div class="brand">
        <div class="mark" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span></div>
        <div>
          <h1>Generals.io Stats</h1>
          <p>Cloudflare Worker 查询台</p>
        </div>
      </div>
      <div class="top-actions">
        <span class="status" id="health">Public API</span>
      </div>
    </header>

    <div class="layout">
      <section class="intro">
        <div class="intro-copy">
          <p class="eyebrow">Replay intelligence for generals.io</p>
          <h2>玩家战绩，一屏看清。</h2>
          <p class="lead">查询最近战绩、模式胜率、两人交手和当前高星活跃榜。没有登录，没有数据库，直接读 public replay 数据。</p>
        </div>
        <div class="map-plane" aria-hidden="true">
          <span class="tile"></span><span class="tile"></span><span class="tile"></span><span class="tile"></span><span class="tile"></span><span class="tile"></span><span class="tile"></span><span class="tile"></span>
          <span class="tile"></span><span class="tile"></span><span class="tile"></span><span class="tile"></span><span class="tile"></span><span class="tile"></span><span class="tile"></span><span class="tile"></span>
          <span class="tile"></span><span class="tile"></span><span class="tile"></span><span class="tile"></span><span class="tile"></span><span class="tile"></span><span class="tile"></span><span class="tile"></span>
          <span class="tile"></span><span class="tile"></span><span class="tile"></span><span class="tile"></span><span class="tile"></span><span class="tile"></span><span class="tile"></span><span class="tile"></span>
          <span class="tile"></span><span class="tile"></span><span class="tile"></span><span class="tile"></span><span class="tile"></span><span class="tile"></span><span class="tile"></span><span class="tile"></span>
          <span class="tile"></span><span class="tile"></span><span class="tile"></span><span class="tile"></span><span class="tile"></span><span class="tile"></span><span class="tile"></span><span class="tile"></span>
        </div>
      </section>

      <section class="workspace">
        <nav class="tabs" aria-label="功能">
          <button class="tab active" data-tab="today">玩家概览</button>
          <button class="tab" data-tab="winrate">胜率</button>
          <button class="tab" data-tab="duel">交手</button>
          <button class="tab" data-tab="recent">活跃榜</button>
        </nav>

        <section class="tool">
          <div class="forms">
            <form class="form active" data-form="today">
              <div class="field span-6">
                <label for="today-name">用户名</label>
                <input id="today-name" name="username" placeholder="EklipZ" autocomplete="off" required />
              </div>
              <div class="field span-4">
                <label for="today-hours">小时</label>
                <input id="today-hours" name="hours" type="number" min="1" max="8760" value="24" required />
              </div>
              <button class="submit" type="submit">查询</button>
            </form>

            <form class="form" data-form="winrate">
              <div class="field span-5">
                <label for="wr-name">用户名</label>
                <input id="wr-name" name="username" placeholder="EklipZ" autocomplete="off" required />
              </div>
              <div class="field span-3">
                <label for="wr-mode">模式</label>
                <select id="wr-mode" name="mode">
                  <option value="duel">1v1</option>
                  <option value="ffa">FFA</option>
                  <option value="bigteam">BigTeam</option>
                </select>
              </div>
              <div class="field span-2">
                <label for="wr-days">天数</label>
                <input id="wr-days" name="days" type="number" min="1" max="3650" value="30" required />
              </div>
              <button class="submit" type="submit">查询</button>
            </form>

            <form class="form" data-form="duel">
              <div class="field span-4">
                <label for="duel-p1">玩家 1</label>
                <input id="duel-p1" name="p1" placeholder="EklipZ" autocomplete="off" required />
              </div>
              <div class="field span-4">
                <label for="duel-p2">玩家 2</label>
                <input id="duel-p2" name="p2" placeholder="bot" autocomplete="off" required />
              </div>
              <div class="field span-2">
                <label for="duel-days">天数</label>
                <input id="duel-days" name="days" type="number" min="1" max="3650" value="90" required />
              </div>
              <button class="submit" type="submit">查询</button>
            </form>

            <form class="form" data-form="recent">
              <div class="field span-3">
                <label for="recent-mode">模式</label>
                <select id="recent-mode" name="mode">
                  <option value="duel">1v1</option>
                  <option value="ffa">FFA</option>
                  <option value="bigteam">BigTeam</option>
                </select>
              </div>
              <div class="field span-4">
                <label for="recent-minutes">最近分钟</label>
                <input id="recent-minutes" name="minutes" type="number" min="1" max="10080" value="60" required />
              </div>
              <div class="field span-3">
                <label for="recent-limit">前几名</label>
                <input id="recent-limit" name="limit" type="number" min="1" max="100" value="10" required />
              </div>
              <button class="submit" type="submit">查询</button>
            </form>
          </div>

          <div class="result" id="result">
            <div class="empty">
              <div>
                <strong>选择一个查询开始</strong>
                <span>结果会在这里生成，可复制为纯文本摘要。</span>
              </div>
            </div>
          </div>
        </section>
      </section>
    </div>
  </main>

  <script>
    var resultEl = document.getElementById("result");
    var lastPlainText = "";

    function esc(value) {
      return String(value == null ? "" : value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    function fmtStar(value) {
      if (value == null || Number.isNaN(Number(value))) return "⭐?";
      var n = Number(value);
      return "⭐" + (Math.abs(n - Math.round(n)) < 0.005 ? String(Math.round(n)) : n.toFixed(2));
    }

    function fmtPct(value) {
      if (value == null) return "?";
      return (Number(value) * 100).toFixed(1) + "%";
    }

    function ago(ms) {
      if (!ms) return "?";
      var minutes = Math.max(1, Math.floor((Date.now() - Number(ms)) / 60000));
      if (minutes < 1440) return minutes + "min前";
      return Math.floor(minutes / 1440) + "d前";
    }

    function setLoading() {
      resultEl.innerHTML = '<div class="loading"><div><div class="spinner"></div><div>查询中...</div></div></div>';
    }

    function setError(message) {
      resultEl.innerHTML = '<div class="error"><div><strong>查询失败</strong><br>' + esc(message) + '</div></div>';
    }

    function api(path, params) {
      var url = new URL(path, window.location.origin);
      Object.keys(params).forEach(function (key) {
        if (params[key] !== undefined && params[key] !== null && params[key] !== "") {
          url.searchParams.set(key, params[key]);
        }
      });
      return fetch(url.toString()).then(function (res) {
        return res.json().then(function (body) {
          if (!res.ok || body.ok === false) throw new Error(body.error || "HTTP " + res.status);
          return body;
        });
      });
    }

    function metrics(items) {
      return '<div class="metrics">' + items.map(function (item) {
        return '<div class="metric"><span>' + esc(item.label) + '</span><strong>' + esc(item.value) + '</strong></div>';
      }).join("") + '</div>';
    }

    function warnings(items) {
      if (!items || !items.length) return "";
      return '<div class="warnings">' + items.map(function (item) {
        return '<div class="warning">' + esc(item) + '</div>';
      }).join("") + '</div>';
    }

    function copyButton() {
      return '<button class="copy" id="copy-result" type="button">复制摘要</button>';
    }

    function table(headers, rows) {
      if (!rows || !rows.length) {
        return '<p class="pill">无数据</p>';
      }
      return '<table><thead><tr>' + headers.map(function (h) {
        return '<th>' + esc(h) + '</th>';
      }).join("") + '</tr></thead><tbody>' + rows.map(function (row) {
        return '<tr>' + row.map(function (cell) {
          return '<td>' + cell + '</td>';
        }).join("") + '</tr>';
      }).join("") + '</tbody></table>';
    }

    function renderPeriod(body) {
      var data = body.data;
      var s = data.summary;
      var profile = data.profile || {};
      var title = data.username + " · " + (data.mode ? modeTitle(data.mode) + " · " : "") + data.label;
      var profileText = "1v1 " + fmtStar(profile.stars && profile.stars.duel) + " ｜ FFA " + fmtStar(profile.stars && profile.stars.ffa) + " ｜ Big " + fmtStar(profile.stars && profile.stars.bigteam);
      var html = '<div class="result-head"><div><h3>' + esc(title) + '</h3><p>' + esc(profileText) + '</p></div>' + copyButton() + '</div>';
      html += warnings(data.warnings);
      html += metrics([
        { label: "总局数", value: s.total + "局" },
        { label: "战绩", value: s.wins + "胜" + s.losses + "负" },
        { label: "胜率", value: fmtPct(s.winRate) },
        { label: "分页", value: data.fetched.pages + "页" }
      ]);
      if (!data.mode) {
        html += '<div class="section-title">模式统计</div>';
        html += table(["模式", "局数", "战绩", "胜率"], data.modes.map(function (m) {
          return [esc(m.title), esc(m.total + "局"), esc(m.wins + "胜" + m.losses + "负"), esc(fmtPct(m.winRate))];
        }));
      }
      html += '<div class="section-title">高星对手记录</div>';
      html += table(["对手", "当时最高星", "交手", "胜率", "最近"], data.opponents.map(function (o) {
        return [esc(o.name), esc(fmtStar(o.bestReplayStars)), esc(o.wins + "胜" + o.losses + "负"), esc(fmtPct(o.games ? o.wins / o.games : null)), esc(ago(o.latestMs))];
      }));
      html += '<div class="section-title">最近对局</div>';
      html += table(["时间", "模式", "结果", "名次", "对手"], data.recentGames.map(function (g) {
        return [esc(ago(g.startedMs)), esc(g.mode), esc(g.result), esc(g.rank + " / " + fmtStar(g.myStars)), esc(g.strongestOpponent + " / " + fmtStar(g.strongestStars))];
      }));
      resultEl.innerHTML = html;
      lastPlainText = title + "\\n当前⭐：" + profileText + "\\n总局数：" + s.total + "，战绩：" + s.wins + "胜" + s.losses + "负，胜率：" + fmtPct(s.winRate);
      bindCopy();
    }

    function renderDuel(body) {
      var data = body.data;
      var s = data.summary;
      var title = data.p1 + " vs " + data.p2 + " · 最近 " + data.days + " 天";
      var html = '<div class="result-head"><div><h3>' + esc(title) + '</h3><p>范围：1v1 + Custom</p></div>' + copyButton() + '</div>';
      html += warnings(data.warnings);
      html += metrics([
        { label: "交手", value: s.games + "局" },
        { label: data.p1, value: s.p1Wins + "胜 · " + fmtPct(s.p1WinRate) },
        { label: data.p2, value: s.p2Wins + "胜 · " + fmtPct(s.p2WinRate) },
        { label: "其他第一", value: s.other + "局" }
      ]);
      html += '<div class="section-title">按模式</div>';
      html += table(["模式", data.p1, data.p2, "总局"], data.byMode.map(function (m) {
        return [esc(m.title), esc(m.p1Wins + "胜 / " + fmtPct(m.p1WinRate)), esc(m.p2Wins + "胜 / " + fmtPct(m.p2WinRate)), esc(m.total + "局")];
      }));
      html += '<div class="section-title">最近交手</div>';
      html += table(["时间", "模式", "结果", data.p1, data.p2], data.recentGames.map(function (g) {
        return [esc(ago(g.startedMs)), esc(g.mode), esc(g.result), esc(fmtStar(g.p1Stars)), esc(fmtStar(g.p2Stars))];
      }));
      resultEl.innerHTML = html;
      lastPlainText = title + "\\n交手：" + s.games + "局\\n" + data.p1 + "：" + s.p1Wins + "胜，胜率" + fmtPct(s.p1WinRate) + "\\n" + data.p2 + "：" + s.p2Wins + "胜，胜率" + fmtPct(s.p2WinRate);
      bindCopy();
    }

    function renderRecent(body) {
      var data = body.data;
      var title = data.title + " · 最近 " + data.minutes + " 分钟 · ⭐前 " + data.topN;
      var html = '<div class="result-head"><div><h3>' + esc(title) + '</h3><p>按当前 profile 星数排名</p></div>' + copyButton() + '</div>';
      html += warnings(data.warnings);
      html += metrics([
        { label: "对局", value: data.overview.games + "场" },
        { label: "玩家", value: data.overview.players + "名" },
        { label: "补查星数", value: data.overview.checkedProfiles + "名" },
        { label: "分页", value: data.fetched.pages + "页" }
      ]);
      html += '<div class="section-title">排名</div>';
      html += table(["#", "玩家", "当前星", "局数", "最近"], data.players.map(function (p, index) {
        return [esc(index + 1), esc(p.name), esc(fmtStar(p.currentStars)), esc(p.games + "局"), esc(ago(p.latestMs))];
      }));
      resultEl.innerHTML = html;
      lastPlainText = title + "\\n" + data.players.map(function (p, i) {
        return (i + 1) + ". " + p.name + "/" + fmtStar(p.currentStars) + "，" + p.games + "局，最近" + ago(p.latestMs);
      }).join("\\n");
      bindCopy();
    }

    function modeTitle(mode) {
      if (mode === "duel") return "1v1";
      if (mode === "ffa") return "FFA";
      if (mode === "bigteam") return "BigTeam";
      if (mode === "custom") return "Custom";
      return mode;
    }

    function bindCopy() {
      var button = document.getElementById("copy-result");
      if (!button) return;
      button.addEventListener("click", function () {
        navigator.clipboard.writeText(lastPlainText).then(function () {
          button.textContent = "已复制";
          setTimeout(function () { button.textContent = "复制摘要"; }, 1200);
        });
      });
    }

    document.querySelectorAll(".tab").forEach(function (button) {
      button.addEventListener("click", function () {
        var tab = button.getAttribute("data-tab");
        document.querySelectorAll(".tab").forEach(function (x) { x.classList.toggle("active", x === button); });
        document.querySelectorAll(".form").forEach(function (form) { form.classList.toggle("active", form.getAttribute("data-form") === tab); });
      });
    });

    document.querySelectorAll("form").forEach(function (form) {
      form.addEventListener("submit", function (event) {
        event.preventDefault();
        var type = form.getAttribute("data-form");
        var data = new FormData(form);
        setLoading();
        var promise;
        if (type === "today") {
          promise = api("/api/today", { username: data.get("username"), hours: data.get("hours") }).then(renderPeriod);
        } else if (type === "winrate") {
          promise = api("/api/winrate", { username: data.get("username"), mode: data.get("mode"), days: data.get("days") }).then(renderPeriod);
        } else if (type === "duel") {
          promise = api("/api/duel", { p1: data.get("p1"), p2: data.get("p2"), days: data.get("days") }).then(renderDuel);
        } else {
          promise = api("/api/recent", { mode: data.get("mode"), minutes: data.get("minutes"), limit: data.get("limit") }).then(renderRecent);
        }
        promise.catch(function (error) { setError(error.message); });
      });
    });

    api("/api/health", {}).then(function () {
      document.getElementById("health").textContent = "API Ready";
    }).catch(function () {
      document.getElementById("health").textContent = "API Error";
    });
  </script>
</body>
</html>`;
