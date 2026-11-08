import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createRequire } from 'node:module'

const backendPath = fileURLToPath(new URL('../server.cjs', import.meta.url))
const require = createRequire(new URL('../server.cjs', import.meta.url))
const { chooseTrainingAction, createBattle, createBattleTeam, createTrainingTeam, hasTrainingActionRequest, initializeBattleEngine, PVP_FORMAT_ID } = require('./battleEngine.cjs')
const { Dex } = require('pokemon-showdown')
const sqlite3 = require('sqlite3').verbose()

const reservePort = async () => {
  const server = createServer()
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve()))
  const { port } = server.address()
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return port
}

const makePokemonEntry = (instanceId, species, ability, moves) => ({
  instanceId,
  species,
  nickname: '',
  shiny: false,
  heldItem: '',
  nature: 'Fuerte',
  level: 5,
  ability,
  moves,
  ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
  evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
})

test('National Dex AG conserva seis Pokémon y Showdown permite cambiar durante el turno', async () => {
  await initializeBattleEngine()
  const seededRandom = (seed) => () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 0x100000000
  }
  const randomTeamA = createTrainingTeam('easy', 5, seededRandom(42))
  const randomTeamB = createTrainingTeam('easy', 5, seededRandom(43))
  assert.equal(randomTeamA.length, 6)
  assert.equal(new Set(randomTeamA.map((pokemon) => Dex.species.get(pokemon.species).baseSpecies)).size, 6)
  assert.notDeepEqual(randomTeamA.map((pokemon) => pokemon.species), randomTeamB.map((pokemon) => pokemon.species))
  assert.doesNotThrow(() => createBattleTeam(randomTeamA, PVP_FORMAT_ID))

  const selectedGenderTeam = createBattleTeam([{
    species: 'Bulbasaur',
    ability: 'Overgrow',
    moves: ['tackle'],
    gender: 'F',
  }], PVP_FORMAT_ID)
  assert.equal(selectedGenderTeam[0].gender, 'F')
  const selectedGenderBattle = createBattle({
    challenger: 'GenderTrainer',
    opponent: 'BattleOpponent',
    challengerTeam: selectedGenderTeam,
    opponentTeam: selectedGenderTeam,
    formatId: PVP_FORMAT_ID,
  })
  assert.equal(selectedGenderBattle.p1.active[0].gender, 'F')

  const speciesNames = ['Charizard', 'Bulbasaur', 'Pikachu', 'Eevee', 'Garchomp', 'Squirtle']
  const sets = speciesNames.map((species) => {
    const data = Dex.species.get(species)
    const learnset = Dex.species.getLearnsetData(data.id).learnset
    return {
      species,
      ability: Object.values(data.abilities)[0],
      moves: Object.keys(learnset).slice(0, 4),
      shiny: false,
    }
  })
  const team = createBattleTeam(sets)
  const battle = createBattle({
    challenger: 'BattleChallenger',
    opponent: 'BattleOpponent',
    challengerTeam: team,
    opponentTeam: team,
    seed: [1, 2, 3, 4],
  })

  assert.equal(battle.p1.pokemon.length, 6)
  assert.equal(battle.p2.pokemon.length, 6)
  assert.equal(battle.p1.activeRequest.active[0].moves.length, 4)
  assert.equal(battle.choose('p1', 'switch 6'), true)
  assert.equal(battle.choose('p2', 'move 1'), true)
  assert.equal(battle.p1.pokemon.find((pokemon) => pokemon.isActive).species.name, 'Squirtle')

  const configuredSet = createBattleTeam([{
    species: 'Pikachu',
    ability: 'Static',
    moves: ['thunderbolt'],
    level: 37,
    nature: 'Firme',
    evs: { hp: 4, atk: 12, def: 0, spa: 0, spd: 0, spe: 8 },
    ivs: { hp: 30, atk: 29, def: 28, spa: 27, spd: 26, spe: 25 },
    shiny: false,
  }])[0]
  assert.equal(configuredSet.level, 37)
  assert.equal(configuredSet.nature, 'Adamant')
  assert.deepEqual(configuredSet.evs, { hp: 4, atk: 12, def: 0, spa: 0, spd: 0, spe: 8 })
  assert.deepEqual(configuredSet.ivs, { hp: 30, atk: 29, def: 28, spa: 27, spd: 26, spe: 25 })

  const opponentSet = createBattleTeam([{
    species: 'Bulbasaur',
    ability: 'Overgrow',
    moves: ['tackle'],
    level: 100,
    evs: { hp: 1, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
    ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
  }])
  const zMoveBattle = createBattle({
    challenger: 'ZMoveTrainer',
    opponent: 'BattleOpponent',
    challengerTeam: createBattleTeam([{
      species: 'Pikachu',
      ability: 'Static',
      heldItem: 'Electrium Z',
      moves: ['thunderbolt'],
      level: 100,
      evs: { hp: 1, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
      ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
    }]),
    opponentTeam: opponentSet,
    seed: [1, 3, 5, 7],
  })
  assert.equal(zMoveBattle.p1.activeRequest.active[0].canZMove[0].move, 'Gigavolt Havoc')
  assert.equal(zMoveBattle.choose('p1', 'move 1 zmove'), true)
  assert.equal(zMoveBattle.choose('p2', 'move 1'), true)
  assert.ok(zMoveBattle.log.some((line) => line.startsWith('|-zpower|')))

  const megaBattle = createBattle({
    challenger: 'MegaTrainer',
    opponent: 'BattleOpponent',
    challengerTeam: createBattleTeam([{
      species: 'Charizard',
      ability: 'Blaze',
      heldItem: 'Charizardite X',
      moves: ['flareblitz'],
      level: 100,
      evs: { hp: 1, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
      ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
    }]),
    opponentTeam: opponentSet,
    seed: [2, 4, 6, 8],
  })
  assert.equal(megaBattle.p1.activeRequest.active[0].canMegaEvo, true)
  assert.equal(megaBattle.choose('p1', 'move 1 mega'), true)
  assert.equal(megaBattle.choose('p2', 'move 1'), true)
  assert.ok(megaBattle.log.some((line) => line.startsWith('|-mega|')))

  const heldItemSet = createBattleTeam([{
    species: 'Pikachu',
    ability: 'Static',
    moves: ['thunderbolt'],
    level: 50,
    nature: 'Fuerte',
    evs: { hp: 1, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
    ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
    heldItem: 'Restos',
    shiny: false,
  }])[0]
  assert.equal(heldItemSet.item, 'Leftovers')

  for (const difficulty of ['easy', 'medium', 'hard']) {
    const trainingTeam = createTrainingTeam(difficulty, 5)
    assert.equal(trainingTeam.length, 6)
    const trainingBattle = createBattle({
      challenger: 'TrainingPlayer',
      opponent: 'TrainingBot',
      challengerTeam: trainingTeam,
      opponentTeam: trainingTeam,
      formatId: PVP_FORMAT_ID,
    })
    const botAction = chooseTrainingAction(trainingBattle, difficulty)
    assert.match(botAction, /^(move|switch) \d+(?: terastallize| zmove)?$/)
    if (difficulty === 'hard' && botAction.startsWith('move')) {
      assert.match(botAction, /^move \d+ terastallize$/)
    }
  }

  const botRequestBattle = createBattle({
    challenger: 'RequestTrainer',
    opponent: 'RequestBot',
    challengerTeam: createTrainingTeam('easy', 5, seededRandom(951)),
    opponentTeam: createTrainingTeam('easy', 5, seededRandom(952)),
    formatId: PVP_FORMAT_ID,
    seed: [4, 3, 2, 1],
  })
  assert.equal(hasTrainingActionRequest(botRequestBattle), true)
  botRequestBattle.p2.activeRequest.active[0].moves = botRequestBattle.p2.activeRequest.active[0].moves.map((move) => ({
    ...move,
    pp: undefined,
  }))
  const missingPpAction = chooseTrainingAction(botRequestBattle, 'easy', () => 0.5)
  assert.match(missingPpAction, /^move \d+$/)
  assert.equal(botRequestBattle.choose('p2', missingPpAction), true)
  botRequestBattle.p2.activeRequest = { wait: true }
  assert.equal(hasTrainingActionRequest(botRequestBattle), false)
  assert.equal(chooseTrainingAction(botRequestBattle, 'easy'), null)

  const botNoMovesBattle = createBattle({
    challenger: 'NoMovesTrainer',
    opponent: 'NoMovesBot',
    challengerTeam: createTrainingTeam('easy', 5, seededRandom(953)),
    opponentTeam: createTrainingTeam('easy', 5, seededRandom(954)),
    formatId: PVP_FORMAT_ID,
    seed: [5, 4, 3, 2],
  })
  botNoMovesBattle.p2.activeRequest.active[0].moves = []
  const fallbackSwitch = chooseTrainingAction(botNoMovesBattle, 'hard')
  assert.match(fallbackSwitch, /^switch \d+$/)
  assert.equal(botNoMovesBattle.choose('p2', fallbackSwitch), true)

  const matchupBattle = createBattle({
    challenger: 'WaterTrainer',
    opponent: 'StrategicTrainingBot',
    challengerTeam: createBattleTeam([{
      species: 'Gyarados',
      ability: 'Intimidate',
      moves: ['splash'],
      level: 50,
    }], PVP_FORMAT_ID),
    opponentTeam: createBattleTeam([{
      species: 'Pikachu',
      ability: 'Static',
      moves: ['thunderbolt', 'quickattack'],
      level: 50,
    }], PVP_FORMAT_ID),
    formatId: PVP_FORMAT_ID,
    seed: [9, 8, 7, 6],
  })
  assert.match(chooseTrainingAction(matchupBattle, 'hard'), /^move 1(?: terastallize)?$/)

  const faintingOpponentTeam = createBattleTeam([
    { species: 'Pikachu', ability: 'Static', moves: ['thunderbolt', 'quickattack'], level: 1 },
    { species: 'Charizard', ability: 'Blaze', moves: ['flamethrower'], level: 1 },
    { species: 'Bulbasaur', ability: 'Overgrow', moves: ['razorleaf'], level: 1 },
    { species: 'Eevee', ability: 'Adaptability', moves: ['swift'], level: 1 },
    { species: 'Garchomp', ability: 'Rough Skin', moves: ['earthquake'], level: 1 },
    { species: 'Squirtle', ability: 'Torrent', moves: ['surf'], level: 1 },
  ], PVP_FORMAT_ID)
  const faintingBattle = createBattle({
    challenger: 'StrongTrainer',
    opponent: 'EasyTrainingBot',
    challengerTeam: createBattleTeam([{
      species: 'Garchomp',
      ability: 'Rough Skin',
      moves: ['earthquake'],
      level: 100,
      evs: { hp: 0, atk: 252, def: 0, spa: 0, spd: 0, spe: 252 },
      ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
    }]),
    opponentTeam: faintingOpponentTeam,
    seed: [1, 2, 3, 4],
  })
  assert.equal(faintingBattle.choose('p1', 'move 1'), true)
  const botMove = chooseTrainingAction(faintingBattle, 'easy')
  assert.match(botMove, /^move \d+$/)
  assert.equal(faintingBattle.choose('p2', botMove), true)
  assert.equal(faintingBattle.p2.pokemon[0].fainted, true)
  assert.ok(faintingBattle.p2.activeRequest?.forceSwitch?.some(Boolean))
  const botSwitch = chooseTrainingAction(faintingBattle, 'easy')
  assert.match(botSwitch, /^switch \d+$/)
  assert.equal(faintingBattle.choose('p2', botSwitch), true)
  assert.notEqual(faintingBattle.p2.active[0].species.name, 'Pikachu')
  assert.equal(faintingBattle.p2.active[0].fainted, false)
  assert.ok(faintingBattle.p1.activeRequest?.active?.[0]?.moves?.length)
  assert.ok(faintingBattle.log.some((line) => line.startsWith('|move|p1a: Garchomp|Earthquake|p2a: Pikachu')))
  assert.ok(faintingBattle.log.some((line) => line === '|faint|p2a: Pikachu'))
  assert.ok(faintingBattle.log.some((line) => line.startsWith('|switch|p2a:')))
})

test('los desafíos PvP usan Gen 9 Custom Game 6 vs 6 y liquidan los premios', { timeout: 45000 }, async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'manzana-battle-test-'))
  const databasePath = join(directory, 'battle.sqlite')
  const port = await reservePort()
  const baseUrl = `http://127.0.0.1:${port}/api`
  const server = spawn(process.execPath, [backendPath], {
    env: { ...process.env, PORT: String(port), DATABASE_PATH: databasePath, JWT_SECRET: 'battle-test-secret' },
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

  const request = async (route, body, token, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(`${baseUrl}${route}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const responseText = await response.text()
    let parsedBody
    try {
      parsedBody = JSON.parse(responseText)
    } catch {
      throw new Error(`Respuesta no JSON en ${route} (${response.status}): ${responseText.slice(0, 200)}`)
    }
    return { status: response.status, body: parsedBody }
  }

  const register = async (username, guild, starter) => {
    const response = await request('/auth/register', {
      username,
      password: 'test-password',
      age: 18,
      guild,
      starter,
      acceptTerms: true,
    })
    assert.equal(response.status, 201, JSON.stringify(response.body))
    return response.body
  }

  const challenger = await register('BattleChallenger', 'Garchomp', 'Charizard')
  const opponent = await register('BattleOpponent', 'Garchomp', 'Bulbasaur')
  const outsider = await register('BattleOutsider', 'Dragonite', 'Dragonite')
  const initialChat = await request('/chat')
  assert.deepEqual(initialChat.body, [])

  const guildOpponents = await request('/battles/opponents?scope=guild', undefined, challenger.token)
  assert.deepEqual(guildOpponents.body.opponents.map((entry) => entry.id), [1, opponent.user.id])
  const communityOpponents = await request('/battles/opponents?scope=community', undefined, challenger.token)
  assert.deepEqual(communityOpponents.body.opponents.map((entry) => entry.id), [outsider.user.id])

  const charizard = makePokemonEntry('charizard-team-0', 'Charizard', 'Blaze', ['flareblitz'])
  const pikachu = makePokemonEntry('pikachu-team-1', 'Pikachu', 'Static', ['thunderbolt'])
  const pcSquirtle = makePokemonEntry('squirtle-pc-0', 'Squirtle', 'Torrent', ['tackle'])
  const bulbasaur = makePokemonEntry('bulbasaur-team-0', 'Bulbasaur', 'Overgrow', ['tackle'])
  const challengerTeam = [
    charizard,
    pikachu,
    makePokemonEntry('eevee-team-2', 'Eevee', 'Adaptability', ['quickattack']),
    makePokemonEntry('snorlax-team-3', 'Snorlax', 'Immunity', ['tackle']),
    makePokemonEntry('garchomp-team-4', 'Garchomp', 'Rough Skin', ['earthquake']),
    makePokemonEntry('dragonite-team-5', 'Dragonite', 'Multiscale', ['dragonclaw']),
  ]
  const opponentTeam = [
    bulbasaur,
    makePokemonEntry('pikachu-opponent-1', 'Pikachu', 'Static', ['thunderbolt']),
    makePokemonEntry('squirtle-opponent-2', 'Squirtle', 'Torrent', ['tackle']),
    makePokemonEntry('eevee-opponent-3', 'Eevee', 'Adaptability', ['quickattack']),
    makePokemonEntry('snorlax-opponent-4', 'Snorlax', 'Immunity', ['tackle']),
    makePokemonEntry('garchomp-opponent-5', 'Garchomp', 'Rough Skin', ['earthquake']),
  ]
  const database = new sqlite3.Database(databasePath)
  await new Promise((resolve, reject) => database.run(
    'INSERT INTO inventory_pokemon (user_id, pokemon_name, level) VALUES (?, ?, 5), (?, ?, 5)',
    [challenger.user.id, 'Pikachu', challenger.user.id, 'Squirtle'],
    (error) => error ? reject(error) : resolve(),
  ))
  await new Promise((resolve, reject) => database.run(
    `INSERT INTO inventory_pokemon (user_id, pokemon_name, level) VALUES
      (?, 'Eevee', 5), (?, 'Snorlax', 5), (?, 'Garchomp', 5), (?, 'Dragonite', 5),
      (?, 'Pikachu', 5), (?, 'Squirtle', 5), (?, 'Eevee', 5), (?, 'Snorlax', 5), (?, 'Garchomp', 5)`,
    [
      challenger.user.id, challenger.user.id, challenger.user.id, challenger.user.id,
      opponent.user.id, opponent.user.id, opponent.user.id, opponent.user.id, opponent.user.id,
    ],
    (error) => error ? reject(error) : resolve(),
  ))
  await new Promise((resolve, reject) => database.close((error) => error ? reject(error) : resolve()))
  const challengerRoster = await request('/profile/pokemon-roster', {
    pokemonRoster: { team: challengerTeam, pc: [pcSquirtle] },
  }, challenger.token, 'PUT')
  assert.equal(challengerRoster.status, 200, JSON.stringify(challengerRoster.body))
  const opponentRoster = await request('/profile/pokemon-roster', {
    pokemonRoster: { team: opponentTeam, pc: [] },
  }, opponent.token, 'PUT')
  assert.equal(opponentRoster.status, 200, JSON.stringify(opponentRoster.body))

  const shortRoster = await request('/profile/pokemon-roster', {
    pokemonRoster: { team: challengerTeam.slice(0, 5), pc: [pcSquirtle, challengerTeam[5]] },
  }, challenger.token, 'PUT')
  assert.equal(shortRoster.status, 200)
  const incompleteChallenge = await request('/battles/requests', { opponentId: opponent.user.id, scope: 'guild' }, challenger.token)
  assert.equal(incompleteChallenge.status, 400)
  assert.match(incompleteChallenge.body.error, /exactamente 6 Pokémon/)
  const restoredRoster = await request('/profile/pokemon-roster', {
    pokemonRoster: { team: challengerTeam, pc: [pcSquirtle] },
  }, challenger.token, 'PUT')
  assert.equal(restoredRoster.status, 200)

  const rejectedChallenge = await request('/battles/requests', { opponentId: outsider.user.id, scope: 'community' }, challenger.token)
  assert.equal(rejectedChallenge.status, 201, JSON.stringify(rejectedChallenge.body))
  const outsiderRequests = await request('/battles/requests', undefined, outsider.token)
  assert.equal(outsiderRequests.body.requests[0].challengerName, 'BattleChallenger')
  const rejected = await request(`/battles/requests/${rejectedChallenge.body.requestId}/reject`, {}, outsider.token)
  assert.equal(rejected.status, 200)

  const challenge = await request('/battles/requests', { opponentId: opponent.user.id, scope: 'guild' }, challenger.token)
  assert.equal(challenge.status, 201)
  const pending = await request('/battles/requests', undefined, opponent.token)
  assert.equal(pending.body.requests[0].status, 'pending')
  const accepted = await request(`/battles/requests/${challenge.body.requestId}/accept`, {}, opponent.token)
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body))
  assert.equal(accepted.body.battle.format, '[Gen 9] Custom Game')
  assert.equal(accepted.body.battle.turn, 1)
  assert.equal(accepted.body.battle.players.p2.request.moves[0].id, 'tackle')
  assert.equal(accepted.body.battle.players.p2.request.moves[0].type, 'Normal')
  assert.equal(accepted.body.battle.players.p2.request.moves[0].category, 'Physical')
  assert.equal(accepted.body.battle.players.p2.request.moves[0].basePower, 40)
  assert.equal(accepted.body.battle.players.p2.cry, 'https://raw.githubusercontent.com/PokeAPI/cries/main/cries/pokemon/latest/1.ogg')
  assert.equal(accepted.body.battle.players.p2.cryFallback, undefined)
  assert.equal(accepted.body.battle.players.p1.request, null)
  assert.equal(accepted.body.battle.players.p2.request.canTerastallize, 'Grass')
  assert.equal(accepted.body.battle.players.p1.sprites.front, '/models/scharizard.gif')
  assert.equal(accepted.body.battle.players.p1.sprites.back, '/models/scharizard-b.gif')
  assert.deepEqual(accepted.body.battle.players.p1.types, ['Fire', 'Flying'])
  assert.ok(['', 'M', 'F'].includes(accepted.body.battle.players.p1.gender))
  assert.equal(accepted.body.battle.players.p1.gender, accepted.body.battle.players.p1.team[0].gender)
  assert.deepEqual(accepted.body.battle.players.p1.boosts, {})
  assert.deepEqual(accepted.body.battle.field, { weather: null, terrain: null, rooms: [] })
  assert.deepEqual(accepted.body.battle.players.p1.team[0].types, ['Fire', 'Flying'])
  assert.deepEqual(accepted.body.battle.players.p1.team.map((pokemon) => pokemon.species), ['Charizard', 'Pikachu', 'Eevee', 'Snorlax', 'Garchomp', 'Dragonite'])
  assert.equal(accepted.body.battle.players.p1.team.some((pokemon) => pokemon.species === 'Squirtle'), false)
  assert.equal(accepted.body.battle.players.p2.team.length, 6)
  assert.equal(accepted.body.battle.request.type, 'move')

  const activeBattles = await request('/battles/active', undefined, outsider.token)
  assert.equal(activeBattles.status, 200)
  assert.equal(activeBattles.body.battles.length, 1)
  assert.equal(activeBattles.body.battles[0].id, challenge.body.requestId)
  const spectatorView = await request(`/battles/${challenge.body.requestId}/spectate`, undefined, outsider.token)
  assert.equal(spectatorView.status, 200)
  assert.equal(spectatorView.body.battle.isSpectator, true)
  assert.equal(spectatorView.body.battle.yourSide, null)
  assert.equal(spectatorView.body.battle.request, null)
  assert.equal(spectatorView.body.battle.players.p1.request, null)
  assert.equal(spectatorView.body.battle.players.p2.request, null)
  assert.equal(spectatorView.body.battle.players.p1.team.length, 6)
  const spectatorMove = await request(`/battles/${challenge.body.requestId}/move`, { moveId: 'tackle' }, outsider.token)
  assert.equal(spectatorMove.status, 404)
  const spectatorChatWrite = await request(`/battles/${challenge.body.requestId}/messages`, { message: 'hello' }, outsider.token)
  assert.equal(spectatorChatWrite.status, 403)
  const participantChatWrite = await request(`/battles/${challenge.body.requestId}/messages`, { message: '¡Suerte!' }, challenger.token)
  assert.equal(participantChatWrite.status, 201)
  const spectatorChat = await request(`/battles/${challenge.body.requestId}/messages`, undefined, outsider.token)
  assert.equal(spectatorChat.body.messages[0].username, 'BattleChallenger')
  assert.equal(spectatorChat.body.messages[0].message, '¡Suerte!')

  const sprite = await fetch(`http://127.0.0.1:${port}/models/sbulbasaur-b.gif`)
  assert.equal(sprite.status, 200)
  assert.match(sprite.headers.get('content-type'), /image\/gif/)
  for (const spritePath of ['/models/sgarchomp.gif', '/models/sdragonite.gif']) {
    const battleSprite = await fetch(`http://127.0.0.1:${port}${spritePath}`)
    assert.equal(battleSprite.status, 200, `${spritePath} debe existir para la arena y el equipo`)
  }
  const invalidMove = await request(`/battles/${challenge.body.requestId}/move`, { moveId: 'not-a-move' }, challenger.token)
  assert.equal(invalidMove.status, 400)
  const unavailableMechanic = await request(`/battles/${challenge.body.requestId}/move`, { moveId: 'flareblitz', battleOption: 'dynamax' }, challenger.token)
  assert.equal(unavailableMechanic.status, 400)
  const pcSwitch = await request(`/battles/${challenge.body.requestId}/move`, { switchIndex: 6 }, challenger.token)
  assert.equal(pcSwitch.status, 400)
  const firstSwitch = await request(`/battles/${challenge.body.requestId}/move`, { switchIndex: 1 }, challenger.token)
  assert.equal(firstSwitch.status, 200)
  const firstMove = await request(`/battles/${challenge.body.requestId}/move`, { moveId: 'tackle' }, opponent.token)
  assert.equal(firstMove.status, 200)
  assert.equal(firstMove.body.battle.status, 'active')
  assert.equal(firstMove.body.battle.players.p1.species, 'Pikachu')
  const secondSwitch = await request(`/battles/${challenge.body.requestId}/move`, { switchIndex: 1 }, challenger.token)
  assert.equal(secondSwitch.status, 200, JSON.stringify(secondSwitch.body))
  const secondMove = await request(`/battles/${challenge.body.requestId}/move`, { moveId: 'tackle' }, opponent.token)
  assert.equal(secondMove.status, 200)
  assert.equal(secondMove.body.battle.players.p1.species, 'Charizard')
  const thirdMove = await request(`/battles/${challenge.body.requestId}/move`, { moveId: 'flareblitz', battleOption: 'terastallize' }, challenger.token)
  assert.equal(thirdMove.status, 200)
  assert.equal(thirdMove.body.battle.status, 'active')
  let finishingMove = thirdMove
  for (let turn = 0; turn < 120 && finishingMove.body.battle.status === 'active'; turn += 1) {
    for (const token of [opponent.token, challenger.token]) {
      const current = await request('/battles/current', undefined, token)
      const currentBattle = current.body.battle
      if (currentBattle.status === 'finished') {
        finishingMove = current
        break
      }
      const battleRequest = currentBattle.request
      if (!battleRequest || battleRequest.type === 'wait') continue
      const action = battleRequest.type === 'switch'
        ? { switchIndex: currentBattle.players[currentBattle.yourSide].team.find((pokemon) => !pokemon.active && !pokemon.fainted)?.index }
        : { moveId: battleRequest.moves.find((move) => !move.disabled && move.pp > 0)?.id }
      finishingMove = await request(`/battles/${currentBattle.id}/move`, action, token)
      assert.equal(finishingMove.status, 200, JSON.stringify(finishingMove.body))
      if (finishingMove.body.battle.status === 'finished') break
    }
  }
  assert.equal(finishingMove.body.battle.status, 'finished')
  assert.ok(finishingMove.body.battle.log.some((line) => line.startsWith('|-terastallize|p1a: Charizard|Fire')))
  const noLongerActiveSpectator = await request(`/battles/${challenge.body.requestId}/spectate`, undefined, outsider.token)
  assert.equal(noLongerActiveSpectator.status, 404)
  const noActiveBattles = await request('/battles/active', undefined, outsider.token)
  assert.deepEqual(noActiveBattles.body.battles, [])

  const challengerProfile = await request('/profile', undefined, challenger.token)
  const opponentProfile = await request('/profile', undefined, opponent.token)
  assert.equal(challengerProfile.body.battleWins + opponentProfile.body.battleWins, 1)
  const challengerWon = challengerProfile.body.battleWins === 1
  assert.equal(challengerProfile.body.bayas, challengerWon ? 180 : 165)
  assert.equal(challengerProfile.body.mysteriousCoins.bronze, 3)
  assert.equal(challengerProfile.body.battleWins, challengerWon ? 1 : 0)
  assert.equal(challengerProfile.body.battleLosses, challengerWon ? 0 : 1)
  assert.equal(opponentProfile.body.bayas, challengerWon ? 165 : 180)
  assert.equal(opponentProfile.body.mysteriousCoins.bronze, 3)
  assert.equal(opponentProfile.body.battleWins, challengerWon ? 0 : 1)
  assert.equal(opponentProfile.body.battleLosses, challengerWon ? 1 : 0)

  const winnerBattle = await request('/battles/current', undefined, challenger.token)
  assert.equal(winnerBattle.body.battle.isWinner, challengerWon)
  const repeatedMove = await request(`/battles/${challenge.body.requestId}/move`, { moveId: 'tackle' }, challenger.token)
  assert.equal(repeatedMove.status, 404)

  const forfeitChallenge = await request('/battles/requests', { opponentId: opponent.user.id, scope: 'guild' }, challenger.token)
  const forfeitAccepted = await request(`/battles/requests/${forfeitChallenge.body.requestId}/accept`, {}, opponent.token)
  assert.equal(forfeitAccepted.status, 200)
  const unauthorizedForfeit = await request(`/battles/${forfeitAccepted.body.battle.id}/forfeit`, {}, outsider.token)
  assert.equal(unauthorizedForfeit.status, 404)
  const forfeitedBattle = await request(`/battles/${forfeitAccepted.body.battle.id}/forfeit`, {}, challenger.token)
  assert.equal(forfeitedBattle.status, 200, JSON.stringify(forfeitedBattle.body))
  assert.equal(forfeitedBattle.body.battle.status, 'finished')
  assert.equal(forfeitedBattle.body.battle.winnerName, 'BattleOpponent')
  assert.equal(forfeitedBattle.body.battle.isWinner, false)
  assert.ok(forfeitedBattle.body.battle.log.some((line) => line === '|win|BattleOpponent'))
  assert.equal(forfeitedBattle.body.user.bayas, challengerProfile.body.bayas + 15)
  assert.equal(forfeitedBattle.body.user.battleLosses, challengerProfile.body.battleLosses + 1)
  const forfeitWinnerProfile = await request('/profile', undefined, opponent.token)
  assert.equal(forfeitWinnerProfile.body.bayas, opponentProfile.body.bayas + 30)
  assert.equal(forfeitWinnerProfile.body.battleWins, opponentProfile.body.battleWins + 1)
  const duplicateForfeit = await request(`/battles/${forfeitAccepted.body.battle.id}/forfeit`, {}, challenger.token)
  assert.equal(duplicateForfeit.status, 404)

  const shortTrainingRoster = await request('/profile/pokemon-roster', {
    pokemonRoster: { team: challengerTeam.slice(0, 5), pc: [pcSquirtle, challengerTeam[5]] },
  }, challenger.token, 'PUT')
  assert.equal(shortTrainingRoster.status, 200)
  const incompleteTraining = await request('/battles/training', { difficulty: 'easy' }, challenger.token)
  assert.equal(incompleteTraining.status, 400)
  assert.match(incompleteTraining.body.error, /exactamente 6 Pokémon/)
  const restoredTrainingRoster = await request('/profile/pokemon-roster', {
    pokemonRoster: { team: challengerTeam, pc: [pcSquirtle] },
  }, challenger.token, 'PUT')
  assert.equal(restoredTrainingRoster.status, 200)

  const training = await request('/battles/training', { difficulty: 'easy' }, challenger.token)
  assert.equal(training.status, 201, JSON.stringify(training.body))
  assert.equal(training.body.battle.isTraining, true)
  assert.equal(training.body.battle.trainingDifficulty, 'easy')
  assert.equal(training.body.battle.format, '[Gen 9] Custom Game')
  assert.equal(training.body.battle.players.p1.team.length, 6)
  assert.equal(training.body.battle.players.p2.team.length, 6)
  assert.equal(new Set(training.body.battle.players.p2.team.map((pokemon) => pokemon.species)).size, 6)
  assert.match(training.body.battle.id, /^training-/)

  const trainingTurn = await request(`/battles/${training.body.battle.id}/move`, {
    moveId: training.body.battle.request.moves[0].id,
  }, challenger.token)
  assert.equal(trainingTurn.status, 200, JSON.stringify(trainingTurn.body))
  assert.equal(trainingTurn.body.battle.status, 'active')
  assert.equal(trainingTurn.body.battle.isTraining, true)
  assert.ok(trainingTurn.body.battle.log.length > training.body.battle.log.length)
  const trainingTurnLog = trainingTurn.body.battle.log.slice(training.body.battle.log.length)
  assert.ok(trainingTurnLog.some((line) => line.startsWith('|move|p1a:')))
  assert.ok(trainingTurnLog.some((line) =>
    line.startsWith('|move|p2a:') || line.startsWith('|switch|p2a:'),
  ))
  const faintedBot = trainingTurnLog.find((line) => line.startsWith('|faint|p2a:'))
  if (faintedBot) {
    const faintedPokemon = trainingTurn.body.battle.players.p2.team.find((pokemon) => pokemon.fainted)
    assert.ok(faintedPokemon)
    assert.notEqual(trainingTurn.body.battle.players.p2.species, faintedPokemon.species)
  }

  const challengerAfterTraining = await request('/profile', undefined, challenger.token)
  assert.equal(challengerAfterTraining.body.bayas, forfeitedBattle.body.user.bayas)
  assert.equal(challengerAfterTraining.body.battleWins, forfeitedBattle.body.user.battleWins)

  const outsiderDatabase = new sqlite3.Database(databasePath)
  await new Promise((resolve, reject) => outsiderDatabase.run(
    `INSERT INTO inventory_pokemon (user_id, pokemon_name, level) VALUES
      (?, 'Pikachu', 5), (?, 'Squirtle', 5), (?, 'Eevee', 5), (?, 'Snorlax', 5), (?, 'Garchomp', 5)`,
    [outsider.user.id, outsider.user.id, outsider.user.id, outsider.user.id, outsider.user.id],
    (error) => error ? reject(error) : resolve(),
  ))
  await new Promise((resolve, reject) => outsiderDatabase.close((error) => error ? reject(error) : resolve()))
  const outsiderRoster = await request('/profile/pokemon-roster', {
    pokemonRoster: {
      team: [
        makePokemonEntry('dragonite-training', 'Dragonite', 'Multiscale', ['dragonclaw']),
        makePokemonEntry('pikachu-outsider', 'Pikachu', 'Static', ['thunderbolt']),
        makePokemonEntry('squirtle-outsider', 'Squirtle', 'Torrent', ['tackle']),
        makePokemonEntry('eevee-outsider', 'Eevee', 'Adaptability', ['quickattack']),
        makePokemonEntry('snorlax-outsider', 'Snorlax', 'Immunity', ['tackle']),
        makePokemonEntry('garchomp-outsider', 'Garchomp', 'Rough Skin', ['earthquake']),
      ],
      pc: [],
    },
  }, outsider.token, 'PUT')
  assert.equal(outsiderRoster.status, 200)
  const sharedTraining = await request('/battles/training', { difficulty: 'easy' }, outsider.token)
  assert.equal(sharedTraining.status, 201, JSON.stringify(sharedTraining.body))
  assert.equal(sharedTraining.body.battle.players.p2.team.length, 6)
  const unauthorizedAbandon = await request(`/battles/training/${sharedTraining.body.battle.id}/abandon`, {}, challenger.token)
  assert.equal(unauthorizedAbandon.status, 404)
  const abandonedTraining = await request(`/battles/training/${training.body.battle.id}/abandon`, {}, challenger.token)
  assert.equal(abandonedTraining.status, 200, JSON.stringify(abandonedTraining.body))
  assert.equal(abandonedTraining.body.battle.status, 'finished')
  assert.equal(abandonedTraining.body.battle.winnerName, null)
  const restartedTraining = await request('/battles/training', { difficulty: 'medium' }, challenger.token)
  assert.equal(restartedTraining.status, 201, JSON.stringify(restartedTraining.body))
  assert.equal(restartedTraining.body.battle.trainingDifficulty, 'medium')
  const abandonedRestart = await request(`/battles/training/${restartedTraining.body.battle.id}/abandon`, {}, challenger.token)
  assert.equal(abandonedRestart.status, 200)
  const profileDatabase = new sqlite3.Database(databasePath)
  const savedBotProfiles = await new Promise((resolve, reject) => {
    profileDatabase.all('SELECT difficulty, level_band FROM training_bot_teams', (error, rows) => error ? reject(error) : resolve(rows))
  })
  await new Promise((resolve, reject) => profileDatabase.close((error) => error ? reject(error) : resolve()))
  assert.deepEqual(savedBotProfiles, [])
})