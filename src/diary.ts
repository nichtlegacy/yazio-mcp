// Turns the raw diary payload (ids only) into readable entries with nutrient totals.
// Product nutrients are per 1 g/ml of base unit, recipe nutrients are per portion,
// quick-entry (simple product) nutrients are absolute.

export type NutrientMap = Record<string, number>;

export interface Product {
  name: string;
  producer?: string | null;
  base_unit: 'g' | 'ml';
  nutrients: NutrientMap;
  servings?: { serving: string; amount: number }[];
}

export interface Recipe {
  name: string;
  portion_count: number;
  nutrients: NutrientMap;
}

export interface RawDiary {
  products: {
    id: string;
    date: string;
    daytime: string;
    product_id: string;
    amount: number;
    serving: string | null;
    serving_quantity: number | null;
  }[];
  recipe_portions: {
    id: string;
    date: string;
    daytime: string;
    recipe_id: string;
    portion_count: number;
  }[];
  simple_products: {
    id: string;
    date: string;
    daytime: string;
    name: string;
    nutrients: NutrientMap;
    is_ai_generated?: boolean;
  }[];
}

// Compact, human-readable projection of the nutrient keys people care about.
const SUMMARY_KEYS: Record<string, string> = {
  'energy.energy': 'kcal',
  'nutrient.protein': 'protein_g',
  'nutrient.carb': 'carbs_g',
  'nutrient.fat': 'fat_g',
  'nutrient.sugar': 'sugar_g',
  'nutrient.dietaryfiber': 'fiber_g',
  'nutrient.saturated': 'saturated_fat_g',
  'nutrient.salt': 'salt_g',
};

export type NutrientSummary = Partial<Record<string, number>>;

const round = (n: number) => Math.round(n * 100) / 100;

export function summarize(nutrients: NutrientMap | undefined, factor = 1): NutrientSummary {
  const out: NutrientSummary = {};
  for (const [key, label] of Object.entries(SUMMARY_KEYS)) {
    const value = nutrients?.[key];
    if (typeof value === 'number') out[label] = round(value * factor);
  }
  return out;
}

function add(total: NutrientSummary, part: NutrientSummary) {
  for (const [key, value] of Object.entries(part))
    total[key] = round((total[key] ?? 0) + (value ?? 0));
}

export interface DiaryEntry {
  id: string;
  type: 'product' | 'recipe_portion' | 'quick_entry';
  time: string;
  daytime: string;
  name: string;
  nutrients: NutrientSummary | null;
  [extra: string]: unknown;
}

export function buildDiary(
  raw: RawDiary,
  products: Map<string, Product | null>,
  recipes: Map<string, Recipe | null>
) {
  const entries: DiaryEntry[] = [];

  for (const item of raw.products ?? []) {
    const product = products.get(item.product_id);
    entries.push({
      id: item.id,
      type: 'product',
      time: item.date,
      daytime: item.daytime,
      name: product?.name ?? 'Unknown product',
      producer: product?.producer ?? undefined,
      product_id: item.product_id,
      amount: item.amount,
      unit: product?.base_unit,
      serving: item.serving ?? undefined,
      serving_quantity: item.serving_quantity ?? undefined,
      nutrients: product ? summarize(product.nutrients, item.amount) : null,
    });
  }

  for (const item of raw.recipe_portions ?? []) {
    const recipe = recipes.get(item.recipe_id);
    entries.push({
      id: item.id,
      type: 'recipe_portion',
      time: item.date,
      daytime: item.daytime,
      name: recipe?.name ?? 'Unknown recipe',
      recipe_id: item.recipe_id,
      portion_count: item.portion_count,
      nutrients: recipe ? summarize(recipe.nutrients, item.portion_count) : null,
    });
  }

  for (const item of raw.simple_products ?? []) {
    entries.push({
      id: item.id,
      type: 'quick_entry',
      time: item.date,
      daytime: item.daytime,
      name: item.name,
      ai_generated: item.is_ai_generated || undefined,
      nutrients: summarize(item.nutrients),
    });
  }

  entries.sort((a, b) => a.time.localeCompare(b.time));

  const meals: Record<string, { entries: DiaryEntry[]; totals: NutrientSummary }> = {};
  const totals: NutrientSummary = {};
  for (const daytime of ['breakfast', 'lunch', 'dinner', 'snack'])
    meals[daytime] = { entries: [], totals: {} };
  for (const entry of entries) {
    const meal = (meals[entry.daytime] ??= { entries: [], totals: {} });
    meal.entries.push(entry);
    if (entry.nutrients) {
      add(meal.totals, entry.nutrients);
      add(totals, entry.nutrients);
    }
  }
  return { totals, meals };
}
