# Sign-in

The app does not use passwords. Instead, it signs users in with an email link (also called a "magic link") to verify their identity. When a user requests a sign-in link, the app stores a time-limited, single-use verification code and emails a link back through an SMTP server.

Set `SMTP_HOST` to the SMTP server hostname, for example `smtp.example.com`. It is required in production, and the app will not start without it.

Set `SMTP_USER` and `SMTP_PASSWORD` to the credentials for that server. Both are required in production, and the app will not start without them. Treat the password as a secret; the app never logs it.

Set `SMTP_PORT` only if the server does not use the default port `587`. Port `465` uses TLS from the start. Every other port upgrades to TLS with STARTTLS when the server offers it.

Set `SIGNIN_SENDER_EMAIL` to the full sender address, for example `login@example.com`. It is required in production, and the app will not start without it. It does not have to match the hostname in `PUBLIC_ORIGIN`.

For example, with [Resend](https://resend.com/settings/smtp):

- `SMTP_HOST`: `smtp.resend.com`
- `SMTP_USER`: `resend`
- `SMTP_PASSWORD`: a Resend API key
