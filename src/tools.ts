import { randomUUID } from 'node:crypto';
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { addDays, orderedRange, toApiDateTime, today } from './dates.js';
import {
  buildDiary,
  summarize,
  type NutrientMap,
  type Product,
  type RawDiary,
  type Recipe,
} from './diary.js';
import type { YazioClient } from './yazio.js';
import { YazioError } from './yazio.js';

const DateArg = z.iso
  .date()
  .optional()
  .describe('Day as YYYY-MM-DD in local time. Defaults to today.');
const TimeArg = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/)
  .optional()
  .describe('Local time HH:MM. Defaults to now for today, otherwise a typical time for the meal.');
const Daytime = z
  .enum(['breakfast', 'lunch', 'dinner', 'snack'])
  .describe('Meal: breakfast, lunch, dinner or snack');
const Id = (what: string) => z.uuid().describe(`${what} (UUID)`);

// Verified: the only body value types the API accepts for writes.
const BODY_VALUE_TYPES = [
  'weight',
  'ratio.fat',
  'ratio.muscle',
  'circumference.waist',
  'circumference.hip',
  'circumference.chest',
  'circumference.thigh',
  'circumference.arm',
  'glucoselevel',
  'bloodpressure',
] as const;

// Verified training names; anything else is logged as a custom training.
// ponytail: probed subset of YAZIO's catalogue, extend when a name is missing.
const TRAININGS = new Set([
  'walking',
  'running',
  'cycling',
  'swimming',
  'strengthtraining',
  'yoga',
  'pilates',
  'hiking',
  'rowing',
  'football',
  'soccer',
  'basketball',
  'tennis',
  'badminton',
  'volleyball',
  'climbing',
  'skiing',
  'snowboarding',
  'inlineskating',
  'hiit',
  'crosstrainer',
  'stretching',
  'golf',
  'handball',
  'hockey',
  'icehockey',
  'martialarts',
  'kickboxing',
  'squash',
  'zumba',
  'gymnastics',
  'mountainbiking',
  'nordicwalking',
  'stairclimbing',
  'treadmill',
  'functionaltraining',
  'surfing',
  'sailing',
  'canoeing',
  'kayaking',
  'trampoline',
  'rugby',
  'baseball',
  'waterpolo',
  'calisthenics',
]);

// Product search needs a country; the profile country is where the account was
// created, which is often not the food market, so the app language decides.
const LANGUAGE_COUNTRY: Record<string, string> = {
  de: 'DE',
  en: 'US',
  fr: 'FR',
  es: 'ES',
  it: 'IT',
  pt: 'PT',
  nl: 'NL',
  pl: 'PL',
  tr: 'TR',
  ru: 'RU',
  sv: 'SE',
  da: 'DK',
  nb: 'NO',
  fi: 'FI',
  cs: 'CZ',
  hu: 'HU',
  ro: 'RO',
  el: 'GR',
  ja: 'JP',
  ko: 'KR',
};

// Credentials and payment identifiers are never handed to the model.
const PRIVATE_USER_FIELDS = new Set(['user_token', 'email', 'stripe_customer_id', 'siwa_user_id']);

interface User {
  language: string;
  country: string | null;
  food_database_country: string | null;
  sex: 'male' | 'female';
  [key: string]: unknown;
}

const json = (data: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data) }],
});
const READ = { readOnlyHint: true, idempotentHint: true, openWorldHint: true };
const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};
const DELETE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
};

