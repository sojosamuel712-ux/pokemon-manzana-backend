const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const { AsyncLocalStorage } = require('node:async_hooks');
const { Dex } = require('pokemon-showdown');
const { FORMAT_ID, PVP_FORMAT_ID, chooseTrainingAction, createBattle, createBattleTeam, createTrainingTeam, getBattleCry, getBattleMoveData, getBattleSprites, hasTrainingActionRequest, initializeBattleEngine, restoreBattle } = require('./battleEngine.cjs');
const { getPokemonEvolution, normalizeEvolutionItemName } = require('./evolution.cjs');

const app = express();
const isProduction = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT || 3000);
const jwtSecret = process.env.JWT_SECRET || (isProduction ? '' : 'development-only-change-me');
const termsVersion = '2026-11-08';
const corsOrigins = (process.env.CORS_ORIGIN || (isProduction ? '' : 'http://localhost:5173'))
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const databasePath = process.env.DATABASE_PATH || path.join(__dirname, 'db', 'manzana.sqlite');
const trustProxyHops = process.env.TRUST_PROXY_HOPS === undefined ? 0 : Number(process.env.TRUST_PROXY_HOPS);
if (isProduction && (!jwtSecret || jwtSecret.length < 32)) {
  throw new Error('En producción, JWT_SECRET debe tener al menos 32 caracteres aleatorios.');
}
if (isProduction && (!process.env.DATABASE_PATH || !path.isAbsolute(databasePath))) {
  throw new Error('En producción, DATABASE_PATH debe apuntar a una ruta absoluta en almacenamiento persistente.');
}
if (!Number.isSafeInteger(trustProxyHops) || trustProxyHops < 0) {
  throw new Error('TRUST_PROXY_HOPS debe ser un entero no negativo.');
}
fs.mkdirSync(path.dirname(databasePath), { recursive: true });
const schemaPath = path.join(__dirname, 'db', 'schema.sql');
const modelDirectory = path.resolve(process.env.MODEL_DIRECTORY || path.join(__dirname, 'models'));
const spriteDirectory = path.resolve(process.env.SPRITE_DIRECTORY || path.join(__dirname, 'public', 'sprites'));
const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'catalog.json'), 'utf8'));
const db = new sqlite3.Database(databasePath);

if (!process.env.JWT_SECRET && !isProduction) {
  console.warn('JWT_SECRET no está definido; se usará una clave de desarrollo.');
}

app.use(cors({
  origin(origin, callback) {
    callback(null, !origin || corsOrigins.includes(origin));
  },
}));
app.set('trust proxy', trustProxyHops);
app.use('/api/admin/announcements', express.json({ limit: '60mb' }));
app.use(express.json({ limit: '5mb' }));
app.use('/models', express.static(modelDirectory, { maxAge: '1d' }));
app.use('/sprites', express.static(spriteDirectory, { maxAge: '1d' }));

const createRateLimiter = ({ limit, windowMs, message }) => {
  const clients = new Map();
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of clients) {
      if (entry.resetAt <= now) clients.delete(key);
    }
  }, Math.min(windowMs, 60_000));
  cleanup.unref();

  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    let entry = clients.get(key);
    if (!entry || entry.resetAt <= now) {
      if (!entry && clients.size >= 10_000) {
        return res.status(429).json({ error: 'Hay demasiadas solicitudes. Inténtalo más tarde.' });
      }
      entry = { count: 0, resetAt: now + windowMs };
      clients.set(key, entry);
    }
    if (entry.count >= limit) {
      const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: message });
    }
    entry.count += 1;
    return next();
  };
};

const registrationRateLimit = createRateLimiter({
  limit: 10,
  windowMs: 60 * 60 * 1000,
  message: 'Demasiados intentos de registro. Inténtalo más tarde.',
});
const loginRateLimit = createRateLimiter({
  limit: 20,
  windowMs: 15 * 60 * 1000,
  message: 'Demasiados intentos de inicio de sesión. Inténtalo más tarde.',
});

const transactionContext = new AsyncLocalStorage();
let transactionQueue = Promise.resolve();
const coinColumns = { bronze: 'bronze_coins', silver: 'silver_coins', gold: 'gold_coins', diamond: 'diamond_coins' };
const coinExchanges = {
  silver: { source: 'bronze', rate: 4 },
  gold: { source: 'silver', rate: 3 },
  diamond: { source: 'gold', rate: 2 },
};

const runRaw = (sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, function onRun(error) {
    if (error) reject(error);
    else resolve({ id: this.lastID, changes: this.changes });
  });
});

const getRaw = (sql, params = []) => new Promise((resolve, reject) => {
  db.get(sql, params, (error, row) => {
    if (error) reject(error);
    else resolve(row);
  });
});

const scheduleDatabaseOperation = (operation) => transactionContext.getStore()
  ? operation()
  : transactionQueue.then(operation);

const run = (sql, params = []) => scheduleDatabaseOperation(() => runRaw(sql, params));
const get = (sql, params = []) => scheduleDatabaseOperation(() => getRaw(sql, params));

const getEffectiveGuildRole = (userRecord, membershipRole) => {
  const roleLevel = Number(userRecord?.role_level ?? 4);
  if (membershipRole === 'leader' && roleLevel !== 2) {
    return 'member';
  }
  return membershipRole || 'member';
};

const chooseWeightedEntry = (entries) => {
  const totalWeight = entries.reduce((total, entry) => total + Number(entry.probability), 0);
  let roll = Math.random() * totalWeight;
  for (const entry of entries) {
    roll -= Number(entry.probability);
    if (roll < 0) return entry;
  }
  return entries.at(-1);
};

const allRaw = (sql, params = []) => new Promise((resolve, reject) => {
  db.all(sql, params, (error, rows) => {
    if (error) reject(error);
    else resolve(rows);
  });
});

const all = (sql, params = []) => scheduleDatabaseOperation(() => allRaw(sql, params));

const withTransaction = (operation) => {
  const transaction = transactionQueue.then(() => transactionContext.run(true, async () => {
    let started = false;
    try {
      await runRaw('BEGIN IMMEDIATE TRANSACTION');
      started = true;
      const result = await operation();
      await runRaw('COMMIT');
      return result;
    } catch (error) {
      if (started) await runRaw('ROLLBACK');
      throw error;
    }
  }));
  transactionQueue = transaction.then(() => undefined, () => undefined);
  return transaction;
};

const initializeDatabase = async () => {
  await run('PRAGMA foreign_keys = ON');
  const schema = fs.readFileSync(schemaPath, 'utf8');
  await new Promise((resolve, reject) => {
    db.exec(schema, (error) => (error ? reject(error) : resolve()));
  });

  const chatColumns = await all('PRAGMA table_info(chat_messages)');
  if (!chatColumns.some((column) => column.name === 'guild_name')) {
    await run('ALTER TABLE chat_messages ADD COLUMN guild_name TEXT');
  }

  const announcementColumns = await all('PRAGMA table_info(announcements)');
  if (!announcementColumns.some((column) => column.name === 'image_data')) {
    await run('ALTER TABLE announcements ADD COLUMN image_data TEXT');
  }

  const userColumns = await all('PRAGMA table_info(users)');
  if (!userColumns.some((column) => column.name === 'role_level')) {
    await run('ALTER TABLE users ADD COLUMN role_level INTEGER NOT NULL DEFAULT 4');
  }
  if (!userColumns.some((column) => column.name === 'terms_version')) {
    await run("ALTER TABLE users ADD COLUMN terms_version TEXT NOT NULL DEFAULT ''");
  }
  if (!userColumns.some((column) => column.name === 'terms_accepted_at')) {
    await run('ALTER TABLE users ADD COLUMN terms_accepted_at TEXT');
  }

  const inventoryPokemonColumns = await all('PRAGMA table_info(inventory_pokemon)');
  if (!inventoryPokemonColumns.some((column) => column.name === 'shiny')) {
    await run('ALTER TABLE inventory_pokemon ADD COLUMN shiny INTEGER NOT NULL DEFAULT 0');
  }

  const shopColumns = await all('PRAGMA table_info(shop_catalog)');
  if (!shopColumns.some((column) => column.name === 'quantity')) {
    await run('ALTER TABLE shop_catalog ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1');
  }
  if (!shopColumns.some((column) => column.name === 'shiny')) {
    await run('ALTER TABLE shop_catalog ADD COLUMN shiny INTEGER NOT NULL DEFAULT 0');
  }

  const profileColumns = await all('PRAGMA table_info(profiles)');
  if (!profileColumns.some((column) => column.name === 'diamond_coins')) {
    await run('ALTER TABLE profiles ADD COLUMN diamond_coins INTEGER NOT NULL DEFAULT 0');
  }

  const rouletteColumns = await all('PRAGMA table_info(roulette_prizes)');
  if (!rouletteColumns.some((column) => column.name === 'wheel_type')) {
    await run("ALTER TABLE roulette_prizes ADD COLUMN wheel_type TEXT NOT NULL DEFAULT 'prize'");
  }
  if (!rouletteColumns.some((column) => column.name === 'coin_type')) {
    await run("ALTER TABLE roulette_prizes ADD COLUMN coin_type TEXT NOT NULL DEFAULT 'bronze'");
  }
  if (!rouletteColumns.some((column) => column.name === 'probability')) {
    await run('ALTER TABLE roulette_prizes ADD COLUMN probability REAL NOT NULL DEFAULT 1');
  }
  await run("DELETE FROM roulette_prizes WHERE prize_type NOT IN ('item', 'pokemon')");

  const userCount = await get('SELECT COUNT(*) AS count FROM users');
  if (isProduction) {
    const demoUser = await get('SELECT password_hash FROM users WHERE username = ?', ['AshManzana']);
    if (demoUser && await bcrypt.compare('123456', demoUser.password_hash)) {
      throw new Error('La base de producción conserva la contraseña conocida de la cuenta demo AshManzana. Elimina o restablece esa cuenta antes de desplegar.');
    }
  }
  if (!isProduction && userCount.count === 0) {
    const passwordHash = await bcrypt.hash('123456', 10);
    const result = await run(
      'INSERT INTO users (username, password_hash, age, guild, starter, role_level) VALUES (?, ?, ?, ?, ?, ?)',
      ['AshManzana', passwordHash, 18, 'Garchomp', 'Garchomp', 0],
    );
    await run('INSERT INTO profiles (user_id, bayas, bronze_coins, silver_coins, battle_wins, battle_losses) VALUES (?, ?, ?, ?, ?, ?)', [result.id, 640, 5, 1, 18, 6]);
    await run('INSERT INTO inventory_items (user_id, item_name, quantity) VALUES (?, ?, ?)', [result.id, 'Baya Ziu', 1]);
    await run('INSERT INTO inventory_items (user_id, item_name, quantity) VALUES (?, ?, ?)', [result.id, 'Poción minorista', 1]);
    await run('INSERT INTO inventory_pokemon (user_id, pokemon_name, level) VALUES (?, ?, ?)', [result.id, 'Garchomp', 5]);
    await run('INSERT INTO inventory_pokemon (user_id, pokemon_name, level) VALUES (?, ?, ?)', [result.id, 'Dragonite', 5]);
  }

  const usersForGuilds = await all('SELECT id, guild FROM users ORDER BY id ASC');
  for (const member of usersForGuilds) {
    const membership = await get('SELECT user_id FROM guild_memberships WHERE user_id = ?', [member.id]);
    if (membership) continue;
    const role = 'member';
    await run('INSERT INTO guild_memberships (user_id, guild_name, role) VALUES (?, ?, ?)', [member.id, member.guild, role]);
  }

  await run(`UPDATE guild_memberships
    SET role = CASE (SELECT role_level FROM users WHERE id = guild_memberships.user_id)
      WHEN 2 THEN 'leader'
      WHEN 3 THEN 'elite'
      ELSE 'member'
    END`);

  const guildsWithMembers = await all('SELECT DISTINCT guild_name FROM guild_memberships');
  for (const { guild_name: guildName } of guildsWithMembers) {
    const messageCount = await get('SELECT COUNT(*) AS count FROM guild_messages WHERE guild_name = ?', [guildName]);
    if (messageCount.count === 0) {
      await run('INSERT INTO guild_messages (guild_name, username, message) VALUES (?, ?, ?)', [guildName, `Guía de ${guildName}`, `Bienvenidos al gremio ${guildName}. Preséntate y comparte tus aventuras con la comunidad.`]);
    }
  }

  const announcementCount = await get('SELECT COUNT(*) AS count FROM announcements');
  if (announcementCount.count === 0) {
    const announcements = [
      'Liga de verano abierta: gana bayas extra si participas esta semana.',
      'Tienda semanal renovada con Pokémon de temporada y objetos exclusivos.',
      'La comunidad recomienda revisar los acuerdos de privacidad antes del registro.',
    ];
    for (const message of announcements) await run('INSERT INTO announcements (message) VALUES (?)', [message]);
  }

  const shopCatalogCount = await get('SELECT COUNT(*) AS count FROM shop_catalog');
  if (shopCatalogCount.count === 0) {
    const entries = [
      ['item', 'Baya Ziu', 35, 'Recupera energía y mejora la resistencia en combate.', 'Común', 10],
      ['item', 'Poción minorista', 80, 'Repara pequeños daños antes del enfrentamiento.', 'Rara', 10],
      ['item', 'Vara de relicario', 120, 'Objeto especial para entrenadores de la comunidad.', 'Épica', 5],
      ['pokemon', 'Dragonite', 240, 'Disponible en la semana comunitaria.', 'Épica', 1],
      ['pokemon', 'Dragapult', 260, 'Disponible en la semana comunitaria.', 'Legendaria', 1],
      ['pokemon', 'Metagross', 220, 'Disponible en la semana comunitaria.', 'Rara', 1],
    ];
    for (const [category, name, price, description, rarity, quantity] of entries) {
      await run('INSERT INTO shop_catalog (category, name, price, description, rarity, quantity) VALUES (?, ?, ?, ?, ?, ?)', [category, name, price, description, rarity, quantity]);
    }
  }

  const defaultRoulettePrizes = {
    bronze: {
      item: [['Baya Ziu', 50], ['Poción minorista', 35], ['Vara de relicario', 15]],
      pokemon: [['Dragonite', 50], ['Dragapult', 30], ['Metagross', 20]],
    },
    silver: {
      item: [['Superpoción', 50], ['Caramelo Raro', 35], ['Master Ball', 15]],
      pokemon: [['Tyranitar', 50], ['Salamence', 30], ['Garchomp', 20]],
    },
    gold: {
      item: [['Cápsula Dorada', 50], ['Parche Habilidad', 35], ['Cristal Z', 15]],
      pokemon: [['Metagross', 50], ['Dragapult', 30], ['Dragonite', 20]],
    },
    diamond: {
      item: [['Master Ball', 50], ['Parche Habilidad', 35], ['Vara de relicario', 15]],
      pokemon: [['Garchomp', 50], ['Dragapult', 30], ['Dragonite', 20]],
    },
  };
  const categoryCount = await get("SELECT COUNT(*) AS count FROM roulette_prizes WHERE wheel_type = 'category'");
  if (!categoryCount.count) {
    await run('INSERT INTO roulette_prizes (wheel_type, coin_type, prize_type, name, amount, rarity, enabled, probability) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', ['category', 'bronze', 'item', 'Objetos', 1, 'Común', 1, 50]);
    await run('INSERT INTO roulette_prizes (wheel_type, coin_type, prize_type, name, amount, rarity, enabled, probability) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', ['category', 'bronze', 'pokemon', 'Pokémon', 1, 'Común', 1, 50]);
  }
  for (const [coinType, categories] of Object.entries(defaultRoulettePrizes)) {
    for (const [prizeType, prizes] of Object.entries(categories)) {
      const group = await get('SELECT COUNT(*) AS count FROM roulette_prizes WHERE wheel_type = ? AND coin_type = ? AND prize_type = ?', ['prize', coinType, prizeType]);
      if (group.count) continue;
      for (const [name, probability] of prizes) {
        await run('INSERT INTO roulette_prizes (wheel_type, coin_type, prize_type, name, amount, rarity, enabled, probability) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', ['prize', coinType, prizeType, name, 1, 'Común', 1, probability]);
      }
    }
  }

};

