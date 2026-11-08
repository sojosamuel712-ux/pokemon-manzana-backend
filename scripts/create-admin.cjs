const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcrypt');
const sqlite3 = require('sqlite3').verbose();

const username = process.argv[2]?.trim();
const databasePath = process.env.DATABASE_PATH || path.join(__dirname, '..', 'db', 'manzana.sqlite');
const schemaPath = path.join(__dirname, '..', 'db', 'schema.sql');

const run = (database, sql, params = []) => new Promise((resolve, reject) => {
  database.run(sql, params, function onRun(error) {
    if (error) reject(error);
    else resolve({ id: this.lastID, changes: this.changes });
  });
});

const get = (database, sql, params = []) => new Promise((resolve, reject) => {
  database.get(sql, params, (error, row) => error ? reject(error) : resolve(row));
});

const readHidden = (prompt) => new Promise((resolve, reject) => {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    reject(new Error('La contraseña debe introducirse en una terminal interactiva.'));
    return;
  }

  process.stdin.ref();
  let value = '';
  const finish = (error) => {
    process.stdin.removeListener('data', onData);
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdin.unref();
    process.stdout.write('\n');
    if (error) reject(error);
    else resolve(value);
  };
  const onData = (chunk) => {
    for (const character of chunk) {
      if (character === '\u0003') return finish(new Error('Operación cancelada.'));
      if (character === '\r' || character === '\n') return finish();
      if (character === '\u007f' || character === '\b') {
        value = Array.from(value).slice(0, -1).join('');
      } else if (character >= ' ') {
        value += character;
      }
    }
  };

  process.stdout.write(prompt);
  process.stdin.setEncoding('utf8');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', onData);
});

const ensureColumn = async (database, name, definition) => {
  const columns = await new Promise((resolve, reject) => {
    database.all('PRAGMA table_info(users)', (error, rows) => error ? reject(error) : resolve(rows));
  });
  if (!columns.some((column) => column.name === name)) {
    await run(database, `ALTER TABLE users ADD COLUMN ${name} ${definition}`);
  }
};

const createInitialAdmin = async () => {
  if (!username || !/^[\p{L}\p{N}_-]{3,24}$/u.test(username)) {
    throw new Error('Uso: npm run admin:create -- <usuario-de-3-a-24-caracteres>');
  }
  if (process.env.NODE_ENV === 'production' && (!process.env.DATABASE_PATH || !path.isAbsolute(databasePath))) {
    throw new Error('En producción, define DATABASE_PATH como una ruta absoluta persistente.');
  }

  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new sqlite3.Database(databasePath);
  try {
    await new Promise((resolve, reject) => {
      database.exec(fs.readFileSync(schemaPath, 'utf8'), (error) => error ? reject(error) : resolve());
    });
    await ensureColumn(database, 'role_level', 'INTEGER NOT NULL DEFAULT 4');
    await ensureColumn(database, 'terms_version', "TEXT NOT NULL DEFAULT ''");
    await ensureColumn(database, 'terms_accepted_at', 'TEXT');

    const userCount = await get(database, 'SELECT COUNT(*) AS count FROM users');
    if (userCount.count !== 0) {
      throw new Error('El asistente solo crea la primera cuenta en una base sin usuarios. No modifica cuentas existentes.');
    }

    const password = await readHidden('Contraseña nueva (mínimo 12 caracteres): ');
    if (password.length < 12 || password.length > 128) {
      throw new Error('La contraseña debe tener entre 12 y 128 caracteres.');
    }
    const confirmation = await readHidden('Repite la contraseña: ');
    if (password !== confirmation) throw new Error('Las contraseñas no coinciden.');

    const passwordHash = await bcrypt.hash(password, 12);
    await run(database, 'BEGIN IMMEDIATE TRANSACTION');
    try {
      const currentUsers = await get(database, 'SELECT COUNT(*) AS count FROM users');
      if (currentUsers.count !== 0) {
        throw new Error('La base ya tiene usuarios. No se creó ninguna cuenta.');
      }
      const account = await run(
        database,
        'INSERT INTO users (username, password_hash, age, guild, starter, role_level) VALUES (?, ?, ?, ?, ?, ?)',
        [username, passwordHash, 18, 'Garchomp', 'Garchomp', 1],
      );
      await run(database, 'INSERT INTO profiles (user_id, bayas, bronze_coins) VALUES (?, ?, ?)', [account.id, 150, 2]);
      await run(database, 'INSERT INTO inventory_pokemon (user_id, pokemon_name, level) VALUES (?, ?, ?)', [account.id, 'Garchomp', 5]);
      await run(database, 'INSERT INTO guild_memberships (user_id, guild_name, role) VALUES (?, ?, ?)', [account.id, 'Garchomp', 'member']);
      await run(database, 'COMMIT');
    } catch (error) {
      await run(database, 'ROLLBACK');
      throw error;
    }

    process.stdout.write(`Cuenta de administración inicial creada: ${username}\n`);
  } finally {
    await new Promise((resolve, reject) => database.close((error) => error ? reject(error) : resolve()));
  }
};

createInitialAdmin().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
