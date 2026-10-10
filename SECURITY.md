# Security — حصيلتي (Hasila)

## Known npm audit findings

All findings flagged by `npm audit` are in **devDependencies** (build
toolchain only) and do not affect the shipped APK or AAB that users
download from Google Play.

| Package | Severity | Who is at risk | Planned fix |
|---|---|---|---|
| tar (via @capacitor/cli) | Critical | Build environment only | Capacitor 8 migration (Phase C) |
| @capacitor/cli | High | Build environment only | Capacitor 8 migration |
| vite | High | Dev server (Windows UNC path, NTLMv2) | Vite 8 migration |
| esbuild | Moderate | Dev server only | Fixed by Vite 8 migration |

### Why we are not force-upgrading now

- @capacitor/cli 6 → 8 requires regenerating the entire android/ project,
  updating Gradle scripts, re-testing all Capacitor plugins, and verifying
  the full APK. This is scheduled for Phase C.
- vite 5 → 8 drops CommonJS support and has multiple breaking API changes.
  It needs a dedicated migration and build-verification cycle.

Forcing these upgrades without proper testing introduces a higher risk of
build failure than the theoretical build-time vulnerabilities they fix.

### What is safe in the shipped app

- The published APK/AAB contains no tar, no vite, and no esbuild.
- The CI environment (GitHub Actions, ubuntu-latest) is not vulnerable to
  the Windows-specific UNC-path exploit in vite.
- No user data is involved in any of these build-tool operations.
