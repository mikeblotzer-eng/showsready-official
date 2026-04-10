// ============================================================
// ShowsReady Backend — WITH REAL AI STAGING
// Node.js + Express + Stripe + Replicate (for AI staging)
// ============================================================

require('dotenv').config();
const express = require('express');
const stripe  = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors    = require('cors');
const Replicate = require('replicate');

const app  = express();
const PORT = process.env.PORT || 3001;

// Initialize Replicate for AI image staging
const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
});

// ── Stripe webhook MUST receive raw body — register BEFORE express.json()
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '50mb' })); // Increased for base64 images
app.use(cors({ origin: process.env.CLIENT_URL || '*' }));

// ============================================================
// STAGING STYLE PROMPTS
// These define how each style transforms the images
// ============================================================
const STYLE_PROMPTS = {
  modern: {
    prompt: 'modern minimalist interior design, clean lines, neutral colors, contemporary furniture, bright natural lighting, professional real estate photography',
    negative: 'cluttered, dark, old furniture, poor lighting, messy',
    strength: 0.75
  },
  coastal: {
    prompt: 'coastal beach house interior, light blue and white colors, natural textures, beach-inspired decor, bright airy atmosphere, nautical accents, professional staging',
    negative: 'dark colors, heavy furniture, cluttered, landlocked aesthetic',
    strength: 0.75
  },
  rustic: {
    prompt: 'rustic farmhouse interior, warm wood tones, vintage furniture, cozy atmosphere, natural materials, country charm, professionally staged',
    negative: 'modern, sterile, plastic, artificial, urban',
    strength: 0.75
  },
  industrial: {
    prompt: 'industrial loft interior, exposed brick, metal accents, urban modern design, open space, professional staging, high-end finishes',
    negative: 'traditional, ornate, cluttered, suburban',
    strength: 0.75
  },
  luxury: {
    prompt: 'luxury high-end interior, elegant furniture, marble surfaces, sophisticated color palette, designer finishes, professional luxury real estate staging',
    negative: 'cheap, cluttered, outdated, worn, budget',
    strength: 0.8
  },
  minimalist: {
    prompt: 'minimalist scandinavian interior, white walls, simple clean furniture, uncluttered space, natural light, professional minimal staging',
    negative: 'busy, ornate, colorful, cluttered, maximalist',
    strength: 0.7
  }
};

// ============================================================
// AI IMAGE STAGING ENDPOINT
// Takes an image and style, returns AI-staged version
// ============================================================
app.post('/api/stage-image', async (req, res) => {
  try {
    const { imageBase64, style, roomType } = req.body;
    
    if (!imageBase64 || !style) {
      return res.status(400).json({ error: 'imageBase64 and style are required' });
    }

    if (!STYLE_PROMPTS[style]) {
      return res.status(400).json({ error: 'Invalid style. Choose: modern, coastal, rustic, industrial, luxury, or minimalist' });
    }

    console.log(`[stage-image] Processing ${roomType || 'room'} in ${style} style...`);

    const styleConfig = STYLE_PROMPTS[style];
    
    // Add room-specific context to prompt
    const roomContext = roomType ? `${roomType} room, ` : '';
    const fullPrompt = `${roomContext}${styleConfig.prompt}`;

    // Use Replicate's Stable Diffusion XL for image-to-image transformation
    const output = await replicate.run(
      "stability-ai/sdxl:39ed52f2a78e934b3ba6e2a89f5b1c712de7dfea535525255b1aa35c5565e08b",
      {
        input: {
          image: imageBase64,
          prompt: fullPrompt,
          negative_prompt: styleConfig.negative,
          num_inference_steps: 25,
          guidance_scale: 7.5,
          strength: styleConfig.strength,
          scheduler: "DPMSolverMultistep"
        }
      }
    );

    // Replicate returns an array of image URLs
    const stagedImageUrl = Array.isArray(output) ? output[0] : output;

    console.log(`[stage-image] ✓ Staged successfully`);

    res.json({
      success: true,
      stagedImageUrl,
      style,
      roomType: roomType || 'unknown'
    });

  } catch (err) {
    console.error('[stage-image] Error:', err);
    res.status(500).json({ 
      error: 'Image staging failed',
      details: err.message 
    });
  }
});

