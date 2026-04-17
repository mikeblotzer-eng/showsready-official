-- Run this in your Supabase SQL editor (or via Supabase CLI migrations)

CREATE TABLE IF NOT EXISTS users (
  email                  text PRIMARY KEY,
  name                   text,
  plan                   text        NOT NULL DEFAULT 'free',
  listings_used          integer     NOT NULL DEFAULT 0,
  listings_limit         integer     NOT NULL DEFAULT 1,
  watermark              boolean     NOT NULL DEFAULT true,
  stripe_customer_id     text,
  stripe_subscription_id text,
  cancel_at_period_end   boolean     NOT NULL DEFAULT false,
  plan_start             timestamptz          DEFAULT now(),
  plan_end               timestamptz,
  created_at             timestamptz          DEFAULT now(),
  updated_at             timestamptz          DEFAULT now()
);

-- Disable RLS — this table is only accessed by the backend via service role key
ALTER TABLE users DISABLE ROW LEVEL SECURITY;
