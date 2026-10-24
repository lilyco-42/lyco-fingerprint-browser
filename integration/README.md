# Real Chromium startup checks

The dedicated private Linux Actions workflow runs the actual `CdpClient` and existing configuration script against a pinned stock Chrome Headless Shell. It checks an explicitly synthetic User-Agent marker and configured language/platform/CPU/timezone on the first request and first synchronous page script. A separate ordinary target is created without harness-side configuration or resume, and a deliberately invalid timezone tests a real command refusal. Fixture observations retain the first result rather than replacing it with later reads.

Only self-owned loopback fixtures are visited. The browser's outbound proxy points to a closed loopback port. Public browser dependencies and Debian packages are downloaded and checked/extracted inside the job; system packages are not installed. The job runs as an isolated unprivileged account. All product execution remains in GitHub Actions.

This is Linux headless CI with the test-only `--no-sandbox` flag. It is not a Windows installer, desktop UI, session-restore, worker/iframe identity, full privacy or third-party eligibility test. A green result for these assertions cannot prove that another service will not detect or restrict an account. No detector, score or production identity values are changed by the harness.

The existing unit workflow still tests mocked transports separately; passing those tests is not proof of these browser assertions. The dedicated browser workflow never skips unavailable dependencies and never converts a missing browser or failed check into a pass.
