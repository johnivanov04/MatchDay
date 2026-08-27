-- MatchDay — the two push transports, named.
--
-- ── WHY THIS IS A MIGRATION OF ITS OWN ─────────────────────────────────────
--
-- PostgreSQL will not let a value added to an enum be *used* in the same
-- transaction that added it. That does not bite when the type is created from
-- scratch, as both are here — but it bites hard the first time somebody adds a
-- third channel, and by then the columns, constraints and functions that would
-- have to move are considerable. Declaring the types alone, in their own file,
-- means that future migration is a one-line `alter type` with nothing else in
-- it, which is the only shape that is safe.
--
-- ── WHY AN ENUM AND NOT A TEXT CHECK ───────────────────────────────────────
--
-- Both of these are closed sets defined by somebody else. A push transport is
-- one MatchDay implements, and there are two. An APNs environment is one Apple
-- defines, and there are exactly two — `development` and `production` are the
-- only values the `aps-environment` entitlement can hold. Neither is a place
-- where an unexpected string should be storable at all.

create type public.push_channel as enum (
  -- The W3C Web Push protocol: a browser-issued endpoint URL plus the two
  -- encryption keys. Every subscription that existed before this migration.
  'web_push',
  -- Apple Push Notification service, spoken directly over HTTP/2 to a device
  -- token. Only the native iOS app produces these.
  'apns'
);

comment on type public.push_channel is
  'How a push subscription is delivered to. Determines which columns of '
  'push_subscriptions are populated — see push_subscriptions_channel_shape.';


-- ── APNs environment ───────────────────────────────────────────────────────
--
-- Not a detail: it selects the *host* a notification is sent to, and a token
-- minted in one environment is meaningless in the other. Sending a production
-- token to `api.sandbox.push.apple.com` returns BadDeviceToken, and the device
-- goes quiet with no other symptom.
--
-- It is recorded per row rather than inferred, because it cannot be inferred.
-- The environment is a property of the *binary* — the `aps-environment`
-- entitlement Xcode signs in, `development` for a development build and
-- `production` for anything from TestFlight or the App Store — and it is not
-- recoverable from the token, whose bytes are opaque and identically shaped in
-- both. The app reads its own signed entitlement and reports it.

create type public.apns_environment as enum ('development', 'production');

comment on type public.apns_environment is
  'Which APNs host a device token belongs to. Reported by the app from its own '
  'signed aps-environment entitlement; never inferred from the token.';
