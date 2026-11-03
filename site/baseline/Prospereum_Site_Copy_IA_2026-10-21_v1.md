# Prospereum.io — Site Copy, Information Architecture and Token Page Spec v1

Prepared by Fire for Shu Li and Jason Li — 2026-10-21 — Working draft, buildable now; no deploy, no spend, no DNS change in this document

Basis: Public Whitepaper v3.4 (public sections only), the Site Plan v1 of 2026-10-16, and a live read of Base mainnet this morning. Rules: supply facts stated, value expectations never; no yield or rebate projections; the internal rationale is not used anywhere.

Live chain read (https://mainnet.base.org, block 52,900,163, 2026-10-21 13:34:33 UTC): PSRE token 0x2fE08f304f1Af799Bc29E3D4E210973291d96702; totalSupply 8,400,000 exactly, so emitted to date is 0; Treasury Safe 0xa9Fde837EBC15BEE101d0D895c41a296Ac2CAfCe holds 4,000,000.000003 PSRE; Uniswap v3 pool 0x0adc6be14e76b89584216fad4e458df5f996d336 has code, fee tier 1%, holds 199,999.90 PSRE. A cap() call reverted; the 21M cap is an immutable per the whitepaper and the exact getter name must come from the ABI.

## 1. Information architecture

Seven pages. Top nav: Home · What PSRE is · How you earn it · Where you can use it · Token · Partners & Developers. "Team access" (the existing password gate) sits in the footer only.

<!-- widths: 1.5,3.6,1.9 -->
| Page | One-sentence purpose | Live data |
|---|---|---|
| Home | One screen on what Prospereum is; send each visitor to the right door. | Total supply, emitted to date |
| What PSRE is | Define the token in plain words, including what it is not. | None |
| How you earn it | Proof of Prosperity: rewards exist only when a brand's customers hold more PSRE than ever before. | None |
| Where you can use it | Live partners as they launch; until then, how to become one. | PartnerVault count (view function to confirm) |
| Token | Supply facts and live state read from the chain, with contract links. | Supply, emitted, cap, treasury, pool, block |
| Partners & Developers | The vault model in two paragraphs; repo, addresses, audit. | Contract addresses (static) |
| Team access | Existing password gate; unchanged. | None |

Footer on every page: contract address (BaseScan link) · audit report · public whitepaper PDF · partnerships@prospereum.io · one legal line (Section 4, item 5). Security/Governance is folded into Partners & Developers; Dashboard and Updates come after launch.

## 2. Page copy

### 2.1 Home

**Headline:** Rewards that are real.

**Sub-headline:** Prospereum turns loyalty points into PSRE, a token on Base that customers actually own. Brands give it as purchase rewards. Customers keep it, trade it, or spend it with any partner.

**Three doors**

- **I run a brand.** Replace points that expire with a reward your customers keep. → How you earn it
- **I got PSRE from a brand.** It is yours: hold it in the app, move it to your wallet, use it with other partners. → Where you can use it
- **I want the numbers.** Supply, emission, contracts, live from the chain. → Token

**Live strip (reads from chain, refreshed every 60 seconds):** Total supply 8,400,000 PSRE · Emitted through rewards 0 PSRE · Cap 21,000,000 PSRE · Block 52,900,163

**Three facts**

- **Capped for good.** 21 million PSRE, ever. Written into the contract; no vote can change it.
- **Earned, not printed.** 12.6 million PSRE can only enter the world when a brand's customers hold more PSRE than they ever have. No growth, no new PSRE.
- **Launched in the open.** Live on Base since 22 April 2026. No pre-sale, no ICO, no insider discount. Audited by BlockApex, 29 findings, all resolved before launch.

**Closing line:** Loyalty points were a promise. PSRE is a thing.

### 2.2 What PSRE is

**Headline:** A reward you own.

Points expire, shrink, and only work in one shop. PSRE is a token on the Base blockchain, so when a brand gives it to you, it is yours. Nobody can expire it, and you are not locked to the brand that gave it.

**What you can do with it**

- Keep it in the brand's app, no wallet or crypto knowledge needed.
- Move it to your own wallet at any time.
- Use it with any Prospereum partner, or trade it on a decentralised exchange.

**Where it comes from**

- 8.4 million PSRE were created at launch: 4.2 million for the team (locked four years, one-year cliff) and 4.2 million for the treasury, which seeded the first trading pool.
- 12.6 million sit in a reserve that opens only through Proof of Prosperity. As of today, zero has been released.
- 21 million is the ceiling. The contract will not mint a token past it.

**What PSRE is not**

PSRE is not a share in any company. It pays no dividends, carries no vote, and holding it does not entitle you to anyone's revenue. It is a reward token used inside the Prospereum network.

### 2.3 How you earn it

**Headline:** Proof of Prosperity, in plain words.

Most tokens are mined by computers or printed by a team. New PSRE is released only when a brand's customers, together, hold more PSRE than they ever have before.

**The whole mechanism**

1. **A brand joins** by creating a PartnerVault and buying at least $500 of PSRE. That first buy earns nothing; it is the entry ticket.
2. **The brand rewards its customers** in PSRE on every purchase. Each customer gets a CustomerVault inside the brand's app. It feels like any rewards balance.
3. **Every week the protocol takes a reading** of the brand's ecosystem: PSRE in its vault plus PSRE in its customers' vaults.
4. **If the reading beats the brand's all-time high,** the protocol releases a small amount of new PSRE as a reward for that growth. 70% goes to the brand's customers through the partner reward; 30% goes to stakers who lock PSRE to support the network.
5. **If the reading is flat or lower, nothing is released.** The high-water mark stays where it was; rewards resume when growth resumes.

**Three rules that keep it honest**

- **Reward PSRE never counts twice.** PSRE the protocol released is excluded from future readings, so rewards cannot compound on themselves.
- **The bar only rises.** Buying PSRE to fake growth means raising your own all-time high every time; the only cheap way to earn is real customers holding real rewards.
- **It gets harder.** The more of the 12.6 million reserve has been released, the slower the rest comes out. The reserve opens over years, not months.

**For brands:** steady growth earns and keeps a higher tier (Bronze 0.8×, Silver 1.0×, Gold 1.2×) than one big buy. Rewards are claimable weekly and never expire. **For customers:** nothing to do; rewards reach your vault because your brand grew.

### 2.4 Token

**Headline:** The numbers, straight from the chain.

Everything here is read from Base mainnet when you load the page. The contract is the source of truth.

**Live** (as of block 52,900,163, 21 Oct 2026 13:34 UTC)

- Total supply: 8,400,000 PSRE
- Released through Proof of Prosperity to date: 0 PSRE
- Maximum supply, ever: 21,000,000 PSRE
- Remaining reserve: 12,600,000 PSRE
- Protocol treasury: 4,000,000 PSRE
- Trading pool (Uniswap v3, PSRE/USDC, 1% fee): 199,999.9 PSRE in pool · address linked

**Allocation at launch**

- 12,600,000 (60%) — Proof of Prosperity reserve, released only through verified commerce growth
- 4,200,000 (20%) — Team and founders, four-year vesting, one-year cliff
- 4,200,000 (20%) — Treasury, held in a 2-of-3 multisig; 200,000 seeded the first trading pool

**Contracts on Base (chain ID 8453)** — PSRE token 0x2fE0…6702 · PartnerVaultFactory 0xFF84…6902 · StakingVault 0x684B…ED2D · RewardEngine 0x9Ab3…7EF5 — each linked to BaseScan.

**Rules nobody can change:** the 21 million cap, the 12.6 million reserve, new PSRE only from verified commerce growth. Adjustable parameters (base rate, tier thresholds, weekly ceiling, minimum entry) sit behind a 48-hour timelock; upgrades behind 7 days.

**Audit:** BlockApex, 2–17 April 2026; 29 findings, all resolved before deployment. Report linked.

### 2.5 Where you can use it (short copy)

**Headline:** Partners, announced as they launch. Every brand on Prospereum rewards its customers in the same PSRE, so what you earned in one place works in the next. Brands appear here when their PartnerVault goes live. Want your brand on it? partnerships@prospereum.io.

### 2.6 Partners & Developers (two paragraphs on the vault model)

A **PartnerVault** is a brand's on-chain account with Prospereum. The brand creates it, funds it with PSRE, and distributes rewards from it. The protocol watches one number per vault: PSRE held by the vault and all its customers together. That total, and its all-time high, decide whether the brand earns anything in a given week.

A **CustomerVault** is the customer's balance inside a brand's ecosystem. The brand's app creates it; the customer never touches a key unless they want to, can claim the balance to a personal wallet at any time, and nothing the brand does can take it back. Interfaces, addresses and the audit report are in the public repository (linked).

## 3. Token page specification (read-only)

<!-- widths: 1.6,2.9,2.5 -->
| Stat shown | Source call (Base RPC, eth_call) | Display rule |
|---|---|---|
| Total supply | PSRE token, totalSupply() selector 0x18160ddd | ÷ 1e18, thousands separators, no decimals |
| Emitted to date | totalSupply − 8,400,000 × 1e18 (computed) | "0 PSRE" is shown as 0, never hidden |
| Maximum supply | Constant 21,000,000 until the cap view function is confirmed from the ABI (cap() reverted on 2026-10-21) | Labelled "immutable" |
| Remaining reserve | 21,000,000 − totalSupply (computed) | Same format as supply |
| Treasury balance | balanceOf(Treasury Safe) selector 0x70a08231 | Rounded to whole PSRE; Safe address linked only after Jason confirms publication (decision 3) |
| Pool | balanceOf(pool) on the token; fee() selector 0xddca3f43 on the pool | Shows PSRE in pool and the fee tier; address linked to BaseScan and app.uniswap.org |
| Contract address | Static, from deployments.md | Linked to BaseScan; copy button |
| Last updated | eth_blockNumber + eth_getBlockByNumber timestamp | "Block N, HH:MM UTC" |

**Refresh:** client-side viem reads on page load, cached 60 seconds, re-read on focus. If the RPC fails, show the last cached value with "last read at block N", never a blank or a typed-in number. **Endpoint:** public https://mainnet.base.org in v1; a free-tier keyed endpoint if rate limits bite.

**Not shown, by design:** price, market cap, charts, holder counts, trading volume. Why: the page documents supply mechanics, and a price panel would turn a utility description into an invitation to speculate.

## 4. Decisions for Jason (the only items that block launch)

1. **Domain and DNS.** Who holds prospereum.io (GoDaddy) and the Cloudflare zone; can Fire get delegated DNS or a Pages deploy token? Nothing goes live without it.
2. **Which partners may be named.** May "Where you can use it" name AXIA and Elyxr before their PartnerVaults exist? Draft assumes no ("announced as they launch").
3. **Treasury Safe address.** The technical whitepaper publishes it; the public one does not. Show it on the Token page, or the balance only?
4. **Emission-start statement.** The chain shows zero emitted since 22 April and the draft says so plainly. Confirm, or supply the first-epoch date if a partner is about to go live.
5. **Legal footer text.** Draft: "PSRE is a utility token used within the Prospereum protocol. It is not a share, a deposit or a financial product, and nothing on this site is advice. Published by WealthHealth AI, Inc." Confirm the entity; send counsel's edits.
6. **Analytics.** Cloudflare Web Analytics (no cookies, no banner) is the draft choice. Confirm, or name what you already run.

End of document — Fire, 2026-10-21
