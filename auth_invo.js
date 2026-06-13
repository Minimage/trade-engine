/**
 * Invo One-Time Authentication
 * Run this ONCE to get your access and refresh tokens
 *
 * Usage:
 *   node auth_invo.js
 *
 * It will:
 *   1. Send OTP to seancampbell914@gmail.com
 *   2. Ask you to enter the code
 *   3. Save tokens to invo_tokens.json
 */

import fetch from 'node-fetch';
import { createInterface } from 'readline';
import { writeFileSync } from 'fs';

const API_BASE = 'https://api.involio.com/v1_0';
const EMAIL    = 'seancampbell914@gmail.com';

const rl = createInterface({
  input:  process.stdin,
  output: process.stdout,
});

const ask = (question) => new Promise(resolve => rl.question(question, resolve));

async function main() {
  console.log('\n🚀 Invo Authentication');
  console.log('======================');
  console.log(`Email: ${EMAIL}\n`);

  // Step 1 — Request OTP
  console.log('Requesting OTP code...');
  const startRes = await fetch(`${API_BASE}/auth/login/email/start`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ email: EMAIL }),
  });
  const startData = await startRes.json();
  console.log('OTP response:', startData);

  if (!startRes.ok) {
    console.error('❌ Failed to send OTP:', startData);
    rl.close();
    return;
  }

  console.log('\n📧 Check your email for the login code');

  // Step 2 — Enter OTP
  const otp = await ask('Enter the code from your email: ');

  // Step 3 — Submit OTP
  console.log('\nSubmitting code...');
  const loginRes = await fetch(`${API_BASE}/auth/login/email`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ email: EMAIL, otp: otp.trim() }),
  });
  const loginData = await loginRes.json();

  if (!loginRes.ok || !loginData.accessToken) {
    console.error('❌ Login failed:', loginData);
    rl.close();
    return;
  }

  // Step 4 — Save tokens
  const tokens = {
    accessToken:  loginData.accessToken,
    refreshToken: loginData.refreshToken,
    targetUsers:  ['crypto_rocket'],
    savedAt:      new Date().toISOString(),
  };

  writeFileSync('./invo_tokens.json', JSON.stringify(tokens, null, 2));

  console.log('\n✅ Authentication successful!');
  console.log('Tokens saved to invo_tokens.json');
  console.log('\nFor Replit Secrets, add:');
  console.log(`  INVO_ACCESS_TOKEN  = ${loginData.accessToken.substring(0, 20)}...`);
  console.log(`  INVO_REFRESH_TOKEN = ${loginData.refreshToken?.substring(0, 20) || 'n/a'}...`);
  console.log('\nNow restart your trade engine — the poller will start automatically.');

  rl.close();
}

main().catch(e => {
  console.error('Fatal error:', e);
  rl.close();
});