const createToken = (user) => jwt.sign({ id: user.id, username: user.username }, jwtSecret, { expiresIn: '24h' });

const authenticate = async (req, res, next) => {
  const authorization = req.headers.authorization || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Token de acceso requerido.' });

  let auth;
  try {
    auth = jwt.verify(token, jwtSecret);
  } catch {
    return res.status(401).json({ error: 'Token inválido o expirado.' });
  }
  const user = await get('SELECT id FROM users WHERE id = ?', [auth.id]);
  if (!user) return res.status(401).json({ error: 'La cuenta de esta sesión ya no está disponible.' });
  req.auth = auth;
  return next();
};

const getProfile = async (userId) => {
  const user = await get('SELECT id, username, age, guild, starter, role_level, created_at FROM users WHERE id = ?', [userId]);
  if (!user) return null;
  const profile = await get('SELECT bayas, bronze_coins, silver_coins, gold_coins, diamond_coins, battle_wins, battle_losses FROM profiles WHERE user_id = ?', [userId]);
  const membership = await get('SELECT role FROM guild_memberships WHERE user_id = ?', [userId]);
  const items = await all('SELECT item_name AS name, quantity FROM inventory_items WHERE user_id = ?', [userId]);
  const pokemon = await all('SELECT pokemon_name AS name, level, shiny FROM inventory_pokemon WHERE user_id = ?', [userId]);
  const savedRoster = await get('SELECT roster_json FROM pokemon_rosters WHERE user_id = ?', [userId]);
  const guildRole = getEffectiveGuildRole(user, membership?.role);
  return {
    id: user.id,
    username: user.username,
    age: user.age,
    guild: user.guild,
    guildRole,
    roleLevel: Number(user.role_level ?? 4),
    starter: user.starter,
    bayas: profile?.bayas || 0,
    mysteriousCoins: {
      bronze: profile?.bronze_coins || 0,
      silver: profile?.silver_coins || 0,
      gold: profile?.gold_coins || 0,
      diamond: profile?.diamond_coins || 0,
    },
    battleWins: profile?.battle_wins || 0,
    battleLosses: profile?.battle_losses || 0,
    inventory: {
      items: items.flatMap((item) => Array.from({ length: item.quantity }, () => item.name)),
      pokemon: pokemon.map((entry) => ({ ...entry, shiny: Boolean(entry.shiny) })),
    },
    pokemonRoster: savedRoster ? JSON.parse(savedRoster.roster_json) : null,
  };
};

const getBattleTeam = async (userId, formatId = FORMAT_ID, requireFullTeam = false) => {
  const savedRoster = await get('SELECT roster_json FROM pokemon_rosters WHERE user_id = ?', [userId]);
  if (!savedRoster) throw new Error('Guarda tu equipo Pokémon antes de combatir.');

  const roster = JSON.parse(savedRoster.roster_json);
  if (!Array.isArray(roster.team) || roster.team.length < (requireFullTeam ? 6 : 1) || roster.team.length > 6) {
    throw new Error(requireFullTeam
      ? 'El combate PvP de Gen 9 Custom Game requiere exactamente 6 Pokémon en tu equipo.'
      : 'Tu equipo debe tener entre 1 y 6 Pokémon para combatir.');
  }

  const ownedPokemon = await all(
    'SELECT id, pokemon_name AS name, shiny FROM inventory_pokemon WHERE user_id = ? ORDER BY id',
    [userId],
  );
  const ownedItems = await all(
    'SELECT item_name AS name, quantity FROM inventory_items WHERE user_id = ? AND quantity > 0',
    [userId],
  );
  const availableItems = new Map(ownedItems.map((item) => [
    normalizeEvolutionItemName(item.name),
    Number(item.quantity),
  ]));
  const usedPokemon = new Set();
  const team = roster.team.map((pokemon) => {
    const ownedMatches = ownedPokemon.filter((owned) =>
      owned.name.toLocaleLowerCase() === String(pokemon.species || '').trim().toLocaleLowerCase() &&
      !usedPokemon.has(owned.id));
    const owned = ownedMatches.find((entry) => Boolean(entry.shiny) === Boolean(pokemon.shiny)) || ownedMatches[0];
    if (!owned) throw new Error(`${pokemon.species || 'Un Pokémon'} de tu equipo ya no está en tu inventario.`);
    usedPokemon.add(owned.id);
    if (pokemon.heldItem) {
      const itemId = normalizeEvolutionItemName(pokemon.heldItem);
      const quantity = availableItems.get(itemId) || 0;
      if (!quantity) throw new Error(`El objeto equipado "${pokemon.heldItem}" no está en tu inventario.`);
      availableItems.set(itemId, quantity - 1);
    }
    return { ...pokemon, shiny: Boolean(owned.shiny) };
  });

  return createBattleTeam(team, formatId);
};

