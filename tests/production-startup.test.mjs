import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createRequire } from 'node:module'

const backendDirectory = fileURLToPath(new URL('../', import.meta.url))
const backendPath = join(backendDirectory, 'server.cjs')
const require = createRequire(new URL('../server.cjs', import.meta.url))
const sqlite3 = require('sqlite3').verbose()

const reservePort = async () => {
  const server = createServer()
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve()))
  const { port } = server.address()
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return port
}

test('producción no arranca sin secretos y almacenamiento persistente configurados', () => {
  const env = { ...process.env, NODE_ENV: 'production' }
  delete env.JWT_SECRET
  delete env.DATABASE_PATH
  const result = spawnSync(process.execPath, [backendPath], { cwd: backendDirectory, env, encoding: 'utf8' })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /JWT_SECRET debe tener al menos 32 caracteres/)
})

test('producción sirve API y recursos sin incluir la interfaz ni crear la cuenta demo', { timeout: 30000 }, async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'manzana-production-test-'))
  const databasePath = join(directory, 'persistent', 'manzana.sqlite')
  const port = await reservePort()
  const server = spawn(process.execPath, [backendPath], {
    cwd: backendDirectory,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      JWT_SECRET: 'production-test-secret-at-least-32-chars',
      DATABASE_PATH: databasePath,
      CORS_ORIGIN: '',
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

  const baseUrl = `http://127.0.0.1:${port}`
  let isReady = false
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`Backend terminó antes de iniciar: ${serverError}`)
    try {
      const response = await fetch(`${baseUrl}/api/health`)
      if (response.ok) {
        isReady = true
        break
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.ok(isReady, `El backend no inició: ${serverError}`)

  const page = await fetch(baseUrl, { headers: { Accept: 'text/html' } })
  assert.equal(page.status, 404)

  for (const asset of ['/models/sbulbasaur.gif', '/sprites/generation-1/sbulbasaur.png']) {
    const response = await fetch(`${baseUrl}${asset}`)
    assert.equal(response.status, 200, `${asset} debe incluirse en el despliegue`)
  }

  const database = new sqlite3.Database(databasePath)
  const users = await new Promise((resolve, reject) => database.get(
    'SELECT COUNT(*) AS count FROM users',
    (error, row) => error ? reject(error) : resolve(row.count),
  ))
  await new Promise((resolve, reject) => database.close((error) => error ? reject(error) : resolve()))
  assert.equal(users, 0)
})
