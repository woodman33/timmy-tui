#!/usr/bin/env node
// Creates (once) the Timmy Pro product and its $19/month price in Stripe, using
// the logged-in Stripe CLI. Test mode by default; nothing here prints keys.
//
//   node scripts/pro/stripe-setup.mjs              # test mode
//   node scripts/pro/stripe-setup.mjs --live --confirm-live
//
// Idempotent: the price is found by its lookup key first, so re-running prints
// the existing price instead of creating a duplicate.

import { execFileSync } from 'node:child_process';

const LOOKUP_KEY = 'timmy_pro_monthly';
const UNIT_AMOUNT = '1900'; // $19.00
const args = process.argv.slice(2);
const live = args.includes('--live');
if (live && !args.includes('--confirm-live')) {
  console.error('Live mode creates a real product and price. Re-run with --live --confirm-live to proceed.');
  process.exit(2);
}

function stripe(method, path, data) {
  const argv = [method, path, ...data.flatMap((d) => ['-d', d])];
  if (live) argv.push('--live');
  try {
    return JSON.parse(execFileSync('stripe', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch (err) {
    const detail = String(err.stderr || err.message).split('\n').filter(Boolean).slice(-1)[0];
    throw new Error(`stripe ${method} ${path} failed: ${detail}`);
  }
}

const existing = stripe('get', '/v1/prices', [`lookup_keys[]=${LOOKUP_KEY}`, 'active=true', 'limit=1']);
let price = existing?.data?.[0];
let created = false;
if (!price) {
  const product = stripe('post', '/v1/products', [
    'name=Timmy Pro',
    'description=Hosted receipts, Cloud Logs, verify links, release receipts and hosted agent runs for Timmy.',
    'metadata[product]=timmy_pro',
  ]);
  price = stripe('post', '/v1/prices', [
    `product=${product.id}`,
    `unit_amount=${UNIT_AMOUNT}`,
    'currency=usd',
    'recurring[interval]=month',
    `lookup_key=${LOOKUP_KEY}`,
    'metadata[product]=timmy_pro',
  ]);
  created = true;
}

console.log(JSON.stringify({
  mode: live ? 'live' : 'test',
  created,
  price_id: price.id,
  product_id: typeof price.product === 'string' ? price.product : price.product?.id,
  amount: `${(price.unit_amount / 100).toFixed(2)} ${String(price.currency).toUpperCase()} / ${price.recurring?.interval}`,
  lookup_key: price.lookup_key,
}, null, 2));
