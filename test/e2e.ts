// Live end-to-end check against the real YAZIO API through the built stdio server.
// Needs YAZIO_USERNAME/YAZIO_PASSWORD. Every write is undone and verified; test
// entries go to a day 35 days back so they never overlap with today's diary.
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { addDays, today } from '../src/dates.js';

const DAY = addDays(today(), -35);
const COLA = '97098498-1544-424b-8417-9946623435be'; // 0.2 kcal/ml, serving glass = 330 ml

async function connect(env: Record<string, string> = {}) {
  const client = new Client({ name: 'e2e', version: '0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ['dist/index.js'],
      env: { ...(process.env as Record<string, string>), ...env },
      stderr: 'ignore',
    })
  );
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const started = Date.now();
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { text: string }[])[0].text;
    if (result.isError) throw new Error(`${name} failed: ${text}`);
    console.log(`  ok  ${name} (${Date.now() - started} ms, ${text.length} chars)`);
    return JSON.parse(text);
  };
  return { client, call };
}

const { client, call } = await connect();
const cleanup: (() => Promise<unknown>)[] = [];

try {
  const { tools } = await client.listTools();
  console.log(`${tools.length} tools listed\n\nread tools:`);

  const profile = await call('get_profile');
  assert.ok(profile.profile.language && !('email' in profile.profile));
  await call('get_diary');
  const diary = await call('get_diary', { date: addDays(today(), -1) });
  assert.ok(diary.meals.breakfast && diary.totals);
  const summary = await call('get_daily_summary', { date: addDays(today(), -1) });
  assert.ok(summary.goals['energy.energy'] > 0);
  const goals = await call('get_goals');
  assert.ok(goals['energy.energy'] > 0);
  const history = await call('get_nutrition_history', {
    start: addDays(today(), -14),
    nutrients: ['nutrient.sugar', 'mineral.iron'],
  });
  assert.ok(history.days.length > 0 && 'kcal' in history.days[0]);
  await call('get_water_intake');
  await call('get_exercises', { date: addDays(today(), -1) });
  await call('get_body_values');
  const weights = await call('get_body_value_history', { type: 'weight' });
  assert.ok(weights.count > 0);
  await call('get_body_value_history', { type: 'ratio.fat', start: addDays(today(), -30) });
  const streak = await call('get_streak');
  assert.ok(streak.current_streak >= 0);
  const search = await call('search_products', { query: 'skyr', limit: 3 });
  assert.equal(search.results.length, 3);
  const barcode = await call('search_products', { query: '4270004341294' });
  assert.equal(barcode.results[0].product_id, COLA);
  const product = await call('get_product', { id: COLA });
  assert.equal(product.nutrients_per_100.kcal, 20);
  const suggested = await call('get_suggested_products', { daytime: 'lunch' });
  assert.ok(suggested.length > 0 && suggested.length <= 10 && suggested[0].name);
  const recipes = await call('search_recipes', { query: 'salat', limit: 2 });
  assert.ok(recipes.length > 0 && recipes[0].per_portion.kcal > 0);
  const mine = await call('get_my_recipes');
  await call('get_recipe', { id: recipes[0].id });

  console.log(`\nwrite round trips on ${DAY}:`);
  const diaryIds = async () =>
    Object.values(
      (await call('get_diary', { date: DAY })).meals as Record<
        string,
        { entries: { id: string }[] }
      >
    ).flatMap((m) => m.entries.map((e) => e.id));

  const food = await call('add_food_entry', {
    product_id: COLA,
    daytime: 'snack',
    serving: 'glass',
    date: DAY,
  });
  cleanup.push(() => call('remove_diary_entry', { id: food.id }));
  const quick = await call('add_quick_entry', {
    name: 'e2e quick entry',
    kcal: 123,
    protein_g: 4,
    daytime: 'snack',
    date: DAY,
  });
  cleanup.push(() => call('remove_diary_entry', { id: quick.id }));
  let recipeEntry: { id: string } | undefined;
  if (mine.length > 0) {
    recipeEntry = await call('add_recipe_entry', {
      recipe_id: mine[0].id,
      daytime: 'snack',
      date: DAY,
    });
    cleanup.push(() => call('remove_diary_entry', { id: recipeEntry!.id }));
  }
  const logged = await call('get_diary', { date: DAY });
  const snack = logged.meals.snack.entries as { id: string; nutrients: { kcal: number } }[];
  assert.equal(snack.find((e) => e.id === food.id)?.nutrients.kcal, 66);
  assert.equal(snack.find((e) => e.id === quick.id)?.nutrients.kcal, 123);
  if (recipeEntry) assert.ok(snack.some((e) => e.id === recipeEntry!.id));

  const weight = await call('add_body_value', {
    type: 'weight',
    value: 99.9,
    date: DAY,
    time: '06:01',
  });
  cleanup.push(() => call('remove_body_value', { id: weight.id }));
  const body = await call('get_body_values', { date: DAY });
  assert.ok(
    body.weight.some((w: { id: string; value: number }) => w.id === weight.id && w.value === 99.9)
  );

  const run = await call('add_exercise', {
    name: 'running',
    duration_min: 20,
    kcal: 200,
    distance_m: 3000,
    date: DAY,
  });
  cleanup.push(() => call('remove_exercise', { id: run.id }));
  const custom = await call('add_exercise', {
    name: 'e2e custom training',
    duration_min: 15,
    kcal: 50,
    date: DAY,
  });
  cleanup.push(() => call('remove_exercise', { id: custom.id }));
  const exercises = await call('get_exercises', { date: DAY });
  console.log(
    '      training as stored:',
    JSON.stringify(exercises.training.find((t: { id: string }) => t.id === run.id))
  );
  console.log(
    '      custom as stored:  ',
    JSON.stringify(exercises.custom_training.find((t: { id: string }) => t.id === custom.id))
  );
  assert.ok(exercises.training.some((t: { id: string }) => t.id === run.id));
  assert.ok(exercises.custom_training.some((t: { id: string }) => t.id === custom.id));

  const water = await call('add_water', { amount_ml: 250, date: DAY });
  cleanup.push(() => call('add_water', { total_ml: water.previous_ml, date: DAY }));
  assert.equal(
    (await call('get_water_intake', { date: DAY })).water_intake,
    water.previous_ml + 250
  );

  console.log('\ncleanup:');
  while (cleanup.length) await cleanup.pop()!();
  const after = await diaryIds();
  for (const id of [food.id, quick.id, recipeEntry?.id])
    assert.ok(!after.includes(id), `diary entry ${id} removed`);
  assert.ok(
    !(await call('get_body_values', { date: DAY })).weight?.some(
      (w: { id: string }) => w.id === weight.id
    )
  );
  const exAfter = await call('get_exercises', { date: DAY });
  assert.ok(
    ![...exAfter.training, ...exAfter.custom_training].some((t: { id: string }) =>
      [run.id, custom.id].includes(t.id)
    )
  );
  assert.equal((await call('get_water_intake', { date: DAY })).water_intake, water.previous_ml);
  console.log('  all test entries removed');
} finally {
  // Undo whatever is left if an assertion failed halfway.
  for (const undo of cleanup.reverse())
    await undo().catch((e) => console.error('CLEANUP FAILED', e));
  await client.close();
}

// A blocked API version must surface as a readable tool error, not a crash.
const blocked = await connect({ YAZIO_API_VERSION: 'v20' });
const result = await blocked.client.callTool({ name: 'get_diary', arguments: {} });
assert.ok(result.isError && /version_blocked/.test((result.content as { text: string }[])[0].text));
console.log('\nv20 without app user agent -> readable version_blocked error');
await blocked.client.close();
console.log('\nE2E PASSED');
