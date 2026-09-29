# YAZIO API notes

YAZIO has no public API. This server talks to the private API of the mobile app at
`https://yzapi.yazio.com`. Everything below was verified against a real account
(Pro, about two months of data) between 2026-07-30 and 2026-09-29. It can break
without notice.

## Versions and authentication

| Version | Behaviour |
|---|---|
| `v15`–`v19` | 200, identical payloads |
| `v20`–`v22` | `403 {"error":"version_blocked"}` **unless** an app User-Agent is sent (`YAZIO/12.89.0 (com.yazio.android; …)`); with it 200 and identical payloads |
| `v23`+ | 410 Gone |

The server uses `v18` without spoofing a User-Agent (`YAZIO_API_VERSION` overrides it).
A `version_blocked` answer is reported as a readable tool error.

- OAuth2 password grant and refresh grant on `POST /{v}/oauth/token` with the app's
  static client id/secret. Tokens live 48 h (`expires_in: 172800`).
- The refresh grant rotates **both** tokens.
- Validation errors are Symfony arrays: `[{"property_path": "date", "message": "…"}]`.
  Other errors are objects or `null`. A non-UUID on a UUID route answers 405, an
  unknown UUID 404, a reversed date range 500.
- No rate-limit headers; 40 serial requests at ~16 req/s were not throttled.

## Timestamps

Timestamps are local user time without a zone (`YYYY-MM-DD HH:MM:SS`); date
parameters are strictly `YYYY-MM-DD`. The server therefore uses the machine's local
time zone for "today" and "now".

## Read endpoints

| Endpoint | Notes |
|---|---|
| `GET /user` | Profile. `country` is the registration country, not the food market |
| `GET /user/settings`, `/user/dietary-preferences` | |
| `GET /user/consumed-items?date=` | `{products, recipe_portions, simple_products}`, ids only |
| `GET /user/consumed-items/nutrients-daily?start=&end=` | kcal, macros and `energy_goal` per day with data, one request for any range |
| `GET /user/consumed-items/specific-nutrient-daily?start=&end=&nutrient=` | `{date: value}`; does not validate the key, unknown keys give `{}` |
| `GET /user/widgets/daily-summary?date=` | Meals, steps, water, goals; `goals["energy.energy"]` includes activity calories |
| `GET /user/goals?date=` | Base goals (`/user/goals/unmodified` is identical) |
| `GET /user/water-intake?date=` | Cumulative ml |
| `GET /user/exercises?date=` | `training`, `custom_training`, `activity`; duration in minutes, distance in meters |
| `GET /user/bodyvalues?date=` | All body values of a day with ids, keyed by type |
| `GET /user/bodyvalues/{type}?start=&end=` | `[{date, value}]`, newest first; does not validate the type |
| `GET /user/bodyvalues/weight/last?date=` | Only works for `weight` |
| `GET /user/streak` | Whole history, parameters are ignored |
| `GET /user/products/suggested?date=&daytime=` | ~160 `{product_id, amount, serving, serving_quantity}` |
| `GET /user/recipes` | Recipe ids |
| `GET /products/{id}` | No `id` field in the response; nutrients per 1 g/ml |
| `GET /products/search?query=&countries=&locales=&sex=` | `countries` is required; EAN barcodes work as query |
| `GET /recipes/{id}` | Nutrients per portion; `servings` are ingredients |
| `GET /recipes/search?query=&locale=&size=` | Returns recipe ids only |

Nutrient units: energy in kcal, everything else in grams. Product nutrients are per
1 g/ml of `base_unit`, recipe nutrients per portion, quick-entry nutrients absolute.
Verified: 330 ml × 0.2 kcal/ml = 66 kcal, equal to `nutrients-daily` and the summary.

## Write endpoints

| Endpoint | Body |
|---|---|
| `POST /user/consumed-items` | `{"products": [{id, product_id, date, daytime, amount, serving, serving_quantity}]}` |
| | `{"simple_products": [{id, date, daytime, name, nutrients}]}` — `energy.energy` required |
| | `{"recipe_portions": [{id, date, daytime, recipe_id, portion_count}]}` |
| `DELETE /user/consumed-items` | `[id]`, works for all three entry types |
| `POST /user/water-intake` | `[{date, water_intake}]`, cumulative day total |
| `POST /user/bodyvalues` | `{"<type>": [{id, date, value}]}`; `bloodpressure` uses `systolic`, `diastolic` |
| `DELETE /user/bodyvalues` | `[id]` |
| `POST /user/exercises` | `{"training": [{id, name, date, duration, energy, distance, steps, note}]}` or `custom_training` with a free name |
| `DELETE /user/exercises/trainings` | `[id]`, for standard and custom trainings |

Ids are client-generated UUID v4. A body without known keys answers 201 and creates
nothing.

Body value types accepted for writes: `weight`, `ratio.fat`, `ratio.muscle`,
`circumference.waist`, `circumference.hip`, `circumference.chest`,
`circumference.thigh`, `circumference.arm`, `glucoselevel`, `bloodpressure`.

Standard training names are validated (`"bogus" does not represent a valid training`).
Confirmed: walking, running, cycling, swimming, strengthtraining, yoga, pilates,
hiking, rowing, football, soccer, basketball, tennis, badminton, volleyball, climbing,
skiing, snowboarding, inlineskating, hiit, crosstrainer, stretching, golf, handball,
hockey, icehockey, martialarts, kickboxing, squash, zumba, gymnastics, mountainbiking,
nordicwalking, stairclimbing, treadmill, functionaltraining, surfing, sailing,
canoeing, kayaking, trampoline, rugby, baseball, waterpolo, calisthenics.

## Not available

- Fasting: no endpoint; only `active_fasting_countdown_template_key` in the daily summary.
- Feelings: `GET /user/feeling?date=` exists, `PUT` answers 500; not exposed.
- Goal changes: `/user/goals` has no write method. `PATCH /user` edits the profile; not exposed.
- `…/favorites`, `…/recent` and similar paths answer 405 because they hit UUID routes, not
  because they exist.
- `/user/subscription` contains a payment transaction id; not exposed.
