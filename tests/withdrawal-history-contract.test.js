const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const gateway = fs.readFileSync(path.join(root, 'api', 'src', 'financial-gateway.js'), 'utf8');
const page = fs.readFileSync(path.join(root, 'app', 'withdraw.html'), 'utf8');
const pageScript = fs.readFileSync(path.join(root, 'app', 'js', 'withdrawal-page.js'), 'utf8');

test('history endpoint is authenticated with Pi identity derived server-side', () => {
  assert.match(gateway, /router\.get\("\/api\/my-withdrawals"/);
  assert.match(gateway, /const identity = await verifiedPiIdentity\(req\)/);
  assert.match(gateway, /p_pi_uid: identity\.pi_uid/);
  assert.match(gateway, /p_network: MAINNET/);
  assert.match(gateway, /const rows = \(Array\.isArray\(data\) \? data : \[\]\)\.map/);
});

test('withdrawal request page uses existing trusted API and only the request endpoint', () => {
  assert.match(page, /js\/core\/pi-auth-core\.js/);
  assert.match(page, /js\/core\/albukhr-api-core\.js/);
  assert.match(pageScript, /\/api\/my-stakes\?network=mainnet/);
  assert.match(pageScript, /\/api\/my-withdrawals\?network=mainnet/);
  assert.match(pageScript, /\/api\/withdrawal-request/);
  assert.doesNotMatch(pageScript, /Pi\.createPayment|submitPayment|completePayment/);
  assert.doesNotMatch(pageScript, /localStorage|sessionStorage/);
});

test('user withdrawal page retains explicit Mainnet guards and does not expose Pi UID input', () => {
  assert.match(pageScript, /env\.isMainnet\(\)/);
  assert.match(pageScript, /core\.network[^\n]*mainnet/);
  assert.doesNotMatch(pageScript, /name=["']pi_uid["']/i);
});
