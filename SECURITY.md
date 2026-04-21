# Security Policy

## Supported Versions

Only the latest minor release is supported with security fixes.

## Reporting a Vulnerability

Please do not open public issues for vulnerabilities.

Report security issues privately to the maintainers with:

- impact summary
- reproduction steps
- affected version
- suggested fix (optional)

If the report is valid, we will acknowledge it and work on a fix as soon as possible.

## Secret Handling

- Never commit `privateKey`, tokens, or other credentials.
- Use local runtime configuration and secret management in CI/CD.
- Rotate credentials immediately if exposure is suspected.
