import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const backendPath = fileURLToPath(new URL('../server.cjs', import.meta.url))

const reservePort = async () => {
  const server = createServer()
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve()))
  const { port } = server.address()
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return port
}

test('registro y login limitan solicitudes y el servidor reporta límites de JSON en formato API', { timeout: 30000 }, async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'manzana-api-hardening-'))
  const port = await reservePort()
  const server = spawn(process.execPath, [backendPath], {
    env: { ...process.env, PORT: String(port), DATABASE_PATH: join(directory, 'hardening.sqlite'), JWT_SECRET: 'api-hardening-test-secret' },
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

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const response = await fetch(`${baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: `LimitCheck${attempt}`,
        password: 'secure-test-password',
        age: 16,
        guild: 'Garchomp',
        starter: 'Bulbasaur',
        acceptTerms: true,
      }),
    })
    assert.equal(response.status, 201)
  }
  const limitedRegistration = await fetch(`${baseUrl}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'LimitCheckExtra',
      password: 'secure-test-password',
      age: 16,
      guild: 'Garchomp',
      starter: 'Bulbasaur',
      acceptTerms: true,
    }),
  })
  assert.equal(limitedRegistration.status, 429)
  assert.ok(Number(limitedRegistration.headers.get('retry-after')) > 0)

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'no-such-account', password: 'wrong-password' }),
    })
    assert.equal(response.status, 401)
  }
  const limitedLogin = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'no-such-account', password: 'wrong-password' }),
  })
  assert.equal(limitedLogin.status, 429)

  const oversized = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'no-such-account', password: 'x'.repeat(5 * 1024 * 1024) }),
  })
  assert.equal(oversized.status, 413)
  assert.deepEqual(await oversized.json(), { error: 'La solicitud excede el tamaño permitido.' })

  const announcementPayload = JSON.stringify({ announcements: [], note: 'x'.repeat(5 * 1024 * 1024) })
  const announcementResponse = await fetch(`${baseUrl}/admin/announcements`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: announcementPayload,
  })
  assert.equal(announcementResponse.status, 401)
})
