# Privacy notice

The Dinkel Portal is a private, noncommercial tool run by and for the members of one
fantasy football league. It is not a product, it is not sold, and it carries no
advertising.

Yahoo's API Terms of Use require an accessible privacy policy that accurately
describes what is collected, used, shared, and retained. This is that notice.

## Who runs this

The league's commissioner operates the deployment. There is no company behind it and
no third party with access to the data.

## What is stored, and for how long

### Stored indefinitely

| Data                            | Why                                                                                                                                                                                          |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Yahoo GUID                      | Identifies your account at sign-in. This is one of the few values Yahoo's terms permit storing indefinitely.                                                                                 |
| Yahoo access and refresh tokens | Encrypted with AES-256-GCM. Needed to read league data on your behalf.                                                                                                                       |
| Your display name               | Prefilled from your Yahoo nickname and confirmed by you, after which it is this application's data. It labels league records that outlive a Yahoo connection.                                |
| Your portal role                | Commissioner, manager, or read-only. Set in the portal, independent of Yahoo.                                                                                                                |
| Optional email address          | Only if you provide one. Not used to send anything in the current version.                                                                                                                   |
| League records                  | Dues, payouts, prize structure, rules, weekly challenge outcomes, draft-order history, announcements, recaps, import history, and audit records. This is the league's own data, not Yahoo's. |

### Stored for at most 24 hours

Everything read from Yahoo — team names, manager nicknames, scores, rosters,
standings, matchups, transactions, draft results, and player statistics — is fetched
live when a page loads and held in a short-lived cache. Most entries expire in two
to sixty minutes; none may exceed 24 hours, which the database enforces through a
time-to-live attribute rather than relying on application code.

This is a requirement, not a preference. Yahoo's API Terms of Use state that data
not explicitly identified as storable indefinitely must be removed within 24 hours
of being obtained.

There is no permanent copy of Yahoo data. No player table, no roster history, no
statistics warehouse.

### Finalized league outcomes

When a weekly challenge is finalized, the portal keeps the season, the week, the
challenge, the winning member, the winning value, a sentence explaining the
arithmetic, and the payment status. The Yahoo response used to compute it is not
kept.

## Uploaded files

CSV files used to import legacy league history are processed and discarded. The text
is not written to persistent storage during a dry run, and the temporary upload
bucket — when used — is encrypted and deletes objects automatically after seven
days. The original file is not needed after a successful import.

## What the portal can do in Yahoo

Nothing. It requests **read-only** Fantasy access and performs no write operation of
any kind: it cannot change your lineup, make transactions, act as commissioner, or
set draft order. Yahoo's current documentation describes no write endpoints, and the
portal does not use undocumented ones.

## What is not done

- No payment processing, fund holding, money transfer, or percentage of any prize.
  Dues and prizes are recorded as internal administrative notes; money changes hands
  entirely outside this software.
- No advertising, analytics, tracking pixels, or third-party scripts.
- No selling, sharing, or transferring of data to anyone.
- No email or SMS is sent in the current version.
- No Google account, Google Sheets, or Google Drive integration.
- No scraping of Yahoo's website and no browser automation.

## Language models

Weekly recaps may be phrased by a language model (Claude), and only when a
commissioner has configured an API key. The model receives a small set of already
computed facts — scores, winners, values — and writes prose around them. It never
computes a score, a ranking, or a winner, and every recap requires commissioner
review before publication.

## Removing your data

- **Disconnect Yahoo.** Use "Remove Yahoo connection" on the dashboard. This deletes
  the stored tokens and every cached Yahoo response for your account immediately.
- **Remove your account.** Ask the commissioner. Your portal user, sessions, and
  connection are deleted.

Historical league records that reference you — a 2021 challenge win, a dues payment —
are the league's own bookkeeping and are kept by default, since deleting them would
falsify the league's history. Ask the commissioner if you want your name replaced in
those records with an anonymous label.

You may also revoke this application's access directly from Yahoo's account settings
at any time, independently of anything in the portal.

## Changes

Material changes will be noted here and announced in the portal.

## Contact

Ask the league commissioner, or open an issue at
<https://github.com/thelopie/commissioner-tools>.

---

Not affiliated with, endorsed by, or sponsored by Yahoo. Yahoo is a trademark of its
respective owner.
