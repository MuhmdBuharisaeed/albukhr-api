ALBUKHR A2U / Withdrawal Integration Audit
Date: 2026-10-17 Scope: Read-only audit of Mainnet Supabase, user-side repository, admin-side repository, Mainnet API repository, and A2U-related RPC definitions. Safety: No database writes, GitHub commits, Render changes, or Pi transactions were performed.
Executive conclusion
Do not apply the current A2U migration or enable A2U payouts yet. The current code and Mainnet database are not aligned. The safest path is to preserve the existing withdrawal request and admin review workflow, establish one authoritative payout service, and make its SQL contract match the API exactly. Mainnet A2U must remain hard-disabled until Pi officially authorizes it and the integration has passed verification.
Mainnet Supabase findings
Project: App Albukhr project (ribpntyqdleytsyktdfb).
Existing tables: public.withdrawal_requests, public.withdrawal_payout_attempts, public.stakes, and public.albukhr_fee_policies.
withdrawal_requests has no v2 A2U progress markers such as payment_creation_started_at or submission_started_at.
withdrawal_payout_attempts has the original columns only: id, withdrawal_request_id, network, status, attempt_count, lease_until, payment_id, txid, last_error, started_at, completed_at, updated_at. No lease_token or fencing token column exists.
The current unique index permits only one attempt row per withdrawal request. This is usable as a foundation, but the new API's v2 claim/progress/finalize protocol is not installed.
Current Mainnet A2U RPCs include:
public.claim_a2u_withdrawal_payout(uuid)
public.finish_a2u_withdrawal_payout(uuid,text,text,text,text)
public.get_a2u_approved_withdrawal_queue(integer)
Missing RPCs referenced by src/a2u-payout-service.js:
claim_a2u_withdrawal_payout_v2
record_a2u_withdrawal_payout_progress_v2
fail_a2u_withdrawal_payout_v2
finalize_a2u_withdrawal_payout_v2
The v2 queue contract also needs to be checked against get_a2u_approved_withdrawal_queue(integer) before wiring the worker.
claim_a2u_withdrawal_payout and finish_a2u_withdrawal_payout are SECURITY DEFINER functions, executable by service_role only (not anon or authenticated). This access boundary should be preserved.
There are no explicit RLS policies on withdrawal_requests or withdrawal_payout_attempts in the inspected public schema. RLS is enabled; API service-role access and SECURITY DEFINER RPC boundaries must remain explicit.
Mainnet currently has zero withdrawal_requests and zero withdrawal_payout_attempts, so there are no existing withdrawal records to migrate at the time of this audit.
Existing active fee policy must remain authoritative. Do not hard-code a new fee rule into the payout worker if the withdrawal request already contains a policy snapshot.
Withdrawal request SQL findings
Two overloads exist:
public.create_my_withdrawal_request(text,text,uuid,text,numeric) — service-role/API path; accepts p_network and currently checks Mainnet.
public.create_my_withdrawal_request(text,uuid,text,numeric) — auth-bound overload.
Both currently calculate availability from the original stake/reward amounts and only prevent another request in pending or approved status. They do not subtract all prior paid withdrawals from the available balance. The v2 migration must fix both overloads, using the correct network, user, stake, withdrawal type, amount, fee snapshot and status semantics. It must also avoid double counting a request in the same transaction and protect concurrent requests by locking the stake row and performing the balance check and insert atomically.
Do not drop either overload until callers and grants have been traced. The Mainnet API explicitly calls the five-argument overload with p_network='mainnet'.
Mainnet API findings (MuhmdBuharisaeed/albukhr-api)
src/a2u-payout-service.js calls four v2 RPCs that do not exist in Mainnet Supabase. The worker therefore cannot complete its intended claim/progress/finalize protocol.
The A2U service expects lease_token, payment_creation_started_at, and submission_started_at, but the current database schema does not expose those fields.
server.js does not mount src/a2u-worker.js.
scripts/a2u-payout-cron.js exists, but render.yaml does not define a Cron service. It must not be assumed to run.
package.json does not list pi-backend as a dependency, even though src/pi-a2u-client.js dynamically imports pi-backend. The current npm run check also does not syntax-check the A2U service, worker, or cron script.
src/financial-gateway.js still contains a second A2U execution path (executeWithdrawalPayout) exposed through POST /api/pay-withdrawal with OPERATIONS_API_KEY. It uses an in-process activePayouts set and updates withdrawal_requests directly, bypassing the new durable database claim/fencing protocol. Once A2U is enabled, this would be a competing payout path. The route must be disabled or made to delegate to the one authoritative A2U service before Mainnet enablement.
The existing request creation endpoint POST /api/withdrawal-request calls the five-argument SQL overload. Preserve its verified Pi identity check and network validation.
Do not change unrelated U2A investment routes in financial-gateway.js; the existing U2A flow must be preserved.
User-side findings (MuhmdBuharisaeed/albukhr-app)
investor-dashboard.html links to withdraw.html, but withdraw.html was not present in the inspected main branch tree. This is a broken user-side entry point unless the file is supplied from another deployment/source. Verify deployed file/source before restoring or creating a replacement.
js/marketplace/marketplace-engine.js is investment-oriented and delegates to window.AlbukhrStaking.addStake; it does not contain the withdrawal request flow.
The current repo search did not find a user-side caller for /api/withdrawal-request or a read endpoint for the user's withdrawal history. Trace any external/deployed withdraw.html and existing withdrawal scripts before adding new files, to avoid duplicating an existing production page.
User-side request creation and history should call the trusted Mainnet API, not expose service-role RPCs directly in browser code.
Admin-side findings (MuhmdBuharisaeed/albukhr-admin)
admin-withdrawals.html and js/admin-withdrawals.js implement the current manual flow: pending -> approve/reject -> manual Pi send -> TXID -> paid.
The admin page uses albukhr_security.get_withdrawal_review_queue, review_withdrawal_request, and mark_withdrawal_paid.
The page clearly states that it does not send Pi automatically. The manual mark_withdrawal_paid path must not be casually removed until the automated path has a verified state transition and a safe operational fallback.
Before A2U activation, the admin page should distinguish (a) review/approval, (b) A2U queued/processing/uncertain/completed states, and (c) any explicitly approved fallback procedure. It must never mark a request paid solely because a worker reports success; final state must be database-authoritative and verified against Pi.
Preserve AAL2 and finance/super-admin authorization and audit logging.
Required target architecture
User-side calls trusted Mainnet API to create request and read its own withdrawal history.
API verifies Pi identity, Mainnet network, stake ownership, maturity, amount, fee-policy snapshot and remaining available balance.
Admin review RPC controls approve/reject; only approved requests enter the A2U queue.
One authoritative A2U payout service is used by every trigger. No direct payout implementation remains in financial-gateway.js.
A database claim/fencing token prevents concurrent workers. Progress is durably recorded before external create-payment and transaction submission.
Any uncertain external outcome is reconciled against Pi's payment records before another create/submit action. Never auto-resubmit when the prior result is uncertain.
Only a Pi-verified transaction and an atomic database finalization may mark a request paid and close its payout attempt.
A2U remains hard-disabled in source until official Mainnet support is confirmed and separately reviewed.
Safe order of work
Finish read-only trace of all callers, grants, constraints, indexes, and admin/user pages.
Prepare one coordinated review patch across SQL, API, user-side, and admin-side code; no live changes.
Run SQL syntax/contract checks and the API test suite against the existing isolated Testnet contract only where the schemas actually match. Do not apply Mainnet-only migration to the current Testnet schema.
Review the exact migration and full file diffs before any write operation.
Only after explicit approval: apply the migration to Mainnet in a controlled change window, with immediate post-migration checks; keep all Pi payouts disabled.
Deploy only after the API, user-side, and admin-side callers match the new SQL contract and tests pass. Keep Mainnet A2U disabled until Pi authorization.
Actions not performed
No Supabase schema/data changes.
No GitHub commits or pushes.
No Render environment/deployment changes.
No Pi payment or blockchain transaction.
