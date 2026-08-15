/* NFL Live Numbers — browser-only data engine for static Vercel hosting. */
(() => {
  "use strict";

  const nativeFetch = window.fetch.bind(window);
  const SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";
  const SUMMARY = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary";
  const CDN = "https://cdn.espn.com/core/nfl/playbyplay";
  const ROSTER = team => `https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${team}/roster`;
  const CORE = game => `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events/${game}/competitions/${game}`;
  const DISCOVERY = "https://fastcast.semfs.engsvc.go.com/public/websockethost";
  const PROFILE = 12000;
  const isoNow = () => new Date().toISOString();
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const clamp = (value, low, high) => Math.min(high, Math.max(low, Number(value)));
  const query = (base, params = {}) => {
    const url = new URL(base);
    Object.entries(params).forEach(([key, value]) => value != null && url.searchParams.set(key, value));
    return url.toString();
  };
  const idFromRef = value => {
    if (!value) return "";
    if (typeof value === "object") value = value.id || value.$key || value.$ref;
    return String(value || "").split("?", 1)[0].replace(/\/$/, "").split("/").at(-1) || "";
  };

  async function fetchResult(url, source, params = {}) {
    const requestStarted = isoNow();
    const started = performance.now();
    try {
      let response = await nativeFetch(query(url, params), {
        cache: "no-store",
        headers: { Accept: "application/json,text/plain,*/*" },
      });
      if (response.status === 403) {
        response = await nativeFetch(query(url, { ...params, _: Date.now() }), { cache: "no-store" });
      }
      if (!response.ok) throw new Error(`ESPN returned ${response.status}`);
      return {
        source,
        request_started: requestStarted,
        response_received: isoNow(),
        duration_ms: performance.now() - started,
        status_code: response.status,
        data: await response.json(),
        error: null,
      };
    } catch (error) {
      return {
        source,
        request_started: requestStarted,
        response_received: isoNow(),
        duration_ms: performance.now() - started,
        status_code: 0,
        data: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  function normalizeEvent(event) {
    const competition = event.competitions?.[0] || {};
    const teams = {};
    for (const competitor of competition.competitors || []) {
      const team = competitor.team || {};
      teams[competitor.homeAway || "unknown"] = {
        id: String(team.id || competitor.id || ""),
        abbreviation: team.abbreviation || "?",
        name: team.displayName || team.name || "Unknown",
        logo: team.logo || "",
        color: team.color || "",
        score: Number(competitor.score || 0),
        possession: Boolean(competitor.possession),
        timeouts: competitor.timeoutsLeft,
      };
    }
    const status = competition.status || event.status || {};
    const type = status.type || {};
    const home = teams.home || {};
    const away = teams.away || {};
    return {
      id: String(event.id || competition.id || ""),
      name: event.name || `${away.abbreviation || "?"} at ${home.abbreviation || "?"}`,
      short_name: event.shortName,
      date: event.date || competition.date,
      home,
      away,
      home_abbr: home.abbreviation,
      away_abbr: away.abbreviation,
      period: Number(status.period || 0),
      clock: status.displayClock || "--:--",
      state: type.state || "pre",
      status: type.shortDetail || type.detail || "Scheduled",
      completed: Boolean(type.completed),
      play_by_play_available: competition.playByPlayAvailable !== false,
      red_zone: Boolean(competition.situation?.isRedZone),
      situation: competition.situation || {},
    };
  }

  function flattenPlays(data, source) {
    if (!data) return [];
    if (source === "core") return data.id ? [{ ...data }] : [];
    if (source === "fastcast") {
      return Object.values(data.entities?.plays || {})
        .filter(play => play && play.id)
        .sort((a, b) => Number(a.sequenceNumber || 0) - Number(b.sequenceNumber || 0));
    }
    const drives = source === "cdn" ? data.gamepackageJSON?.drives || {} : data.drives || {};
    const list = [...(drives.previous || [])];
    if (drives.current && typeof drives.current === "object") list.push(drives.current);
    const plays = [];
    list.forEach((drive, index) => {
      const driveId = String(drive.id || `drive-${index}`);
      const team = drive.team?.abbreviation || drive.team?.id;
      const result = drive.displayResult || drive.result;
      for (const play of drive.plays || []) {
        plays.push({ ...play, _drive_id: driveId, _drive_team: team, _drive_result: result });
      }
    });
    return plays.sort((a, b) => Number(a.sequenceNumber || 0) - Number(b.sequenceNumber || 0));
  }

  function classify(raw) {
    const text = `${raw.type?.text || ""} ${raw.text || ""}`.toLowerCase();
    if (raw.isPenalty || text.includes("penalty")) return "penalty";
    if (raw.isTurnover || /intercept|fumble|turnover/.test(text)) return "turnover";
    if (raw.scoringPlay) return "scoring";
    if (text.includes("sack")) return "sack";
    if (/kick|punt|field goal|extra point/.test(text)) return "special";
    if (/pass|reception/.test(text)) return "pass";
    if (/rush|run|scramble/.test(text)) return "rush";
    return "other";
  }

  const regexEscape = text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  function rosterPlayers(data) {
    const team = data?.team || {};
    const players = [];
    for (const group of data?.athletes || []) {
      for (const item of group.items || []) {
        const jersey = String(item.jersey || "").match(/^\s*(\d{1,2})/)?.[1] || null;
        const full = item.fullName || item.displayName || "Unknown";
        const words = full.split(/\s+/);
        const aliases = new Set([full, item.shortName]);
        if (words.length > 1) {
          const last = words.slice(1).join(" ");
          aliases.add(`${words[0][0]}.${last}`);
          aliases.add(`${words[0][0]}. ${last}`);
        }
        players.push({
          id: String(item.id || ""), full_name: full, jersey,
          team_id: String(team.id || ""), aliases: [...aliases].filter(Boolean),
        });
      }
    }
    return players;
  }

  function enhanceDescription(text, raw, players) {
    let enhanced = text;
    const participants = [];
    const used = new Set();
    const byId = new Map(players.map(player => [player.id, player]));
    const structured = Array.isArray(raw.participants) ? raw.participants : Array.isArray(raw.athletes) ? raw.athletes : [];
    for (const entry of structured) {
      const athlete = entry.athlete || entry.player || entry;
      const player = byId.get(String(athlete.id || entry.athleteId || idFromRef(athlete) || ""));
      if (player && !used.has(player.id)) {
        participants.push({ name: player.full_name, full_name: player.full_name, jersey: player.jersey, espn_id: player.id, team_id: player.team_id, confidence: "structured_id" });
        used.add(player.id);
      }
    }
    const aliases = [];
    players.forEach(player => player.aliases.forEach(alias => aliases.push({ alias, player })));
    aliases.sort((a, b) => b.alias.length - a.alias.length);
    for (const { alias, player } of aliases) {
      if (!alias || alias.length < 4) continue;
      const pattern = new RegExp(`(^|[^\\w#])(${regexEscape(alias)})(?!\\w)`, "gi");
      enhanced = enhanced.replace(pattern, (match, prefix, shown) => {
        if (!used.has(player.id)) {
          participants.push({ name: player.full_name, full_name: player.full_name, jersey: player.jersey, espn_id: player.id, team_id: player.team_id, confidence: "exact_alias" });
          used.add(player.id);
        }
        return `${prefix}#${player.jersey || "?"} ${shown}`;
      });
    }
    enhanced = enhanced.replace(/(^|[^#\w])([A-Z]\.[A-Z][A-Za-z'\-]+(?:\s(?:Jr\.|Sr\.|II|III|IV))?)(?!\w)/g, (match, prefix, shown, offset, whole) => {
      const before = whole.slice(Math.max(0, offset - 12), offset + prefix.length);
      if (/#(?:\?|\d+[A-Z]?)\s+$/.test(before)) return match;
      participants.push({ name: shown, full_name: shown, jersey: null, confidence: "not_found" });
      return `${prefix}#? ${shown}`;
    });
    return { enhanced, participants };
  }

  function normalizePlay(raw, source, firstSeen, game, players) {
    const text = raw.text || raw.shortText || "Play details unavailable";
    const { enhanced, participants } = enhanceDescription(text, raw, players);
    const start = raw.start || {};
    const teamId = String(start.team?.id || idFromRef(start.team) || "");
    const teamAbbr = [game.away, game.home].find(team => String(team?.id || "") === teamId)?.abbreviation;
    const location = start.possessionText || (start.yardLine != null ? String(start.yardLine) : null);
    const type = classify(raw);
    return {
      play_id: String(raw.id || raw.sequenceNumber || `unknown-${firstSeen}`),
      sequence: Number(raw.sequenceNumber || 0),
      quarter: Number(raw.period?.number || raw.period || 0),
      game_clock: raw.clock?.displayValue || raw.clock?.displayClock || "--:--",
      wallclock: raw.wallclock || null,
      possession: teamAbbr || teamId || null,
      down: start.down != null ? Number(start.down) : null,
      distance: start.distance != null ? Number(start.distance) : null,
      yard_line: location,
      description_original: text,
      description_enhanced: enhanced,
      yards: raw.statYardage != null ? Number(raw.statYardage) : null,
      play_type: type,
      scoring_play: Boolean(raw.scoringPlay),
      turnover: Boolean(raw.isTurnover),
      penalty: Boolean(raw.isPenalty) || type === "penalty",
      participants,
      source,
      first_seen_timestamp: firstSeen,
      last_updated_timestamp: isoNow(),
      home_score: Number(raw.homeScore || 0),
      away_score: Number(raw.awayScore || 0),
      drive_id: raw._drive_id || null,
      drive_team: raw._drive_team || null,
      drive_result: raw._drive_result || null,
      revision: 1,
      resolution_ms: 0,
    };
  }

  function mergeHeader(game, header) {
    const competition = header?.competitions?.[0];
    if (!competition) return game;
    const status = competition.status || {};
    const merged = { ...game };
    merged.clock = status.displayClock || merged.clock;
    merged.period = Number(status.period || merged.period || 0);
    merged.status = status.type?.shortDetail || status.type?.detail || merged.status;
    merged.state = status.type?.state || merged.state;
    merged.completed = Boolean(status.type?.completed);
    merged.situation = competition.situation || merged.situation || {};
    merged.red_zone = Boolean(merged.situation?.isRedZone);
    for (const competitor of competition.competitors || []) {
      const side = competitor.homeAway;
      if (side !== "home" && side !== "away") continue;
      const team = competitor.team || {};
      merged[side] = {
        ...(merged[side] || {}), id: String(team.id || competitor.id || merged[side]?.id || ""),
        abbreviation: team.abbreviation || merged[side]?.abbreviation,
        logo: team.logo || merged[side]?.logo,
        score: Number(competitor.score || 0), possession: Boolean(competitor.possession),
      };
    }
    return merged;
  }

  function pointerParts(path) {
    if (!path) return [];
    if (!path.startsWith("/")) throw new Error(`Invalid JSON pointer: ${path}`);
    return path.slice(1).split("/").map(part => part.replace(/~1/g, "/").replace(/~0/g, "~"));
  }
  function applyPatch(document, operations) {
    const locate = parts => {
      let parent = document;
      for (const part of parts.slice(0, -1)) parent = Array.isArray(parent) ? parent[Number(part)] : parent[part];
      return [parent, parts.at(-1)];
    };
    const read = parts => parts.reduce((value, part) => Array.isArray(value) ? value[Number(part)] : value[part], document);
    const remove = parts => {
      const [parent, key] = locate(parts);
      return Array.isArray(parent) ? parent.splice(Number(key), 1)[0] : (() => { const value = parent[key]; delete parent[key]; return value; })();
    };
    const write = (parts, value, insert) => {
      const [parent, key] = locate(parts);
      const copied = structuredClone(value);
      if (Array.isArray(parent)) {
        if (insert && key === "-") parent.push(copied);
        else if (insert) parent.splice(Number(key), 0, copied);
        else parent[Number(key)] = copied;
      } else parent[key] = copied;
    };
    for (const operation of operations) {
      const parts = pointerParts(String(operation.path || ""));
      if (!parts.length) {
        if (operation.op === "add" || operation.op === "replace") document = structuredClone(operation.value);
        else if (operation.op === "remove") document = null;
        continue;
      }
      if (operation.op === "remove") remove(parts);
      else if (operation.op === "add" || operation.op === "replace") write(parts, operation.value, operation.op === "add");
      else if (operation.op === "copy" || operation.op === "move") {
        const source = pointerParts(String(operation.from || ""));
        write(parts, operation.op === "copy" ? read(source) : remove(source), true);
      } else if (operation.op === "test" && JSON.stringify(read(parts)) !== JSON.stringify(operation.value)) {
        throw new Error(`Fastcast patch test failed at ${operation.path}`);
      }
    }
    return document;
  }

  async function decodeEnvelope(value) {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== "object" || !("pl" in parsed)) return parsed;
    let payload = parsed.pl;
    if (parsed["~c"] && typeof payload === "string") {
      if (!("DecompressionStream" in window)) throw new Error("This browser cannot decode compressed Fastcast data");
      const bytes = Uint8Array.from(atob(payload), character => character.charCodeAt(0));
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
      payload = JSON.parse(await new Response(stream).text());
    } else if (typeof payload === "string") {
      try { payload = JSON.parse(payload); } catch (_) { /* payload can be plain text */ }
    }
    return payload;
  }

  function distribution(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const percentile = p => {
      if (!sorted.length) return null;
      const position = (sorted.length - 1) * p;
      const low = Math.floor(position), high = Math.ceil(position);
      return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
    };
    const average = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null;
    return { count: sorted.length, min: sorted[0] ?? null, max: sorted.at(-1) ?? null, average, median: percentile(.5), p25: percentile(.25), p75: percentile(.75), p90: percentile(.9) };
  }

  class BrowserEngine {
    constructor() {
      this.games = new Map();
      this.scoreboardRaw = {};
      this.monitor = null;
      this.listeners = new Set();
      this.runToken = 0;
      this.socket = null;
      this.markSequence = 0;
    }

    async scoreboard(dates) {
      const result = await fetchResult(SCOREBOARD, "scoreboard", { limit: "1000", region: "us", lang: "en", dates });
      if (result.data) {
        this.scoreboardRaw = result.data;
        for (const game of (result.data.events || []).map(normalizeEvent)) this.games.set(game.id, game);
      }
      this.recordRequest(result);
      return { games: [...this.games.values()], request_ms: result.duration_ms, error: result.error, received: result.response_received };
    }

    createMonitor(game, settings) {
      return {
        game: structuredClone(game),
        interval: clamp(settings.interval ?? .5, .5, 10),
        preferred_source: ["summary", "cdn"].includes(settings.preferred_source) ? settings.preferred_source : "summary",
        compare: Boolean(settings.compare),
        plays: new Map(), known: new Map(), firstSource: new Map(), raw: {}, players: [],
        last_check: null, last_new_play: null, lastCorePlayId: null,
        fastcast_status: "connecting", last_fastcast_event: null, last_fastcast_push: null, fastcast_push_count: 0,
        requests: [], observations: new Map(), marks: [], errors: [], resolution: {}, comparison_started: settings.compare ? isoNow() : null,
      };
    }

    async start(gameId, settings = {}) {
      if (this.monitor?.game.id === gameId) {
        this.monitor.interval = clamp(settings.interval ?? this.monitor.interval, .5, 10);
        this.monitor.preferred_source = settings.preferred_source || this.monitor.preferred_source;
        if (settings.compare && !this.monitor.compare) this.monitor.comparison_started = isoNow();
        this.monitor.compare = Boolean(settings.compare);
        return this.monitor;
      }
      this.stop();
      let game = this.games.get(gameId);
      if (!game) {
        await this.scoreboard();
        game = this.games.get(gameId);
      }
      game ||= { id: gameId, name: `NFL Game ${gameId}`, home: {}, away: {}, home_abbr: "HOME", away_abbr: "AWAY", state: "unknown" };
      this.monitor = this.createMonitor(game, settings);
      const token = ++this.runToken;
      this.fastcastLoop(token);
      this.coreLoop(token);
      this.statusLoop(token);
      this.reconcileLoop(token);
      this.loadRosters(token).then(() => token === this.runToken && this.reconcileOnce(token));
      await this.reconcileOnce(token);
      return this.monitor;
    }

    stop() {
      this.runToken += 1;
      if (this.socket) {
        try { this.socket.close(); } catch (_) { /* already closed */ }
      }
      this.socket = null;
    }

    async loadRosters(token) {
      const monitor = this.monitor;
      const teams = [monitor?.game.away, monitor?.game.home].filter(Boolean);
      const results = await Promise.all(teams.map(team => fetchResult(ROSTER(String(team.abbreviation || team.id || "").toLowerCase()), `roster:${team.abbreviation || team.id}`, { region: "us", lang: "en" })));
      if (token !== this.runToken || !this.monitor) return;
      const raw = {};
      const players = [];
      results.forEach(result => {
        this.recordRequest(result);
        if (result.data) {
          raw[result.source] = result.data;
          players.push(...rosterPlayers(result.data));
        }
      });
      this.monitor.players = players;
      this.monitor.raw.rosters = raw;
    }

    async coreLoop(token) {
      while (token === this.runToken && this.monitor) {
        const started = performance.now();
        await this.coreCycle(token);
        await sleep(Math.max(50, this.monitor.interval * 1000 - (performance.now() - started)));
      }
    }

    async coreCycle(token) {
      const monitor = this.monitor;
      if (!monitor) return;
      const gameId = monitor.game.id;
      const result = await fetchResult(`${CORE(gameId)}/situation`, "core_situation", { region: "us", lang: "en", _: Date.now() });
      if (token !== this.runToken || !this.monitor) return;
      this.recordRequest(result);
      if (result.error) return this.connectionError(result.error);
      const data = result.data || {};
      monitor.raw.core_situation = data;
      monitor.last_check = result.response_received;
      const situation = { ...data };
      delete situation.$ref; delete situation.lastPlay; delete situation.team;
      situation.possession = idFromRef(data.team);
      monitor.game.situation = situation;
      monitor.game.red_zone = Boolean(data.isRedZone);
      const playId = idFromRef(data.lastPlay);
      this.notify({ type: "tick", game: monitor.game, last_check: monitor.last_check, status: "live", fastcast_status: monitor.fastcast_status });
      if (playId && playId !== monitor.lastCorePlayId) {
        const play = await fetchResult(`${CORE(gameId)}/plays/${playId}`, "core", { region: "us", lang: "en", _: Date.now() });
        if (token !== this.runToken || !this.monitor) return;
        this.recordRequest(play);
        if (play.data) {
          monitor.lastCorePlayId = playId;
          monitor.raw.core = play.data;
          this.processPayload(play);
        }
      }
    }

    async statusLoop(token) {
      while (token === this.runToken && this.monitor) {
        const monitor = this.monitor;
        const result = await fetchResult(`${CORE(monitor.game.id)}/status`, "core_status", { region: "us", lang: "en", _: Date.now() });
        if (token !== this.runToken || !this.monitor) return;
        this.recordRequest(result);
        if (result.data) {
          monitor.raw.core_status = result.data;
          monitor.game.clock = result.data.displayClock || monitor.game.clock;
          monitor.game.period = Number(result.data.period || monitor.game.period || 0);
          monitor.game.state = result.data.type?.state || monitor.game.state;
          monitor.game.status = result.data.type?.shortDetail || result.data.type?.detail || monitor.game.status;
          monitor.game.completed = Boolean(result.data.type?.completed);
          this.notify({ type: "tick", game: monitor.game, last_check: result.response_received, status: "live", fastcast_status: monitor.fastcast_status });
        }
        await sleep(2000);
      }
    }

    async reconcileLoop(token) {
      while (token === this.runToken && this.monitor) {
        await sleep(10000);
        if (token === this.runToken) await this.reconcileOnce(token);
      }
    }

    async reconcileOnce(token) {
      const monitor = this.monitor;
      if (!monitor) return;
      const gameId = monitor.game.id;
      const sources = monitor.compare ? ["cdn", "summary"] : [monitor.preferred_source];
      const results = await Promise.all(sources.map(source => source === "cdn"
        ? fetchResult(CDN, "cdn", { xhr: "1", gameId, _: Date.now() })
        : fetchResult(SUMMARY, "summary", { event: gameId, region: "us", lang: "en", _: Date.now() })));
      if (token !== this.runToken || !this.monitor) return;
      results.sort((a, b) => new Date(a.response_received) - new Date(b.response_received));
      results.forEach(result => {
        this.recordRequest(result);
        if (result.data) {
          monitor.raw[result.source] = result.data;
          this.processPayload(result);
        } else if (result.error) this.connectionError(result.error);
      });
    }

    async fastcastLoop(token) {
      let backoff = 1000;
      while (token === this.runToken && this.monitor) {
        try {
          const discovery = await fetchResult(DISCOVERY, "fastcast_discovery", { _: Date.now() });
          if (!discovery.data) throw new Error(discovery.error || "Fastcast discovery failed");
          const details = discovery.data;
          const socketUrl = `wss://${details.ip}:${details.securePort}/FastcastService/pubsub/profiles/${PROFILE}?TrafficManager-Token=${encodeURIComponent(details.token)}`;
          await this.openFastcast(socketUrl, token);
          backoff = 1000;
        } catch (error) {
          if (token !== this.runToken || !this.monitor) return;
          this.monitor.fastcast_status = "fallback";
          this.connectionError(`Fastcast unavailable: ${error instanceof Error ? error.message : error}`);
        }
        await sleep(backoff);
        backoff = Math.min(15000, backoff * 2);
      }
    }

    openFastcast(url, token) {
      return new Promise((resolve, reject) => {
        const socket = new WebSocket(url);
        this.socket = socket;
        let opened = false;
        let document = null;
        let subscribed = false;
        let queue = Promise.resolve();
        const timeout = setTimeout(() => { try { socket.close(); } catch (_) {} reject(new Error("connection timeout")); }, 10000);
        socket.onopen = () => {
          opened = true;
          clearTimeout(timeout);
          socket.send(JSON.stringify({ op: "C" }));
        };
        socket.onerror = () => { if (!opened) { clearTimeout(timeout); reject(new Error("connection rejected")); } };
        socket.onclose = () => { clearTimeout(timeout); resolve(); };
        socket.onmessage = event => {
          queue = queue.then(async () => {
            if (token !== this.runToken || !this.monitor) return;
            const message = JSON.parse(event.data);
            const op = message.op;
            const received = isoNow();
            if (op === "C" && message.sid && !subscribed) {
              socket.send(JSON.stringify({ op: "S", sid: message.sid, tc: `gp-football-nfl-${this.monitor.game.id}` }));
              subscribed = true;
              this.monitor.fastcast_status = "connected";
              this.notify({ type: "tick", game: this.monitor.game, status: "live", fastcast_status: "connected" });
            } else if (op === "H" && message.pl) {
              const checkpoint = await fetchResult(String(message.pl), "fastcast", { _: Date.now() });
              if (!checkpoint.data) throw new Error(checkpoint.error || "checkpoint failed");
              document = checkpoint.data;
              this.monitor.last_fastcast_event = checkpoint.response_received;
              this.monitor.raw.fastcast = { entities: { plays: document.entities?.plays || {} }, header: document.header || {}, _fastcast: { operation: "H" } };
              this.processPayload({ ...checkpoint, source: "fastcast", data: this.monitor.raw.fastcast });
            } else if ((op === "P" || op === "R") && document) {
              const operations = await decodeEnvelope(message);
              if (!Array.isArray(operations)) return;
              document = applyPatch(document, operations);
              const ids = new Set();
              operations.forEach(operation => {
                const parts = pointerParts(String(operation.path || ""));
                if (parts.length >= 3 && parts[0] === "entities" && parts[1] === "plays") ids.add(parts[2]);
              });
              const selected = {};
              ids.forEach(id => document.entities?.plays?.[id] && (selected[id] = document.entities.plays[id]));
              const payload = { entities: { plays: selected }, header: document.header || {}, _fastcast: { operation: op, changed_play_ids: [...ids] } };
              this.monitor.fastcast_status = op === "P" ? "active" : this.monitor.fastcast_status;
              this.monitor.last_fastcast_event = received;
              if (op === "P") {
                this.monitor.last_fastcast_push = received;
                this.monitor.fastcast_push_count += 1;
              }
              this.monitor.raw.fastcast = payload;
              this.processPayload({ source: "fastcast", request_started: received, response_received: received, duration_ms: 0, status_code: 101, data: payload, error: null });
            }
          }).catch(error => {
            if (this.monitor) this.connectionError(`Fastcast message error: ${error.message || error}`);
          });
        };
      });
    }

    processPayload(result) {
      const monitor = this.monitor;
      if (!monitor || !result.data) return;
      monitor.last_check = result.response_received;
      const header = result.source === "cdn" ? result.data.gamepackageJSON?.header : result.data.header;
      if (header) monitor.game = mergeHeader(monitor.game, header);
      const rawPlays = flattenPlays(result.data, result.source);
      const additions = [], corrections = [];
      for (const raw of rawPlays) {
        const id = String(raw.id || raw.sequenceNumber || "");
        if (!id) continue;
        const wasKnown = monitor.known.has(id);
        const changed = wasKnown && monitor.known.get(id) !== (raw.text || "");
        const firstSeen = result.response_received || isoNow();
        const play = normalizePlay(raw, result.source, firstSeen, monitor.game, monitor.players);
        const enhancementChanged = wasKnown && monitor.plays.get(id)?.description_enhanced !== play.description_enhanced;
        if (wasKnown) play.source = monitor.firstSource.get(id) || play.source;
        const observationKey = `${id}|${result.source}`;
        if (!monitor.observations.has(observationKey)) {
          monitor.observations.set(observationKey, {
            play_id: id, description: play.description_original, sequence: play.sequence,
            quarter: play.quarter, game_clock: play.game_clock, endpoint: result.source,
            first_seen: firstSeen, espn_wallclock: play.wallclock,
            request_duration_ms: result.duration_ms,
          });
        }
        if (wasKnown && result.source !== monitor.preferred_source) continue;
        if (!wasKnown) {
          monitor.firstSource.set(id, result.source);
          monitor.last_new_play = firstSeen;
          monitor.known.set(id, play.description_original);
          monitor.plays.set(id, play);
          if (result.source === "core" || result.source === "fastcast") {
            monitor.game.home.score = play.home_score;
            monitor.game.away.score = play.away_score;
          }
          for (const mark of monitor.marks.filter(item => !item.play_id)) {
            const delay = new Date(firstSeen) - new Date(mark.marked_at);
            if (delay >= 0) Object.assign(mark, { play_id: id, first_seen: firstSeen, observed_delay_ms: delay });
          }
          additions.push(play);
        } else if (changed || enhancementChanged) {
          play.revision = (monitor.plays.get(id)?.revision || 1) + 1;
          monitor.known.set(id, play.description_original);
          monitor.plays.set(id, play);
          corrections.push(play);
        }
      }
      const participants = [...monitor.plays.values()].slice(-20).flatMap(play => play.participants || []);
      const resolved = participants.filter(player => player.jersey).length;
      monitor.resolution = { players_detected: participants.length, numbers_resolved: resolved, resolution_rate: participants.length ? resolved / participants.length * 100 : null, failures: {} };
      if (additions.length || corrections.length) {
        this.notify({ type: "plays", new: additions, corrected: corrections, game: monitor.game, last_check: monitor.last_check, last_new_play: monitor.last_new_play, resolution: monitor.resolution, fastcast_status: monitor.fastcast_status, status: "live" });
      } else {
        this.notify({ type: "tick", game: monitor.game, last_check: monitor.last_check, status: "live", fastcast_status: monitor.fastcast_status });
      }
    }

    recordRequest(result) {
      if (!this.monitor) return;
      this.monitor.requests.push({ endpoint: result.source, received: result.response_received, duration_ms: result.duration_ms, success: !result.error, error: result.error });
      if (this.monitor.requests.length > 5000) this.monitor.requests.splice(0, 1000);
    }

    connectionError(error) {
      if (!this.monitor) return;
      this.monitor.errors = [error, ...this.monitor.errors].slice(0, 10);
      this.notify({ type: "connection", status: "reconnecting", error, game: this.monitor.game, fastcast_status: this.monitor.fastcast_status });
    }

    subscribe(listener) {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }
    notify(message) { this.listeners.forEach(listener => listener(message)); }

    snapshot(gameId) {
      const monitor = this.monitor?.game.id === gameId ? this.monitor : null;
      return {
        game: monitor?.game || this.games.get(gameId),
        plays: monitor ? [...monitor.plays.values()].sort((a, b) => a.sequence - b.sequence) : [],
        monitoring: Boolean(monitor), interval: monitor?.interval ?? null,
        preferred_source: monitor?.preferred_source ?? null, compare: monitor?.compare ?? false,
        last_check: monitor?.last_check ?? null, last_new_play: monitor?.last_new_play ?? null,
        errors: monitor?.errors || [], resolution: monitor?.resolution || {},
        comparison_started: monitor?.comparison_started || null,
        fastcast_status: monitor?.fastcast_status || "idle",
        last_fastcast_event: monitor?.last_fastcast_event || null,
        last_fastcast_push: monitor?.last_fastcast_push || null,
        fastcast_push_count: monitor?.fastcast_push_count || 0,
      };
    }

    mark(gameId) {
      if (!this.monitor || this.monitor.game.id !== gameId) throw new Error("Select a game first");
      const mark = { id: ++this.markSequence, game_id: gameId, marked_at: isoNow(), play_id: null, observed_delay_ms: null };
      this.monitor.marks.push(mark);
      return mark;
    }

    stats() {
      const monitor = this.monitor;
      const delays = (monitor?.marks || []).map(mark => mark.observed_delay_ms).filter(value => value != null);
      return { tv_delay_ms: distribution(delays), plays_received: monitor?.plays.size || 0, endpoints: [] };
    }

    comparison() {
      const grouped = new Map();
      for (const item of this.monitor?.observations.values() || []) {
        if (!["fastcast", "core", "summary", "cdn"].includes(item.endpoint)) continue;
        const row = grouped.get(item.play_id) || { play_id: item.play_id, description: item.description, sequence: item.sequence, fastcast_first: null, core_first: null, summary_first: null, cdn_first: null };
        row[`${item.endpoint}_first`] = item.first_seen;
        grouped.set(item.play_id, row);
      }
      return [...grouped.values()].sort((a, b) => b.sequence - a.sequence).slice(0, 100);
    }

    health() {
      const grouped = new Map();
      for (const request of this.monitor?.requests || []) {
        const row = grouped.get(request.endpoint) || { endpoint: request.endpoint, total: 0, requests: 0, errors: 0, last_check: null, last_success: null };
        row.total += Number(request.duration_ms || 0); row.requests += 1; row.last_check = request.received;
        if (request.success) row.last_success = request.received; else row.errors += 1;
        grouped.set(request.endpoint, row);
      }
      return [...grouped.values()].map(row => ({ ...row, avg_ms: row.requests ? row.total / row.requests : null }));
    }

    history() {
      if (!this.monitor) return [];
      return [{ game_id: this.monitor.game.id, away_abbr: this.monitor.game.away_abbr, home_abbr: this.monitor.game.home_abbr, date: this.monitor.game.date, play_count: this.monitor.plays.size, avg_request_ms: this.monitor.requests.length ? this.monitor.requests.reduce((sum, row) => sum + row.duration_ms, 0) / this.monitor.requests.length : null, tv_marks: this.monitor.marks.length }];
    }

    csvText() {
      const columns = ["game_id", "play_id", "quarter", "game_clock", "description", "tv_manual_timestamp", "espn_timestamp", "first_seen_timestamp", "observed_tv_delay_ms", "endpoint", "http_response_ms"];
      const quote = value => `"${String(value ?? "").replaceAll('"', '""')}"`;
      const lines = [columns.map(quote).join(",")];
      for (const observation of this.monitor?.observations.values() || []) {
        const mark = this.monitor.marks.find(item => item.play_id === observation.play_id) || {};
        lines.push([this.monitor.game.id, observation.play_id, observation.quarter, observation.game_clock, observation.description, mark.marked_at, observation.espn_wallclock, observation.first_seen, mark.observed_delay_ms, observation.endpoint, observation.request_duration_ms].map(quote).join(","));
      }
      return lines.join("\r\n");
    }

    async handle(input, options = {}) {
      const url = new URL(typeof input === "string" ? input : input.url, location.origin);
      const path = url.pathname;
      let match;
      if (path === "/api/games" && (!options.method || options.method === "GET")) return this.scoreboard(url.searchParams.get("dates") || undefined);
      if ((match = path.match(/^\/api\/games\/([^/]+)\/monitor$/))) {
        const body = typeof options.body === "string" ? JSON.parse(options.body) : options.body || {};
        const monitor = await this.start(match[1], body);
        return { ok: true, game: monitor.game, interval: monitor.interval, preferred_source: monitor.preferred_source, compare: monitor.compare };
      }
      if ((match = path.match(/^\/api\/games\/([^/]+)\/mark$/))) return this.mark(match[1]);
      if ((match = path.match(/^\/api\/games\/([^/]+)\/latency$/))) return { statistics: this.stats(), comparison: this.comparison() };
      if ((match = path.match(/^\/api\/games\/([^/]+)\/raw\/([^/]+)$/))) return match[2] === "scoreboard" ? this.scoreboardRaw : this.monitor?.raw[match[2]] || {};
      if ((match = path.match(/^\/api\/games\/([^/]+)$/))) return this.snapshot(match[1]);
      if (path === "/api/health/sources") return { sources: this.health() };
      if (path === "/api/history") return { games: this.history() };
      if (path === "/api/access") return { computer: location.origin, phone: location.origin };
      if ((match = path.match(/^\/api\/settings\/([^/]+)$/))) {
        if (String(options.method || "GET").toUpperCase() === "PUT") {
          const body = JSON.parse(options.body || "{}"); localStorage.setItem(match[1], JSON.stringify(body.value)); return { ok: true };
        }
        return { key: match[1], value: JSON.parse(localStorage.getItem(match[1]) || "null") };
      }
      throw Object.assign(new Error(`Unknown browser API route: ${path}`), { status: 404 });
    }
  }

  class VirtualResponse {
    constructor(data, status = 200) { this.data = data; this.status = status; this.ok = status >= 200 && status < 300; }
    async json() { return structuredClone(this.data); }
    async text() { return typeof this.data === "string" ? this.data : JSON.stringify(this.data); }
  }

  class VirtualEventSource {
    constructor(url) {
      this.url = url; this.readyState = 0; this.listeners = new Map(); this.onopen = null; this.onerror = null;
      const gameId = new URL(url, location.origin).pathname.match(/^\/api\/games\/([^/]+)\/events$/)?.[1];
      queueMicrotask(() => {
        if (!gameId) return this.onerror?.(new Event("error"));
        this.readyState = 1;
        this.unsubscribe = engine.subscribe(message => this.emit("update", message));
        this.emit("snapshot", engine.snapshot(gameId));
        this.onopen?.(new Event("open"));
      });
    }
    addEventListener(type, listener) { const list = this.listeners.get(type) || []; list.push(listener); this.listeners.set(type, list); }
    emit(type, data) { const event = { type, data: JSON.stringify(data) }; (this.listeners.get(type) || []).forEach(listener => listener(event)); }
    close() { this.readyState = 2; this.unsubscribe?.(); }
  }
  VirtualEventSource.CONNECTING = 0; VirtualEventSource.OPEN = 1; VirtualEventSource.CLOSED = 2;

  const engine = new BrowserEngine();
  window.NFLLiveEngine = engine;
  window.fetch = async (input, options = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, location.origin);
    if (!url.pathname.startsWith("/api/")) return nativeFetch(input, options);
    try { return new VirtualResponse(await engine.handle(input, options)); }
    catch (error) { return new VirtualResponse({ detail: error.message || String(error) }, error.status || 500); }
  };
  window.EventSource = VirtualEventSource;
})();
