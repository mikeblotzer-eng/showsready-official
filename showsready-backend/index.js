import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

const PORT = process.env.PORT || 3001;

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ ok: true }));

// ── AI text (Claude Haiku — fast, cheap, market insights) ────────────────────
app.post("/api/ai", async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: "prompt required" });
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 512,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await r.json();
    const text = data.content?.[0]?.text;
    if (!text) throw new Error(JSON.stringify(data));
    res.json({ text });
  } catch (err) {
    console.error("/api/ai:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Generate walkthrough script + voice ──────────────────────────────────────
app.post("/api/generate", async (req, res) => {
  const { images, address, market, photoCount } = req.body;
  if (!images?.length) return res.status(400).json({ error: "images required" });

  // Step 1: Script via Claude vision
  let script;
  try {
    const imageBlocks = images.map(b64 => ({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: b64 },
    }));

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-opus-4-6",
        max_tokens: 1200,
        system: "You are an expert real estate copywriter. Respond ONLY in valid JSON. No markdown, no backticks, no extra text.",
        messages: [{
          role: "user",
          content: [
            ...imageBlocks,
            {
              type: "text",
              text: `Create a ~60-second property walkthrough voiceover script.
Address: ${address || "the property"}
Market: ${market || "National"}
Exactly ${photoCount} slides. Images are provided IN ORDER. Write narration for each image in the exact order shown.

Return JSON:
{
  "propertyHeadline": "6-8 word compelling headline",
  "slides": [
    {
      "id": 0,
      "narration": "15-22 words of warm spoken voiceover, conversational present-tense, no punctuation except commas",
      "roomLabel": "Living Room",
      "displayDuration": 8
    }
  ],
  "closingTagline": "10-15 word memorable closing line"
}`,
            },
          ],
        }],
      }),
    });

    const data = await r.json();
    const raw = data.content?.[0]?.text;
    if (!raw) throw new Error("No response from Claude: " + JSON.stringify(data));
    script = JSON.parse(raw.replace(/```json|```/g, "").trim());
  } catch (err) {
    console.error("Script gen failed:", err.message);
    return res.status(500).json({ error: "Script generation failed: " + err.message });
  }

  // Step 2: Voice via ElevenLabs (optional — skips gracefully if key missing)
  let audio = null;
  if (process.env.ELEVENLABS_API_KEY) {
    try {
      const fullScript = script.slides.map(s => s.narration).join(". ") + ". " + (script.closingTagline || "");
      // Aria: natural, warm, professional voice. Override with ELEVENLABS_VOICE_ID env var.
      const voiceId = process.env.ELEVENLABS_VOICE_ID || "9BWtsMINqrJLrRacOk9x";
      const vr = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: "POST",
        headers: {
          "xi-api-key": process.env.ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: fullScript,
          model_id: "eleven_turbo_v2",
          voice_settings: { stability: 0.4, similarity_boost: 0.8, style: 0.3, use_speaker_boost: true },
        }),
      });
      if (vr.ok) {
        const buf = await vr.arrayBuffer();
        audio = `data:audio/mpeg;base64,${Buffer.from(buf).toString("base64")}`;
      } else {
        console.warn("ElevenLabs:", vr.status, await vr.text());
      }
    } catch (e) {
      console.warn("ElevenLabs non-fatal:", e.message);
    }
  }

  res.json({ ...script, audio });
});

// ── Stripe checkout session ───────────────────────────────────────────────────
app.post("/api/checkout", async (req, res) => {
  const { email, name, plan } = req.body;
  if (!email || !plan) return res.status(400).json({ error: "email and plan required" });

  const priceMap = {
    single: process.env.STRIPE_PRICE_SINGLE || "price_1TGzNGRUZwmjaBpqcRAq2YX6",
    pro:    process.env.STRIPE_PRICE_PRO    || "price_1TGzOkRUZwmjaBpq5LjPbZYd",
    elite:  process.env.STRIPE_PRICE_ELITE  || "price_1TGzQARUZwmjaBpq1LWQQClK",
  };
  const priceId = priceMap[plan];
  if (!priceId) return res.status(400).json({ error: "invalid plan" });

  const isSub = plan !== "single";
  const clientUrl = process.env.CLIENT_URL || "https://showsready.netlify.app";

  try {
    const params = new URLSearchParams({
      customer_email: email,
      "line_items[0][price]": priceId,
      "line_items[0][quantity]": "1",
      mode: isSub ? "subscription" : "payment",
      success_url: `${clientUrl}/success.html?plan=${plan}&email=${encodeURIComponent(email)}`,
      cancel_url: `${clientUrl}/app.html`,
      "metadata[name]": name || "",
      "metadata[plan]": plan,
    });

    const r = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    const data = await r.json();
    if (!data.url) throw new Error(data.error?.message || "No checkout URL from Stripe");
    res.json({ checkoutUrl: data.url });
  } catch (err) {
    console.error("/api/checkout:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Stripe webhook ────────────────────────────────────────────────────────────
app.post("/api/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"] || "";
  const secret = process.env.STRIPE_WEBHOOK_SECRET || "";

  try {
    const payload = req.body.toString();
    const parts = Object.fromEntries(sig.split(",").map(p => p.split("=")));
    const { createHmac } = await import("crypto");
    const expected = "v1=" + createHmac("sha256", secret).update(`${parts.t}.${payload}`).digest("hex");
    if (expected !== `v1=${parts.v1}`) throw new Error("Bad signature");

    const event = JSON.parse(payload);
    if (event.type === "checkout.session.completed") {
      const s = event.data.object;
      console.log(`Payment complete: ${s.customer_email} → ${s.metadata?.plan}`);
      // TODO: persist to database, trigger welcome email
    }
  } catch (err) {
    return res.status(400).json({ error: "Webhook error: " + err.message });
  }

  res.json({ received: true });
});

// ── User signup ───────────────────────────────────────────────────────────────
app.post("/api/signup", (req, res) => {
  const { email, name } = req.body;
  console.log(`Signup noted: ${name} <${email}>`);
  res.json({ ok: true });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\nShowsReady backend → http://localhost:${PORT}`);
  console.log(`  Anthropic API : ${process.env.ANTHROPIC_API_KEY ? "✓ configured" : "✗ MISSING — set ANTHROPIC_API_KEY"}`);
  console.log(`  ElevenLabs    : ${process.env.ELEVENLABS_API_KEY ? "✓ configured" : "— not set (voiceover disabled)"}`);
  console.log(`  Stripe        : ${process.env.STRIPE_SECRET_KEY ? "✓ configured" : "✗ MISSING — set STRIPE_SECRET_KEY"}`);
  console.log();
});
