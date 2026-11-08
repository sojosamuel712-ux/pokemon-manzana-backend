import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const require = createRequire(new URL('../server.cjs', import.meta.url))
const sqlite3 = require('sqlite3').verbose()
const backendPath = fileURLToPath(new URL('../server.cjs', import.meta.url))

const reservePort = async () => {
  const server = createServer()
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve()))
  const { port } = server.address()
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return port
}

const runSql = (database, sql, params = []) => new Promise((resolve, reject) => {
  database.run(sql, params, function onRun(error) {
    if (error) reject(error)
    else resolve({ id: this.lastID, changes: this.changes })
  })
})

const getSql = (database, sql, params = []) => new Promise((resolve, reject) => {
  database.get(sql, params, (error, row) => error ? reject(error) : resolve(row))
})

test('la supresión administrativa elimina datos relacionados e invalida sesiones', { timeout: 30000 }, async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'manzana-account-deletion-'))
  const databasePath = join(directory, 'accounts.sqlite')
  const port = await reservePort()
  const server = spawn(process.execPath, [backendPath], {
    env: { ...process.env, PORT: String(port), DATABASE_PATH: databasePath, JWT_SECRET: 'account-deletion-test-secret' },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let serverError = ''
  server.stderr.setEncoding('utf8')
  server.stderr.on('data', (chunk) => { serverError += chunk })

  context.after(async () => {
    if (server.exitCode === null) {
      server.kill('SIGTERM')
      await new Promise((resolve) => server.once('exit', resolve))
    }
    rmSync(directory, { recursive: true, force: true })
  })

  const baseUrl = `http://127.0.0.1:${port}/api`
  let isReady = false
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`Backend terminó antes de iniciar: ${serverError}`)
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) {
        isReady = true
        break
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.ok(isReady, `El backend no inició: ${serverError}`)

  const request = async (route, { body, token, method } = {}) => {
    const response = await fetch(`${baseUrl}${route}`, {
      method: method || (body === undefined ? 'GET' : 'POST'),
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: response.status, body: await response.json() }
  }
  const register = async (username) => request('/auth/register', {
    body: {
      username,
      password: 'secure-test-password',
      age: 18,
      guild: 'Garchomp',
      starter: 'Bulbasaur',
      acceptTerms: true,
    },
  })

  const admin = await register('AccountAdmin')
  assert.equal(admin.status, 201, JSON.stringify(admin.body))
  const peer = await register('BattlePeer')
  assert.equal(peer.status, 201, JSON.stringify(peer.body))
  const target = await register('DeleteTarget')
  assert.equal(target.status, 201, JSON.stringify(target.body))

  const nonAdminDelete = await request(`/admin/users/${target.body.user.id}`, { token: peer.body.token, method: 'DELETE' })
  assert.equal(nonAdminDelete.status, 403)

  const database = new sqlite3.Database(databasePath)
  await runSql(database, 'UPDATE users SET role_level = 1 WHERE id = ?', [admin.body.user.id])
  await runSql(database, 'UPDATE users SET role_level = 1 WHERE id = ?', [peer.body.user.id])
  await runSql(database, 'INSERT INTO inventory_items (user_id, item_name, quantity) VALUES (?, ?, ?)', [target.body.user.id, 'Poción', 4])
  await runSql(database, 'INSERT INTO inventory_pokemon (user_id, pokemon_name, level) VALUES (?, ?, ?)', [target.body.user.id, 'Pikachu', 10])
  await runSql(database, 'INSERT INTO pokemon_rosters (user_id, roster_json) VALUES (?, ?)', [target.body.user.id, '{"team":[],"pc":[]}'])
  await runSql(database, 'INSERT INTO chat_messages (user_id, username, message) VALUES (?, ?, ?)', [target.body.user.id, 'DeleteTarget', 'Mensaje que se debe borrar'])
  await runSql(database, 'INSERT INTO guild_messages (guild_name, user_id, username, message) VALUES (?, ?, ?, ?)', ['Garchomp', target.body.user.id, 'DeleteTarget', 'Mensaje del gremio que se debe borrar'])
  const battle = await runSql(
    database,
    `INSERT INTO battle_requests (challenger_id, opponent_id, scope, status, challenger_team, p1_species)
     VALUES (?, ?, 'community', 'finished', '{}', 'Bulbasaur')`,
    [target.body.user.id, peer.body.user.id],
  )
  await runSql(database, 'INSERT INTO battle_messages (battle_id, user_id, message) VALUES (?, ?, ?)', [battle.id, peer.body.user.id, 'Chat de combate'])
  await runSql(
    database,
    `INSERT INTO training_battles
      (user_id, difficulty, level_band, challenger_team, opponent_team, battle_state, p1_species, p2_species)
     VALUES (?, 'easy', 5, '{}', '{}', '{}', 'Bulbasaur', 'Pikachu')`,
    [target.body.user.id],
  )
  await runSql(
    database,
    'INSERT INTO user_sanctions (user_id, admin_user_id, sanction_type, reason) VALUES (?, ?, ?, ?)',
    [target.body.user.id, admin.body.user.id, 'warning', 'Prueba'],
  )
  await new Promise((resolve, reject) => database.close((error) => error ? reject(error) : resolve()))

  const selfDelete = await request(`/admin/users/${admin.body.user.id}`, { token: admin.body.token, method: 'DELETE' })
  assert.equal(selfDelete.status, 400)
  const systemDelete = await request('/admin/users/1', { token: admin.body.token, method: 'DELETE' })
  assert.equal(systemDelete.status, 403)
  const adminDelete = await request(`/admin/users/${peer.body.user.id}`, { token: admin.body.token, method: 'DELETE' })
  assert.equal(adminDelete.status, 403)

  const missingReason = await request('/account/deletion-requests', {
    body: { reason: '   ' },
    token: target.body.token,
  })
  assert.equal(missingReason.status, 400)
  const deletionRequest = await request('/account/deletion-requests', {
    body: { reason: 'Ya no deseo usar esta cuenta.' },
    token: target.body.token,
  })
  assert.equal(deletionRequest.status, 201, JSON.stringify(deletionRequest.body))
  assert.equal(deletionRequest.body.request.reason, 'Ya no deseo usar esta cuenta.')
  const duplicateRequest = await request('/account/deletion-requests', {
    body: { reason: 'Otra solicitud duplicada.' },
    token: target.body.token,
  })
  assert.equal(duplicateRequest.status, 409)
  const ownRequest = await request('/account/deletion-request', { token: target.body.token })
  assert.equal(ownRequest.body.request.id, deletionRequest.body.request.id)
  const adminDashboard = await request('/admin/dashboard', { token: admin.body.token })
  assert.deepEqual(adminDashboard.body.accountDeletionRequests.map(({ userId, username, guild, reason }) => ({
    userId, username, guild, reason,
  })), [{
    userId: target.body.user.id,
    username: 'DeleteTarget',
    guild: 'Garchomp',
    reason: 'Ya no deseo usar esta cuenta.',
  }])

  const deletion = await request(`/admin/users/${target.body.user.id}`, { token: admin.body.token, method: 'DELETE' })
  assert.equal(deletion.status, 200, JSON.stringify(deletion.body))
  assert.deepEqual(deletion.body.deleted, { chatMessages: 1, guildMessages: 1 })

  const staleSession = await request('/profile', { token: target.body.token })
  assert.equal(staleSession.status, 401)

  const verifyDb = new sqlite3.Database(databasePath)
  for (const [table, column] of [
    ['profiles', 'user_id'],
    ['inventory_items', 'user_id'],
    ['inventory_pokemon', 'user_id'],
    ['pokemon_rosters', 'user_id'],
    ['user_sanctions', 'user_id'],
    ['account_deletion_requests', 'user_id'],
    ['training_battles', 'user_id'],
    ['battle_requests', 'challenger_id'],
    ['chat_messages', 'user_id'],
    ['guild_messages', 'user_id'],
  ]) {
    assert.equal((await getSql(verifyDb, `SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`, [target.body.user.id])).count, 0, `${table} debe quedar limpio`)
  }
  assert.equal((await getSql(verifyDb, 'SELECT COUNT(*) AS count FROM battle_messages WHERE battle_id = ?', [battle.id])).count, 0)
  assert.equal((await getSql(verifyDb, 'SELECT COUNT(*) AS count FROM users WHERE id = ?', [target.body.user.id])).count, 0)
  assert.equal((await getSql(verifyDb, 'SELECT terms_version, terms_accepted_at FROM users WHERE id = ?', [peer.body.user.id])).terms_version, '2026-11-08')
  await new Promise((resolve, reject) => verifyDb.close((error) => error ? reject(error) : resolve()))
})