export function registerTools(server: McpServer, yazio: YazioClient): void {
  // Catalogue entries practically never change, so they are cached for the session.
  // ponytail: unbounded per-process cache, fine for a stdio server; add an LRU if it ever runs long-lived.
  const products = new Map<string, Promise<Product | null>>();
  const recipes = new Map<string, Promise<(Recipe & Record<string, unknown>) | null>>();
  let userPromise: Promise<User> | null = null;

  const getUser = () =>
    (userPromise ??= yazio
      .get<User>('/user')
      .catch((e) => ((userPromise = null), Promise.reject(e))));
  const cached = <T>(cache: Map<string, Promise<T | null>>, id: string, load: () => Promise<T>) => {
    if (!cache.has(id)) {
      cache.set(
        id,
        load().catch((e) => {
          cache.delete(id);
          if (e instanceof YazioError && (e.status === 404 || e.status === 405)) return null;
          throw e;
        })
      );
    }
    return cache.get(id)!;
  };
  const getProduct = (id: string) =>
    cached(products, id, () => yazio.get<Product>(`/products/${id}`));
  const getRecipe = (id: string) =>
    cached(recipes, id, () => yazio.get<Recipe & Record<string, unknown>>(`/recipes/${id}`));
  const market = async (country?: string) => {
    const user = await getUser();
    const c = (
      country ??
      user.food_database_country ??
      LANGUAGE_COUNTRY[user.language] ??
      user.country ??
      'US'
    ).toUpperCase();
    return { country: c, locale: `${user.language}_${c}`, sex: user.sex };
  };
  const recipeSummary = (id: string, r: Recipe & Record<string, unknown>) => ({
    id,
    name: r.name,
    portion_count: r.portion_count,
    preparation_time_min: r.preparation_time,
    difficulty: r.difficulty,
    own_recipe: r.is_yazio_recipe === false,
    per_portion: summarize(r.nutrients),
  });

  // ---- Profile ----------------------------------------------------------------

  server.registerTool(
    'get_profile',
    {
      title: 'Get profile',
      description:
        'YAZIO profile (sex, birth date, height, start weight, goal, diet split, units, language), app settings and dietary preferences.',
      inputSchema: z.object({}),
      annotations: READ,
    },
    async () => {
      const [user, settings, dietary_preferences] = await Promise.all([
        getUser(),
        yazio.get('/user/settings'),
        yazio.get('/user/dietary-preferences'),
      ]);
      const profile = Object.fromEntries(
        Object.entries(user).filter(([key]) => !PRIVATE_USER_FIELDS.has(key))
      );
      return json({ profile, settings, dietary_preferences });
    }
  );

  // ---- Diary --------------------------------------------------------------------

  server.registerTool(
    'get_diary',
    {
      title: 'Get food diary',
      description:
        'All food logged on a day, grouped by meal, with names and calculated nutrients per entry, per meal and for the day. ' +
        'Entry ids are needed for remove_diary_entry.',
      inputSchema: z.object({ date: DateArg }),
      annotations: READ,
    },
    async ({ date = today() }) => {
      const raw = await yazio.get<RawDiary>('/user/consumed-items', { date });
      const productIds = [...new Set(raw.products.map((p) => p.product_id))];
      const recipeIds = [...new Set(raw.recipe_portions.map((r) => r.recipe_id))];
      const productMap = new Map(
        await Promise.all(productIds.map(async (id) => [id, await getProduct(id)] as const))
      );
      const recipeMap = new Map(
        await Promise.all(recipeIds.map(async (id) => [id, await getRecipe(id)] as const))
      );
      return json({ date, ...buildDiary(raw, productMap, recipeMap) });
    }
  );

  server.registerTool(
    'get_daily_summary',
    {
      title: 'Get daily summary',
      description:
        "The app's day overview: calories and macros per meal with per-meal energy goals, steps, activity energy, water and goals. " +
        'Here goals["energy.energy"] already includes burned activity calories when consume_activity_energy is true; ' +
        'get_goals returns the base goal.',
      inputSchema: z.object({ date: DateArg }),
      annotations: READ,
    },
    async ({ date = today() }) => json(await yazio.get('/user/widgets/daily-summary', { date }))
  );

  server.registerTool(
    'get_goals',
    {
      title: 'Get goals',
      description:
        'Base daily goals for a day: energy (kcal), protein/fat/carbs (g), steps, target weight (kg) and water (ml). ' +
        'Activity calories are not included (see get_daily_summary).',
      inputSchema: z.object({ date: DateArg }),
      annotations: READ,
    },
    async ({ date = today() }) => json(await yazio.get('/user/goals', { date }))
  );

  server.registerTool(
    'get_nutrition_history',
    {
      title: 'Get nutrition history',
      description:
        'Calories, macros and calorie goal per day for a date range in one request. Only days with logged food are returned. ' +
        'Optionally add more nutrients by key, e.g. nutrient.sugar, nutrient.dietaryfiber, nutrient.salt, nutrient.saturated, ' +
        'mineral.iron, mineral.calcium, vitamin.c (values in grams). Unknown keys return no data rather than an error.',
      inputSchema: z.object({
        start: DateArg.describe('First day (YYYY-MM-DD). Defaults to 6 days before end.'),
        end: DateArg.describe('Last day (YYYY-MM-DD). Defaults to today.'),
        nutrients: z
          .array(z.string().regex(/^[a-z]+\.[a-z0-9]+$/))
          .max(20)
          .optional()
          .describe('Extra nutrient keys'),
      }),
      annotations: READ,
    },
    async ({ start, end = today(), nutrients = [] }) => {
      const [from, to] = orderedRange(start ?? addDays(end, -6), end);
      const days = await yazio.get<
        {
          date: string;
          energy: number;
          carb: number;
          protein: number;
          fat: number;
          energy_goal: number;
        }[]
      >('/user/consumed-items/nutrients-daily', { start: from, end: to });
      const rows = new Map(
        days.map((d) => [
          d.date,
          {
            date: d.date,
            kcal: round(d.energy),
            kcal_goal: round(d.energy_goal),
            protein_g: round(d.protein),
            carbs_g: round(d.carb),
            fat_g: round(d.fat),
          } as Record<string, number | string>,
        ])
      );
      for (const nutrient of nutrients) {
        const values = await yazio.get<Record<string, number>>(
          '/user/consumed-items/specific-nutrient-daily',
          {
            start: from,
            end: to,
            nutrient,
          }
        );
        for (const [date, value] of Object.entries(values)) {
          const row = rows.get(date) ?? rows.set(date, { date }).get(date)!;
          row[nutrient] = Math.round(value * 1e6) / 1e6;
        }
      }
      return json({
        start: from,
        end: to,
        days: [...rows.values()].sort((a, b) => String(a.date).localeCompare(String(b.date))),
      });
    }
  );

  server.registerTool(
    'add_food_entry',
    {
      title: 'Log food',
      description:
        'Log a product from the YAZIO database (find it with search_products). Give either amount in the base unit (g or ml), ' +
        'or a serving name from get_product (e.g. "piece", "portion") plus serving_quantity; the amount is then calculated.',
      inputSchema: z.object({
        product_id: Id('Product id from search_products'),
        daytime: Daytime,
        amount: z.number().positive().optional().describe('Amount in base unit (g or ml)'),
        serving: z.string().optional().describe('Serving name from get_product servings'),
        serving_quantity: z
          .number()
          .positive()
          .optional()
          .describe('Number of servings, default 1'),
        date: DateArg,
        time: TimeArg,
      }),
      annotations: WRITE,
    },
    async ({ product_id, daytime, amount, serving, serving_quantity, date = today(), time }) => {
      const product = await getProduct(product_id);
      if (!product) throw new Error(`Product ${product_id} not found`);
      if (amount === undefined) {
        if (!serving) throw new Error('Provide amount (g/ml) or a serving');
        const match = product.servings?.find((s) => s.serving === serving);
        if (!match) {
          const available = product.servings
            ?.map((s) => `${s.serving} (${s.amount} ${product.base_unit})`)
            .join(', ');
          throw new Error(
            `Serving "${serving}" not available. Options: ${available || 'none, use amount'}`
          );
        }
        amount = round(match.amount * (serving_quantity ?? 1));
      }
      const id = randomUUID();
      await yazio.post('/user/consumed-items', {
        products: [
          {
            id,
            product_id,
            date: toApiDateTime(date, time, daytime),
            daytime,
            amount,
            serving: serving ?? null,
            serving_quantity: serving ? (serving_quantity ?? 1) : null,
          },
        ],
      });
      return json({
        logged: true,
        id,
        name: product.name,
        amount,
        unit: product.base_unit,
        daytime,
        date,
        nutrients: summarize(product.nutrients, amount),
      });
    }
  );

  server.registerTool(
    'add_quick_entry',
    {
      title: 'Quick-log calories',
      description:
        'Log a meal by name and nutrient values only, without a database product (YAZIO "quick add"). ' +
        'Use when the food is not in the database or only calories/macros are known. Values are totals for the whole entry.',
      inputSchema: z.object({
        name: z
          .string()
          .min(1)
          .max(200)
          .describe('What was eaten, e.g. "2 bread rolls with salami"'),
        kcal: z.number().nonnegative().describe('Total energy in kcal'),
        protein_g: z.number().nonnegative().optional(),
        carbs_g: z.number().nonnegative().optional(),
        fat_g: z.number().nonnegative().optional(),
        daytime: Daytime,
        date: DateArg,
        time: TimeArg,
      }),
      annotations: WRITE,
    },
    async ({ name, kcal, protein_g, carbs_g, fat_g, daytime, date = today(), time }) => {
      const nutrients: NutrientMap = { 'energy.energy': kcal };
      if (protein_g !== undefined) nutrients['nutrient.protein'] = protein_g;
      if (carbs_g !== undefined) nutrients['nutrient.carb'] = carbs_g;
      if (fat_g !== undefined) nutrients['nutrient.fat'] = fat_g;
      const id = randomUUID();
      await yazio.post('/user/consumed-items', {
        simple_products: [
          { id, date: toApiDateTime(date, time, daytime), daytime, name, nutrients },
        ],
      });
      return json({ logged: true, id, name, daytime, date, nutrients: summarize(nutrients) });
    }
  );

  server.registerTool(
    'add_recipe_entry',
    {
      title: 'Log recipe portions',
      description:
        'Log portions of a recipe (from get_my_recipes or search_recipes). Recipe nutrients are per portion.',
      inputSchema: z.object({
        recipe_id: Id('Recipe id'),
        portion_count: z.number().positive().default(1).describe('Number of portions, default 1'),
        daytime: Daytime,
        date: DateArg,
        time: TimeArg,
      }),
      annotations: WRITE,
    },
    async ({ recipe_id, portion_count, daytime, date = today(), time }) => {
      const recipe = await getRecipe(recipe_id);
      if (!recipe) throw new Error(`Recipe ${recipe_id} not found`);
      const id = randomUUID();
      await yazio.post('/user/consumed-items', {
        recipe_portions: [
          { id, date: toApiDateTime(date, time, daytime), daytime, recipe_id, portion_count },
        ],
      });
      return json({
        logged: true,
        id,
        name: recipe.name,
        portion_count,
        daytime,
        date,
        nutrients: summarize(recipe.nutrients, portion_count),
      });
    }
  );

  server.registerTool(
    'remove_diary_entry',
    {
      title: 'Remove diary entry',
      description:
        'Delete a food, recipe or quick entry from the diary. Use the entry id from get_diary (not the product id).',
      inputSchema: z.object({ id: Id('Diary entry id from get_diary') }),
      annotations: DELETE,
    },
    async ({ id }) => {
      await yazio.delete('/user/consumed-items', [id]);
      return json({ removed: true, id });
    }
  );

  // ---- Water --------------------------------------------------------------------

  server.registerTool(
    'get_water_intake',
    {
      title: 'Get water intake',
      description: 'Water drunk on a day in ml.',
      inputSchema: z.object({ date: DateArg }),
      annotations: READ,
    },
    async ({ date = today() }) => json(await yazio.get('/user/water-intake', { date }))
  );

  server.registerTool(
    'add_water',
    {
      title: 'Log water',
      description:
        'Change the water intake of a day. amount_ml adds to (or, if negative, subtracts from) the current total; ' +
        'total_ml sets the day total directly.',
      inputSchema: z
        .object({
          amount_ml: z.number().optional().describe('Amount to add in ml, e.g. 250'),
          total_ml: z.number().nonnegative().optional().describe('New total for the day in ml'),
          date: DateArg,
          time: TimeArg,
        })
        .refine(
          (a) => (a.amount_ml === undefined) !== (a.total_ml === undefined),
          'Provide either amount_ml or total_ml'
        ),
      annotations: WRITE,
    },
    async ({ amount_ml, total_ml, date = today(), time }) => {
      const current = await yazio.get<{ water_intake: number }>('/user/water-intake', { date });
      const total = Math.max(0, total_ml ?? current.water_intake + (amount_ml ?? 0));
      // The API stores the cumulative day total, not individual drinks.
      await yazio.post('/user/water-intake', [
        { date: toApiDateTime(date, time), water_intake: total },
      ]);
      return json({ date, previous_ml: current.water_intake, total_ml: total });
    }
  );

  // ---- Activity -----------------------------------------------------------------

  server.registerTool(
    'get_exercises',
    {
      title: 'Get exercises',
      description:
        'Trainings, custom trainings and daily activity (steps, distance in m, energy in kcal) of a day. ' +
        'Training duration is in minutes, distance in meters; gateway shows the source such as apple_health.',
      inputSchema: z.object({ date: DateArg }),
      annotations: READ,
    },
    async ({ date = today() }) => json(await yazio.get('/user/exercises', { date }))
  );

  server.registerTool(
    'add_exercise',
    {
      title: 'Log exercise',
      description:
        'Log a training. Known names are logged as standard trainings: ' +
        [...TRAININGS].join(', ') +
        '. Any other name is logged as a custom training.',
      inputSchema: z.object({
        name: z.string().min(1).max(100).describe('Training name, e.g. running or "Physiotherapy"'),
        duration_min: z.number().int().positive().describe('Duration in minutes'),
        kcal: z.number().nonnegative().optional().describe('Burned energy in kcal'),
        distance_m: z.number().nonnegative().optional().describe('Distance in meters'),
        steps: z.number().int().nonnegative().optional(),
        note: z.string().max(500).optional(),
        date: DateArg,
        time: TimeArg,
      }),
      annotations: WRITE,
    },
    async ({ name, duration_min, kcal, distance_m, steps, note, date = today(), time }) => {
      const key = name.toLowerCase().replace(/[\s_-]/g, '');
      const kind = TRAININGS.has(key) ? 'training' : 'custom_training';
      const id = randomUUID();
      await yazio.post('/user/exercises', {
        [kind]: [
          {
            id,
            name: kind === 'training' ? key : name,
            date: toApiDateTime(date, time),
            duration: duration_min,
            energy: kcal ?? 0,
            distance: distance_m ?? 0,
            steps: steps ?? 0,
            note: note ?? null,
          },
        ],
      });
      return json({ logged: true, id, kind, name: kind === 'training' ? key : name, date });
    }
  );

  server.registerTool(
    'remove_exercise',
    {
      title: 'Remove exercise',
      description: 'Delete a training or custom training by its id from get_exercises.',
      inputSchema: z.object({ id: Id('Training id') }),
      annotations: DELETE,
    },
    async ({ id }) => {
      await yazio.delete(`/user/exercises/${id}`);
      return json({ removed: true, id });
    }
  );

  // ---- Body values ----------------------------------------------------------------

  const BodyType = z
    .enum(BODY_VALUE_TYPES)
    .describe(
      'weight (kg), ratio.fat / ratio.muscle (%), circumference.* (cm), glucoselevel, bloodpressure'
    );

  server.registerTool(
    'get_body_values',
    {
      title: 'Get body values',
      description:
        'All body values logged on a day (weight, body fat, circumferences, …) with ids, grouped by type.',
      inputSchema: z.object({ date: DateArg }),
      annotations: READ,
    },
    async ({ date = today() }) => json(await yazio.get('/user/bodyvalues', { date }))
  );

  server.registerTool(
    'get_body_value_history',
    {
      title: 'Get body value history',
      description:
        'History of one body value type over a date range, newest first. Defaults to the full history.',
      inputSchema: z.object({
        type: BodyType.default('weight'),
        start: DateArg.describe('First day (YYYY-MM-DD). Defaults to the beginning.'),
        end: DateArg.describe('Last day (YYYY-MM-DD). Defaults to today.'),
      }),
      annotations: READ,
    },
    async ({ type, start = '2000-01-01', end = today() }) => {
      const [from, to] = orderedRange(start, end);
      const values = await yazio.get<unknown[]>(`/user/bodyvalues/${type}`, {
        start: from,
        end: to,
      });
      return json({ type, start: from, end: to, count: values.length, values });
    }
  );

  server.registerTool(
    'add_body_value',
    {
      title: 'Log body value',
      description:
        'Log a body value, e.g. weight in kg. For bloodpressure give systolic and diastolic instead of value.',
      inputSchema: z
        .object({
          type: BodyType,
          value: z.number().positive().optional().describe('Value in the unit of the type'),
          systolic: z.number().positive().optional(),
          diastolic: z.number().positive().optional(),
          date: DateArg,
          time: TimeArg,
        })
        .refine(
          (a) =>
            a.type === 'bloodpressure'
              ? a.systolic !== undefined && a.diastolic !== undefined
              : a.value !== undefined,
          'Provide value, or systolic and diastolic for bloodpressure'
        ),
      annotations: WRITE,
    },
    async ({ type, value, systolic, diastolic, date = today(), time }) => {
      const id = randomUUID();
      const entry =
        type === 'bloodpressure'
          ? { id, date: toApiDateTime(date, time), systolic, diastolic }
          : { id, date: toApiDateTime(date, time), value };
      await yazio.post('/user/bodyvalues', { [type]: [entry] });
      return json({ logged: true, type, ...entry });
    }
  );

  server.registerTool(
    'remove_body_value',
    {
      title: 'Remove body value',
      description: 'Delete a body value entry by its id from get_body_values.',
      inputSchema: z.object({ id: Id('Body value id') }),
      annotations: DELETE,
    },
    async ({ id }) => {
      await yazio.delete('/user/bodyvalues', [id]);
      return json({ removed: true, id });
    }
  );

  server.registerTool(
    'get_streak',
    {
      title: 'Get streak',
      description:
        'Current logging streak and, per day, which meals were logged. Defaults to the last 30 days.',
      inputSchema: z.object({
        start: DateArg.describe('First day (YYYY-MM-DD). Defaults to 29 days before end.'),
        end: DateArg.describe('Last day (YYYY-MM-DD). Defaults to today.'),
      }),
      annotations: READ,
    },
    async ({ start, end = today() }) => {
      const [from, to] = orderedRange(start ?? addDays(end, -29), end);
      // The endpoint ignores parameters and always returns the whole history.
      const all = await yazio.get<Record<string, { streak_count: number }>>('/user/streak');
      const dates = Object.keys(all).sort();
      const last = dates.at(-1);
      const days = Object.fromEntries(
        dates.filter((d) => d >= from && d <= to).map((d) => [d, all[d]])
      );
      return json({
        current_streak: last ? all[last].streak_count : 0,
        last_logged_day: last ?? null,
        days,
      });
    }
  );

  // ---- Food & recipe catalogue ---------------------------------------------------

  server.registerTool(
    'search_products',
    {
      title: 'Search products',
      description:
        'Search the YAZIO food database by name, brand or barcode (EAN). Results show nutrients per 100 g/ml and the default serving. ' +
        'Country defaults to the food market of the profile language.',
      inputSchema: z.object({
        query: z.string().min(1).describe('Food name, brand or EAN barcode'),
        limit: z.number().int().min(1).max(50).default(10),
        country: z
          .string()
          .length(2)
          .optional()
          .describe('ISO country of the food market, e.g. DE, AT, US'),
      }),
      annotations: READ,
    },
    async ({ query, limit, country }) => {
      const m = await market(country);
      const results = await yazio.get<
        {
          product_id: string;
          name: string;
          producer: string | null;
          is_verified: boolean;
          base_unit: string;
          serving: string;
          serving_quantity: number;
          amount: number;
          nutrients: NutrientMap;
        }[]
      >('/products/search', { query, countries: m.country, locales: m.locale, sex: m.sex });
      return json({
        country: m.country,
        results: results.slice(0, limit).map((p) => ({
          product_id: p.product_id,
          name: p.name,
          producer: p.producer ?? undefined,
          verified: p.is_verified,
          unit: p.base_unit,
          nutrients_per_100: summarize(p.nutrients, 100),
          default_serving: { serving: p.serving, quantity: p.serving_quantity, amount: p.amount },
        })),
      });
    }
  );

  server.registerTool(
    'get_product',
    {
      title: 'Get product',
      description:
        'Full product details: servings (name and amount in g/ml), base unit, barcodes, category and all nutrients. ' +
        'Raw nutrients are per 1 g/ml of the base unit (energy in kcal, others in g); nutrients_per_100 is a readable summary.',
      inputSchema: z.object({ id: Id('Product id') }),
      annotations: READ,
    },
    async ({ id }) => {
      const product = await getProduct(id);
      if (!product) throw new Error(`Product ${id} not found`);
      return json({ id, ...product, nutrients_per_100: summarize(product.nutrients, 100) });
    }
  );

  server.registerTool(
    'get_suggested_products',
    {
      title: 'Get suggested products',
      description:
        'Products YAZIO suggests for a meal, based on what the user usually eats at that time.',
      inputSchema: z.object({ daytime: Daytime, date: DateArg }),
      annotations: READ,
    },
    async ({ daytime, date = today() }) =>
      json(await yazio.get('/user/products/suggested', { date, daytime }))
  );

  server.registerTool(
    'search_recipes',
    {
      title: 'Search recipes',
      description:
        'Search YAZIO recipes by name. Returns name, portions, preparation time and nutrients per portion.',
      inputSchema: z.object({
        query: z.string().min(1),
        limit: z.number().int().min(1).max(20).default(5),
      }),
      annotations: READ,
    },
    async ({ query, limit }) => {
      const m = await market();
      const ids = await yazio.get<string[]>('/recipes/search', {
        query,
        locale: m.locale,
        size: limit,
      });
      const found = await Promise.all(ids.map(async (id) => [id, await getRecipe(id)] as const));
      return json(found.filter(([, r]) => r).map(([id, r]) => recipeSummary(id, r!)));
    }
  );

  server.registerTool(
    'get_my_recipes',
    {
      title: 'Get my recipes',
      description: "The user's own and saved recipes with nutrients per portion.",
      inputSchema: z.object({}),
      annotations: READ,
    },
    async () => {
      const ids = await yazio.get<string[]>('/user/recipes');
      const found = await Promise.all(ids.map(async (id) => [id, await getRecipe(id)] as const));
      return json(found.filter(([, r]) => r).map(([id, r]) => recipeSummary(id, r!)));
    }
  );

  server.registerTool(
    'get_recipe',
    {
      title: 'Get recipe',
      description:
        'Full recipe: ingredients (servings), instructions, tags and all nutrients per portion.',
      inputSchema: z.object({ id: Id('Recipe id') }),
      annotations: READ,
    },
    async ({ id }) => {
      const recipe = await getRecipe(id);
      if (!recipe) throw new Error(`Recipe ${id} not found`);
      return json({ ...recipe, per_portion: summarize(recipe.nutrients) });
    }
  );
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