const getBattleView = (record, userId) => {
  const battle = restoreBattle(JSON.parse(record.battle_state));
  const isSpectator = userId !== record.challenger_id && userId !== record.opponent_id;
  const ownSideId = isSpectator ? null : record.challenger_id === userId ? 'p1' : 'p2';
  const p1 = battle.p1;
  const p2 = battle.p2;
  const player = (sideId, side, username, species, shiny) => {
    const pokemon = side?.active?.[0] || side?.pokemon.find((entry) => entry.isActive) || side?.pokemon[0];
    const getPokemonGender = (entry) => {
      const gender = entry?.gender || entry?.species?.gender || '';
      return gender === 'M' || gender === 'F' ? gender : '';
    };
    const activeSpecies = pokemon?.species?.name || species;
    const team = (side?.pokemon || []).map((entry, index) => ({
      index,
      species: entry.species.name,
      nickname: entry.name !== entry.species.name ? entry.name : '',
      types: [...entry.types],
      gender: getPokemonGender(entry),
      shiny: Boolean(entry.set.shiny),
      sprites: getBattleSprites(entry.species.name),
      cry: getBattleCry(entry.species.name),
      hp: Math.max(0, entry.hp || 0),
      maxHp: entry.maxhp || 1,
      status: entry.status || '',
      boosts: Object.fromEntries(Object.entries(entry.boosts || {}).filter(([, value]) => value !== 0)),
      volatiles: Object.keys(entry.volatiles || {}).map((id) => ({
        id,
        name: battle.dex.conditions.get(id).name || id,
      })),
      fainted: Boolean(entry.fainted),
      active: Boolean(entry.isActive),
    }));
    const request = side?.activeRequest;
    const forceSwitch = request?.forceSwitch || [];
    const activeRequest = request?.active?.[0];
    const moves = (activeRequest?.moves || []).map((move, index) => ({
      ...move,
      ...getBattleMoveData(move.id),
      zMove: activeRequest.canZMove?.[index]?.move || null,
      canZMove: Boolean(activeRequest.canZMove?.[index]),
    }));
    return {
      side: sideId,
      username,
      species: activeSpecies,
      shiny: Boolean(pokemon?.set.shiny ?? shiny),
      sprites: getBattleSprites(activeSpecies),
      cry: getBattleCry(activeSpecies),
      types: pokemon ? [...pokemon.types] : [],
      gender: getPokemonGender(pokemon),
      hp: Math.max(0, pokemon?.hp || 0),
      maxHp: pokemon?.maxhp || 1,
      status: pokemon?.status || '',
      boosts: Object.fromEntries(Object.entries(pokemon?.boosts || {}).filter(([, value]) => value !== 0)),
      volatiles: Object.keys(pokemon?.volatiles || {}).map((id) => ({
        id,
        name: battle.dex.conditions.get(id).name || id,
      })),
      team,
      request: !isSpectator && sideId === ownSideId && request ? {
        type: forceSwitch.some(Boolean) ? 'switch' : moves.length ? 'move' : 'wait',
        forceSwitch,
        moves,
        trapped: Boolean(activeRequest?.trapped),
        canMegaEvo: Boolean(activeRequest?.canMegaEvo),
        canMegaEvoX: Boolean(activeRequest?.canMegaEvoX),
        canMegaEvoY: Boolean(activeRequest?.canMegaEvoY),
        canUltraBurst: Boolean(activeRequest?.canUltraBurst),
        canDynamax: Boolean(activeRequest?.canDynamax),
        canTerastallize: activeRequest?.canTerastallize || null,
        maxMoves: activeRequest?.maxMoves || null,
      } : null,
    };
  };
  const players = {
    p1: player('p1', p1, record.challenger_name, record.p1_species, record.p1_shiny),
    p2: player('p2', p2, record.opponent_name, record.p2_species, record.p2_shiny),
  };

  return {
    id: record.id,
    status: record.status,
    format: battle.format.name || FORMAT_ID,
    turn: battle.turn,
    isTraining: Boolean(record.is_training),
    trainingDifficulty: record.difficulty || null,
    yourSide: ownSideId,
    isSpectator,
    players,
    field: {
      weather: battle.field.weather ? {
        id: battle.field.weather,
        duration: battle.field.weatherState.duration ?? 0,
      } : null,
      terrain: battle.field.terrain ? {
        id: battle.field.terrain,
        duration: battle.field.terrainState.duration ?? 0,
      } : null,
      rooms: Object.entries(battle.field.pseudoWeather || {}).map(([id, state]) => ({
        id,
        duration: state.duration ?? 0,
      })),
    },
    request: ownSideId ? players[ownSideId].request : null,
    winner: record.winner_id,
    isWinner: record.winner_id === userId,
    winnerName: battle.winner || null,
    log: battle.log.filter((line) => line.startsWith('|') && !line.startsWith('|request|') && !line.startsWith('|split|')),
  };
};

const getBattleRecord = async (battleId) => get(
  `SELECT b.*, challenger.username AS challenger_name, opponent.username AS opponent_name
   FROM battle_requests b
   JOIN users challenger ON challenger.id = b.challenger_id
   JOIN users opponent ON opponent.id = b.opponent_id
   WHERE b.id = ?`,
  [battleId],
);

const applyBattleRewards = async (winnerId, challengerId, opponentId) => {
  const loserId = winnerId === challengerId ? opponentId : challengerId;
  await run(
    'UPDATE profiles SET bayas = bayas + 30, bronze_coins = bronze_coins + 1, battle_wins = battle_wins + 1 WHERE user_id = ?',
    [winnerId],
  );
  await run(
    'UPDATE profiles SET bayas = bayas + 15, bronze_coins = bronze_coins + 1, battle_losses = battle_losses + 1 WHERE user_id = ?',
    [loserId],
  );
};

const getTrainingBattleRecord = async (battleId, userId) => get(
  `SELECT b.id, b.status, b.battle_state, b.p1_species, b.p1_shiny, b.p2_species, b.p2_shiny,
          b.difficulty, b.winner_side, b.user_id AS challenger_id, -1 AS opponent_id,
          u.username AS challenger_name,
          'Entrenador Bot' || CASE b.difficulty
            WHEN 'easy' THEN ' · Fácil'
            WHEN 'medium' THEN ' · Medio'
            ELSE ' · Difícil'
          END AS opponent_name,
          CASE WHEN b.winner_side = 'p1' THEN b.user_id ELSE NULL END AS winner_id,
          1 AS is_training
   FROM training_battles b JOIN users u ON u.id = b.user_id
   WHERE b.id = ? AND b.user_id = ?`,
  [battleId, userId],
);

const getTrainingBattleView = async (battleId, userId) => {
  const record = await getTrainingBattleRecord(battleId, userId);
  return record ? getBattleView({ ...record, id: `training-${record.id}` }, userId) : null;
};

const getEligibleOpponents = async (userId, scope) => {
  if (!['guild', 'community'].includes(scope)) return null;
  const currentUser = await get('SELECT guild FROM users WHERE id = ?', [userId]);
  if (!currentUser) return [];
  const comparison = scope === 'guild' ? '= ?' : '<> ?';
  return all(
    `SELECT id, username, guild FROM users WHERE id <> ? AND guild ${comparison} ORDER BY username COLLATE NOCASE`,
    [userId, currentUser.guild],
  );
};

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

app.get('/api/catalog', (_req, res) => res.json(catalog));

app.post('/api/auth/register', registrationRateLimit, async (req, res) => {
  const { username, password, age, guild, starter, acceptTerms } = req.body || {};
  const cleanUsername = typeof username === 'string' ? username.trim() : '';
  const starterSpecies = typeof starter === 'string' && starter.length <= 32
    ? Dex.species.get(starter)
    : null;
  const numericAge = Number(age);
  if (
    !/^[\p{L}\p{N}_-]{3,24}$/u.test(cleanUsername) ||
    typeof password !== 'string' ||
    password.length < 10 ||
    password.length > 128 ||
    !Number.isInteger(numericAge) ||
    numericAge < 16 ||
    numericAge > 99 ||
    !['Garchomp', 'Dragonite', 'Dragapult', 'Metagross'].includes(guild) ||
    !starterSpecies?.exists ||
    !Number.isInteger(starterSpecies.num) ||
    starterSpecies.num < 1 ||
    acceptTerms !== true
  ) {
    return res.status(400).json({ error: 'Revisa el usuario, la contraseña, la edad, el gremio, el Pokémon inicial y la aceptación de los acuerdos.' });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 10);
    const result = await run('INSERT INTO users (username, password_hash, age, guild, starter, role_level, terms_version, terms_accepted_at) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)', [cleanUsername, passwordHash, numericAge, guild, starterSpecies.name, 4, termsVersion]);
    await run('INSERT INTO profiles (user_id, bayas, bronze_coins) VALUES (?, ?, ?)', [result.id, 150, 2]);
    await run('INSERT INTO inventory_items (user_id, item_name, quantity) VALUES (?, ?, ?)', [result.id, 'Baya de inicio', 1]);
    await run('INSERT INTO inventory_pokemon (user_id, pokemon_name, level) VALUES (?, ?, ?)', [result.id, starter, 5]);
    await run('INSERT INTO guild_memberships (user_id, guild_name, role) VALUES (?, ?, ?)', [result.id, guild, 'member']);
    const guildMessageCount = await get('SELECT COUNT(*) AS count FROM guild_messages WHERE guild_name = ?', [guild]);
    if (guildMessageCount.count === 0) {
      await run('INSERT INTO guild_messages (guild_name, username, message) VALUES (?, ?, ?)', [guild, `Guía de ${guild}`, `Bienvenidos al gremio ${guild}. Preséntate y comparte tus aventuras con la comunidad.`]);
    }
    const user = await get('SELECT id, username FROM users WHERE id = ?', [result.id]);
    res.status(201).json({ token: createToken(user), user: await getProfile(result.id) });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT') return res.status(409).json({ error: 'El usuario ya está registrado.' });
    console.error(error);
    res.status(500).json({ error: 'No se pudo crear la cuenta.' });
  }
});

app.post('/api/auth/login', loginRateLimit, async (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const user = username ? await get('SELECT id, username, password_hash FROM users WHERE username = ?', [username]) : null;
  if (!user || !(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ error: 'Credenciales incorrectas.' });
  res.json({ token: createToken(user), user: await getProfile(user.id) });
});

app.get('/api/profile', authenticate, async (req, res) => res.json(await getProfile(req.auth.id)));

app.get('/api/account/deletion-request', authenticate, async (req, res) => {
  const request = await get(
    `SELECT id, reason, created_at AS createdAt
     FROM account_deletion_requests
     WHERE user_id = ?`,
    [req.auth.id],
  );
  res.json({ request: request || null });
});

app.post('/api/account/deletion-requests', authenticate, async (req, res) => {
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  if (!reason || reason.length > 500) {
    return res.status(400).json({ error: 'Escribe un motivo de hasta 500 caracteres para la solicitud.' });
  }

  const result = await withTransaction(async () => {
    const account = await get('SELECT role_level FROM users WHERE id = ?', [req.auth.id]);
    if (!account) return { status: 401, error: 'La cuenta ya no existe.' };
    if (Number(account.role_level) <= 1) {
      return { status: 403, error: 'Las cuentas de sistema y administración no pueden solicitar supresión desde este módulo.' };
    }

    const existing = await get('SELECT id FROM account_deletion_requests WHERE user_id = ?', [req.auth.id]);
    if (existing) return { status: 409, error: 'Ya existe una solicitud de supresión pendiente para esta cuenta.' };

    const inserted = await run(
      'INSERT INTO account_deletion_requests (user_id, reason) VALUES (?, ?)',
      [req.auth.id, reason],
    );
    const request = await get(
      `SELECT id, reason, created_at AS createdAt
       FROM account_deletion_requests
       WHERE id = ?`,
      [inserted.id],
    );
    return { status: 201, request };
  });
  if (result.status !== 201) return res.status(result.status).json({ error: result.error });
  res.status(201).json({ request: result.request });
});

