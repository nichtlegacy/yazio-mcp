// Drives the real MCP server through an in-memory MCP client against a fake YAZIO API.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { today } from '../src/dates.js';
import { registerTools } from '../src/tools.js';
import { YazioClient } from '../src/yazio.js';

const PRODUCT = '97098498-1544-424b-8417-9946623435be';

async function setup() {
  const posts: { path: string; body: unknown }[] = [];
  const deletes: { path: string; body: unknown }[] = [];
  let water = 500;
  const fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/v18/, '');
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const reply = (status: number, data?: unknown) =>
      new Response(data === undefined ? null : JSON.stringify(data), { status });
    if (path === '/oauth/token')
      return reply(200, { access_token: 'a', refresh_token: 'r', expires_in: 172800 });
    if (init.method === 'POST') {
      posts.push({ path, body });
      if (path === '/user/water-intake') water = body[0].water_intake;
      return reply(204);
    }
    if (init.method === 'DELETE') {
      deletes.push({ path, body });
      return reply(204);
    }
    switch (path) {
      case '/user':
        return reply(200, {
          language: 'de',
          country: 'TR',
          food_database_country: null,
          sex: 'male',
          email: 'x@y.z',
          user_token: 't',
          first_name: 'Jan',
        });
      case '/user/settings':
      case '/user/dietary-preferences':
        return reply(200, {});
      case `/products/${PRODUCT}`:
        return reply(200, {
          name: 'Cola Lemon',
          base_unit: 'ml',
          servings: [{ serving: 'glass', amount: 330 }],
          nutrients: { 'energy.energy': 0.2 },
        });
      case '/products/search':
        return reply(200, [
          {
            product_id: PRODUCT,
            name: 'Cola Lemon',
            producer: 'JUUZ',
            is_verified: false,
            base_unit: 'ml',
            serving: 'glass',
            serving_quantity: 1,
            amount: 330,
            nutrients: { 'energy.energy': 0.2 },
            query: url.search,
          },
        ]);
      case '/user/water-intake':
        return reply(200, { water_intake: water, gateway: null, source: null });
      case '/user/products/suggested':
        return reply(200, [
          { product_id: PRODUCT, amount: 330, serving: 'glass', serving_quantity: 1 },
          { product_id: PRODUCT, amount: 660, serving: 'glass', serving_quantity: 2 },
        ]);
      case '/user/streak':
        return reply(200, { '2026-09-01': { streak_count: 1 }, '2026-09-02': { streak_count: 2 } });
      default:
        return reply(404, null);
    }
  }) as typeof globalThis.fetch;

  const server = new McpServer({ name: 'test', version: '0' });
  registerTools(server, new YazioClient({ username: 'u', password: 'p', fetch }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0' });
  await client.connect(clientTransport);

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { type: string; text: string }[])[0].text;
    return {
      isError: Boolean(result.isError),
      text,
      data: result.isError ? undefined : JSON.parse(text),
    };
  };
  return { client, call, posts, deletes };
}

test('tools: list and profile privacy', async () => {
  const { client, call } = await setup();
  const { tools } = await client.listTools();
  assert.equal(tools.length, 25);
  for (const tool of tools) {
    assert.ok(tool.description && tool.annotations, `${tool.name} has description and annotations`);
  }
  const { data } = await call('get_profile');
  assert.equal(data.profile.first_name, 'Jan');
  assert.equal(data.profile.email, undefined);
  assert.equal(data.profile.user_token, undefined);
});

