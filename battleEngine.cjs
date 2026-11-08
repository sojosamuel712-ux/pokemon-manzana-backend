const fs = require('node:fs')
const path = require('node:path')
const { Battle, Dex, TeamValidator, toID } = require('pokemon-showdown')

const FORMAT_ID = 'gen9nationaldexag'
const PVP_FORMAT_ID = 'gen9customgame'
const modelDirectory = path.resolve(process.env.MODEL_DIRECTORY || path.join(__dirname, 'models'))
const spriteVariants = new Map()
let localizedItemIds = new Map()
const natureNames = {
  Fuerte: 'Hardy',
  Huraña: 'Lonely',
  Audaz: 'Brave',
  Firme: 'Adamant',
  Pícara: 'Naughty',
  Osada: 'Bold',
  Dócil: 'Docile',
  Plácida: 'Relaxed',
  Agitada: 'Impish',
  Floja: 'Lax',
  Miedosa: 'Timid',
  Activa: 'Hasty',
  Seria: 'Serious',
  Alegre: 'Jolly',
  Ingenua: 'Naive',
  Modesta: 'Modest',
  Afable: 'Mild',
  Mansa: 'Quiet',
  Tímida: 'Bashful',
  Alocada: 'Rash',
  Serena: 'Calm',
  Amable: 'Gentle',
  Grosera: 'Sassy',
  Cauta: 'Careful',
  Rara: 'Quirky',
}

const spriteFiles = fs.readdirSync(modelDirectory).filter((file) => file.endsWith('.gif')).sort()
for (const file of spriteFiles) {
  let stem = file.slice(0, -4)
  let orientation = 'front'
  let shiny = false
  if (stem.endsWith('-b-s')) {
    orientation = 'back'
    shiny = true
    stem = stem.slice(0, -4)
  } else if (stem.endsWith('-b')) {
    orientation = 'back'
    stem = stem.slice(0, -2)
  } else if (stem.endsWith('-s')) {
    shiny = true
    stem = stem.slice(0, -2)
  }
  if (stem.startsWith('s')) stem = stem.slice(1)
  const key = `${toID(stem)}:${orientation}:${shiny}`
  if (!spriteVariants.has(key)) spriteVariants.set(key, `/models/${encodeURIComponent(file)}`)
}

const getBattleCry = (species) => {
  const dexSpecies = Dex.species.get(species)
  if (!dexSpecies.exists || !Number.isInteger(dexSpecies.num) || dexSpecies.num < 1) {
    return null
  }
  return `https://raw.githubusercontent.com/PokeAPI/cries/main/cries/pokemon/latest/${dexSpecies.num}.ogg`
}

const getBattleSprites = (species, fallback, shinyFallback = fallback) => {
  const dexSpecies = Dex.species.get(species)
  const id = toID(dexSpecies.id || species)
  const sprite = (orientation, shiny) => spriteVariants.get(`${id}:${orientation}:${shiny}`)
    || (shiny ? shinyFallback : fallback)
    || null

  return {
    front: sprite('front', false),
    back: sprite('back', false),
    frontShiny: sprite('front', true),
    backShiny: sprite('back', true),
  }
}

const getBattleMoveData = (moveId) => {
  const move = Dex.moves.get(toID(moveId))
  if (!move.exists) return null
  return {
    type: move.type,
    category: move.category,
    basePower: move.basePower,
    accuracy: move.accuracy,
    priority: move.priority,
  }
}

const initializeBattleEngine = async () => {
  const { itemCatalog } = await import(path.join(__dirname, 'data', 'itemCatalog.mjs'))
  localizedItemIds = new Map(itemCatalog.map((item) => [toID(item.name), item.id]))
}

