# Requirements register

The register lives in [`requirements.json`](requirements.json) and is rendered
to [`requirements.html`](requirements.html) by `node tools/reqpage.mjs`: every
piece of review feedback as a numbered requirement, with status, dates, the
check that closes it, and a proof screenshot captured from the current build by
`node tools/proof.mjs`. Filter and sort in the page.

Statuses: `DONE` (met and shown), `WATCH` (met, but has regressed at least once
or sits below the bar asked for), `OPEN` (not met).
