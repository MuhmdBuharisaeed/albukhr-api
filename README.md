# albukhr-api

ALBUKHR API — Mainnet Replacement v2
Aligned to https://ribpntyqdleytsyktdfb.supabase.co.
Critical safety state
The current Mainnet database does not contain stakes, transactions, withdraw_requests, project_treasury, project_treasury_transactions, or settle_project_liquidity_payment(). Therefore all financial/payment endpoints fail closed with HTTP 503 instead of inventing or writing to nonexistent financial state.
Endpoints
GET / service identity
GET /health database/API health
GET /supabase-status safe capability report
GET /mainnet-status protected by X-API-Key
GET /wallet-status protected by X-API-Key
Financial endpoints are disabled until the reviewed Mainnet financial schema and settlement RPC exist.
Security hardening
Mainnet URL is hard-locked; wildcard CORS is removed; Helmet, rate limiting, request-size limits and operational API-key protection are enabled. No private wallet seed is returned or hard-coded. Service-role and Pi secrets are environment-only.
Run
npm install cp .env.example .env Fill secrets, then npm start.