test('el servidor valida edad y datos del registro fuera del formulario', { timeout: 30000 }, async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'manzana-registration-validation-'))
  const port = await reservePort()
  const server = spawn(process.execPath, [backendPath], {
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_PATH: join(directory, 'validation.sqlite'),
      JWT_SECRET: 'registration-validation-test-secret',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let serverError = ''
  server.stderr.setEncoding('utf8')
  server.stderr.on('data', (chunk) => { serverError += chunk })
  context.after(async () => {
    if (server.exitCode === null) {
      server.kill('SIGTERM')
      await new Promise((resolve) => server.once('exit', resolve))
    }
    rmSync(directory, { recursive: true, force: true })
  })

  const baseUrl = `http://127.0.0.1:${port}/api`
  let response
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`Backend terminó antes de iniciar: ${serverError}`)
    try {
      response = await fetch(`${baseUrl}/health`)
      if (response.ok) break
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.ok(response?.ok, `El backend no inició: ${serverError}`)

  const invalidRegistrations = [
    { username: 'UnderAge', password: 'secure-test-password', age: 15, guild: 'Garchomp', starter: 'Bulbasaur', acceptTerms: true },
    { username: 'InvalidAge', password: 'secure-test-password', age: 'no-es-edad', guild: 'Garchomp', starter: 'Bulbasaur', acceptTerms: true },
    { username: 'BadStarter', password: 'secure-test-password', age: 20, guild: 'Garchomp', starter: 'Missingno', acceptTerms: true },
    { username: 'ShortPass', password: 'short', age: 20, guild: 'Garchomp', starter: 'Bulbasaur', acceptTerms: true },
  ]
  for (const body of invalidRegistrations) {
    const result = await fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    assert.equal(result.status, 400)
    assert.equal((await result.json()).error, 'Revisa el usuario, la contraseña, la edad, el gremio, el Pokémon inicial y la aceptación de los acuerdos.')
  }
})
