/** Local dietary preferences, applied as FLAGS (never as a safety verdict). */
export const PREF_DEFAULTS = { vegan: false, glutenFree: false, lactoseFree: false, avoidIngredients: [], preferredFlavours: [], avoidFlavours: [] };
const norm = s => String(s ?? '').toLocaleLowerCase('it').normalize('NFD').replace(/[̀-ͯ]/g, '');

const MILK = ['latte', 'siero', 'caseina', 'caseinato', 'lattosio', 'whey', 'burro', 'panna', 'yogurt', 'formaggio'];
const ANIMAL = [...MILK, 'uovo', 'uova', 'albume', 'gelatina', 'collagene', 'carne', 'pesce', 'manzo', 'pollo', 'miele', 'carminio'];
const GLUTEN = ['glutine', 'frumento', 'grano', 'orzo', 'segale', 'avena', 'farro', 'kamut'];

export function mergePrefs(current, patch) {
  const p = { ...PREF_DEFAULTS, ...current };
  for (const [k, v] of Object.entries(patch ?? {})) if (k in PREF_DEFAULTS && v !== undefined) p[k] = Array.isArray(PREF_DEFAULTS[k]) ? [...new Set([...(p[k] ?? []), ...v.map(x => x.trim()).filter(Boolean)])] : Boolean(v);
  return p;
}
export function removePrefs(current, { keys = [], values = {} } = {}) {
  const p = { ...PREF_DEFAULTS, ...current };
  for (const k of keys) if (k in PREF_DEFAULTS) p[k] = PREF_DEFAULTS[k];
  for (const [k, list] of Object.entries(values)) if (Array.isArray(p[k])) p[k] = p[k].filter(x => !list.map(norm).includes(norm(x)));
  return p;
}

/** label: {ingredients, allergens[], mayContain[]} from prozis_nutrition. Returns conflicts and the data that was checked. */
export function checkAgainstPrefs(prefs, { name = '', flavour = '', label } = {}) {
  const conflicts = [], cautions = [];
  const text = norm([label?.ingredients, ...(label?.allergens ?? [])].join(' '));
  const may = norm((label?.mayContain ?? []).join(' '));
  const hit = words => words.filter(w => new RegExp(`\\b${w}`).test(text));
  if (prefs.lactoseFree && hit(MILK).length && !/senza lattosio|lactose.?free/.test(norm(name))) conflicts.push(`contiene derivati del latte (${hit(MILK).join(', ')})`);
  if (prefs.vegan && hit(ANIMAL).length) conflicts.push(`ingredienti di origine animale (${hit(ANIMAL).join(', ')})`);
  if (prefs.glutenFree) { if (hit(GLUTEN).length) conflicts.push(`glutine o cereali con glutine (${hit(GLUTEN).join(', ')})`); else if (GLUTEN.some(w => may.includes(w))) cautions.push('può contenere tracce di glutine'); }
  for (const a of prefs.avoidIngredients ?? []) { const w = norm(a); if (w && text.includes(w)) conflicts.push(`contiene "${a}"`); else if (w && may.includes(w)) cautions.push(`può contenere tracce di "${a}"`); }
  if ((prefs.avoidFlavours ?? []).some(f => norm(flavour).includes(norm(f)))) conflicts.push(`gusto da evitare (${flavour})`);
  const preferredFlavour = (prefs.preferredFlavours ?? []).some(f => flavour && norm(flavour).includes(norm(f)));
  return { conflicts, cautions, preferredFlavour, dataChecked: Boolean(label?.ingredients),
    note: label?.ingredients ? 'Controllo automatico sugli ingredienti dichiarati: non è una garanzia, verifica sempre l\'etichetta.' : 'Ingredienti non disponibili in questa vista: usa prozis_nutrition per il controllo.' };
}