app.put('/api/profile/pokemon-roster', authenticate, async (req, res) => {
  const roster = req.body.pokemonRoster;
  if (!roster || !Array.isArray(roster.team) || !Array.isArray(roster.pc) || roster.team.length > 6 || roster.team.length + roster.pc.length > 1000) {
    return res.status(400).json({ error: 'La configuración del equipo Pokémon no es válida.' });
  }

  const instanceIds = new Set();
  for (const pokemon of [...roster.team, ...roster.pc]) {
    if (
      !pokemon || typeof pokemon !== 'object' ||
      typeof pokemon.species !== 'string' || !pokemon.species.trim() ||
      typeof pokemon.instanceId !== 'string' || !pokemon.instanceId.trim() ||
      instanceIds.has(pokemon.instanceId) ||
      !Number.isInteger(pokemon.level) || pokemon.level < 1 || pokemon.level > 100 ||
      typeof pokemon.shiny !== 'boolean' ||
      typeof pokemon.nickname !== 'string' || pokemon.nickname.length > 16 ||
      typeof pokemon.heldItem !== 'string' ||
      typeof pokemon.nature !== 'string' ||
      typeof pokemon.ability !== 'string' ||
      !Array.isArray(pokemon.moves) || pokemon.moves.length > 4 ||
      pokemon.moves.some((move) => typeof move !== 'string') ||
      !pokemon.ivs || !pokemon.evs ||
      !['hp', 'atk', 'def', 'spa', 'spd', 'spe'].every((stat) =>
        Number.isInteger(pokemon.ivs[stat]) && pokemon.ivs[stat] >= 0 && pokemon.ivs[stat] <= 31 &&
        Number.isInteger(pokemon.evs[stat]) && pokemon.evs[stat] >= 0 && pokemon.evs[stat] <= 252,
      ) ||
      Object.values(pokemon.evs).reduce((total, value) => total + value, 0) > 508
    ) {
      return res.status(400).json({ error: 'Revisa los datos de cada Pokémon antes de guardar.' });
    }
    instanceIds.add(pokemon.instanceId);
  }

  const rosterJson = JSON.stringify({ team: roster.team, pc: roster.pc });
  if (Buffer.byteLength(rosterJson, 'utf8') > 1_000_000) {
    return res.status(400).json({ error: 'La configuración del equipo supera el tamaño permitido.' });
  }

  const result = await withTransaction(async () => {
    const ownedPokemon = await all('SELECT pokemon_name AS name FROM inventory_pokemon WHERE user_id = ?', [req.auth.id]);
    const ownedCounts = new Map();
    const rosterCounts = new Map();
    for (const entry of ownedPokemon) {
      const key = entry.name.toLocaleLowerCase();
      ownedCounts.set(key, (ownedCounts.get(key) || 0) + 1);
    }
    for (const pokemon of [...roster.team, ...roster.pc]) {
      const key = pokemon.species.trim().toLocaleLowerCase();
      rosterCounts.set(key, (rosterCounts.get(key) || 0) + 1);
    }
    if (ownedCounts.size !== rosterCounts.size || [...ownedCounts].some(([species, count]) => rosterCounts.get(species) !== count)) {
      return { status: 400, error: 'El equipo debe contener exactamente los Pokémon que tienes en tu inventario.' };
    }

    await run(
      `INSERT INTO pokemon_rosters (user_id, roster_json) VALUES (?, ?)
       ON CONFLICT (user_id) DO UPDATE SET roster_json = excluded.roster_json, updated_at = CURRENT_TIMESTAMP`,
      [req.auth.id, rosterJson],
    );
    return { status: 200 };
  });
  if (result.status !== 200) return res.status(result.status).json({ error: result.error });
  res.json({ user: await getProfile(req.auth.id) });
});

app.post('/api/profile/pokemon-evolve', authenticate, async (req, res) => {
  const instanceId = String(req.body.instanceId || '').trim();
  const targetSpecies = String(req.body.targetSpecies || '').trim();
  if (!instanceId || !targetSpecies) {
    return res.status(400).json({ error: 'Selecciona el Pokémon y su evolución.' });
  }

  const result = await withTransaction(async () => {
    const savedRoster = await get('SELECT roster_json FROM pokemon_rosters WHERE user_id = ?', [req.auth.id]);
    if (!savedRoster) {
      return { status: 409, error: 'Guarda tu equipo Pokémon antes de evolucionar.' };
    }

    const roster = JSON.parse(savedRoster.roster_json);
    const pokemon = [...roster.team, ...roster.pc].find((entry) => entry.instanceId === instanceId);
    if (!pokemon) return { status: 404, error: 'El Pokémon seleccionado ya no está en tu equipo ni en el PC.' };

    const evolution = getPokemonEvolution(pokemon.species, targetSpecies);
    if (!evolution) return { status: 400, error: 'La especie seleccionada no es una evolución válida de este Pokémon.' };

    const profile = await get('SELECT bayas FROM profiles WHERE user_id = ?', [req.auth.id]);
    if (!profile || profile.bayas < evolution.cost) {
      return { status: 400, error: `Necesitas ${evolution.cost} bayas para esta evolución.` };
    }

    let itemToConsume = null;
    if (evolution.requiredItem) {
      const itemAliases = new Set([
        normalizeEvolutionItemName(evolution.requiredItem),
        normalizeEvolutionItemName(evolution.requiredItemAlias),
      ]);
      const ownedItems = await all(
        'SELECT item_name, quantity FROM inventory_items WHERE user_id = ? AND quantity > 0',
        [req.auth.id],
      );
      itemToConsume = ownedItems.find((item) => itemAliases.has(normalizeEvolutionItemName(item.item_name)));
      if (!itemToConsume) {
        const itemName = evolution.requiredItemAlias || evolution.requiredItem;
        return { status: 400, error: `Necesitas ${itemName} para evolucionar a ${evolution.target}.` };
      }
    }

    const ownedPokemon = await get(
      `SELECT id FROM inventory_pokemon
       WHERE user_id = ? AND pokemon_name = ? COLLATE NOCASE AND shiny = ?
       ORDER BY CASE WHEN level = ? THEN 0 ELSE 1 END, id LIMIT 1`,
      [req.auth.id, pokemon.species, pokemon.shiny ? 1 : 0, pokemon.level],
    );
    if (!ownedPokemon) return { status: 409, error: 'Este Pokémon ya no aparece en tu inventario.' };

    await run('UPDATE profiles SET bayas = bayas - ? WHERE user_id = ?', [evolution.cost, req.auth.id]);
    if (itemToConsume) {
      if (itemToConsume.quantity === 1) {
        await run('DELETE FROM inventory_items WHERE user_id = ? AND item_name = ?', [req.auth.id, itemToConsume.item_name]);
      } else {
        await run(
          'UPDATE inventory_items SET quantity = quantity - 1 WHERE user_id = ? AND item_name = ?',
          [req.auth.id, itemToConsume.item_name],
        );
      }
    }
    await run('UPDATE inventory_pokemon SET pokemon_name = ? WHERE id = ?', [evolution.target, ownedPokemon.id]);

    const updatedRoster = {
      team: roster.team.map((entry) =>
        entry.instanceId === instanceId
          ? { ...entry, species: evolution.target, ability: evolution.targetAbility || entry.ability }
          : entry),
      pc: roster.pc.map((entry) =>
        entry.instanceId === instanceId
          ? { ...entry, species: evolution.target, ability: evolution.targetAbility || entry.ability }
          : entry),
    };
    await run(
      'UPDATE pokemon_rosters SET roster_json = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?',
      [JSON.stringify(updatedRoster), req.auth.id],
    );

    return { status: 200, evolution };
  });

  if (result.status !== 200) return res.status(result.status).json({ error: result.error });
  res.json({ user: await getProfile(req.auth.id), evolution: result.evolution });
});

app.get('/api/shop/catalog', authenticate, async (_req, res) => {
  const shopCatalog = await all(
    `SELECT id, category, name, price, description, rarity, quantity, shiny
     FROM shop_catalog
     WHERE enabled = 1
     ORDER BY category, name COLLATE NOCASE`,
  );
  res.json({ shopCatalog });
});

const requireAdminAccess = async (userId) => {
  const user = await get('SELECT role_level FROM users WHERE id = ?', [userId]);
  if (!user || Number(user.role_level) !== 1) {
    return false;
  }
  return true;
};

app.get('/api/admin/dashboard', authenticate, async (req, res) => {
  if (!(await requireAdminAccess(req.auth.id))) {
    return res.status(403).json({ error: 'No tienes permisos de administración.' });
  }

  const announcements = await all('SELECT id, message, image_data AS imageData FROM announcements ORDER BY id DESC');
  const shopCatalog = await all('SELECT id, category, name, price, description, rarity, quantity, shiny, enabled FROM shop_catalog ORDER BY category, id');
  const roulettePrizes = await all('SELECT id, wheel_type AS wheelType, coin_type AS coinType, prize_type AS prizeType, name, amount, rarity, probability, enabled FROM roulette_prizes ORDER BY id');
  const sanctions = await all(
    `SELECT s.id, s.user_id AS userId, s.sanction_type AS sanctionType, s.reason, s.created_at AS createdAt,
            u.username AS username
     FROM user_sanctions s
     JOIN users u ON u.id = s.user_id
     ORDER BY s.id DESC`,
  );
  const users = await all(
    `SELECT id, username, age, guild, starter, role_level AS roleLevel
     FROM users
     ORDER BY role_level ASC, username COLLATE NOCASE ASC`,
  );
  const accountDeletionRequests = await all(
    `SELECT r.id, r.user_id AS userId, u.username, u.guild, r.reason, r.created_at AS createdAt
     FROM account_deletion_requests r
     JOIN users u ON u.id = r.user_id
     ORDER BY r.created_at ASC, r.id ASC`,
  );

  res.json({ announcements, shopCatalog, roulettePrizes, sanctions, users, accountDeletionRequests });
});

app.post('/api/admin/announcements', authenticate, async (req, res) => {
  if (!(await requireAdminAccess(req.auth.id))) {
    return res.status(403).json({ error: 'No tienes permisos de administración.' });
  }

  const list = Array.isArray(req.body.announcements) ? req.body.announcements : [];
  if (list.length > 20) return res.status(400).json({ error: 'Puedes guardar hasta 20 anuncios a la vez.' });
  const entries = [];
  for (const item of list) {
    const announcement = typeof item === 'string' ? { message: item } : item || {};
    const message = String(announcement.message || '').trim();
    const imageData = String(announcement.imageData || '');
    if (!message && !imageData) continue;
    if (message.length > 500) return res.status(400).json({ error: 'Cada anuncio admite hasta 500 caracteres.' });
    if (imageData) {
      const match = imageData.match(/^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/);
      if (!match) return res.status(400).json({ error: 'La imagen debe ser PNG, JPEG, WebP o GIF.' });
      if (Buffer.byteLength(match[2], 'base64') > 2 * 1024 * 1024) {
        return res.status(400).json({ error: 'Cada imagen debe pesar 2 MB o menos.' });
      }
    }
    entries.push({ message, imageData: imageData || null });
  }

  await withTransaction(async () => {
    await run('DELETE FROM announcements');
    for (const entry of entries) {
      await run('INSERT INTO announcements (message, image_data) VALUES (?, ?)', [entry.message, entry.imageData]);
    }
  });
  res.json({ success: true, announcements: await all('SELECT id, message, image_data AS imageData FROM announcements ORDER BY id DESC') });
});

app.post('/api/admin/shop', authenticate, async (req, res) => {
  if (!(await requireAdminAccess(req.auth.id))) {
    return res.status(403).json({ error: 'No tienes permisos de administración.' });
  }

  const submittedEntries = Array.isArray(req.body.entries) ? req.body.entries : [];
  const entries = [];
  const entryKeys = new Set();
  for (const entry of submittedEntries) {
    const category = String(entry.category || 'item');
    const name = String(entry.name || '').trim();
    const price = Number(entry.price);
    const quantity = Number(entry.quantity);
    const key = `${category}:${name.toLocaleLowerCase()}`;
    if (!['item', 'pokemon'].includes(category) || !name) {
      return res.status(400).json({ error: 'Cada producto debe tener una categoría y un nombre válidos.' });
    }
    if (!Number.isSafeInteger(price) || price < 0 || !Number.isSafeInteger(quantity) || quantity < 0) {
      return res.status(400).json({ error: 'El precio y las existencias deben ser números enteros no negativos.' });
    }
    if (entryKeys.has(key)) {
      return res.status(400).json({ error: `El producto ${name} está repetido en el catálogo.` });
    }
    entryKeys.add(key);
    entries.push({
      category,
      name,
      price,
      quantity,
      description: String(entry.description || ''),
      rarity: String(entry.rarity || 'Común'),
      shiny: category === 'pokemon' && entry.shiny ? 1 : 0,
      enabled: entry.enabled === false ? 0 : 1,
    });
  }

  await withTransaction(async () => {
    await run('DELETE FROM shop_catalog');
    for (const entry of entries) {
      await run('INSERT INTO shop_catalog (category, name, price, description, rarity, quantity, shiny, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
        entry.category,
        entry.name,
        entry.price,
        entry.description,
        entry.rarity,
        entry.quantity,
        entry.shiny,
        entry.enabled,
      ]);
    }
  });

  res.json({ success: true, shopCatalog: await all('SELECT id, category, name, price, description, rarity, quantity, shiny, enabled FROM shop_catalog ORDER BY category, id') });
});