const createPokemonSet = (source, shiny) => {
  const species = Dex.species.get(String(source?.species || '').trim())
  if (!species.exists) throw new Error('El Pokémon seleccionado no existe en National Dex.')

  const moves = Array.isArray(source.moves)
    ? [...new Set(source.moves.map((move) => Dex.moves.get(toID(move))).filter((move) => move.exists).map((move) => move.id))].slice(0, 4)
    : []
  if (!moves.length) throw new Error('Este Pokémon necesita al menos un movimiento válido para combatir.')

  const requestedAbility = Dex.abilities.get(toID(source.ability || '')).exists
    ? Dex.abilities.get(toID(source.ability)).name
    : null
  const defaultAbility = species.abilities['0'] || Object.values(species.abilities)[0]
  const ability = requestedAbility || Dex.abilities.get(toID(defaultAbility)).name
  let heldItem = Dex.items.get(toID(source.heldItem || ''))
  if (source.heldItem && !heldItem.exists) {
    heldItem = Dex.items.get(localizedItemIds.get(toID(source.heldItem)) || '')
  }
  if (source.heldItem && !heldItem.exists) {
    throw new Error(`El objeto equipado "${source.heldItem}" no existe en National Dex.`)
  }
  const evs = { ...(source.evs || { hp: 4, atk: 252, spe: 252 }) }
  if (Object.values(evs).every((value) => Number(value) === 0)) evs.hp = 1
  const team = [{
    species: species.name,
    ability,
    item: heldItem.exists ? heldItem.name : '',
    moves,
    nature: natureNames[source.nature] || Dex.natures.get(toID(source.nature)).name || 'Hardy',
    level: Number.isInteger(source.level) && source.level >= 1 && source.level <= 100 ? source.level : 100,
    gender: source.gender === 'M' || source.gender === 'F' ? source.gender : undefined,
    evs,
    ivs: source.ivs || { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
    shiny: Boolean(shiny),
  }]
  return team[0]
}

const createBattleTeam = (sources, formatId = FORMAT_ID) => {
  if (!Array.isArray(sources) || sources.length < 1 || sources.length > 6) {
    throw new Error('El equipo de combate debe tener entre 1 y 6 Pokémon.')
  }

  const team = sources.map((source) => createPokemonSet(source, source.shiny))
  const errors = new TeamValidator(formatId).validateTeam(team)
  if (errors?.length) throw new Error(errors.join(' '))
  return team
}

const randomIndex = (length, rng) => Math.min(length - 1, Math.floor(rng() * length))

const shuffle = (values, rng) => {
  const shuffled = [...values]
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = randomIndex(index + 1, rng)
    const value = shuffled[index]
    shuffled[index] = shuffled[swapIndex]
    shuffled[swapIndex] = value
  }
  return shuffled
}

const trainingSpecies = Dex.species.all().filter((species) =>
  species.exists &&
  species.num > 0 &&
  species.num <= 1025 &&
  species.gen <= 9 &&
  !species.battleOnly &&
  !species.isNonstandard,
)

const getRandomLearnsetMoves = (species, rng) => {
  const learnset = Dex.species.getLearnsetData(species.id)?.learnset || {}
  const moves = Object.keys(learnset)
    .map((moveId) => Dex.moves.get(moveId))
    .filter((move) => move.exists && !move.isNonstandard)
  const damagingMoves = moves.filter((move) => move.basePower > 0)
  const utilityMoves = moves.filter((move) =>
    move.category === 'Status' && (
      move.heal ||
      move.status ||
      move.boosts ||
      move.volatileStatus ||
      move.sideCondition
    ),
  )
  const selected = []
  const stabMoves = shuffle(damagingMoves.filter((move) => species.types.includes(move.type)), rng)
  if (stabMoves.length) selected.push(stabMoves[0])

  const remainingMoves = shuffle(moves.filter((move) => !selected.some((entry) => entry.id === move.id)), rng)
  for (const move of remainingMoves) {
    if (selected.length >= 3) break
    selected.push(move)
  }

  if (utilityMoves.length && rng() < 0.75) {
    const utilityMove = shuffle(utilityMoves, rng).find((move) => !selected.some((entry) => entry.id === move.id))
    if (utilityMove) {
      if (selected.length === 4) selected.pop()
      selected.push(utilityMove)
    }
  }
  return selected.slice(0, 4).map((move) => move.id)
}

