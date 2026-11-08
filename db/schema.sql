PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  age INTEGER,
  guild TEXT NOT NULL,
  starter TEXT NOT NULL,
  role_level INTEGER NOT NULL DEFAULT 4 CHECK (role_level BETWEEN 0 AND 4),
  terms_version TEXT NOT NULL DEFAULT '',
  terms_accepted_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS profiles (
  user_id INTEGER PRIMARY KEY,
  bayas INTEGER NOT NULL DEFAULT 100,
  bronze_coins INTEGER NOT NULL DEFAULT 0,
  silver_coins INTEGER NOT NULL DEFAULT 0,
  gold_coins INTEGER NOT NULL DEFAULT 0,
  diamond_coins INTEGER NOT NULL DEFAULT 0,
  battle_wins INTEGER NOT NULL DEFAULT 0,
  battle_losses INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS inventory_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  item_name TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE (user_id, item_name)
);

CREATE TABLE IF NOT EXISTS inventory_pokemon (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  pokemon_name TEXT NOT NULL,
  level INTEGER NOT NULL DEFAULT 5,
  shiny INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pokemon_rosters (
  user_id INTEGER PRIMARY KEY,
  roster_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  username TEXT NOT NULL,
  message TEXT NOT NULL,
  guild_name TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS guild_memberships (
  user_id INTEGER PRIMARY KEY,
  guild_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'elite', 'leader')),
  joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS guild_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_name TEXT NOT NULL,
  user_id INTEGER,
  username TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS guild_messages_guild_id ON guild_messages(guild_name, id);

CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message TEXT NOT NULL,
  image_data TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS shop_catalog (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL CHECK (category IN ('item', 'pokemon')),
  name TEXT NOT NULL,
  price INTEGER NOT NULL DEFAULT 0,
  description TEXT,
  rarity TEXT,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 0),
  shiny INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS roulette_prizes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prize_type TEXT NOT NULL CHECK (prize_type IN ('item', 'pokemon', 'coins', 'berries')),
  name TEXT NOT NULL,
  amount INTEGER NOT NULL DEFAULT 1,
  rarity TEXT NOT NULL DEFAULT 'Común',
  enabled INTEGER NOT NULL DEFAULT 1,
  wheel_type TEXT NOT NULL DEFAULT 'prize',
  coin_type TEXT NOT NULL DEFAULT 'bronze',
  probability REAL NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_sanctions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  admin_user_id INTEGER NOT NULL,
  sanction_type TEXT NOT NULL CHECK (sanction_type IN ('warning', 'suspension', 'ban')),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (admin_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS account_deletion_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS battle_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  challenger_id INTEGER NOT NULL,
  opponent_id INTEGER NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('guild', 'community')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'rejected', 'finished', 'expired')),
  challenger_team TEXT NOT NULL,
  opponent_team TEXT,
  battle_state TEXT,
  p1_species TEXT NOT NULL,
  p1_shiny INTEGER NOT NULL DEFAULT 0,
  p2_species TEXT,
  p2_shiny INTEGER NOT NULL DEFAULT 0,
  winner_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (challenger_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (opponent_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (winner_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS battle_requests_participants_status
  ON battle_requests(challenger_id, opponent_id, status, id);

CREATE TABLE IF NOT EXISTS battle_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  battle_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (battle_id) REFERENCES battle_requests(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS battle_messages_battle_id ON battle_messages(battle_id, id);

CREATE TABLE IF NOT EXISTS training_bot_teams (
  difficulty TEXT NOT NULL CHECK (difficulty IN ('easy', 'medium', 'hard')),
  level_band INTEGER NOT NULL CHECK (level_band BETWEEN 1 AND 100),
  team_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (difficulty, level_band)
);

CREATE TABLE IF NOT EXISTS training_battles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  difficulty TEXT NOT NULL CHECK (difficulty IN ('easy', 'medium', 'hard')),
  level_band INTEGER NOT NULL CHECK (level_band BETWEEN 1 AND 100),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'finished')),
  challenger_team TEXT NOT NULL,
  opponent_team TEXT NOT NULL,
  battle_state TEXT NOT NULL,
  p1_species TEXT NOT NULL,
  p1_shiny INTEGER NOT NULL DEFAULT 0,
  p2_species TEXT NOT NULL,
  p2_shiny INTEGER NOT NULL DEFAULT 0,
  winner_side TEXT CHECK (winner_side IN ('p1', 'p2')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS training_battles_user_status
  ON training_battles(user_id, status, id);
