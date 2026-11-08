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

test('las compras concurrentes comparten y descuentan el stock global', { timeout: 40000 }, async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'manzana-shop-test-'))
  const databasePath = join(directory, 'shop.sqlite')
  const port = await reservePort()
  const baseUrl = `http://127.0.0.1:${port}/api`
  const server = spawn(process.execPath, [backendPath], {
    env: { ...process.env, PORT: String(port), DATABASE_PATH: databasePath, JWT_SECRET: 'shop-test-secret' },
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

  const request = async (route, body, token) => {
    const response = await fetch(`${baseUrl}${route}`, {
      method: body === undefined ? 'GET' : 'POST',
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

  const adminAccount = await register('ShopAdmin')
  const database = new sqlite3.Database(databasePath)
  await runSql(database, 'UPDATE users SET role_level = 1 WHERE id = ?', [adminAccount.user.id])
  await new Promise((resolve, reject) => database.close((error) => error ? reject(error) : resolve()))
  const adminLogin = await request('/auth/login', { username: 'ShopAdmin', password: 'test-password' })
  assert.equal(adminLogin.status, 200)

  const catalogResponse = await request('/admin/shop', {
    entries: [
      { category: 'item', name: 'Objeto de prueba', price: 1, quantity: 1, description: 'Prueba', rarity: 'Común', enabled: true },
      { category: 'pokemon', name: 'Bulbasaur', price: 1, quantity: 1, description: 'Prueba', rarity: 'Común', shiny: true, enabled: true },
    ],
  }, adminLogin.body.token)
  assert.equal(catalogResponse.status, 200, JSON.stringify(catalogResponse.body))

  const firstBuyer = await register('ShopBuyerOne')
  const secondBuyer = await register('ShopBuyerTwo')
  const visibleToFirst = await request('/shop/catalog', undefined, firstBuyer.token)
  const visibleToSecond = await request('/shop/catalog', undefined, secondBuyer.token)
  const item = visibleToFirst.body.shopCatalog.find((entry) => entry.name === 'Objeto de prueba')
  const pokemon = visibleToFirst.body.shopCatalog.find((entry) => entry.name === 'Bulbasaur')
  assert.equal(pokemon.shiny, 1)
  assert.equal(item.quantity, 1)
  assert.equal(visibleToSecond.body.shopCatalog.find((entry) => entry.id === item.id).quantity, 1)

  const buyerDatabase = new sqlite3.Database(databasePath)
  await runSql(buyerDatabase, 'UPDATE profiles SET bayas = 0 WHERE user_id = ?', [secondBuyer.user.id])
  await new Promise((resolve, reject) => buyerDatabase.close((error) => error ? reject(error) : resolve()))
  const rejectedForBalance = await request('/shop/items', { itemId: item.id }, secondBuyer.token)
  assert.equal(rejectedForBalance.status, 400)
  const stockAfterRejection = await request('/shop/catalog', undefined, firstBuyer.token)
  assert.equal(stockAfterRejection.body.shopCatalog.find((entry) => entry.id === item.id).quantity, 1)

  const restoredBuyerDatabase = new sqlite3.Database(databasePath)
  await runSql(restoredBuyerDatabase, 'UPDATE profiles SET bayas = 150 WHERE user_id = ?', [secondBuyer.user.id])
  await new Promise((resolve, reject) => restoredBuyerDatabase.close((error) => error ? reject(error) : resolve()))

  const itemPurchases = await Promise.all([
    request('/shop/items', { itemId: item.id }, firstBuyer.token),
    request('/shop/items', { itemId: item.id }, secondBuyer.token),
  ])
  assert.deepEqual(itemPurchases.map((purchase) => purchase.status).sort(), [200, 409])
  const afterItemPurchase = await request('/shop/catalog', undefined, secondBuyer.token)
  assert.equal(afterItemPurchase.body.shopCatalog.find((entry) => entry.id === item.id).quantity, 0)

  const pokemonPurchases = await Promise.all([
    request('/shop/pokemon', { name: pokemon.name }, firstBuyer.token),
    request('/shop/pokemon', { name: pokemon.name }, secondBuyer.token),
  ])
  assert.deepEqual(pokemonPurchases.map((purchase) => purchase.status).sort(), [200, 409])
  const successfulPokemonPurchase = pokemonPurchases.find((purchase) => purchase.status === 200)
  assert.equal(successfulPokemonPurchase.body.user.inventory.pokemon.find((entry) => entry.name === pokemon.name).shiny, true)
  const afterPokemonPurchase = await request('/shop/catalog', undefined, firstBuyer.token)
  assert.equal(afterPokemonPurchase.body.shopCatalog.find((entry) => entry.id === pokemon.id).quantity, 0)
})