app.post('/api/admin/roulette', authenticate, async (req, res) => {
  if (!(await requireAdminAccess(req.auth.id))) {
    return res.status(403).json({ error: 'No tienes permisos de administración.' });
  }

  const entries = Array.isArray(req.body.entries) ? req.body.entries : [];
  const normalizedEntries = [];
  for (const entry of entries) {
    const wheelType = String(entry.wheelType || 'prize');
    const coinType = String(entry.coinType || 'bronze');
    const prizeType = String(entry.prizeType || 'item');
    const name = String(entry.name || '').trim();
    const amount = Number(entry.amount);
    const probability = Number(entry.probability);
    if (!['category', 'prize'].includes(wheelType) || !['item', 'pokemon'].includes(prizeType)) {
      return res.status(400).json({ error: 'La ruleta o el tipo de premio no son válidos.' });
    }
    if (wheelType === 'prize' && !coinColumns[coinType]) {
      return res.status(400).json({ error: 'El tipo de moneda no es válido.' });
    }
    if (!name || !Number.isSafeInteger(amount) || amount < 1 || amount > 99 || !Number.isFinite(probability) || probability <= 0 || probability > 10000) {
      return res.status(400).json({ error: 'Cada premio necesita nombre, cantidad de 1 a 99 y peso de probabilidad mayor que cero.' });
    }
    normalizedEntries.push({
      wheelType,
      coinType: wheelType === 'category' ? 'bronze' : coinType,
      prizeType,
      name,
      amount,
      rarity: String(entry.rarity || 'Común'),
      probability,
      enabled: entry.enabled === false ? 0 : 1,
    });
  }

  const activeEntries = normalizedEntries.filter((entry) => entry.enabled);
  const hasActiveType = (wheelType, coinType, prizeType) => activeEntries.some((entry) =>
    entry.wheelType === wheelType && entry.coinType === coinType && entry.prizeType === prizeType,
  );
  if (!hasActiveType('category', 'bronze', 'item') || !hasActiveType('category', 'bronze', 'pokemon')) {
    return res.status(400).json({ error: 'La ruleta inicial necesita premios activos de objetos y Pokémon.' });
  }
  for (const coinType of Object.keys(coinColumns)) {
    for (const prizeType of ['item', 'pokemon']) {
      if (!hasActiveType('prize', coinType, prizeType)) {
        return res.status(400).json({ error: `La ruleta de ${coinType} necesita al menos un premio activo de ${prizeType}.` });
      }
    }
  }

  await withTransaction(async () => {
    await run('DELETE FROM roulette_prizes');
    for (const entry of normalizedEntries) {
      await run('INSERT INTO roulette_prizes (wheel_type, coin_type, prize_type, name, amount, rarity, probability, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
        entry.wheelType,
        entry.coinType,
        entry.prizeType,
        entry.name,
        entry.amount,
        entry.rarity,
        entry.probability,
        entry.enabled,
      ]);
    }
  });

  res.json({ success: true, roulettePrizes: await all('SELECT id, wheel_type AS wheelType, coin_type AS coinType, prize_type AS prizeType, name, amount, rarity, probability, enabled FROM roulette_prizes ORDER BY id') });
});

app.get('/api/roulette/config', authenticate, async (_req, res) => {
  const entries = await all(
    `SELECT id, wheel_type AS wheelType, coin_type AS coinType, prize_type AS prizeType, name, amount, rarity, probability
     FROM roulette_prizes
     WHERE enabled = 1 AND probability > 0
     ORDER BY id`,
  );
  res.json({
    categories: entries.filter((entry) => entry.wheelType === 'category'),
    prizes: entries.filter((entry) => entry.wheelType === 'prize'),
  });
});

app.post('/api/roulette/category-spin', authenticate, async (req, res) => {
  const categories = await all("SELECT id, prize_type AS prizeType, probability FROM roulette_prizes WHERE wheel_type = 'category' AND enabled = 1 AND probability > 0");
  if (!categories.length) return res.status(503).json({ error: 'La ruleta de categorías no tiene resultados configurados.' });
  const category = chooseWeightedEntry(categories);
  const selectionToken = jwt.sign({ userId: req.auth.id, rouletteCategory: category.prizeType }, jwtSecret, { expiresIn: '1h' });
  res.json({ category: category.prizeType, categoryId: category.id, selectionToken });
});

app.post('/api/roulette/spin', authenticate, async (req, res) => {
  const coinType = String(req.body.coinType || '');
  const prizeType = String(req.body.prizeType || '');
  let selection
  try {
    selection = jwt.verify(String(req.body.selectionToken || ''), jwtSecret);
  } catch {
    return res.status(400).json({ error: 'Gira primero la ruleta de categorías para elegir el tipo de premio.' });
  }
  if (selection.userId !== req.auth.id || selection.rouletteCategory !== prizeType) {
    return res.status(400).json({ error: 'La categoría no coincide con el resultado de la ruleta inicial.' });
  }
  const coinColumn = coinColumns[coinType];
  if (!coinColumn) return res.status(400).json({ error: 'Selecciona una moneda válida.' });
  if (!['item', 'pokemon'].includes(prizeType)) return res.status(400).json({ error: 'Primero selecciona objetos o Pokémon en la ruleta inicial.' });

  const result = await withTransaction(async () => {
    const profile = await get(`SELECT ${coinColumn} AS balance FROM profiles WHERE user_id = ?`, [req.auth.id]);
    if (!profile || profile.balance < 1) return { status: 400, error: `No tienes monedas de ${coinType}.` };
    const category = await get("SELECT id FROM roulette_prizes WHERE wheel_type = 'category' AND prize_type = ? AND enabled = 1 AND probability > 0 LIMIT 1", [prizeType]);
    if (!category) return { status: 400, error: 'Esa categoría no está activa en la ruleta inicial.' };
    const prizeEntries = await all("SELECT id, prize_type AS prizeType, name, amount, rarity, probability FROM roulette_prizes WHERE wheel_type = 'prize' AND coin_type = ? AND prize_type = ? AND enabled = 1 AND probability > 0", [coinType, prizeType]);
    if (!prizeEntries.length) return { status: 503, error: `La ruleta de ${coinType} no tiene premios activos de ${prizeType}.` };
    const prize = chooseWeightedEntry(prizeEntries);
    await run(`UPDATE profiles SET ${coinColumn} = ${coinColumn} - 1 WHERE user_id = ?`, [req.auth.id]);
    if (prize.prizeType === 'item') {
      await run(
        `INSERT INTO inventory_items (user_id, item_name, quantity) VALUES (?, ?, ?)
         ON CONFLICT (user_id, item_name) DO UPDATE SET quantity = quantity + excluded.quantity`,
        [req.auth.id, prize.name, prize.amount],
      );
    } else {
      for (let amount = 0; amount < prize.amount; amount += 1) {
        await run('INSERT INTO inventory_pokemon (user_id, pokemon_name, level) VALUES (?, ?, 5)', [req.auth.id, prize.name]);
      }
    }
    return { status: 200, category: prizeType, prize };
  });
  if (result.status !== 200) return res.status(result.status).json({ error: result.error });
  res.json({ category: result.category, prize: result.prize, user: await getProfile(req.auth.id) });
});

app.post('/api/economy/convert-coins', authenticate, async (req, res) => {
  const targetType = String(req.body.targetType || '');
  const exchange = coinExchanges[targetType];
  const amount = Number(req.body.amount);
  if (!exchange || !Number.isSafeInteger(amount) || amount < 1 || amount > 100000) {
    return res.status(400).json({ error: 'La conversión solicitada no es válida.' });
  }
  const sourceColumn = coinColumns[exchange.source];
  const targetColumn = coinColumns[targetType];
  const totalCost = exchange.rate * amount;
  const result = await withTransaction(async () => {
    const profile = await get(`SELECT ${sourceColumn} AS balance FROM profiles WHERE user_id = ?`, [req.auth.id]);
    if (!profile || profile.balance < totalCost) return { status: 400, error: `Necesitas ${totalCost} monedas de ${exchange.source} para esta conversión.` };
    await run(`UPDATE profiles SET ${sourceColumn} = ${sourceColumn} - ?, ${targetColumn} = ${targetColumn} + ? WHERE user_id = ?`, [totalCost, amount, req.auth.id]);
    return { status: 200 };
  });
  if (result.status !== 200) return res.status(result.status).json({ error: result.error });
  res.json({ user: await getProfile(req.auth.id), converted: amount, spent: totalCost, source: exchange.source, target: targetType });
});

app.post('/api/admin/sanctions', authenticate, async (req, res) => {
  if (!(await requireAdminAccess(req.auth.id))) {
    return res.status(403).json({ error: 'No tienes permisos de administración.' });
  }

  const { userId, sanctionType, reason } = req.body;
  const targetUserId = Number(userId);
  const cleanReason = String(reason || '').trim();
  const cleanType = String(sanctionType || '').trim();

  if (!Number.isInteger(targetUserId) || !['warning', 'suspension', 'ban'].includes(cleanType) || !cleanReason) {
    return res.status(400).json({ error: 'Revisa el usuario, el tipo de sanción y el motivo.' });
  }

  await run('INSERT INTO user_sanctions (user_id, admin_user_id, sanction_type, reason) VALUES (?, ?, ?, ?)', [targetUserId, req.auth.id, cleanType, cleanReason]);
  res.status(201).json({ success: true });
});

app.delete('/api/admin/users/:id', authenticate, async (req, res) => {
  const currentUser = await get('SELECT role_level FROM users WHERE id = ?', [req.auth.id]);
  if (!currentUser || Number(currentUser.role_level) !== 1) {
    return res.status(403).json({ error: 'No tienes permisos de administración.' });
  }

  const targetUserId = Number(req.params.id);
  if (!Number.isSafeInteger(targetUserId) || targetUserId < 1) {
    return res.status(400).json({ error: 'El usuario seleccionado no es válido.' });
  }
  if (targetUserId === Number(req.auth.id)) {
    return res.status(400).json({ error: 'No puedes eliminar tu propia cuenta desde este módulo.' });
  }

  const result = await withTransaction(async () => {
    const targetUser = await get('SELECT id, username, role_level FROM users WHERE id = ?', [targetUserId]);
    if (!targetUser) return { status: 404, error: 'La cuenta seleccionada ya no existe.' };
    if (Number(targetUser.role_level) <= 1) {
      return { status: 403, error: 'Las cuentas de sistema y de administración están protegidas en este módulo.' };
    }

    const chatMessages = await run(
      'DELETE FROM chat_messages WHERE user_id = ? OR (user_id IS NULL AND username = ? COLLATE NOCASE)',
      [targetUserId, targetUser.username],
    );
    const guildMessages = await run(
      'DELETE FROM guild_messages WHERE user_id = ? OR (user_id IS NULL AND username = ? COLLATE NOCASE)',
      [targetUserId, targetUser.username],
    );
    await run('DELETE FROM users WHERE id = ?', [targetUserId]);
    return {
      status: 200,
      deleted: {
        chatMessages: chatMessages.changes,
        guildMessages: guildMessages.changes,
      },
    };
  });
  if (result.status !== 200) return res.status(result.status).json({ error: result.error });
  res.json({ success: true, deleted: result.deleted });
});