const createTrainingTeam = (difficulty, level, rng = Math.random) => {
  if (!['easy', 'medium', 'hard'].includes(difficulty)) {
    throw new Error('Selecciona una dificultad válida para entrenar.')
  }

  const normalizedLevel = Math.max(1, Math.min(100, Math.floor(Number(level) || 1)))
  const evs = difficulty === 'hard'
    ? { hp: 4, atk: 252, def: 0, spa: 0, spd: 0, spe: 252 }
    : difficulty === 'medium'
      ? { hp: 84, atk: 84, def: 84, spa: 84, spd: 84, spe: 84 }
      : { hp: 1, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 }
  const candidatePool = shuffle(trainingSpecies, rng)
  let lastValidationError = 'No se pudo generar un equipo válido.'

  for (let attempt = 0; attempt < 30; attempt += 1) {
    const team = []
    const selectedSpecies = new Set()
    for (const species of candidatePool) {
      const baseSpecies = toID(species.baseSpecies || species.name)
      if (selectedSpecies.has(baseSpecies)) continue
      const moves = getRandomLearnsetMoves(species, rng)
      if (!moves.length) continue
      selectedSpecies.add(baseSpecies)
      team.push({
        species: species.name,
        ability: species.abilities['0'] || Object.values(species.abilities)[0],
        moves,
        level: normalizedLevel,
        evs,
        ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
      })
      if (team.length === 6) break
    }
    if (team.length !== 6) {
      throw new Error('La Pokédex no proporcionó suficientes especies con movimientos para generar el equipo.')
    }
    try {
      return createBattleTeam(team, PVP_FORMAT_ID)
    } catch (error) {
      lastValidationError = error.message
    }
  }

  throw new Error(`No se pudo validar el equipo aleatorio del bot: ${lastValidationError}`)
}

const scoreTrainingMove = (move, attacker, target) => {
  const moveData = Dex.moves.get(typeof move === 'string' ? move : move?.id)
  if (!moveData.exists || !attacker || !target) return Number.NEGATIVE_INFINITY
  if (moveData.category === 'Status') {
    const hpRatio = attacker.maxhp ? attacker.hp / attacker.maxhp : 1
    if (moveData.heal && hpRatio < 0.72) return 65 + (1 - hpRatio) * 55
    if (moveData.status && !target.status) return 42
    if (moveData.boosts) {
      const usefulBoosts = Object.entries(moveData.boosts).some(([stat, amount]) =>
        amount > 0 && (attacker.boosts[stat] || 0) < 6,
      )
      if (usefulBoosts) return 36
    }
    return -12
  }

  const effectiveness = 2 ** Dex.getEffectiveness(moveData.type, target.species.types)
  const stab = attacker.species.types.includes(moveData.type) ? 1.5 : 1
  const accuracy = moveData.accuracy === true ? 1 : Math.max(0, moveData.accuracy) / 100
  const priority = Math.max(0, moveData.priority) * 8
  const recoilPenalty = moveData.recoil ? moveData.basePower * 0.12 : 0
  return moveData.basePower * effectiveness * stab * accuracy + priority - recoilPenalty
}

const scoreTrainingSwitch = (pokemon, target, lastOpponentMove) => {
  const hpRatio = pokemon.maxhp ? pokemon.hp / pokemon.maxhp : 0
  const bestAttack = pokemon.moves.reduce((best, moveId) =>
    Math.max(best, scoreTrainingMove(Dex.moves.get(moveId), pokemon, target)),
  0)
  const attackScore = Number.isFinite(bestAttack) ? bestAttack : 0
  const incomingMove = lastOpponentMove ? Dex.moves.get(lastOpponentMove) : null
  const incomingEffectiveness = incomingMove?.exists && incomingMove.basePower > 0
    ? Dex.getEffectiveness(incomingMove.type, pokemon.species.types)
    : 0
  const immunityBonus = incomingEffectiveness <= -6 ? 55 : 0
  return attackScore + hpRatio * 22 - incomingEffectiveness * 24 + immunityBonus - (pokemon.status ? 5 : 0)
}

const hasTrainingActionRequest = (battle) => {
  const request = battle.p2.activeRequest
  return Boolean(request && !request.wait && (
    request.forceSwitch?.some(Boolean) ||
    request.active?.length
  ))
}

