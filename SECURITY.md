# Security and private data

Do not publish account tokens, proxy subscription links, browser profiles,
cookies, certificates, environment export bundles or customer orders in issues.
Use GitHub private vulnerability reporting when available, or contact the
maintainer privately before sharing sensitive reproduction material.

The application stores runtime data under Electron's per-user data directory;
the optional Mihomo manager uses the user's application-data directory. These
directories and downloaded proxy configurations are not source distribution
assets. Environment exports can include sensitive session material: review
their contents before sharing them.

CI uses synthetic local fixtures and never logs into a real customer account,
executes a real purchase or claims third-party detector acceptance. A passing
build does not guarantee anonymity, service eligibility or avoidance of risk
controls. Public preview packages remain unpublished drafts until their stated
acceptance scope has been reviewed.
