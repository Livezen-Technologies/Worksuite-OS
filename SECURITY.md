# Security policy

## Reporting a vulnerability

Please report security vulnerabilities privately. Do not open a public issue, pull request or discussion for them.

Use GitHub's private vulnerability reporting: open the repository's **Security** tab and choose
**Report a vulnerability** (<https://github.com/Livezen-Technologies/Worksuite-OS/security/advisories/new>).

Please include:

- the component affected (for example the shell, a service under `services/`, the installer, the image build or the
  server), and the commit or release version;
- what an attacker can do, and what access they need (remote, local user, physical access);
- steps to reproduce, or a proof of concept;
- any fix or mitigation you suggest.

## What happens next

- We acknowledge your report within 3 working days.
- We send a first assessment (whether we can reproduce it, and how severe it is) within 10 working days.
- We keep you informed while we work on a fix. We aim to release fixes for critical and high-severity issues within
  30 days, and for others in a later scheduled release.
- We publish a GitHub security advisory when the fix ships. We credit you there unless you ask us not to.

Please give us a reasonable time to release a fix before you disclose the issue publicly. We will agree a disclosure
date with you. By default it is 90 days after your report, or the date the fix ships if that is sooner.

## Scope

In scope: everything in this repository, including WorkSuite OS images and packages built from it, the WorkSuite
services, the shell, the installer and the WorkSuite server.

Out of scope:

- vulnerabilities in upstream Debian packages, the Linux kernel, Electron or Chromium, unless WorkSuite's
  configuration or patches cause them. Report those upstream; tell us too if WorkSuite OS ships the affected version;
- denial of service that needs physical access to an unlocked device;
- findings from automated scanners without a demonstrated impact.

## Supported versions

Security fixes go to the latest release on the stable update ring and to `main`. Devices receive them through
WorkSuite updates. Older releases are not patched separately.

## Safe harbour

We will not take legal action against you for research done in good faith under this policy: test only against
systems and data you own or are allowed to test, do not access or change other people's data, and do not degrade
services for other users.

Hardening that ships today is described in [docs/security/hardening.md](docs/security/hardening.md).
