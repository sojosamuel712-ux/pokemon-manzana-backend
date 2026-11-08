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
  database.run(sql, params, (error) => error ? reject(error) : resolve())
})

test('las herramientas de administración conservan anuncios e integran sanciones', { timeout: 40000 }, async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'manzana-announcements-test-'))
  const databasePath = join(directory, 'announcements.sqlite')
  const port = await reservePort()
  const baseUrl = `http://127.0.0.1:${port}/api`
  const previousDatabase = new sqlite3.Database(databasePath)
  await runSql(previousDatabase, `CREATE TABLE announcements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`)
  await new Promise((resolve, reject) => previousDatabase.close((error) => error ? reject(error) : resolve()))

  const server = spawn(process.execPath, [backendPath], {
    env: { ...process.env, PORT: String(port), DATABASE_PATH: databasePath, JWT_SECRET: 'announcements-test-secret' },
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

  const registered = await request('/auth/register', {
    username: 'AnnouncementAdmin',
    password: 'test-password',
    age: 18,
    guild: 'Garchomp',
    starter: 'Garchomp',
    acceptTerms: true,
  })
  assert.equal(registered.status, 201, JSON.stringify(registered.body))

  const database = new sqlite3.Database(databasePath)
  await runSql(database, 'UPDATE users SET role_level = 1 WHERE id = ?', [registered.body.user.id])
  await new Promise((resolve, reject) => database.close((error) => error ? reject(error) : resolve()))

  const login = await request('/auth/login', { username: 'AnnouncementAdmin', password: 'test-password' })
  assert.equal(login.status, 200)
  const imageData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/XioAAAAASUVORK5CYII='
  const saved = await request('/admin/announcements', {
    announcements: [
      { message: 'Novedad sin imagen', imageData: '' },
      { message: 'Evento con imagen', imageData },
    ],
  }, login.body.token)

  assert.equal(saved.status, 200, JSON.stringify(saved.body))
  assert.equal(saved.body.announcements.length, 2)
  assert.equal(saved.body.announcements[0].message, 'Evento con imagen')
  assert.equal(saved.body.announcements[0].imageData, imageData)

  const publicAnnouncements = await request('/announcements')
  assert.equal(publicAnnouncements.status, 200)
  assert.equal(publicAnnouncements.body[0].imageData, imageData)
  assert.equal(publicAnnouncements.body[1].message, 'Novedad sin imagen')

  const invalidImage = await request('/admin/announcements', {
    announcements: [{ message: 'Formato no permitido', imageData: 'data:image/svg+xml;base64,PHN2Zy8+' }],
  }, login.body.token)
  assert.equal(invalidImage.status, 400)
  const unchangedAnnouncements = await request('/announcements')
  assert.equal(unchangedAnnouncements.body.length, 2)

  const target = await request('/auth/register', {
    username: 'AnnouncementTarget',
    password: 'test-password',
    age: 18,
    guild: 'Garchomp',
    starter: 'Garchomp',
    acceptTerms: true,
  })
  assert.equal(target.status, 201)
  const globalChat = await request('/chat', { message: 'Mensaje con avatar' }, login.body.token)
  assert.equal(globalChat.status, 201)
  assert.equal(globalChat.body.at(-1).starter, 'Garchomp')
  assert.equal(globalChat.body.at(-1).user, 'AnnouncementAdmin')

  const sanction = await request('/admin/sanctions', {
    userId: target.body.user.id,
    sanctionType: 'warning',
    reason: 'Prueba de integración',
  }, login.body.token)
  assert.equal(sanction.status, 201, JSON.stringify(sanction.body))
  const dashboard = await request('/admin/dashboard', undefined, login.body.token)
  assert.equal(dashboard.status, 200)
  assert.equal(dashboard.body.sanctions[0].username, 'AnnouncementTarget')
  assert.equal(dashboard.body.sanctions[0].reason, 'Prueba de integración')
})