app.get('/api/users', authenticate, async (req, res) => {
  const currentUser = await get('SELECT role_level FROM users WHERE id = ?', [req.auth.id]);
  if (!currentUser || Number(currentUser.role_level) > 1) {
    return res.status(403).json({ error: 'No tienes permisos para gestionar usuarios.' });
  }

  const users = await all(
    `SELECT id, username, age, guild, starter, role_level
     FROM users
     ORDER BY role_level ASC, username COLLATE NOCASE ASC`,
  );

  res.json({ users: users.map((user) => ({ ...user, roleLevel: Number(user.role_level) })) });
});

app.post('/api/users/role', authenticate, async (req, res) => {
  const roleLevel = Number(req.body.roleLevel);
  const targetUserId = Number(req.body.userId);

  if (!Number.isInteger(targetUserId) || !Number.isInteger(roleLevel) || roleLevel < 0 || roleLevel > 4) {
    return res.status(400).json({ error: 'El rango del usuario no es válido.' });
  }

  const currentUser = await get('SELECT role_level FROM users WHERE id = ?', [req.auth.id]);
  if (!currentUser || Number(currentUser.role_level) > 1) {
    return res.status(403).json({ error: 'No tienes permisos para cambiar rangos.' });
  }

  if (currentUser.role_level === 1 && roleLevel === 0) {
    return res.status(403).json({ error: 'Solo el nivel 0 puede asignar el rango de sistema.' });
  }

  const targetUser = await get('SELECT id, username, role_level FROM users WHERE id = ?', [targetUserId]);
  if (!targetUser) {
    return res.status(404).json({ error: 'Usuario no encontrado.' });
  }

  if (req.auth.id === targetUser.id) {
    return res.status(403).json({ error: 'No puedes cambiar tu propio rango.' });
  }

  if (Number(targetUser.role_level) === 0 && Number(currentUser.role_level) !== 0) {
    return res.status(403).json({ error: 'Solo el nivel 0 puede modificar a un usuario del sistema.' });
  }

  const targetGuild = await get('SELECT guild FROM users WHERE id = ?', [targetUserId]);
  if (roleLevel === 2) {
    await run("UPDATE users SET role_level = 4 WHERE guild = ? AND role_level = 2 AND id != ?", [targetGuild.guild, targetUserId]);
    await run("UPDATE guild_memberships SET role = 'member' WHERE guild_name = ? AND role = 'leader'", [targetGuild.guild]);
  }

  await run('UPDATE users SET role_level = ? WHERE id = ?', [roleLevel, targetUserId]);
  const guildRole = roleLevel === 2 ? 'leader' : roleLevel === 3 ? 'elite' : 'member';
  await run('UPDATE guild_memberships SET role = ? WHERE user_id = ?', [guildRole, targetUserId]);
  const users = await all(
    `SELECT id, username, age, guild, starter, role_level
     FROM users
     ORDER BY role_level ASC, username COLLATE NOCASE ASC`,
  );

  res.json({
    updatedUser: await getProfile(targetUserId),
    users: users.map((user) => ({ ...user, roleLevel: Number(user.role_level) })),
  });
});

const getCurrentGuild = async (userId) => {
  const currentUser = await get(
    'SELECT u.guild AS name, u.role_level, gm.role FROM users u LEFT JOIN guild_memberships gm ON gm.user_id = u.id WHERE u.id = ?',
    [userId],
  );
  if (!currentUser) return null;

  const guildRole = getEffectiveGuildRole(currentUser, currentUser.role || 'member');

  const members = await all(
    `SELECT u.username, u.guild AS guild, u.role_level, COALESCE(gm.role, 'member') AS role
     FROM users u LEFT JOIN guild_memberships gm ON gm.user_id = u.id
     WHERE u.guild = ? ORDER BY CASE COALESCE(gm.role, 'member') WHEN 'leader' THEN 0 WHEN 'elite' THEN 1 ELSE 2 END, u.username COLLATE NOCASE`,
    [currentUser.name],
  );
  const messages = await all(
    `SELECT gm.username AS user, gm.message, gm.created_at AS createdAt,
            COALESCE(membership.role, 'member') AS guildRole, CASE WHEN gm.user_id IS NULL THEN 1 ELSE 0 END AS system
     FROM guild_messages gm LEFT JOIN guild_memberships membership ON membership.user_id = gm.user_id
     WHERE gm.guild_name = ? ORDER BY gm.id DESC LIMIT 100`,
    [currentUser.name],
  );

  return {
    name: currentUser.name,
    role: guildRole,
    members: members.map((member) => ({
      ...member,
      role: getEffectiveGuildRole({ role_level: member.role_level }, member.role),
    })),
    messages: messages.reverse(),
  };
};

app.get('/api/guilds/current', authenticate, async (req, res) => {
  const guild = await getCurrentGuild(req.auth.id);
  if (!guild) return res.status(404).json({ error: 'No se encontró tu gremio.' });
  res.json(guild);
});

app.post('/api/guilds/messages', authenticate, async (req, res) => {
  const message = String(req.body.message || '').trim();
  if (!message || message.length > 140) return res.status(400).json({ error: 'El mensaje no es válido.' });
  const user = await get('SELECT guild FROM users WHERE id = ?', [req.auth.id]);
  if (!user) return res.status(404).json({ error: 'No se encontró tu cuenta.' });
  await run('INSERT INTO guild_messages (guild_name, user_id, username, message) VALUES (?, ?, ?, ?)', [user.guild, req.auth.id, req.auth.username, message]);
  res.status(201).json(await getCurrentGuild(req.auth.id));
});

app.post('/api/guilds/roles', authenticate, async (req, res) => {
  const username = String(req.body.username || '').trim();
  const role = req.body.role;
  if (!username || !['member', 'elite'].includes(role)) {
    return res.status(400).json({ error: 'Selecciona un miembro y un rango válido.' });
  }

  const leader = await get('SELECT guild_name, role FROM guild_memberships WHERE user_id = ?', [req.auth.id]);
  if (leader?.role !== 'leader') return res.status(403).json({ error: 'Solo el líder puede gestionar el Alto Mando.' });
  const target = await get(
    'SELECT u.id, gm.role FROM users u JOIN guild_memberships gm ON gm.user_id = u.id WHERE u.username = ? AND u.guild = ? AND gm.guild_name = ?',
    [username, leader.guild_name, leader.guild_name],
  );
  if (!target) return res.status(404).json({ error: 'Ese miembro no pertenece a tu gremio.' });
  if (target.role === 'leader') return res.status(400).json({ error: 'No puedes cambiar el rango del líder del gremio.' });

  await run('UPDATE guild_memberships SET role = ? WHERE user_id = ?', [role, target.id]);
  res.json(await getCurrentGuild(req.auth.id));
});

app.get('/api/announcements', async (_req, res) => res.json(await all('SELECT id, message, image_data AS imageData FROM announcements ORDER BY id DESC')));

const getGlobalChatMessages = () => all(
  `SELECT c.username AS user, c.message, c.created_at AS createdAt,
          COALESCE(c.guild_name, u.guild) AS guild, COALESCE(gm.role, 'member') AS guildRole,
          u.starter AS starter
   FROM chat_messages c LEFT JOIN users u ON u.id = c.user_id
   LEFT JOIN guild_memberships gm ON gm.user_id = u.id ORDER BY c.id ASC`,
);

app.get('/api/chat', async (_req, res) => res.json(await getGlobalChatMessages()));

app.post('/api/chat', authenticate, async (req, res) => {
  const message = String(req.body.message || '').trim();
  if (!message || message.length > 140) return res.status(400).json({ error: 'El mensaje no es válido.' });
  const user = await get('SELECT guild FROM users WHERE id = ?', [req.auth.id]);
  await run('INSERT INTO chat_messages (user_id, username, message, guild_name) VALUES (?, ?, ?, ?)', [req.auth.id, req.auth.username, message, user?.guild || null]);
  res.status(201).json(await getGlobalChatMessages());
});

app.post('/api/economy/bayas', authenticate, async (req, res) => {
  await run('UPDATE profiles SET bayas = bayas + 20 WHERE user_id = ?', [req.auth.id]);
  res.json(await getProfile(req.auth.id));
});

app.get('/api/battles/opponents', authenticate, async (req, res) => {
  const scope = String(req.query.scope || 'guild');
  const opponents = await getEligibleOpponents(req.auth.id, scope);
  if (!opponents) return res.status(400).json({ error: 'Elige un alcance de gremio o comunidad.' });
  res.json({ opponents });
});

app.get('/api/battles/requests', authenticate, async (req, res) => {
  await run("UPDATE battle_requests SET status = 'expired', updated_at = CURRENT_TIMESTAMP WHERE status = 'pending' AND created_at < datetime('now', '-10 minutes')");
  const requests = await all(
    `SELECT b.id, b.challenger_id AS challengerId, b.opponent_id AS opponentId, b.scope,
            b.status, b.p1_species AS challengerPokemon, b.p1_shiny AS challengerShiny,
            b.created_at AS createdAt, challenger.username AS challengerName, opponent.username AS opponentName
     FROM battle_requests b
     JOIN users challenger ON challenger.id = b.challenger_id
     JOIN users opponent ON opponent.id = b.opponent_id
     WHERE (b.challenger_id = ? OR b.opponent_id = ?) AND b.status = 'pending'
     ORDER BY b.id DESC`,
    [req.auth.id, req.auth.id],
  );
  res.json({ requests });
});

app.get('/api/battles/current', authenticate, async (req, res) => {
  const trainingRecord = await get(
    `SELECT id FROM training_battles
     WHERE user_id = ? AND status = 'active'
     ORDER BY id DESC LIMIT 1`,
    [req.auth.id],
  );
  if (trainingRecord) {
    return res.json({ battle: await getTrainingBattleView(trainingRecord.id, req.auth.id) });
  }
  const record = await get(
    `SELECT id FROM battle_requests
     WHERE (challenger_id = ? OR opponent_id = ?) AND status IN ('active', 'finished')
     ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, id DESC LIMIT 1`,
    [req.auth.id, req.auth.id],
  );
  if (record?.status === 'active') {
    const fullRecord = await getBattleRecord(record.id);
    return res.json({ battle: getBattleView(fullRecord, req.auth.id) });
  }
  const finishedTraining = await get(
    `SELECT id FROM training_battles WHERE user_id = ? AND status = 'finished' ORDER BY id DESC LIMIT 1`,
    [req.auth.id],
  );
  if (finishedTraining) {
    return res.json({ battle: await getTrainingBattleView(finishedTraining.id, req.auth.id) });
  }
  if (!record) return res.json({ battle: null });
  const fullRecord = await getBattleRecord(record.id);
  res.json({ battle: getBattleView(fullRecord, req.auth.id) });
});

