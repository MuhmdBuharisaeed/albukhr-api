Canje-canje da haɗarurruka — ALBUKHR A2U Safety Patch v1.2
Sabbin canje-canje
An ƙara lissafin ragowar balance ta category a SQL draft: base amount - SUM(requested_amount + fee_amount) kan requests masu pending, approved, ko paid a Mainnet.
Duka overloads na create_my_withdrawal_request sun yi amfani da helper ɗin; ana riƙe row lock na stake don daidaita request creation.
An ƙara payment_creation_started_at da submission_started_at a payout attempts.
Progress RPC yana rubuta marker kafin createPayment/submitPayment, kuma yana share marker kawai idan payment ID/txid ya samu kuma an adana shi.
Retry da ba a tabbatar da sakamakonsa ba yana tsaya a reconciliation gate, ba ya kira createPayment/submitPayment na biyu.
An ƙara tests na model/static/mock domin balance reserve da uncertainty gates.
An gano cewa official pi-backend SDK yana amfani da PI_ENV wajen zaɓar .env.production, ba NODE_ENV kaɗai ba. Client ɗin Mainnet patch yana tabbatar da PI_ENV=production kuma yana ƙin wani value da zai iya juya network configuration.
Trade-offs
Idan API timeout ya faru tun kafin Pi ta aiwatar da external call, marker zai iya barin request a reconciliation har sai an tabbatar da cewa ba a ƙirƙiri payment/transaction ba. Wannan da gangan ne domin fail-closed.
getIncompleteServerPayments a official Pi SDK yana dawo da latest incomplete payment (0 ko 1). Worker ba zai ƙirƙiri sabon payment idan ya ga payment creation marker amma bai iya match ɗin ba.
Cumulative calculation yana amfani da withdrawal_requests a matsayin accounting register na withdraw requests. Idan akwai wasu external/manual payouts da ba su da corresponding paid withdrawal request row, wannan helper ba zai san da su ba. Ana buƙatar reconciliation na legacy history kafin activation.
Abubuwan da ba a canza ba
Babu canjin fee schedule, stake, reward, treasury, liquidity ko transaction records.
Babu live transaction, Pi API, Supabase apply, GitHub commit ko Render deployment.
Hard gate na A2U Mainnet ya kasance a kashe.
Risk status
Patch ɗin bai dace da Mainnet ba har sai Pi ta bayyana A2U Mainnet a hukumance, PostgreSQL tests sun wuce, Pi Testnet integration tests sun wuce, lockfile/build ya wuce, sannan an yi review da izini daban.
