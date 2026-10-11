# Voice chat deployment

Voice signaling requires the existing PostgreSQL database. The application creates `strike_voice_signals` and its indexes idempotently at runtime; the matching SQL migration is `src/db/migrations/0001_voice_signals.sql` for managed deployments.

The site must be served over HTTPS for microphone access on desktop and Android. STUN is enabled by default. For networks that block direct peer connections, configure a TURN service with `TURN_URL`, `TURN_USERNAME`, and `TURN_CREDENTIAL`. `TURN_URL` accepts comma-separated `turn:` or `turns:` URLs. The configured TURN credentials are returned only to authenticated room members, so use short-lived, restricted credentials from a TURN provider rather than a long-lived account secret.

Signaling messages expire after three minutes and expired rows are periodically deleted. Each connected client polls room presence and messages once per second.