app.get('/api/battles/active', authenticate, async (_req, res) => {
  const records = await all(
    `SELECT b.id, challenger.username AS challenger_name, opponent.username AS opponent_name
     FROM battle_requests b
     JOIN users challenger ON challenger.id = b.challenger_id
     JOIN users opponent ON opponent.id = b.opponent_id
     WHERE b.status = 'active'
     ORDER BY b.updated_at DESC, b.id DESC
     LIMIT 50`,
  );
  const battles = await Promise.all(records.map(async (entry) => {
    const record = await getBattleRecord(entry.id);
    const view = getBattleView(record, null);
    return {
      id: view.id,
      format: view.format,
      turn: view.turn,
      challengerName: record.challenger_name,
      opponentName: record.opponent_name,
      players: view.players,
    };
  }));
  res.json({ battles });
});

app.get('/api/battles/:id/spectate', authenticate, async (req, res) => {
  const record = await getBattleRecord(Number(req.params.id));
  if (!record || record.status !== 'active') {
    return res.status(404).json({ error: 'Ese combate ya no está activo o no existe.' });
  }
  res.json({ battle: getBattleView(record, req.auth.id) });
});

app.get('/api/battles/:id/messages', authenticate, async (req, res) => {
  const battle = await get('SELECT id, status FROM battle_requests WHERE id = ?', [Number(req.params.id)]);
  if (!battle) return res.status(404).json({ error: 'No se encontró ese combate.' });
  const messages = await all(
    `SELECT m.id, m.message, m.created_at AS createdAt, u.username AS username
     FROM battle_messages m JOIN users u ON u.id = m.user_id
     WHERE m.battle_id = ? ORDER BY m.id DESC LIMIT 100`,
    [battle.id],
  );
  res.json({ messages: messages.reverse() });
});

app.post('/api/battles/:id/messages', authenticate, async (req, res) => {
  const message = String(req.body.message || '').trim();
  if (!message || message.length > 500) {
    return res.status(400).json({ error: 'El mensaje debe tener entre 1 y 500 caracteres.' });
  }
  const battle = await get(
    "SELECT id FROM battle_requests WHERE id = ? AND status IN ('active', 'finished') AND (challenger_id = ? OR opponent_id = ?)",
    [Number(req.params.id), req.auth.id, req.auth.id],
  );
  if (!battle) return res.status(403).json({ error: 'Solo los participantes pueden escribir en el chat del combate.' });
  await run('INSERT INTO battle_messages (battle_id, user_id, message) VALUES (?, ?, ?)', [battle.id, req.auth.id, message]);
  res.status(201).json({ success: true });
});

app.post('/api/battles/requests', authenticate, async (req, res) => {
  const opponentId = Number(req.body.opponentId);
  const scope = String(req.body.scope || '');
  if (!Number.isInteger(opponentId) || opponentId === req.auth.id || !['guild', 'community'].includes(scope)) {
    return res.status(400).json({ error: 'Selecciona un rival válido y un alcance de batalla.' });
  }

  const [challenger, opponent] = await Promise.all([
    get('SELECT id, username, guild FROM users WHERE id = ?', [req.auth.id]),
    get('SELECT id, username, guild FROM users WHERE id = ?', [opponentId]),
  ]);
  if (!challenger || !opponent) return res.status(404).json({ error: 'No se encontró al rival.' });
  if ((scope === 'guild' && challenger.guild !== opponent.guild) || (scope === 'community' && challenger.guild === opponent.guild)) {
    return res.status(403).json({ error: 'Ese rival no pertenece al alcance seleccionado.' });
  }

  let team;
  try {
    team = await getBattleTeam(req.auth.id, PVP_FORMAT_ID, true);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  const result = await withTransaction(async () => {
    await run("UPDATE battle_requests SET status = 'expired', updated_at = CURRENT_TIMESTAMP WHERE status = 'pending' AND created_at < datetime('now', '-10 minutes')");
    const busy = await get(
      "SELECT id FROM battle_requests WHERE status IN ('pending', 'active') AND (challenger_id IN (?, ?) OR opponent_id IN (?, ?)) LIMIT 1",
      [req.auth.id, opponentId, req.auth.id, opponentId],
    );
    if (busy) return { error: 'Tú o ese rival ya tienen un desafío pendiente o un combate activo.' };
    const created = await run(
      `INSERT INTO battle_requests (challenger_id, opponent_id, scope, challenger_team, p1_species, p1_shiny)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [req.auth.id, opponentId, scope, JSON.stringify(team), team[0].species, team[0].shiny ? 1 : 0],
    );
    return { id: created.id };
  });
  if (result.error) return res.status(409).json({ error: result.error });
  res.status(201).json({ success: true, requestId: result.id });
});

app.post('/api/battles/requests/:id/reject', authenticate, async (req, res) => {
  const result = await run(
    "UPDATE battle_requests SET status = 'rejected', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND opponent_id = ? AND status = 'pending'",
    [Number(req.params.id), req.auth.id],
  );
  if (!result.changes) return res.status(409).json({ error: 'La solicitud ya no está disponible.' });
  res.json({ success: true });
});

app.post('/api/battles/requests/:id/accept', authenticate, async (req, res) => {
  let opponentTeam;
  try {
    opponentTeam = await getBattleTeam(req.auth.id, PVP_FORMAT_ID, true);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  const result = await withTransaction(async () => {
    const record = await get('SELECT * FROM battle_requests WHERE id = ? AND opponent_id = ? AND status = ?', [Number(req.params.id), req.auth.id, 'pending']);
    if (!record) return { error: 'La solicitud ya no está pendiente.' };
    const busy = await get(
      "SELECT id FROM battle_requests WHERE id <> ? AND status IN ('active') AND (challenger_id = ? OR opponent_id = ?) LIMIT 1",
      [record.id, req.auth.id, req.auth.id],
    );
    if (busy) return { error: 'Termina tu combate activo antes de aceptar otro.' };

    const challenger = await get('SELECT username FROM users WHERE id = ?', [record.challenger_id]);
    const opponent = await get('SELECT username FROM users WHERE id = ?', [record.opponent_id]);
    const battle = createBattle({
      challenger: challenger.username,
      opponent: opponent.username,
      challengerTeam: JSON.parse(record.challenger_team),
      opponentTeam,
      formatId: PVP_FORMAT_ID,
    });
    const update = await run(
      `UPDATE battle_requests
       SET status = 'active', opponent_team = ?, battle_state = ?, p2_species = ?, p2_shiny = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status = 'pending'`,
      [JSON.stringify(opponentTeam), JSON.stringify(battle.toJSON()), opponentTeam[0].species, opponentTeam[0].shiny ? 1 : 0, record.id],
    );
    if (!update.changes) return { error: 'La solicitud ya fue respondida.' };
    return { id: record.id };
  });
  if (result.error) return res.status(409).json({ error: result.error });
  const record = await getBattleRecord(result.id);
  res.json({ battle: getBattleView(record, req.auth.id) });
});

app.post('/api/battles/training', authenticate, async (req, res) => {
  const difficulty = String(req.body.difficulty || '');
  if (!['easy', 'medium', 'hard'].includes(difficulty)) {
    return res.status(400).json({ error: 'Selecciona una dificultad válida para entrenar.' });
  }

  let challengerTeam;
  try {
    challengerTeam = await getBattleTeam(req.auth.id, PVP_FORMAT_ID, true);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  const averageLevel = challengerTeam.reduce((total, pokemon) => total + pokemon.level, 0) / challengerTeam.length;
  const levelBand = Math.max(1, Math.min(100, Math.floor(averageLevel / 5) * 5 || 1));
  const levelOffset = difficulty === 'easy' ? -2 : difficulty === 'hard' ? 2 : 0;
  const result = await withTransaction(async () => {
    const activePvP = await get(
      "SELECT id FROM battle_requests WHERE status = 'active' AND (challenger_id = ? OR opponent_id = ?) LIMIT 1",
      [req.auth.id, req.auth.id],
    );
    const activeTraining = await get(
      "SELECT id FROM training_battles WHERE user_id = ? AND status = 'active' LIMIT 1",
      [req.auth.id],
    );
    if (activePvP || activeTraining) return { error: 'Termina tu combate activo antes de iniciar un entrenamiento.' };

    const opponentTeam = createTrainingTeam(difficulty, Math.max(1, Math.min(100, levelBand + levelOffset)));
    const opponentName = `Entrenador Bot · ${difficulty === 'easy' ? 'Fácil' : difficulty === 'medium' ? 'Medio' : 'Difícil'}`;
    const battle = createBattle({
      challenger: req.auth.username,
      opponent: opponentName,
      challengerTeam,
      opponentTeam,
      formatId: PVP_FORMAT_ID,
    });
    const created = await run(
      `INSERT INTO training_battles
       (user_id, difficulty, level_band, challenger_team, opponent_team, battle_state, p1_species, p1_shiny, p2_species, p2_shiny)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.auth.id,
        difficulty,
        levelBand,
        JSON.stringify(challengerTeam),
        JSON.stringify(opponentTeam),
        JSON.stringify(battle.toJSON()),
        challengerTeam[0].species,
        challengerTeam[0].shiny ? 1 : 0,
        opponentTeam[0].species,
        opponentTeam[0].shiny ? 1 : 0,
      ],
    );
    return { id: created.id };
  });
  if (result.error) return res.status(409).json({ error: result.error });
  res.status(201).json({ battle: await getTrainingBattleView(result.id, req.auth.id) });
});

app.post('/api/battles/training/:id/abandon', authenticate, async (req, res) => {
  const trainingId = Number(String(req.params.id).replace(/^training-/, ''));
  if (!Number.isSafeInteger(trainingId) || trainingId < 1) {
    return res.status(404).json({ error: 'No se encontró ese entrenamiento.' });
  }
  const result = await run(
    "UPDATE training_battles SET status = 'finished', winner_side = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND status = 'active'",
    [trainingId, req.auth.id],
  );
  if (!result.changes) return res.status(404).json({ error: 'Ese entrenamiento no está activo o no te pertenece.' });
  res.json({ battle: await getTrainingBattleView(trainingId, req.auth.id) });
});

