# Disabled hosted package manager

This is JEFF's own fail-closed package, not an upstream npm release or a vulnerability patch. The root dependency override installs it in place of OpenClaw's npm dependency. It contains no dependencies, package installation, network access or subprocess execution. Imports throw and npm/npx entrypoints exit 78 with JEFF_PACKAGE_MANAGEMENT_DISABLED.

JEFF's restricted hosted runtime disables external tools and package-management actions. This artifact removes an unused bundled dependency surface from that runtime. It is unsuitable for a general OpenClaw installation that needs package management, plugin installation or self-updates. Those features require a separately reviewed artifact and explicit enablement.

The repository's development package manager and Docker's npm ci use the Node distribution's npm, before the hosted dependency override is installed. The final installed tree, actual OpenClaw CLI and disabled entrypoints must all be verified on each release.
