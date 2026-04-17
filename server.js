require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const stripe  = process.env.STRIPE_SECRET_KEY
  ? require('stripe')(process.env.STRIPE_SECRET_KEY)
  : null;
const { createClient } = require('@supabase/supabase-js');

const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

const app  = express();
const PORT = process.env.PORT || 3001;

// ── CORS ─────────────────────────────────────────────────────────────────────
const PROD_ORIGINS = [
  'https://showsready.com',
  'https://www.showsready.com',
  'https://showsready.netlify.app',
  /^https:\/\/[a-z0-9-]+--showsready\.netlify\.app$/,
  /^https:\/\/deploy-preview-\d+--showsready\.netlify\.app$/,
];
const DEV_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1:5500',
  'http://127.0.0.1:3000',
];
const ALLOWED_ORIGINS = process.env.NODE_ENV === 'production'
  ? PROD_ORIGINS
  : [...PROD_ORIGINS, ...DEV_ORIGINS];

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    const allowed = ALLOWED_ORIGINS.some(o =>
      typeof o === 'string' ? o === origin : o.test(origin)
    );
    if (allowed) return callback(null, true);
    console.warn('[cors] Blocked origin:', origin);
    callback(new Error('Not allowed by CORS'));
  },
  methods:      ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials:  true,
};

// Stripe webhook MUST receive raw body — register BEFORE express.json()
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(cors(corsOptions));
app.use(express.json({ limit: '50mb' }));

// ── PLAN CONFIG ───────────────────────────────────────────────────────────────
const PLANS = {
  free: {
    name:         'Free Preview',
    price_cents:  0,
    listings:     1,
    watermark:    true,
    stripe_price: null,
    type:         'free',
  },
  single: {
    name:         'Per Listing',
    price_cents:  2999,
    listings:     1,
    watermark:    false,
    stripe_price: process.env.STRIPE_PRICE_SINGLE,
    type:         'payment',
  },
  pro: {
    name:         'Pro Agent',
    price_cents:  4999,
    listings:     10,
    watermark:    false,
    stripe_price: process.env.STRIPE_PRICE_PRO,
    type:         'subscription',
  },
  elite: {
    name:         'Elite Agent',
    price_cents:  9999,
    listings:     30,
    watermark:    false,
    stripe_price: process.env.STRIPE_PRICE_ELITE,
    type:         'subscription',
  },
};

