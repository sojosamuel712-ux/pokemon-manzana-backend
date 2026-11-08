const { Dex } = require('pokemon-showdown');
const evolutionItemNames = require('./data/evolutionItemNames.json');

const normalizeEvolutionItemName = (name) => String(name || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]/g, '');

const getEvolutionDepth = (species, path = new Set()) => {
  if (!species?.exists || path.has(species.id)) return 0;

  const nextPath = new Set(path);
  nextPath.add(species.id);
  return 1 + Math.max(
    0,
    ...species.evos.map((name) => getEvolutionDepth(Dex.species.get(name), nextPath)),
  );
};

const getEvolutionRank = (species) => {
  let rank = 0;
  let current = species;
  const visited = new Set([species.id]);

  while (current.prevo) {
    const previous = Dex.species.get(current.prevo);
    if (!previous.exists || visited.has(previous.id)) break;
    visited.add(previous.id);
    rank += 1;
    current = previous;
  }

  return rank;
};

const getPokemonEvolution = (sourceName, targetName) => {
  const source = Dex.species.get(sourceName);
  const target = Dex.species.get(targetName);
  if (!source.exists || !target.exists) return null;

  const isDirectEvolution = source.evos.some((name) =>
    name.toLocaleLowerCase() === target.name.toLocaleLowerCase());
  if (!isDirectEvolution) return null;

  const isThreeStageLine = getEvolutionRank(source) + getEvolutionDepth(source) >= 3;
  const berryCost = isThreeStageLine && getEvolutionRank(source) === 0 ? 50 : 100;
  const itemOnlyEvolution = target.evoType === 'useItem' &&
    Boolean(target.evoItem) &&
    !target.evoCondition &&
    !target.evoLevel &&
    !target.evoMove;
  const itemId = normalizeEvolutionItemName(itemOnlyEvolution ? target.evoItem : '');

  return {
    source: source.name,
    target: target.name,
    cost: itemOnlyEvolution ? 0 : berryCost,
    requiredItem: itemOnlyEvolution ? target.evoItem : '',
    requiredItemAlias: evolutionItemNames[itemId] || '',
    targetAbility: Object.values(target.abilities)[0] || '',
  };
};

module.exports = {
  getPokemonEvolution,
  normalizeEvolutionItemName,
};