test('tools: add_food_entry calculates the amount from a serving', async () => {
  const { call, posts } = await setup();
  const { data } = await call('add_food_entry', {
    product_id: PRODUCT,
    daytime: 'lunch',
    serving: 'glass',
    serving_quantity: 2,
    date: '2026-09-01',
    time: '13:15',
  });
  assert.equal(data.amount, 660);
  assert.equal(data.nutrients.kcal, 132);
  const item = (posts[0].body as { products: Record<string, unknown>[] }).products[0];
  assert.deepEqual(
    { ...item, id: undefined },
    {
      id: undefined,
      product_id: PRODUCT,
      date: '2026-09-01 13:15:00',
      daytime: 'lunch',
      amount: 660,
      serving: 'glass',
      serving_quantity: 2,
    }
  );

  const missing = await call('add_food_entry', {
    product_id: PRODUCT,
    daytime: 'lunch',
    serving: 'slice',
  });
  assert.ok(missing.isError);
  assert.match(missing.text, /Options: glass \(330 ml\)/);
  const noAmount = await call('add_food_entry', { product_id: PRODUCT, daytime: 'lunch' });
  assert.match(noAmount.text, /Provide amount/);
});

test('tools: quick entry, water, exercise, body values', async () => {
  const { call, posts, deletes } = await setup();

  await call('add_quick_entry', {
    name: 'Brötchen',
    kcal: 478,
    protein_g: 20,
    daytime: 'breakfast',
    date: '2026-09-01',
  });
  assert.deepEqual(
    (posts[0].body as { simple_products: { nutrients: unknown; date: string }[] })
      .simple_products[0].nutrients,
    {
      'energy.energy': 478,
      'nutrient.protein': 20,
    }
  );

  assert.deepEqual((await call('add_water', { amount_ml: 250 })).data, {
    date: today(),
    previous_ml: 500,
    total_ml: 750,
  });
  assert.equal((await call('add_water', { total_ml: 100 })).data.total_ml, 100);
  assert.ok((await call('add_water', { amount_ml: 1, total_ml: 1 })).isError);

  await call('add_exercise', { name: 'Strength Training', duration_min: 60, kcal: 400 });
  await call('add_exercise', { name: 'Physiotherapie', duration_min: 30 });
  const exercises = posts
    .filter((p) => p.path === '/user/exercises')
    .map((p) => p.body as Record<string, { name: string }[]>);
  assert.equal(exercises[0].training[0].name, 'strengthtraining');
  assert.equal(exercises[1].custom_training[0].name, 'Physiotherapie');

  await call('add_body_value', { type: 'weight', value: 77.4, date: '2026-09-01', time: '07:00' });
  const weight = posts.at(-1)!.body as { weight: { value: number; date: string }[] };
  assert.equal(weight.weight[0].value, 77.4);
  assert.equal(weight.weight[0].date, '2026-09-01 07:00:00');
  assert.ok((await call('add_body_value', { type: 'bloodpressure', value: 120 })).isError);

  const id = '6750ba01-6532-47a5-be7d-51698e5518df';
  await call('remove_body_value', { id });
  await call('remove_exercise', { id });
  await call('remove_diary_entry', { id });
  assert.deepEqual(deletes, [
    { path: '/user/bodyvalues', body: [id] },
    { path: '/user/exercises/trainings', body: [id] },
    { path: '/user/consumed-items', body: [id] },
  ]);
});

test('tools: search uses the language market, streak filters days', async () => {
  const { call } = await setup();
  const search = await call('search_products', { query: 'cola' });
  assert.equal(search.data.country, 'DE');
  assert.deepEqual(search.data.results[0].nutrients_per_100, { kcal: 20 });

  const streak = await call('get_streak', { start: '2026-09-02', end: '2026-09-30' });
  assert.equal(streak.data.current_streak, 2);
  assert.deepEqual(Object.keys(streak.data.days), ['2026-09-02']);

  const suggested = await call('get_suggested_products', { daytime: 'lunch', limit: 1 });
  assert.deepEqual(suggested.data, [
    {
      product_id: PRODUCT,
      name: 'Cola Lemon',
      amount: 330,
      unit: 'ml',
      serving: 'glass',
      serving_quantity: 1,
      nutrients: { kcal: 66 },
    },
  ]);

  const bad = await call('get_diary', { date: '29.09.2026' });
  assert.ok(bad.isError);
});
