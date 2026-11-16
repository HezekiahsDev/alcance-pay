# alcance-pay

One payment service for every Alcance Technologies app (Grow, Dali, artist-file, …),
on one Paystack account. Apps never hold the Paystack secret key: they call this
service with their own API key, and it receives the single Paystack webhook and
forwards each event to the app that owns it.

- **Collections**: start a Paystack checkout, verify it.
- **Saved cards**: cards are saved (encrypted) on the first payment and charged
  later for renewals; apps only ever see a card id.
- **Settlement per product**: each app has its own Paystack subaccount, so its
  money settles to its own bank account and reports split cleanly.
- **One webhook, routed**: events are stored once (duplicates ignored) and
  delivered to the owning app with retries for up to ~2 days.

Base URL: `https://pay.alcance.ng`

---

## For app developers

### Authentication

Every call sends the app's API key:

```
Authorization: Bearer ak_<app>_…
```

Keys are server-side secrets: call this service from your backend, never from a
browser or mobile app.

### Start a checkout

```http
POST /v1/payments
{
  "email": "ada@example.com",
  "amount": 225000,                 // kobo (₦2,250)
  "reference": "MEMBERSHIP.abc123", // optional; generated as <APP>-<uuid> if omitted
  "callbackUrl": "https://grow.alcance.ng/checkout/status",   // origin must be registered
  "customerId": "user-uuid",        // your user id; required to save the card
  "saveCard": true,                 // card-only checkout, card kept for later charges
  "metadata": { "plan": "initial" } // returned with every event
}
→ 201 { "reference": "...", "authorizationUrl": "https://checkout.paystack.com/...", "accessCode": "..." }
```

Send the customer to `authorizationUrl`. Paystack returns them to `callbackUrl`
with `?reference=…`.

### Confirm it

```http
GET /v1/payments/:reference/verify
→ 200 {
  "reference": "...", "status": "SUCCESS" | "PENDING" | "FAILED" | "ABANDONED",
  "kind": "CHECKOUT", "amount": 225000, "currency": "NGN", "email": "...",
  "customerId": "user-uuid", "channel": "card", "gatewayResponse": "Approved",
  "paidAt": "...", "metadata": { ... },
  "card": { "id": "uuid", "brand": "visa", "last4": "4081", "expMonth": "12", "expYear": "2030", "bank": "..." } | null
}
```

Grant what was paid for only when `status` is `SUCCESS`. The amount and currency
are already checked against what you asked for. `GET /v1/payments/:reference`
returns the stored status without calling Paystack.

### Charge a saved card

```http
POST /v1/charges
{ "cardId": "uuid", "amount": 210000, "reference": "MEMBERSHIP-RENEW.<id>.<period>", "metadata": {} }
→ 201 { ...payment, "kind": "CARD_CHARGE", "status": "SUCCESS" | "FAILED" | "PENDING" }
```

Use one reference per billing period: sending the same reference again returns
the existing charge instead of charging twice. `PENDING` resolves later via an
event.

### Cards

```http
GET    /v1/cards?customerId=user-uuid   → [ { id, brand, last4, expMonth, expYear, bank } ]
DELETE /v1/cards/:id                     → { "removed": true }   (also deactivated on Paystack)
```

### Events (webhooks)

Every Paystack event that belongs to your app is POSTed to your registered
webhook URL. Respond `2xx` quickly; anything else is retried after 1 min, 5 min,
30 min, 2 h, 6 h, 12 h and 24 h. Events can arrive more than once and out of
order: handle them idempotently (e.g. by reference and status).

An event belongs to your app when it is for a payment you started here, when
its Paystack `metadata.app` is your app id, or when its reference starts with
one of your registered prefixes (for payments or transfers you still make
directly with Paystack).

**ALCANCE mode** (default, recommended):

```
X-Alcance-Event: charge.success
X-Alcance-Delivery: <delivery id>
X-Alcance-Timestamp: 1763300000
X-Alcance-Signature: hex( HMAC-SHA256( webhookSecret, `${timestamp}.${rawBody}` ) )

{ "id": "...", "type": "charge.success", "app": "grow", "createdAt": "...",
  "payment": { ...same shape as verify... } | null,   // for payments started here
  "data": { ...Paystack's data... } }
```

Verify the signature over the raw body and reject timestamps older than 5 minutes:

```ts
const expected = createHmac('sha256', WEBHOOK_SECRET).update(`${ts}.${rawBody}`).digest('hex');
const valid = timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
  && Math.abs(Date.now() / 1000 - Number(ts)) < 300;
```

**PAYSTACK mode** (for apps whose existing Paystack webhook should keep working
unchanged, e.g. Dali): the exact body Paystack sent, with Paystack's original
`x-paystack-signature` header. An app that verifies Paystack webhooks with the
same secret key needs no code change.

---

## Operating the service

### Register an app

```bash
pnpm apps create grow --name "Grow" --mode ALCANCE \
  --webhook-url https://grow-api.alcance.ng/api/v1/payments/events \
  --origin https://grow.alcance.ng --prefix MEMBERSHIP --subaccount ACCT_xxx
pnpm apps create dali --name "Dali" --mode PAYSTACK \
  --webhook-url https://dali-api.alcance.ng/api/v1/payments/webhook --prefix DALI-
pnpm apps list
pnpm apps update <id> [flags]      # --prefix / --origin replace the lists
pnpm apps rotate-key <id>          # new API key
pnpm apps rotate-secret <id>       # new webhook signing secret
pnpm apps disable <id> | enable <id>
```

The API key and webhook secret are printed once. On the server, run these in
`~/projects/alcance/alcance-pay` (the CLI reads `DATABASE_URL` from `.env`).

### Paystack account setup

1. **Webhook URL** (Settings → API Keys & Webhooks):
   `https://pay.alcance.ng/v1/webhooks/paystack`. This replaces the app-specific
   webhook (e.g. Dali's); register those apps with PAYSTACK mode so they still
   receive their events.
2. **Subaccounts** (Payments → Subaccounts): one per product, with that
   product's settlement bank account. Put each `ACCT_…` code on its app
   (`--subaccount`).

### Environment

See `.env.example`: `DATABASE_URL`, `PAYSTACK_SECRET_KEY`, `CARD_ENCRYPTION_KEY`
(32 random bytes, base64; never change it once cards are saved), `PORT` (4500).

### Deploy

Same flow as the other Alcance apps: `pnpm run deploy` on your machine builds
and tests locally, pushes `main`, uploads `dist` and `.env`, and the server's
`deploy.sh` installs and restarts PM2 (`alcance-pay`, port 4500).

First time on the server:

```bash
git clone <repo> ~/projects/alcance/alcance-pay && cd ~/projects/alcance/alcance-pay
# upload .env, then:
docker compose up -d
pnpm install && pnpm exec prisma migrate deploy
sudo bash nginx.sh            # pay.alcance.ng → 127.0.0.1:4500
```

Schema changes are applied with `pnpm exec prisma migrate deploy`.