// ── USER STORE (Supabase) ─────────────────────────────────────────────────────
async function getUser(email) {
  if (!supabase) throw new Error('Database not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  const { data } = await supabase
    .from('users')
    .select('*')
    .eq('email', email.toLowerCase())
    .maybeSingle();
  return data || null;
}

async function upsertUser(email, data) {
  if (!supabase) throw new Error('Database not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  const key = email.toLowerCase();
  const { data: updated, error } = await supabase
    .from('users')
    .upsert({ ...data, email: key, updated_at: new Date().toISOString() }, { onConflict: 'email' })
    .select()
    .single();
  if (error) throw error;
  return updated;
}

async function newUser(email, name) {
  return upsertUser(email, {
    name,
    plan:                   'free',
    listings_used:          0,
    listings_limit:         1,
    watermark:              true,
    stripe_customer_id:     null,
    stripe_subscription_id: null,
    cancel_at_period_end:   false,
    plan_start:             new Date().toISOString(),
    plan_end:               null,
    created_at:             new Date().toISOString(),
  });
}

function publicUser(user) {
  const { stripe_customer_id, stripe_subscription_id, ...safe } = user;
  return safe;
}

// ── AI HELPER ─────────────────────────────────────────────────────────────────
async function callClaude(prompt, maxTokens = 400) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: maxTokens,
      messages:   [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${err}`);
  }
  const data = await res.json();
  return data.content?.[0]?.text || '';
}

// ── STARTUP VALIDATION ────────────────────────────────────────────────────────
function validateEnv() {
  const critical = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'ANTHROPIC_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
  const missing = critical.filter(k => !process.env[k]);
  if (missing.length) console.warn('[startup] Missing required env vars:', missing.join(', '));

  const prices = ['STRIPE_PRICE_SINGLE', 'STRIPE_PRICE_PRO', 'STRIPE_PRICE_ELITE'];
  const missingPrices = prices.filter(k => !process.env[k]);
  if (missingPrices.length) console.warn('[startup] Missing Stripe price IDs — paid checkout will fail:', missingPrices.join(', '));
}

// ── ROUTES ────────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({
    status:    'ok',
    service:   'showsready-api',
    timestamp: new Date().toISOString(),
    stripe:    !!process.env.STRIPE_SECRET_KEY,
    ai:        !!process.env.ANTHROPIC_API_KEY,
    database:  !!supabase,
  });
});

app.get('/api/session', async (req, res) => {
  try {
    const { session_id } = req.query;
    if (!session_id) return res.status(400).json({ error: 'session_id required.' });
    if (!stripe) return res.status(503).json({ error: 'Stripe not configured.' });
    const session = await stripe.checkout.sessions.retrieve(session_id);
    const email = session.customer_details?.email || session.customer_email || null;
    res.json({ email });
  } catch (err) {
    console.error('[api/session]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ai', async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt is required.' });
    const text = await callClaude(prompt, 300);
    res.json({ text });
  } catch (err) {
    console.error('[api/ai]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/generate', async (req, res) => {
  try {
    const { address, price, type, condition, buyer, notes, market, rooms = [], images, photoCount } = req.body;
    if (!address) return res.status(400).json({ error: 'address is required.' });

    // New format: image-based walkthrough generation
    if (images && Array.isArray(images)) {
      const n = images.length || photoCount || 1;
      const prompt = `You are a luxury real estate marketing copywriter. Generate a walkthrough video script for a property at ${address} in the ${market || 'US'} market. The video has ${n} photo slide${n !== 1 ? 's' : ''}.

Return ONLY raw JSON (no markdown, no code fences):
{
  "propertyHeadline": "One compelling 12-18 word opening sentence welcoming viewers",
  "closingTagline": "One 10-14 word call-to-action closing sentence",
  "slides": [
    {"narration": "One vivid 12-16 word sentence describing this room/space", "roomLabel": "Room Name"}
  ]
}

Generate exactly ${n} slide object${n !== 1 ? 's' : ''}. Vary the room labels naturally (e.g. Living Room, Kitchen, Master Suite, Primary Bath, Outdoor Terrace, etc.). Be evocative and specific to the ${market || 'local'} market. No filler phrases.`;

      const raw  = await callClaude(prompt, 600);
      const json = JSON.parse(raw.trim());

      return res.json(json);
    }

    // Legacy format: text-only script generation
    const roomList = rooms.map(r => `${r.label} (${r.style})`).join(', ');
    const prompt = `You are a luxury real estate marketing copywriter. Write a polished walkthrough video script for the following listing.

Property: ${address}
Price: ${price}
Type: ${type}
Condition: ${condition}
Target Buyer: ${buyer}
Key Features: ${notes}
Market: ${market}
Rooms being showcased: ${roomList}

Write in this exact JSON format (no markdown, no code fences, just raw JSON):
{
  "intro": "One compelling opening sentence welcoming viewers to this property (15-20 words)",
  "rooms": [
    {"id": "ext", "voiceover": "One vivid sentence about the exterior (12-16 words)"},
    {"id": "living", "voiceover": "One vivid sentence about the living room (12-16 words)"},
    {"id": "kitchen", "voiceover": "One vivid sentence about the kitchen (12-16 words)"},
    {"id": "master", "voiceover": "One vivid sentence about the master bedroom (12-16 words)"},
    {"id": "bath", "voiceover": "One vivid sentence about the bathroom (12-16 words)"},
    {"id": "outdoor", "voiceover": "One vivid sentence about the outdoor space (12-16 words)"}
  ],
  "outro": "One closing call-to-action sentence (12-16 words)"
}

Only include room IDs that are in the showcased rooms list. Be evocative, specific to this property's market and buyer profile. No generic phrases.`;

    const raw  = await callClaude(prompt, 600);
    const json = JSON.parse(raw.trim());
    const lines = [json.intro, ...(json.rooms || []).map(r => r.voiceover), json.outro].filter(Boolean);
    json.script = lines.join('\n\n');
    res.json(json);
  } catch (err) {
    console.error('[api/generate]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/signup', async (req, res) => {
  try {
    const { name, email, plan = 'free' } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'name and email are required.' });

    let user = await getUser(email) || await newUser(email, name);

    if (plan === 'free') {
      return res.json({ success: true, user: publicUser(user) });
    }

    const session = await createCheckoutSession({ email, name, plan, user });
    res.json({ success: true, checkoutUrl: session.url });
  } catch (err) {
    console.error('[signup]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/checkout', async (req, res) => {
  try {
    const { name, email, plan } = req.body;
    if (!name || !email || !plan) {
      return res.status(400).json({ error: 'name, email, and plan are required.' });
    }
    if (!PLANS[plan] || plan === 'free') {
      return res.status(400).json({ error: 'Invalid plan ID.' });
    }

    const user    = await getUser(email) || await newUser(email, name);
    const session = await createCheckoutSession({ email, name, plan, user });
    res.json({ checkoutUrl: session.url, sessionId: session.id });
  } catch (err) {
    console.error('[checkout]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/user', async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: 'email query param required.' });
    const user = await getUser(email);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    res.json({ user: publicUser(user) });
  } catch (err) {
    console.error('[api/user]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/listing/use', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email is required.' });

    const user = await getUser(email);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    if (user.listings_used >= user.listings_limit) {
      return res.status(403).json({
        error:   'Listing limit reached. Please upgrade your plan.',
        upgrade: true,
        plan:    user.plan,
        used:    user.listings_used,
        limit:   user.listings_limit,
      });
    }

    const updated = await upsertUser(email, { listings_used: user.listings_used + 1 });
    res.json({
      success:   true,
      used:      updated.listings_used,
      limit:     updated.listings_limit,
      remaining: updated.listings_limit - updated.listings_used,
      watermark: updated.watermark,
    });
  } catch (err) {
    console.error('[listing/use]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cancel', async (req, res) => {
  try {
    const { email } = req.body;
    const user = await getUser(email);
    if (!user)                        return res.status(404).json({ error: 'User not found.' });
    if (!user.stripe_subscription_id) return res.status(400).json({ error: 'No active subscription.' });

    await stripe.subscriptions.update(user.stripe_subscription_id, { cancel_at_period_end: true });
    await upsertUser(email, { cancel_at_period_end: true });
    res.json({ success: true, message: 'Your plan will not renew. Access continues until period end.' });
  } catch (err) {
    console.error('[cancel]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/portal', async (req, res) => {
  try {
    const { email } = req.body;
    const user = await getUser(email);
    if (!user || !user.stripe_customer_id) {
      return res.status(404).json({ error: 'No billing account found.' });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer:   user.stripe_customer_id,
      return_url: `${process.env.CLIENT_URL || 'https://showsready.com'}/account`,
    });
    res.json({ portalUrl: session.url });
  } catch (err) {
    console.error('[portal]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── STRIPE WEBHOOK ────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  const sig    = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    console.error('[webhook] Signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log(`[webhook] ${event.type}`);

  try {
    switch (event.type) {

      case 'checkout.session.completed': {
        const session = event.data.object;
        const email   = session.customer_details?.email || session.metadata?.email;
        const plan    = session.metadata?.plan;

        if (email && plan && PLANS[plan]) {
          const planData = PLANS[plan];
          const now      = new Date();
          const end      = new Date(now);
          end.setDate(end.getDate() + 30);

          await upsertUser(email, {
            plan,
            listings_limit:         planData.listings,
            listings_used:          0,
            watermark:              planData.watermark,
            stripe_customer_id:     session.customer,
            stripe_subscription_id: session.subscription || null,
            plan_start:             now.toISOString(),
            plan_end:               planData.type === 'subscription' ? end.toISOString() : null,
            cancel_at_period_end:   false,
          });
          console.log(`[webhook] Plan activated: ${email} → ${plan}`);
        }
        break;
      }

      case 'invoice.paid': {
        const invoice = event.data.object;
        const email   = invoice.customer_email;

        if (email) {
          const user = await getUser(email);
          if (user && user.plan !== 'free' && user.plan !== 'single') {
            const now = new Date();
            const end = new Date(now);
            end.setDate(end.getDate() + 30);
            await upsertUser(email, {
              listings_used:        0,
              plan_start:           now.toISOString(),
              plan_end:             end.toISOString(),
              cancel_at_period_end: false,
            });
            console.log(`[webhook] Subscription renewed, usage reset: ${email}`);
          }
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        console.warn(`[webhook] Payment failed: ${invoice.customer_email}`);
        break;
      }

      case 'customer.subscription.deleted': {
        const sub   = event.data.object;
        const email = sub.metadata?.email || sub.customer_email;
        if (email) {
          await upsertUser(email, {
            plan:                   'free',
            listings_limit:         1,
            listings_used:          0,
            watermark:              true,
            stripe_subscription_id: null,
            cancel_at_period_end:   false,
            plan_end:               new Date().toISOString(),
          });
          console.log(`[webhook] Downgraded to free: ${email}`);
        }
        break;
      }

      case 'payment_intent.succeeded': {
        const pi    = event.data.object;
        const email = pi.metadata?.email;
        const plan  = pi.metadata?.plan;
        if (email && plan === 'single') {
          const user = await getUser(email);
          await upsertUser(email, {
            plan:           'single',
            listings_limit: (user?.listings_limit || 0) + 1,
            watermark:      false,
          });
          console.log(`[webhook] Single listing credit added: ${email}`);
        }
        break;
      }

      default:
        break;
    }
  } catch (err) {
    console.error('[webhook] Handler error:', err.message);
  }

  res.json({ received: true });
});

// ── CHECKOUT SESSION FACTORY ──────────────────────────────────────────────────
async function createCheckoutSession({ email, name, plan, user }) {
  if (!stripe) {
    throw new Error('Stripe is not configured. Set STRIPE_SECRET_KEY before accepting paid checkout.');
  }
  const planData = PLANS[plan];

  let customerId = user?.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email, name,
      metadata: { plan, source: 'showsready' },
    });
    customerId = customer.id;
    await upsertUser(email, { stripe_customer_id: customerId, name });
  }

  const BASE_URL   = process.env.CLIENT_URL || 'https://showsready.com';
  const successUrl = `${BASE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl  = `${BASE_URL}/pricing.html`;

  const config = {
    customer:                   customerId,
    metadata:                   { plan, email },
    success_url:                successUrl,
    cancel_url:                 cancelUrl,
    allow_promotion_codes:      true,
    billing_address_collection: 'required',
  };

  if (planData.type === 'payment') {
    config.mode = 'payment';
    config.line_items = [{
      price_data: {
        currency:     'usd',
        unit_amount:  planData.price_cents,
        product_data: {
          name:        `ShowsReady — ${planData.name}`,
          description: '1 listing walkthrough video · No watermark · Branded end card',
        },
      },
      quantity: 1,
    }];
  } else {
    if (!planData.stripe_price) {
      throw new Error(`Stripe price ID not configured for plan: ${plan}. Set STRIPE_PRICE_${plan.toUpperCase()} env var.`);
    }
    config.mode = 'subscription';
    config.line_items = [{ price: planData.stripe_price, quantity: 1 }];
    config.subscription_data = { metadata: { plan, email } };
  }

  return await stripe.checkout.sessions.create(config);
}

// ── START ─────────────────────────────────────────────────────────────────────
validateEnv();
app.listen(PORT, () => {
  console.log(`ShowsReady API → http://localhost:${PORT}`);
  console.log(`  Stripe:    ${process.env.STRIPE_SECRET_KEY   ? '✓' : '✗ MISSING'}`);
  console.log(`  Anthropic: ${process.env.ANTHROPIC_API_KEY   ? '✓' : '✗ MISSING'}`);
  console.log(`  Supabase:  ${supabase                        ? '✓' : '✗ MISSING — user data will not persist'}`);
  console.log(`  URL:       ${process.env.CLIENT_URL || 'https://showsready.com'}`);
});

module.exports = app;
