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

const runSql = (database, sql, params) => new Promise((resolve, reject) => {
  database.run(sql, params, (error) => error ? reject(error) : resolve())
})

test('la ruleta entrega una categoría configurada y los canjes conservan sus ratios', { timeout: 40000 }, async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'manzana-roulette-test-'))
  const databasePath = join(directory, 'roulette.sqlite')
  const port = await reservePort()
  const baseUrl = `http://127.0.0.1:${port}/api`
  const server = spawn(process.execPath, [backendPath], {
    env: { ...process.env, PORT: String(port), DATABASE_PATH: databasePath, JWT_SECRET: 'roulette-test-secret' },
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

  const request = async (route, body, token, method) => {
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

  const register = async (username) => {
    const response = await request('/auth/register', {
      username,
      password: 'test-password',
      age: 18,
      guild: 'Garchomp',
      starter: 'Garchomp',
      acceptTerms: true,
    })
    assert.equal(response.status, 201, JSON.stringify(response.body))
    return response.body
  }

  const adminAccount = await register('RouletteAdmin')
  const database = new sqlite3.Database(databasePath)
  await runSql(database, 'UPDATE users SET role_level = 1 WHERE id = ?', [adminAccount.user.id])
  const playerAccount = await register('RoulettePlayer')
  await runSql(database, 'UPDATE profiles SET bronze_coins = 11, silver_coins = 3, gold_coins = 2 WHERE user_id = ?', [playerAccount.user.id])
  await new Promise((resolve, reject) => database.close((error) => error ? reject(error) : resolve()))

  const adminLogin = await request('/auth/login', { username: 'RouletteAdmin', password: 'test-password' })
  const playerLogin = await request('/auth/login', { username: 'RoulettePlayer', password: 'test-password' })
  assert.equal(adminLogin.status, 200)
  assert.equal(playerLogin.body.user.mysteriousCoins.diamond, 0)

  const pokemonStats = { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 }
  const savedRoster = {
    team: playerLogin.body.user.inventory.pokemon.map((pokemon, index) => ({
      instanceId: `pokemon-${index}`,
      species: pokemon.name,
      nickname: '',
      heldItem: '',
      nature: 'Fuerte',
      level: 100,
      ability: '',
      moves: [],
      ivs: pokemonStats,
      evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
      shiny: pokemon.shiny,
    })),
    pc: [],
  }
  const savedPokemonProfile = await request('/profile/pokemon-roster', { pokemonRoster: savedRoster }, playerLogin.body.token, 'PUT')
  assert.equal(savedPokemonProfile.status, 200, JSON.stringify(savedPokemonProfile.body))
  assert.deepEqual(savedPokemonProfile.body.user.pokemonRoster, savedRoster)
  const reloadedProfile = await request('/profile', undefined, playerLogin.body.token)
  assert.deepEqual(reloadedProfile.body.pokemonRoster, savedRoster)

  const unauthorizedPokemonRoster = {
    ...savedRoster,
    team: [{ ...savedRoster.team[0], species: 'Mewtwo' }],
  }
  const rejectedPokemonProfile = await request('/profile/pokemon-roster', { pokemonRoster: unauthorizedPokemonRoster }, playerLogin.body.token, 'PUT')
  assert.equal(rejectedPokemonProfile.status, 400)
  assert.deepEqual((await request('/profile', undefined, playerLogin.body.token)).body.pokemonRoster, savedRoster)

  const entries = [
    { wheelType: 'category', prizeType: 'item', name: 'Objetos', amount: 1, probability: 50, enabled: true },
    { wheelType: 'category', prizeType: 'pokemon', name: 'Pokémon', amount: 1, probability: 50, enabled: true },
    ...['bronze', 'silver', 'gold', 'diamond'].flatMap((coinType) => [
      { wheelType: 'prize', coinType, prizeType: 'item', name: `${coinType} objeto`, amount: 1, probability: 100, enabled: true },
      { wheelType: 'prize', coinType, prizeType: 'pokemon', name: `${coinType} Pokémon`, amount: 1, probability: 100, enabled: true },
    ]),
  ]
  const savedRoulette = await request('/admin/roulette', { entries }, adminLogin.body.token)
  assert.equal(savedRoulette.status, 200, JSON.stringify(savedRoulette.body))
  assert.equal(savedRoulette.body.roulettePrizes.length, 10)

  const rouletteConfig = await request('/roulette/config', undefined, playerLogin.body.token)
  assert.equal(rouletteConfig.status, 200)
  assert.equal(rouletteConfig.body.categories.length, 2)
  assert.equal(rouletteConfig.body.prizes.length, 8)
  for (const coinType of ['bronze', 'silver', 'gold', 'diamond']) {
    assert.equal(rouletteConfig.body.prizes.filter((prize) => prize.coinType === coinType).length, 2)
  }

  const beforeCategorySpin = await request('/profile', undefined, playerLogin.body.token)
  const categorySpin = await request('/roulette/category-spin', {}, playerLogin.body.token)
  assert.equal(categorySpin.status, 200)
  assert.ok(['item', 'pokemon'].includes(categorySpin.body.category))
  assert.ok(categorySpin.body.selectionToken)
  const afterCategorySpin = await request('/profile', undefined, playerLogin.body.token)
  assert.deepEqual(afterCategorySpin.body.inventory, beforeCategorySpin.body.inventory)
  assert.deepEqual(afterCategorySpin.body.mysteriousCoins, beforeCategorySpin.body.mysteriousCoins)

  const unselectedCategorySpin = await request('/roulette/spin', { coinType: 'bronze', prizeType: 'pokemon' }, playerLogin.body.token)
  assert.equal(unselectedCategorySpin.status, 400)

  const selectedPrizeType = categorySpin.body.category
  const spin = await request('/roulette/spin', { coinType: 'bronze', prizeType: selectedPrizeType, selectionToken: categorySpin.body.selectionToken }, playerLogin.body.token)
  assert.equal(spin.status, 200, JSON.stringify(spin.body))
  assert.equal(spin.body.category, selectedPrizeType)
  assert.equal(spin.body.prize.name, `bronze ${selectedPrizeType === 'item' ? 'objeto' : 'Pokémon'}`)
  assert.equal(spin.body.user.mysteriousCoins.bronze, 10)
  if (selectedPrizeType === 'item') {
    assert.equal(spin.body.user.inventory.items.find((item) => item === spin.body.prize.name), spin.body.prize.name)
  } else {
    assert.ok(spin.body.user.inventory.pokemon.some((pokemon) => pokemon.name === spin.body.prize.name))
  }

  const secondPrizeSpin = await request('/roulette/spin', { coinType: 'bronze', prizeType: selectedPrizeType, selectionToken: categorySpin.body.selectionToken }, playerLogin.body.token)
  assert.equal(secondPrizeSpin.status, 200, JSON.stringify(secondPrizeSpin.body))
  assert.equal(secondPrizeSpin.body.category, selectedPrizeType)
  assert.equal(secondPrizeSpin.body.user.mysteriousCoins.bronze, 9)

  const spinTierAndVerify = async (coinType, expectedBalance) => {
    const tierCategory = await request('/roulette/category-spin', {}, playerLogin.body.token)
    assert.equal(tierCategory.status, 200, JSON.stringify(tierCategory.body))
    const tierSpin = await request('/roulette/spin', {
      coinType,
      prizeType: tierCategory.body.category,
      selectionToken: tierCategory.body.selectionToken,
    }, playerLogin.body.token)
    assert.equal(tierSpin.status, 200, JSON.stringify(tierSpin.body))
    assert.equal(tierSpin.body.category, tierCategory.body.category)
    assert.equal(tierSpin.body.prize.prizeType, tierCategory.body.category)
    assert.equal(tierSpin.body.prize.name, `${coinType} ${tierCategory.body.category === 'item' ? 'objeto' : 'Pokémon'}`)
    assert.equal(tierSpin.body.user.mysteriousCoins[coinType], expectedBalance)
    if (tierCategory.body.category === 'item') {
      assert.ok(tierSpin.body.user.inventory.items.includes(tierSpin.body.prize.name))
    } else {
      assert.ok(tierSpin.body.user.inventory.pokemon.some((pokemon) => pokemon.name === tierSpin.body.prize.name))
    }
  }

  const silver = await request('/economy/convert-coins', { targetType: 'silver', amount: 1 }, playerLogin.body.token)
  assert.equal(silver.status, 200, JSON.stringify(silver.body))
  assert.equal(silver.body.user.mysteriousCoins.bronze, 5)
  assert.equal(silver.body.user.mysteriousCoins.silver, 4)

  const gold = await request('/economy/convert-coins', { targetType: 'gold', amount: 1 }, playerLogin.body.token)
  assert.equal(gold.status, 200)
  assert.equal(gold.body.user.mysteriousCoins.silver, 1)
  assert.equal(gold.body.user.mysteriousCoins.gold, 3)

  const diamond = await request('/economy/convert-coins', { targetType: 'diamond', amount: 1 }, playerLogin.body.token)
  assert.equal(diamond.status, 200)
  assert.equal(diamond.body.user.mysteriousCoins.gold, 1)
  assert.equal(diamond.body.user.mysteriousCoins.diamond, 1)

  const insufficientConversion = await request('/economy/convert-coins', { targetType: 'diamond', amount: 1 }, playerLogin.body.token)
  assert.equal(insufficientConversion.status, 400)
  await spinTierAndVerify('silver', 0)
  await spinTierAndVerify('gold', 0)
  await spinTierAndVerify('diamond', 0)
})