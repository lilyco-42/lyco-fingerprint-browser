# Real Chromium startup checks

The dedicated private Linux Actions workflow runs the actual `CdpClient` and existing configuration script against a pinned stock Chrome Headless Shell. It checks an explicitly synthetic User-Agent marker and configured language/platform/CPU/timezone on the first request and first synchronous page script. A separate ordinary target is created without harness-side configuration or resume; its owned fixture cookie must survive request continuation. Deliberately invalid timezones test command refusal on both initial and new pages. Fixture observations retain the first result rather than replacing it with later reads.

For new debugger-waiting pages, Chromium cannot acknowledge renderer configuration while its initial Document is held. The controller aborts that provisional navigation before it reaches the server, configures the resulting local error document, disables startup interception and replays an HTTP(S) GET with its original referrer. Cookies use the browser's normal cookie jar; raw headers are not copied into a second request. A new-target POST or other unsafe replay is refused explicitly. Already-ready tabs retain ordinary navigation behavior. The fixture records only whether its own synthetic cookie arrived.

The raw-CDP control records command acknowledgements with and without request interception, without applying identity settings. It is a transport diagnostic and never substitutes for the four product assertions.

Only self-owned loopback fixtures are visited. The browser's outbound proxy points to a closed loopback port. Public browser dependencies and Debian packages are downloaded and checked/extracted inside the job; system packages are not installed. The job runs as an isolated unprivileged account. All product execution remains in GitHub Actions.

This is Linux headless CI with the test-only `--no-sandbox` flag. It is not a Windows installer, desktop UI, session-restore, worker/iframe identity, full privacy or third-party eligibility test. A green result for these assertions cannot prove that another service will not detect or restrict an account. No detector, score or production identity values are changed by the harness.

The existing unit workflow still tests mocked transports separately; passing those tests is not proof of these browser assertions. The dedicated browser workflow never skips unavailable dependencies and never converts a missing browser or failed check into a pass.
