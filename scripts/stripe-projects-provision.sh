#!/bin/bash
# TIMMY Stripe Projects Provisioning Helper Script
# Clean and safe automation for Stripe CLI Projects initialization.

set -e

echo "=========================================================="
echo "💳 TIMMY Stripe Projects Provisioning Helper"
echo "=========================================================="

# Route execution strictly within the founder-terminal directory
cd <home>/Desktop/timmy-tui/founder-terminal

echo "[1/8] Ensuring Stripe CLI is installed..."
brew install stripe/stripe-cli/stripe || true

echo "[2/8] Installing Stripe projects plugin..."
stripe plugin install projects || true

echo "[3/8] Authenticating with Stripe..."
stripe login

echo "[4/8] Initializing Stripe project 'timmy'..."
stripe projects init timmy || true

echo "[5/8] Adding core authentication service (clerk/auth)..."
stripe projects add clerk/auth --json --no-interactive --auto-confirm --accept-tos || true

echo "[6/8] Adding serverless compute infrastructure (cloudflare/worker)..."
stripe projects add cloudflare/worker --json --no-interactive --auto-confirm --accept-tos || true

echo "[7/8] Adding LLM model router api (openrouter/api)..."
stripe projects add openrouter/api --json --no-interactive --auto-confirm --accept-tos || true

echo "[8/8] Adding product telemetry (posthog/analytics)..."
stripe projects add posthog/analytics --json --no-interactive --auto-confirm --accept-tos || true

echo "----------------------------------------------------------"
echo "Adding optional third-party platforms..."
stripe projects add daytona/sandbox --json --no-interactive --auto-confirm --accept-tos || true
stripe projects add vercel/project --json --no-interactive --auto-confirm --accept-tos || true

echo "----------------------------------------------------------"
echo "Pulling latest environment variables..."
stripe projects env --pull || true

echo "Generating projects context for agent runs..."
stripe projects llm-context || true

echo "=========================================================="
echo "✓ Stripe Projects Provisioning Finished!"
echo "=========================================================="