// ============================================================
// BATCH STAGING ENDPOINT
// Stages multiple images at once (for entire listing)
// ============================================================
app.post('/api/stage-listing', async (req, res) => {
  try {
    const { images, style, listingInfo } = req.body;
    
    if (!images || !Array.isArray(images)) {
      return res.status(400).json({ error: 'images array is required' });
    }

    if (!style || !STYLE_PROMPTS[style]) {
      return res.status(400).json({ error: 'Valid style is required' });
    }

    console.log(`[stage-listing] Processing ${images.length} images in ${style} style...`);

    const stagedImages = [];
    
    // Process images sequentially to avoid rate limits
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      
      try {
        console.log(`[stage-listing] Processing image ${i + 1}/${images.length}: ${img.roomType || 'room'}`);
        
        const styleConfig = STYLE_PROMPTS[style];
        const roomContext = img.roomType ? `${img.roomType} room, ` : '';
        const fullPrompt = `${roomContext}${styleConfig.prompt}`;

        const output = await replicate.run(
          "stability-ai/sdxl:39ed52f2a78e934b3ba6e2a89f5b1c712de7dfea535525255b1aa35c5565e08b",
          {
            input: {
              image: img.imageBase64,
              prompt: fullPrompt,
              negative_prompt: styleConfig.negative,
              num_inference_steps: 25,
              guidance_scale: 7.5,
              strength: styleConfig.strength,
              scheduler: "DPMSolverMultistep"
            }
          }
        );

        const stagedImageUrl = Array.isArray(output) ? output[0] : output;

        stagedImages.push({
          originalId: img.id,
          roomType: img.roomType,
          originalUrl: img.originalUrl,
          stagedUrl: stagedImageUrl,
          style
        });

        console.log(`[stage-listing] ✓ Image ${i + 1} staged successfully`);
        
        // Small delay to avoid rate limits
        if (i < images.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }

      } catch (imgErr) {
        console.error(`[stage-listing] Failed to stage image ${i + 1}:`, imgErr);
        
        // Add failed image with error
        stagedImages.push({
          originalId: img.id,
          roomType: img.roomType,
          originalUrl: img.originalUrl,
          stagedUrl: null,
          error: imgErr.message,
          style
        });
      }
    }

    const successCount = stagedImages.filter(img => img.stagedUrl).length;
    console.log(`[stage-listing] ✓ Completed: ${successCount}/${images.length} successful`);

    res.json({
      success: true,
      style,
      totalImages: images.length,
      successfulImages: successCount,
      stagedImages,
      listingInfo
    });

  } catch (err) {
    console.error('[stage-listing] Error:', err);
    res.status(500).json({ 
      error: 'Batch staging failed',
      details: err.message 
    });
  }
});

// ============================================================
// PLAN CONFIG (from original)
// ============================================================
const PLANS = {
  free: {
    name:         'Free Preview',
    price_cents:  0,
    listings:     1,
    watermark:    true,
    aiStaging:    true, // Allow AI staging on free tier (with watermark)
    stripe_price: null,
    type:         'free',
  },
  single: {
    name:         'Per Listing',
    price_cents:  2999,
    listings:     1,
    watermark:    false,
    aiStaging:    true,
    stripe_price: process.env.STRIPE_PRICE_SINGLE || 'price_SINGLE_LISTING_ID',
    type:         'payment',
  },
  pro: {
    name:         'Pro Agent',
    price_cents:  4999,
    listings:     10,
    watermark:    false,
    aiStaging:    true,
    stripe_price: process.env.STRIPE_PRICE_PRO || 'price_PRO_AGENT_MONTHLY_ID',
    type:         'subscription',
  },
  elite: {
    name:         'Elite Agent',
    price_cents:  9999,
    listings:     30,
    watermark:    false,
    aiStaging:    true,
    stripe_price: process.env.STRIPE_PRICE_ELITE || 'price_ELITE_AGENT_MONTHLY_ID',
    type:         'subscription',
  },
};

// USER STORE (same as before - in-memory)
const users = new Map();

function getUser(email) {
  return users.get(email.toLowerCase()) || null;
}

function upsertUser(email, data) {
  const key      = email.toLowerCase();
  const existing = users.get(key) || {};
  const updated  = { ...existing, ...data, email: key, updatedAt: new Date().toISOString() };
  users.set(key, updated);
  return updated;
}

function newUser(email, name) {
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
    createdAt:              new Date().toISOString(),
  });
}

function publicUser(user) {
  const { stripe_customer_id, stripe_subscription_id, ...safe } = user;
  return safe;
}

// ============================================================
// EXISTING ROUTES (kept from original server.js)
// ============================================================

app.get('/health', (_req, res) => {
  res.json({
    status:    'ok',
    service:   'showsready-api',
    timestamp: new Date().toISOString(),
    stripe:    !!process.env.STRIPE_SECRET_KEY,
    replicate: !!process.env.REPLICATE_API_TOKEN,
  });
});