const chooseTrainingAction = (battle, difficulty, rng = Math.random) => {
  const sideRequest = battle.p2.activeRequest
  const request = sideRequest?.active?.[0]
  if (!sideRequest || sideRequest.wait) return null

  if (sideRequest.forceSwitch?.some(Boolean) || battle.p2.active?.some((pokemon) => pokemon.fainted)) {
    const available = battle.p2.pokemon
      .map((pokemon, index) => ({ pokemon, index }))
      .filter(({ pokemon }) => !pokemon.fainted && !pokemon.isActive)
    if (!available.length) return null
    const target = battle.p1.active?.[0]
    const lastMove = target?.lastMove
    const choice = difficulty === 'easy'
      ? available[randomIndex(available.length, rng)]
      : available.reduce((best, entry) =>
        scoreTrainingSwitch(entry.pokemon, target, lastMove) > scoreTrainingSwitch(best.pokemon, target, lastMove) ? entry : best,
      )
    return `switch ${choice.index + 1}`
  }

  const active = battle.p2.active?.[0]
  const target = battle.p1.active?.[0]
  const moves = (request.moves || [])
    .map((move, index) => ({ move, index }))
    .filter(({ move }) => !move.disabled && (typeof move.pp !== 'number' || move.pp > 0))
  if (!moves.length) {
    const availableSwitches = battle.p2.pokemon
      .map((pokemon, index) => ({ pokemon, index }))
      .filter(({ pokemon }) => !pokemon.fainted && !pokemon.isActive)
    if (availableSwitches.length && !request.trapped) {
      const selectedSwitch = difficulty === 'easy'
        ? availableSwitches[randomIndex(availableSwitches.length, rng)]
        : availableSwitches[0]
      return `switch ${selectedSwitch.index + 1}`
    }

    const fallbackMoveIndex = (request.moves || []).findIndex((move) => !move.disabled)
    return fallbackMoveIndex >= 0 ? `move ${fallbackMoveIndex + 1}` : null
  }

  const scoredMoves = moves
    .map((entry) => ({
      ...entry,
      score: scoreTrainingMove(entry.move, active, target) + rng() * (difficulty === 'easy' ? 45 : 5),
    }))
    .sort((left, right) => right.score - left.score)

  if (difficulty === 'easy' && rng() < 0.42) {
    return `move ${moves[randomIndex(moves.length, rng)].index + 1}`
  }

  if (difficulty !== 'easy' && !request.trapped) {
    const reserves = battle.p2.pokemon
      .map((pokemon, index) => ({ pokemon, index }))
      .filter(({ pokemon }) => !pokemon.fainted && !pokemon.isActive)
    if (reserves.length) {
      const lastMove = battle.p1.active?.[0]?.lastMove
      const bestReserve = reserves.reduce((best, entry) =>
        scoreTrainingSwitch(entry.pokemon, target, lastMove) > scoreTrainingSwitch(best.pokemon, target, lastMove)
          ? entry
          : best,
      )
      const currentScore = scoreTrainingSwitch(active, target, lastMove)
      const switchThreshold = difficulty === 'hard' ? 12 : 34
      if (scoreTrainingSwitch(bestReserve.pokemon, target, lastMove) > currentScore + switchThreshold) {
        return `switch ${bestReserve.index + 1}`
      }
    }
  }

  const selected = scoredMoves[0]
  const useTerastallize = difficulty === 'hard' && Boolean(request.canTerastallize)
  const useZMove = difficulty === 'hard' && Boolean(request.canZMove?.[selected.index])
  const battleOption = useTerastallize ? ' terastallize' : useZMove ? ' zmove' : ''
  return `move ${selected.index + 1}${battleOption}`
}

const createBattleSet = (source, shiny) => createBattleTeam([{ ...source, shiny }])

const createBattle = ({ challenger, opponent, challengerTeam, opponentTeam, seed, formatId = FORMAT_ID }) => {
  const battle = new Battle({ formatid: formatId, seed })
  battle.setPlayer('p1', { name: challenger, team: challengerTeam })
  battle.setPlayer('p2', { name: opponent, team: opponentTeam })
  if (battle.requestState === 'teampreview') battle.makeChoices('team 1', 'team 1')
  return battle
}

const restoreBattle = (state) => Battle.fromJSON(state)

module.exports = {
  FORMAT_ID,
  PVP_FORMAT_ID,
  createBattle,
  createBattleTeam,
  createBattleSet,
  createTrainingTeam,
  chooseTrainingAction,
  hasTrainingActionRequest,
  getBattleMoveData,
  getBattleCry,
  getBattleSprites,
  initializeBattleEngine,
  restoreBattle,
}