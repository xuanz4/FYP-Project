## Plan: UNIWEB Local Card Payments Transaction Monitoring Scope

The current implementation is feasible for UNIWEB as a focused prototype for local card-payment monitoring, but it should be reframed to reflect a merchant-agnostic design. The system should be presented as capable of monitoring transactions for any merchant, while using MCC codes and Singapore regulatory context to assess merchant risk.

**What the current code does well**
- It already models card-oriented merchant risk scenarios and transaction monitoring logic.
- It supports card-related behavioural patterns such as unusual spend, burst activity, threshold avoidance, and new-customer anomalies.
- It is suitable for a Singapore-focused MVP because the use case is practical and relevant to merchant payments.

**Updated scope and data requirements**
- The system is limited to local card payments only.
- It should support any merchant, regardless of industry.
- Merchant risk should be assessed using the MCC code in line with Singapore regulatory and compliance expectations.
- The rules and monitoring logic should apply universally across merchants rather than being tied to a fixed set of example industries.
- High-risk jurisdiction should be treated as a contextual escalation signal for manual review rather than as a core payment-type rule.

**Where the current scope is not fully aligned**
- The current examples and wording should not imply that the system is limited to a small set of merchant types.
- The monitoring logic should be framed as merchant-agnostic and driven by merchant profile data, especially MCC-based risk classification.
- Documentation and messaging should clearly state that the system is configured for local card payments only, while supporting any merchant profile.
- The rule set should focus on card-payment anomalies, behavioural risk, merchant profile risk, and review escalation rather than transfer or crypto activity.
- The codebase should resolve the duplicate `app.js` confusion by clearly separating server-side and client-side responsibilities or merging overlapping functionality into a single maintained entry point.

**Recommended plan**
1. Reframe the system purpose around UNIWEB’s domestic card-payment monitoring offer for merchants in Singapore.
2. Keep the monitoring logic centred on card-payment behaviour and merchant risk assessment using MCC code.
3. Make the rules apply to any merchant, regardless of industry, while keeping the scope limited to local card payments.
4. Treat crypto, wire transfers, money transfers, and other non-card flows as out-of-scope examples only.
5. Use high-risk jurisdiction as a supporting compliance escalation factor for manual review, rather than as a primary payment-type trigger.
6. Ensure the user-facing language, system startup message, and documentation clearly state the local card-only scope and the MCC-driven merchant-risk approach.

**Feasibility assessment**
- Yes, the scope is feasible for UNIWEB and appropriate for a merchant payments company.
- It is especially suitable for a prototype or academic demonstration because the focus is clear, realistic, and aligned with Singapore merchant monitoring needs.
- The main requirement is to present the system as merchant-agnostic, MCC-based, and limited to local card payments rather than as a fixed industry-specific solution.