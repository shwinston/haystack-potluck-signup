# Haystack Potluck Signup

Shared signup page for the Ceres SDA Church haystack potluck on Sabbath, November 7, 2026.

Live page: https://shwinston.github.io/haystack-potluck-signup/

The page is a single static `index.html` file (GitHub Pages, no build step). Sign-ups are stored by a Cloudflare Worker in `worker/` using D1, so everyone sees the same list. They used to live only in each browser's `localStorage`.

## Change the event or the amounts

In `index.html`:

- `EVENT` is the block at the top (date, place, serving utensils, contact). The date is Sabbath, November 7, 2026, the place is Ceres SDA Church, and the contact is Shane Hilde. There is no start time or drop-off time on the page. A blank value is hidden.
- `ITEMS` is the menu. Each `amount` is the total for 25 people, including the store hint. Dessert is unchanged (`25 servings`). Item names must stay in sync with `ITEM_NAMES` in `worker/src/index.ts`.
- `API_BASE_URL` is the Worker URL. See below.

Rice is optional and can be claimed more than once. Every other item can be claimed once. A signup stores its own party size. Submitting again with the same name does not change an earlier signup. The headcount adds each signup's party size once, even when that signup covers several items.

Someone can cancel their own signup on the same phone or computer (the page keeps a server-issued token in `localStorage`). The reset code can remove one signup or clear the whole list. The code is checked on the Worker. It is not in this page.

## Deploy the shared list

Full notes, including local testing, are in [worker/README.md](worker/README.md).

The Worker and D1 database are already deployed. `worker/wrangler.jsonc` has database id `1f14a2d7-ef79-4a1f-8238-1e47e5eb674a`. Do not create a second database for this event.

To deploy a code change again, from `worker/`:

```bash
npm install
npx wrangler deploy
```

Schema changes still need `npx wrangler d1 migrations apply haystack-potluck --remote`. `deploy` does not apply migrations. To change the reset code after this Worker exists, run `npx wrangler secret put RESET_CODE`. Local `wrangler dev` reads `.dev.vars` instead, and deploy does not upload that file.

`API_BASE_URL` in `index.html` is already the deployed Worker, `https://haystack-potluck-signup.weathered-feather-4569.workers.dev` (no trailing slash). That constant is the only place the page looks for the API. The D1 database id in `worker/wrangler.jsonc` is the live database. For a local Worker only, temporarily point `API_BASE_URL` at `http://127.0.0.1:8787` and put the deployed URL back before pushing.

CORS already allows `https://shwinston.github.io`. Nothing else has to be set in the Cloudflare dashboard.

## Run it locally

```bash
cd worker
cp .dev.vars.example .dev.vars
# Put a local RESET_CODE in .dev.vars. That file stays uncommitted.
npm install
npx wrangler d1 migrations apply haystack-potluck --local
npx wrangler dev
```

In another terminal, from the repo root:

```bash
python3 -m http.server 8080
```

Open http://127.0.0.1:8080. The page polls the Worker about every 12 seconds and again when the tab is focused.