app.post('/api/signup', async (req, res) => {
  try {
    const { name, email, plan = 'free' } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'name and email are required.' });

    let user = getUser(email) || newUser(email, name);

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

    const user    = getUser(email) || newUser(email, name);
    const session = await createCheckoutSession({ email, name, plan, user });

    res.json({ checkoutUrl: session.url, sessionId: session.id });

  } catch (err) {
    console.error('[checkout]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/user', (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'email query param required.' });

  const user = getUser(email);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  res.json({ user: publicUser(user) });
});

app.post('/api/listing/use', (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email is required.' });

  const user = getUser(email);
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

  const updated = upsertUser(email, { listings_used: user.listings_used + 1 });
  console.log(`[listing/use] ${email} — ${updated.listings_used}/${updated.listings_limit}`);

  res.json({
    success:   true,
    used:      updated.listings_used,
    limit:     updated.listings_limit,
    remaining: updated.listings_limit - updated.listings_used,
    watermark: updated.watermark,
  });
});

app.post('/api/cancel', async (req, res) => {
  try {
    const { email } = req.body;
    const user = getUser(email);

    if (!user || !user.stripe_subscription_id) {
      return res.status(404).json({ error: 'No active subscription found.' });
    }

    await stripe.subscriptions.update(user.stripe_subscription_id, {
      cancel_at_period_end: true,
    });

    upsertUser(email, { cancel_at_period_end: true });
    res.json({ success: true, message: 'Subscription will cancel at period end.' });

  } catch (err) {
    console.error('[cancel]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/portal', async (req, res) => {
  try {
    const { email } = req.body;
    const user = getUser(email);

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

// ============================================================
// STRIPE WEBHOOK (same as before)
// ============================================================
app.post('/webhook', (req, res) => {
  const sig     = req.headers['stripe-signature'];
  const secret  = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    console.error('[webhook] Signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log(`[webhook] ${event.type}`);

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

        upsertUser(email, {
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
        const user = getUser(email);
        if (user && user.plan !== 'free' && user.plan !== 'single') {
          const now = new Date();
          const end = new Date(now);
          end.setDate(end.getDate() + 30);

          upsertUser(email, {
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
        upsertUser(email, {
          plan:                   'free',
          listings_limit:         1,
          listings_used:          0,
          watermark:              true,
          stripe_subscription_id: null,
          cancel_at_period_end:   false,
          plan_end:               new Date().toISOString(),
        });
        console.log(`[webhook] Subscription cancelled, downgraded to free: ${email}`);
      }
      break;
    }

    case 'payment_intent.succeeded': {
      const pi    = event.data.object;
      const email = pi.metadata?.email;
      const plan  = pi.metadata?.plan;

      if (email && plan === 'single') {
        const user = getUser(email);
        upsertUser(email, {
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

  res.json({ received: true });
});

// ============================================================
// CHECKOUT SESSION FACTORY (same as before)
// ============================================================
async function createCheckoutSession({ email, name, plan, user }) {
  const planData = PLANS[plan];

  let customerId = user?.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email,
      name,
      metadata: { plan, source: 'showsready' },
    });
    customerId = customer.id;
    upsertUser(email, { stripe_customer_id: customerId, name });
  }

  const BASE_URL   = process.env.CLIENT_URL || 'https://showsready.com';
  const successUrl = `${BASE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl  = `${BASE_URL}/pricing`;

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
          description: '1 listing walkthrough video · No watermark · AI staging · Branded end card',
        },
      },
      quantity: 1,
    }];
  } else {
    config.mode = 'subscription';
    config.line_items = [{ price: planData.stripe_price, quantity: 1 }];
    config.subscription_data = {
      metadata: { plan, email },
    };
  }

  return await stripe.checkout.sessions.create(config);
}

// ============================================================
// START
// ============================================================
app.listen(PORT, () => {
  console.log(`
  ✦ ShowsReady API with AI Staging
  ─────────────────────────────────
  Running on:    http://localhost:${PORT}
  Health check:  http://localhost:${PORT}/health
  
  Integrations:
  Stripe:        ${process.env.STRIPE_SECRET_KEY ? '✓ configured' : '✗ MISSING'}
  Replicate AI:  ${process.env.REPLICATE_API_TOKEN ? '✓ configured' : '✗ MISSING'}
  
  Client URL:    ${process.env.CLIENT_URL || 'https://showsready.com'}
  ─────────────────────────────────
  `);
});

module.exports = app;
