# Third-party notices

The application is based on [taills/Mirage-Browser](https://github.com/taills/Mirage-Browser),
upstream revision `d31e14887ae75863693070acead8c624224ad0eb`. Its MIT copyright
and license are retained in `LICENSE`. LYCO modifications are distributed under
that MIT license. Individual dependencies retain their own licenses.

Electron is an MIT-licensed framework that includes Chromium and other
components with their own notices. Retain the license/notice files produced by
Electron Forge in the application package. `package-lock.json` records the
application's JavaScript dependency versions.

Mihomo is an optional, separately downloaded proxy executable maintained by
[MetaCubeX/mihomo](https://github.com/MetaCubeX/mihomo). It is not checked into
this source repository or bundled by this project's Forge configuration. Follow
its upstream license and source/distribution requirements if redistributing it.

Managed Chrome/Chromium executables and user-installed fonts are external to
this source distribution. The Linux CI browser is a pinned Chrome for Testing
dependency used only on disposable GitHub-hosted runners; it is not included in
the application installer. This repository does not redistribute Wayfern.
