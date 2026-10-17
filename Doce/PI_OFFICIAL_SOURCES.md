Pi Network official documentation checked — 2026-10-17
Advanced Payments — https://developers.minepi.com/docs/accept-payment/PaymentsAdvanced
Currently states that A2U is available only on Testnet.
This is a no-go for Mainnet payout activation until Pi publishes updated official guidance.
Official Node.js backend SDK — https://github.com/pi-apps/pi-nodejs
Documents the required A2U lifecycle: create payment, persist paymentId, submit to blockchain, persist txid, then complete.
It explicitly warns that persisting paymentId is critical to prevent duplicate payments.
Documents getIncompleteServerPayments() as a way to recover/reconcile incomplete payment state.
The official repository package.json inspected in this review reports pi-backend version 0.1.3; re-check the version and lockfile immediately before any future application.
Its src/config.ts reads process.env.PI_ENV to load .env.production or .env.development; it does not select that file from NODE_ENV alone. The official .env.production values point to Pi Mainnet endpoints/passphrase. The review patch now guards this setting.
Platform API — https://github.com/pi-apps/pi-platform-docs/blob/master/platform_API.md
Documents /v2/payments, /v2/payments/{payment_id}, /v2/payments/{payment_id}/complete and /v2/payments/incomplete_server_payments, plus the payment DTO's direction, network, status, transaction.txid and transaction.verified fields.
All sources must be rechecked before any future Mainnet activation because Pi documentation, SDK versions and endpoints can change.
