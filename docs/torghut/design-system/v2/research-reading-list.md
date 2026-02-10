# Research Reading List (LLM + Quant Trading Systems)

## Status
- Version: `v2`
- Last updated: **2026-02-10**

## Purpose
Curate high-signal public material for designing and operating a production-grade autonomous trading system with a
bounded intelligence layer.

This is not investment advice. Most top trading firms do not publish their live strategies. Public material tends to be
high-level and focuses on process, risk, and tooling rather than alpha specifics.

## Top-Firm And Industry Research (Public)

### Two Sigma (AI in investment management)
- AI in Investment Management: 2026 Outlook (Part I) (2026-01-30)
  - https://www.twosigma.com/articles/ai-in-investment-management-2026-outlook-part-i/
  - Notes:
    - Useful for framing agentic AI adoption as a disciplined engineering program.
- AI in Investment Management: 2026 Outlook (Part II) (2026-01-31)
  - https://www.twosigma.com/articles/ai-in-investment-management-2026-outlook-part-ii/

### Man Group / Man Institute (systematic + ML)
- A Regime-Switching Approach to Alternative Risk Premia (2025-03-27)
  - https://www.man.com/maninstitute/a-regime-switching-approach-to-alternative-risk-premia
- What AI Can (and Can't Yet) Do for Alpha (2025-11-13)
  - https://www.man.com/maninstitute/what-ai-can-and-cant-yet-do-for-alpha
  - Notes:
    - Contains a concrete "AlphaGPT" pipeline concept (idea generation -> coding -> backtesting) that maps well to a
      Torghut research lane, but still requires strong overfitting controls.

### AQR (systematic investing + ML framing)
- The Virtue of Complexity in Return Prediction (2024-03)
  - https://www.aqr.com/Insights/Research/Journal-Article/The-Virtue-of-Complexity-in-Return-Prediction
- Can Machines Build Better Stock Portfolios? (2024-11)
  - https://www.aqr.com/Insights/Research/Journal-Article/Can-Machines-Build-Better-Stock-Portfolios
- A New Paradigm in Active Equity? (2025-02)
  - https://www.aqr.com/Insights/Research/Alternative-Thinking/A-New-Paradigm-in-Active-Equity
  - Notes:
    - Useful for setting expectations: ML and even LLMs can help, but production value comes from disciplined
      deployment, governance, and evaluation.

## LLM Safety And Agentic Systems
- OWASP Top 10 for LLM Applications
  - https://owasp.org/www-project-top-10-for-large-language-model-applications/
- NIST AI RMF Generative AI Profile
  - https://www.nist.gov/publications/artificial-intelligence-risk-management-framework-generative-artificial-intelligence
- Microsoft: Defending against indirect prompt injection (2025-07-22)
  - https://www.microsoft.com/en-us/msrc/blog/2025/07/how-microsoft-defends-against-indirect-prompt-injection-attacks/

## Quant Research That Transfers To Production

### Backtest validity and data snooping
- White's Reality Check for data snooping (2000)
  - https://www.econometricsociety.org/publications/econometrica/2000/09/01/reality-check-data-snooping
- Probability of Backtest Overfitting (CSCV / PBO)
  - https://scholarworks.wmich.edu/math_pubs/42/
- Deflated Sharpe Ratio
  - https://www.pm-research.com/content/iijpormgmt/40/5/94

### Execution and market impact
- Almgren-Chriss optimal execution (2001)
  - https://www.math.nyu.edu/faculty/chriss/optliq_f.pdf

### Trend / time-series momentum
- Time Series Momentum (Moskowitz, Ooi, Pedersen)
  - https://pages.stern.nyu.edu/~lpederse/papers/TimeSeriesMomentum.pdf

## How This Maps To Torghut (Practical)
- Use Two Sigma / AQR / Man material to set process expectations and governance.
- Use the academic references to enforce validity and cost realism.
- Do not treat LLM papers as an excuse to let models bypass deterministic controls.

Suggested next internal deliverables:
- A "research ledger" data model (runs, datasets, parameter search count, results).
- A replay/simulation harness that can reproduce results deterministically.
- A hardened order firewall + kill switch architecture.