app.post('/api/battles/:id/forfeit', authenticate, async (req, res) => {
  const battleId = Number(req.params.id);
  if (!Number.isSafeInteger(battleId) || battleId < 1) {
    return res.status(404).json({ error: 'No se encontró ese combate.' });
  }
  const result = await withTransaction(async () => {
    const record = await getBattleRecord(battleId);
    if (!record || record.status !== 'active' || ![record.challenger_id, record.opponent_id].includes(req.auth.id)) {
      return { error: 'No tienes un combate activo con ese identificador.', status: 404 };
    }
    const forfeitingSide = record.challenger_id === req.auth.id ? 'p1' : 'p2';
    const winnerSide = forfeitingSide === 'p1' ? 'p2' : 'p1';
    const winnerId = winnerSide === 'p1' ? record.challenger_id : record.opponent_id;
    const battle = restoreBattle(JSON.parse(record.battle_state));
    if (!battle.win(winnerSide)) {
      return { error: 'El combate ya terminó.', status: 409 };
    }
    const update = await run(
      "UPDATE battle_requests SET status = 'finished', winner_id = ?, battle_state = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'active'",
      [winnerId, JSON.stringify(battle.toJSON()), record.id],
    );
    if (!update.changes) return { error: 'El combate ya terminó.', status: 409 };
    await applyBattleRewards(winnerId, record.challenger_id, record.opponent_id);
    return { id: record.id };
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  const record = await getBattleRecord(result.id);
  res.json({ battle: getBattleView(record, req.auth.id), user: await getProfile(req.auth.id) });
});

app.post('/api/battles/:id/move', authenticate, async (req, res) => {
  if (String(req.params.id).startsWith('training-')) {
    const trainingId = Number(String(req.params.id).slice('training-'.length));
    if (!Number.isSafeInteger(trainingId) || trainingId < 1) {
      return res.status(404).json({ error: 'No se encontró ese entrenamiento.' });
    }
    const result = await withTransaction(async () => {
      const record = await get(
        "SELECT * FROM training_battles WHERE id = ? AND user_id = ? AND status = 'active'",
        [trainingId, req.auth.id],
      );
      if (!record) return { error: 'No tienes un entrenamiento activo con ese identificador.', status: 404 };

      const battle = restoreBattle(JSON.parse(record.battle_state));
      const sideRequest = battle.p1.activeRequest;
      const request = sideRequest?.active?.[0];
      const switchIndex = req.body.switchIndex === undefined ? NaN : Number(req.body.switchIndex);
      let choice;
      if (Number.isInteger(switchIndex)) {
        if (!sideRequest) return { error: 'Espera a que el rival termine su turno.', status: 409 };
        const pokemon = battle.p1.pokemon[switchIndex];
        if (!pokemon || pokemon.fainted || pokemon.isActive) {
          return { error: 'Selecciona un Pokémon disponible para cambiar.', status: 400 };
        }
        choice = `switch ${switchIndex + 1}`;
      } else {
        if (!request?.moves) return { error: 'Espera a que el rival termine su turno.', status: 409 };
        const moveId = String(req.body.moveId || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const moveIndex = request.moves.findIndex((move) =>
          move.id === moveId && !move.disabled && (typeof move.pp !== 'number' || move.pp > 0),
        );
        if (moveIndex < 0) return { error: 'Ese movimiento no está disponible en este turno.', status: 400 };
        const battleOption = String(req.body.battleOption || '');
        const availableOptions = {
          mega: Boolean(request.canMegaEvo),
          megax: Boolean(request.canMegaEvoX),
          megay: Boolean(request.canMegaEvoY),
          ultra: Boolean(request.canUltraBurst),
          dynamax: Boolean(request.canDynamax),
          terastallize: Boolean(request.canTerastallize),
          zmove: Boolean(request.canZMove?.[moveIndex]),
        };
        if (battleOption && !availableOptions[battleOption]) {
          return { error: 'Esa opción especial no está disponible para este movimiento.', status: 400 };
        }
        choice = `move ${moveIndex + 1}${battleOption ? ` ${battleOption}` : ''}`;
      }

      if (!battle.choose('p1', choice)) {
        return { error: 'Showdown no pudo aceptar ese movimiento.', status: 400 };
      }
      while (!battle.ended && hasTrainingActionRequest(battle)) {
        const botChoice = chooseTrainingAction(battle, record.difficulty);
        if (!botChoice || !battle.choose('p2', botChoice)) {
          throw new Error('El bot no pudo elegir una acción válida para el combate.');
        }
        if (!battle.p2.activeRequest?.forceSwitch?.some(Boolean) && !battle.p2.active?.some((pokemon) => pokemon.fainted)) {
          break;
        }
      }

      const status = battle.ended ? 'finished' : 'active';
      const winnerSide = battle.winner === battle.p1.name ? 'p1' : battle.winner === battle.p2.name ? 'p2' : null;
      await run(
        'UPDATE training_battles SET status = ?, winner_side = ?, battle_state = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [status, winnerSide, JSON.stringify(battle.toJSON()), record.id],
      );
      return { id: record.id };
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    return res.json({ battle: await getTrainingBattleView(result.id, req.auth.id) });
  }

  const result = await withTransaction(async () => {
    const record = await get('SELECT * FROM battle_requests WHERE id = ? AND status = ?', [Number(req.params.id), 'active']);
    if (!record || ![record.challenger_id, record.opponent_id].includes(req.auth.id)) {
      return { error: 'No tienes un combate activo con ese identificador.', status: 404 };
    }
    const battle = restoreBattle(JSON.parse(record.battle_state));
    const sideId = record.challenger_id === req.auth.id ? 'p1' : 'p2';
    const request = battle[sideId].activeRequest?.active?.[0];
    const switchIndex = req.body.switchIndex === undefined ? NaN : Number(req.body.switchIndex);
    let choice;
    if (Number.isInteger(switchIndex)) {
      if (!battle[sideId].activeRequest) {
        return { error: 'Espera a que ambos jugadores terminen el turno actual.', status: 409 };
      }
      const outgoingPokemon = battle[sideId].pokemon[switchIndex];
      if (!outgoingPokemon || outgoingPokemon.fainted || outgoingPokemon.isActive) {
        return { error: 'Selecciona un Pokémon disponible para cambiar.', status: 400 };
      }
      choice = `switch ${switchIndex + 1}`;
    } else {
      if (!request?.moves) return { error: 'Espera a que ambos jugadores terminen el turno actual.', status: 409 };
      const moveId = String(req.body.moveId || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const moveIndex = request.moves.findIndex((move) =>
        move.id === moveId && !move.disabled && (typeof move.pp !== 'number' || move.pp > 0),
      );
      if (moveIndex < 0) return { error: 'Ese movimiento no está disponible en este turno.', status: 400 };
      const battleOption = String(req.body.battleOption || '');
      const canZMove = Boolean(request.canZMove?.[moveIndex]);
      const availableOptions = {
        mega: Boolean(request.canMegaEvo),
        megax: Boolean(request.canMegaEvoX),
        megay: Boolean(request.canMegaEvoY),
        ultra: Boolean(request.canUltraBurst),
        dynamax: Boolean(request.canDynamax),
        terastallize: Boolean(request.canTerastallize),
        zmove: canZMove,
      };
      if (battleOption && !availableOptions[battleOption]) {
        return { error: 'Esa opción especial no está disponible para este movimiento.', status: 400 };
      }
      choice = `move ${moveIndex + 1}${battleOption ? ` ${battleOption}` : ''}`;
    }

    if (!battle.choose(sideId, choice)) {
      return { error: 'Showdown no pudo aceptar ese movimiento.', status: 400 };
    }

    let status = 'active';
    let winnerId = null;
    if (battle.ended) {
      status = 'finished';
      if (battle.winner) {
        winnerId = battle.winner === battle.p1.name ? record.challenger_id : record.opponent_id;
        await applyBattleRewards(winnerId, record.challenger_id, record.opponent_id);
      }
    }
    await run(
      'UPDATE battle_requests SET status = ?, winner_id = ?, battle_state = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = ?',
      [status, winnerId, JSON.stringify(battle.toJSON()), record.id, 'active'],
    );
    return { id: record.id };
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  const record = await getBattleRecord(result.id);
  res.json({ battle: getBattleView(record, req.auth.id), user: await getProfile(req.auth.id) });
});

app.post('/api/shop/items', authenticate, async (req, res) => {
  const itemId = Number(req.body.itemId);
  if (!Number.isSafeInteger(itemId)) return res.status(404).json({ error: 'Objeto no encontrado.' });
  const result = await withTransaction(async () => {
    const item = await get('SELECT id, name, price FROM shop_catalog WHERE id = ? AND category = ? AND enabled = 1', [itemId, 'item']);
    if (!item) return { status: 404, error: 'Objeto no disponible en la tienda.' };
    const profile = await get('SELECT bayas FROM profiles WHERE user_id = ?', [req.auth.id]);
    if (!profile || profile.bayas < item.price) return { status: 400, error: 'No tienes suficientes bayas.' };
    const stock = await run('UPDATE shop_catalog SET quantity = quantity - 1 WHERE id = ? AND enabled = 1 AND quantity > 0', [item.id]);
    if (!stock.changes) return { status: 409, error: 'Este objeto está agotado para todos los usuarios.' };
    await run('UPDATE profiles SET bayas = bayas - ? WHERE user_id = ?', [item.price, req.auth.id]);
    await run(
      `INSERT INTO inventory_items (user_id, item_name, quantity) VALUES (?, ?, 1)
       ON CONFLICT (user_id, item_name) DO UPDATE SET quantity = quantity + 1`,
      [req.auth.id, item.name],
    );
    return { status: 200 };
  });
  if (result.status !== 200) return res.status(result.status).json({ error: result.error });
  res.json({ user: await getProfile(req.auth.id), shopCatalog: await all('SELECT id, category, name, price, description, rarity, quantity, shiny FROM shop_catalog WHERE enabled = 1 ORDER BY category, name COLLATE NOCASE') });
});

app.post('/api/shop/pokemon', authenticate, async (req, res) => {
  const pokemonName = String(req.body.name || '').trim();
  if (!pokemonName) return res.status(404).json({ error: 'Pokémon no encontrado.' });
  const result = await withTransaction(async () => {
    const pokemon = await get('SELECT id, name, price, shiny FROM shop_catalog WHERE category = ? AND name = ? COLLATE NOCASE AND enabled = 1', ['pokemon', pokemonName]);
    if (!pokemon) return { status: 404, error: 'Pokémon no disponible en la tienda.' };
    const ownedPokemon = await get('SELECT 1 FROM inventory_pokemon WHERE user_id = ? AND LOWER(pokemon_name) = LOWER(?) LIMIT 1', [req.auth.id, pokemon.name]);
    if (ownedPokemon) return { status: 409, error: 'Ya tienes este Pokémon en tu cuenta.' };
    const profile = await get('SELECT bayas FROM profiles WHERE user_id = ?', [req.auth.id]);
    if (!profile || profile.bayas < pokemon.price) return { status: 400, error: 'No tienes suficientes bayas.' };
    const stock = await run('UPDATE shop_catalog SET quantity = quantity - 1 WHERE id = ? AND enabled = 1 AND quantity > 0', [pokemon.id]);
    if (!stock.changes) return { status: 409, error: 'Este Pokémon está agotado para todos los usuarios.' };
    await run('UPDATE profiles SET bayas = bayas - ? WHERE user_id = ?', [pokemon.price, req.auth.id]);
    await run('INSERT INTO inventory_pokemon (user_id, pokemon_name, level, shiny) VALUES (?, ?, 5, ?)', [req.auth.id, pokemon.name, pokemon.shiny]);
    return { status: 200 };
  });
  if (result.status !== 200) return res.status(result.status).json({ error: result.error });
  res.json({ user: await getProfile(req.auth.id), shopCatalog: await all('SELECT id, category, name, price, description, rarity, quantity, shiny FROM shop_catalog WHERE enabled = 1 ORDER BY category, name COLLATE NOCASE') });
});

app.use((error, _req, res, next) => {
  if (res.headersSent) return next(error);
  const status = Number(error.status) || 500;
  if (status >= 500) console.error('Error al procesar una solicitud.', error);
  const message = error.type === 'entity.too.large'
    ? 'La solicitud excede el tamaño permitido.'
    : error.type === 'entity.parse.failed'
      ? 'El cuerpo JSON no es válido.'
      : status >= 500
        ? 'Ocurrió un error interno.'
        : 'La solicitud no es válida.';
  res.status(status).json({ error: message });
});

initializeDatabase()
  .then(initializeBattleEngine)
  .then(() => app.listen(port, '0.0.0.0', () => console.log(`Pokémon Manzana API activa en el puerto ${port}`)))
  .catch((error) => {
    console.error('No se pudo inicializar la base de datos.', error);
    process.exit(1);
  });
