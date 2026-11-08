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
const { getPokemonEvolution } = require('./evolution.cjs')
const sqlite3 = require('sqlite3').verbose()
const backendPath = fileURLToPath(new URL('../server.cjs', import.meta.url))
const stats = ['hp', 'atk', 'def', 'spa', 'spd', 'spe']

const reservePort = async () => {
  const server = createServer()
  await new Promise((resolve, reject) =>
    server.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve()))
  const { port } = server.address()
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return port
}

const runSql = (database, sql, params = []) => new Promise((resolve, reject) => {
  database.run(sql, params, (error) => error ? reject(error) : resolve())
})

test('el backend calcula costos y objetos de evolución por especie', () => {
  assert.equal(getPokemonEvolution('Sprigatito', 'Floragato').cost, 50)
  assert.equal(getPokemonEvolution('Floragato', 'Meowscarada').cost, 100)
  assert.equal(getPokemonEvolution('Magikarp', 'Gyarados').cost, 100)
  assert.equal(getPokemonEvolution('Eevee', 'Vaporeon').requiredItemAlias, 'Piedra Agua')
  assert.equal(getPokemonEvolution('Eevee', 'Glaceon').requiredItemAlias, 'Piedra Hielo')
  assert.equal(getPokemonEvolution('Eevee', 'Glaceon').cost, 0)
  assert.equal(getPokemonEvolution('Scyther', 'Scizor').cost, 100)
  assert.equal(getPokemonEvolution('Scyther', 'Scizor').requiredItem, '')
  assert.equal(getPokemonEvolution('Sneasel', 'Weavile').requiredItem, '')
  assert.equal(getPokemonEvolution('Eevee', 'Raichu'), null)
})

test('los objetos puros se consumen sin bayas y las evoluciones combinadas solo cuestan bayas', { timeout: 40000 }, async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'manzana-evolution-test-'))
  const databasePath = join(directory, 'evolution.sqlite')
  const port = await reservePort()
  const baseUrl = `http://127.0.0.1:${port}/api`
  const server = spawn(process.execPath, [backendPath], {
    env: { ...process.env, PORT: String(port), DATABASE_PATH: databasePath, JWT_SECRET: 'evolution-test-secret' },
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

  let isReady = false
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`Backend terminó antes de iniciar: ${serverError}`)
    try {
      const response = await fetch(`${baseUrl}/health`)
      if (response.ok) {
        isReady = true
        break
      }
    } catch { }
    await new Promise((resolve) => setTimeout(resolve, 75))
  }
  assert.ok(isReady, `El backend no inició: ${serverError}`)

  const request = async (method, route, body, token) => {
    const response = await fetch(`${baseUrl}${route}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: response.status, body: await response.json() }
  }

  const registration = await request('POST', '/auth/register', {
    username: 'EvolutionUser',
    password: 'test-password',
    age: 18,
    guild: 'Garchomp',
    starter: 'Eevee',
    acceptTerms: true,
  })
  assert.equal(registration.status, 201, JSON.stringify(registration.body))
  const token = registration.body.token
  const pokemon = {
    instanceId: 'eevee-team-0',
    species: 'Eevee',
    nickname: '',
    heldItem: '',
    nature: 'Fuerte',
    level: 5,
    shiny: false,
    ability: 'Run Away',
    moves: [],
    ivs: Object.fromEntries(stats.map((stat) => [stat, 31])),
    evs: Object.fromEntries(stats.map((stat) => [stat, 0])),
  }
  const porygon = {
    ...pokemon,
    instanceId: 'porygon-team-1',
    species: 'Porygon',
    ability: 'Trace',
  }
  const database = new sqlite3.Database(databasePath)
  await runSql(database, 'INSERT INTO inventory_pokemon (user_id, pokemon_name, level) VALUES (?, ?, 5)', [
    registration.body.user.id,
    'Porygon',
  ])
  await new Promise((resolve, reject) => database.close((error) => error ? reject(error) : resolve()))

  const savedRoster = await request('PUT', '/profile/pokemon-roster', { pokemonRoster: { team: [pokemon, porygon], pc: [] } }, token)
  assert.equal(savedRoster.status, 200, JSON.stringify(savedRoster.body))

  const missingStone = await request('POST', '/profile/pokemon-evolve', {
    instanceId: pokemon.instanceId,
    targetSpecies: 'Glaceon',
  }, token)
  assert.equal(missingStone.status, 400)
  assert.match(missingStone.body.error, /Piedra Hielo/)

  const stoneDatabase = new sqlite3.Database(databasePath)
  await runSql(stoneDatabase, 'INSERT INTO inventory_items (user_id, item_name, quantity) VALUES (?, ?, 1)', [
    registration.body.user.id,
    'Piedra Hielo',
  ])
  await new Promise((resolve, reject) => stoneDatabase.close((error) => error ? reject(error) : resolve()))

  const zeroBerryDatabase = new sqlite3.Database(databasePath)
  await runSql(zeroBerryDatabase, 'UPDATE profiles SET bayas = 0 WHERE user_id = ?', [registration.body.user.id])
  await new Promise((resolve, reject) => zeroBerryDatabase.close((error) => error ? reject(error) : resolve()))

  const evolved = await request('POST', '/profile/pokemon-evolve', {
    instanceId: pokemon.instanceId,
    targetSpecies: 'Glaceon',
  }, token)
  assert.equal(evolved.status, 200, JSON.stringify(evolved.body))
  assert.equal(evolved.body.user.bayas, 0)
  assert.equal(evolved.body.user.pokemonRoster.team[0].species, 'Glaceon')
  assert.deepEqual(evolved.body.user.inventory.items, ['Baya de inicio'])

  const upgradeDatabase = new sqlite3.Database(databasePath)
  await runSql(upgradeDatabase, 'UPDATE profiles SET bayas = 50 WHERE user_id = ?', [registration.body.user.id])
  await runSql(upgradeDatabase, 'INSERT INTO inventory_items (user_id, item_name, quantity) VALUES (?, ?, 1)', [
    registration.body.user.id,
    'Up-Grade',
  ])
  await new Promise((resolve, reject) => upgradeDatabase.close((error) => error ? reject(error) : resolve()))

  const porygonEvolved = await request('POST', '/profile/pokemon-evolve', {
    instanceId: porygon.instanceId,
    targetSpecies: 'Porygon2',
  }, token)
  assert.equal(porygonEvolved.status, 200, JSON.stringify(porygonEvolved.body))
  assert.equal(porygonEvolved.body.user.bayas, 0)
  assert.equal(porygonEvolved.body.user.pokemonRoster.team[1].species, 'Porygon2')
  assert.deepEqual(porygonEvolved.body.user.inventory.items.sort(), ['Baya de inicio', 'Up-Grade'])
  assert.deepEqual(porygonEvolved.body.user.inventory.pokemon.map(({ name }) => name), ['Glaceon', 'Porygon2'])
})
