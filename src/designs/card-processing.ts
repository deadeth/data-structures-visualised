import type { Design } from './types';

/**
 * Credit card processing system, as a high-level design.
 *
 * Seen from the issuer: the party that issued the card and must approve or
 * decline each purchase inside the network's time limit, then keep the money
 * right through clearing, settlement and reconciliation. The baseline is a
 * UK business-card issuer with about a million cards on Mastercard, connected
 * to the network from two data centres. The framings cover the acquirer or
 * payment service provider view (a merchant sends you a charge), issuing on a
 * processor platform, and network scale.
 */
export const cardProcessing: Design = {
  id: 'card-processing',
  name: 'Credit card processing system',
  blurb: 'Follow one card purchase to settlement, then open any part to see what it does and what you could use instead.',
  rest: 'Press Play to follow one tap, or open any box or chip. In the diagram, arrow keys move and Enter opens.',
  restTouch: 'Press Play to follow one purchase, or tap any box or chip to open it.',
  size: { w: 1280, h: 520 },
  frame: { x: 170, y: 22, w: 720, h: 372, label: 'Issuer processor × 2 sites', note: 'Target: under 1 second' },

  components: [
    {
      id: 'merchant',
      name: 'Merchant and acquirer',
      short: 'Merchant',
      tech: 'and acquirer',
      x: 70, y: 96, w: 124, h: 64, kind: 'outside',
      what: 'The card reader at the till and the merchant\'s bank, the acquirer, which connects it to the card network. The chip or phone adds a one-time cryptogram to each purchase, and the acquirer turns it into an authorisation request.',
      why: 'We do not run it, but its habits shape our design. Terminals time out, retry and send reversals when they lose their link. Some purchases are approved offline by the card itself, so we first hear of them in clearing.',
      built: [
        { name: "Merchant", what: "The business selling the goods, here a restaurant in Dublin, with its card terminal at the till. The terminal reads the chip or phone and sends the purchase to the merchant's bank.", why: "We do not run it, but its habits shape the design: terminals time out, retry, and send reversals when they lose the link. So every request must be safe to receive twice, and every hold needs an expiry as a backstop." },
        { name: "Acquirer", what: "The merchant's bank. It connects the merchant's terminals to the card networks, adds the merchant's details to each purchase and sends the authorisation request on.", why: "Each bank connects once, to the network, not to every other bank. We never talk to the acquirer directly: we see its requests as 0100 messages from Mastercard, and its final amounts in the clearing files." },
      ],
      numbers: [
        {
          text: 'Acquirers and terminals wait longer than the issuer is allowed: 25 seconds or more at a till (Visa patent background).',
          from: 'Not a sum. Taken from a source cited on the page: the background section of Visa patent US12118555. Visa and Mastercard publish no figure, so this is a patent\'s description of common practice, not a scheme rule.',
        },
        {
          text: 'An unused card-present hold lapses after 2 days on Mastercard and about 5 on Visa (Stripe\'s published windows).',
          from: 'Not a sum. Taken from a source cited on the page: Stripe\'s guide to placing a hold, which lists authorisation windows by network. They are Stripe\'s published windows, not the networks\' rule books.',
        },
      ],
      fails: 'The terminal loses its link after we approve. It sends a reversal, or nothing at all. A reversal releases the hold at once, and the hold\'s expiry is the backstop when nothing comes.',
      alternatives: [
        {
          name: 'Card present, authorised online by the issuer', chosen: true, good: 'Every purchase asks us, so controls and balance are exact.', cost: 'We have to be up. When we are not, the network answers for us.',
          what: "The chip or phone makes a cryptogram for this purchase, and the acquirer sends it through Mastercard to our gateway as an 0100. Every tap meets the authoriser's checks before a hold is placed. It is the case the tour follows.",
          pros: [
            'A freeze or a limit set in the app takes effect on the next tap.',
            'The hold is placed at the moment of purchase, so the available balance is exact.',
            'The cryptogram, checked in the HSM, makes a copied card hard to use.',
          ],
          cons: [
            'We must answer every request in time, from either site, at any hour.',
            'When we cannot, the network answers for us by stand-in, on parameters set in advance.',
            'Terminals retry and reverse, so every request must be safe to receive twice.',
          ],
        },
        {
          name: 'Offline approval by the chip', good: 'Works with no connection, as on some transit and in-flight purchases. The card\'s own counters cap the risk.', cost: 'We learn of it only in clearing, and must post it even if the balance no longer covers it.',
          what: 'The chip decides on its own, within limits and counters the issuer wrote to it, and the terminal stores the purchase. Nothing reaches our gateway. The first we hear is a clearing record with no hold, which clearing posts anyway.',
          pros: [
            'Works with no connection at all, as on some transit and in-flight purchases.',
            "The card's own counters cap how much can be spent before it must go online.",
            'Adds no load to the authorisation path.',
          ],
          cons: [
            'We learn of the purchase only in clearing.',
            'It must be posted even if the balance no longer covers it, so the account can go negative.',
            'A freeze or a control set in the app cannot stop it at the till.',
          ],
        },
        {
          name: 'Card not present, with 3-D Secure', good: 'An online purchase arrives with the result of strong customer authentication, and the merchant is protected from liability for fraud when it is used.', cost: 'An extra step for the cardholder, and the issuer must answer the authentication request as well.',
          what: 'An online checkout first asks the issuer to authenticate the cardholder, by app, code or biometrics. The 0100 then arrives with the result, and the authoriser takes it as one more check before controls, fraud and funds.',
          pros: [
            'Strong customer authentication rules in the UK and EEA can require it, so it must be supported anyway.',
            'The merchant is protected from liability for fraud when it is used.',
            'A passed check is a strong sign the real cardholder is paying.',
          ],
          cons: [
            'An extra step for the cardholder at checkout.',
            'The issuer must answer the authentication request as well as the authorisation.',
            'No chip cryptogram, so the authoriser leans more on the fraud score.',
          ],
        },
      ],
      say: 'I would draw the four parties first: cardholder, merchant and acquirer, network, issuer. Then say which one we are. Here we are the issuer: the network asks, and we must answer in time.',
    },
    {
      id: 'network',
      name: 'Card network',
      short: 'Network',
      tech: 'Mastercard',
      x: 70, y: 226, w: 124, h: 64, kind: 'outside',
      what: 'Routes each authorisation from the acquirer to the issuer by the card\'s number range, carries clearing files between them in batches, and works out every bank\'s net position for settlement. If the issuer does not answer in time, it answers on the issuer\'s behalf: stand-in processing.',
      why: 'Each bank connects once, to the network, rather than to every other bank. The network sets the rules: message formats (dialects of ISO 8583), time limits, dispute rules and fees.',
      built: [
        { name: "Mastercard", what: "A card network: the company between issuers and acquirers. It routes each authorisation by the card's number range, carries clearing files between banks, works out each bank's net position for settlement, and answers for an issuer that is down (stand-in processing).", why: "The baseline is a UK business-card issuer on Mastercard, connected directly from two data centres. The page keeps to one network as a simplification; a second would bring its own message dialect, rules and files." },
      ],
      numbers: [
        {
          text: 'Visa gives VisaNet a capacity of over 65,000 transaction messages a second (Visa, 2019).',
          from: 'Not a sum. Taken from a source cited on the page: Visa\'s July 2019 fact sheet. It is capacity, not traffic, and it is Visa\'s figure; this design is on Mastercard. Compare our own yearly peak of about 135 messages a second.',
        },
        {
          text: 'Mastercard runs clearing six times a day; issuers may take all six, but four or five are usually enough (Paymentology).',
          from: 'Not a sum. Taken from a source cited on the page: Paymentology\'s guide to clearing, settlement and reconciliation.',
        },
        {
          text: 'Visa Research gives a stand-in approval rate of 67 per cent against 93 per cent when issuers answer, and proposes a model of each issuer\'s decisions (Smarter STIP).',
          from: 'Not a sum. Taken from a source cited on the page: Visa Research, Smarter Stand-In Processing. The rates are from Visa\'s study of its own network, not from Mastercard.',
        },
      ],
      fails: 'When we are slow or down, stand-in decides using parameters we set in advance: limits per card and per day, merchant categories to refuse. It then sends us advices so we can post what it approved. Those parameters are product decisions, made and reviewed before the outage.',
      alternatives: [
        {
          name: 'Connect to the network directly', chosen: true, good: 'Full control of the messages, the time budget and the customer experience. Monzo moved card processing in-house on its own Mastercard link after its outsourced processor failed in 2017.', cost: 'Scheme certification, equipment in your own data centres and round-the-clock operations.',
          what: 'Our gateways in both data centres hold their own connections to Mastercard, speak its ISO 8583 dialect and take the clearing files. We set the time budget (under a second) and the stand-in parameters ourselves.',
          pros: [
            'The whole budget is ours: about 100 ms typically, against a network that waits a few seconds.',
            'We set the stand-in parameters and receive every advice directly.',
            "No one else's outage sits between the network and us. Monzo moved in-house after its processor failed in 2017.",
          ],
          cons: [
            'Scheme certification before going live.',
            'Network equipment and a PCI zone in our own data centres.',
            'Round-the-clock operations, plus clearing files and settlement to run ourselves.',
          ],
        },
        {
          name: 'Use an issuer processor (Marqeta, Lithic, Stripe Issuing, Adyen)', good: 'Live in weeks. They hold the network link and send you each request with 2 to 3 seconds to answer (Lithic allows 6).', cost: 'Their outage is yours, and your budget is a slice of theirs.',
          what: 'The processor holds the network link, the PCI zone and clearing. It sends each authorisation to us as a webhook with 2 to 3 seconds to answer (Lithic allows 6). Our design shrinks to the authoriser, the ledger and events.',
          pros: [
            'Live in weeks, with no scheme certification or network equipment of our own.',
            'No card numbers, HSMs or clearing files to run.',
            "The page's own call when launching fast or while small.",
          ],
          cons: [
            "Their outage is ours: Monzo's 2017 outage was at its processor.",
            'Our budget is a slice of theirs, and it crosses HTTP.',
            'Their clearing match rate and their reports become what we reconcile against.',
          ],
        },
        {
          name: 'A single-message network', good: 'Authorisation and the movement of money are one message, so there is no clearing file to match.', cost: 'A duplicate is a double debit unless it is caught, and you lose the gap in which to adjust the amount.',
          what: 'On a single-message network the authorisation also moves the money. The ledger would post at once, with no hold to place and no clearing record to match it to later.',
          pros: [
            'No clearing step, so no matching of records to holds.',
            'The cardholder sees the final amount straight away.',
            'Fewer states in the life of a purchase.',
          ],
          cons: [
            'A duplicate is a double debit unless it is caught.',
            'No gap in which to adjust the amount, as for a tip or a hotel bill.',
            "This design's purchases are authorised and cleared as separate messages, as the tour shows.",
          ],
        },
      ],
      say: 'Stand-in is not just a failure I hope never happens. It is a product I configure: what the network may approve for my customers while I cannot answer.',
    },
    {
      id: 'gateway',
      name: 'Network gateway',
      short: 'Gateway',
      tech: 'ISO 8583, TCP',
      x: 335, y: 226, w: 140, h: 72, kind: 'node',
      what: 'Holds long-lived TCP connections to the network from both data centres, frames and parses ISO 8583 messages, checks them, catches repeats, and turns each into an internal request. It is inside the PCI zone: it swaps the card number for a token at the vault and has the cryptogram or PIN checked by the HSM before anything else sees the request.',
      why: 'The network speaks one dialect over persistent sockets and matches each answer to its request by reference number. Keeping that protocol, the card number and the clock in one small service keeps PCI scope small, and everything behind it speaks plain internal calls.',
      built: [
        { name: "ISO 8583", what: "The international standard for card authorisation messages. A four-digit type says what a message is (0100 request, 0110 answer, 0120 advice, 0400 reversal), and a bitmap says which numbered fields follow. Each network speaks its own dialect of it.", why: "It is what Mastercard speaks, so connecting directly means parsing it. Keeping it inside one small gateway means everything behind it uses plain internal calls. ISO 20022, the newer standard CHAPS moved to in 2023, is not used for card authorisations on this link." },
        { name: "TCP, long-lived connections", what: "TCP is the internet's standard way to carry an ordered, reliable stream of bytes between two machines. Here the connections are opened once and kept open, and each message starts with its length so the receiver knows where it ends.", why: "The network keeps connections open to both our data centres and an answer may go back on any live one, matched by field 37. Opening a connection for each purchase would add set-up time to every request inside a budget of about 100 ms." },
      ],
      numbers: [
        {
          text: 'On Visa, each message has a length prefix on a long-lived TCP connection, and an answer may return on any live connection, matched by field 37 (Increase).',
          from: 'Not a sum. Taken from sources cited on the page: Increase\'s articles on Visa redundancy and on ISO 8583. They describe Visa; the page assumes Mastercard\'s link works alike in these respects.',
        },
        {
          text: 'Our budget: parse and check in about 1 ms; the whole answer in about 100 ms typically and 300 ms at the 99th percentile (design targets).',
          from: 'Design targets from the latency budget in "Numbers to have ready": network link 10 + parse 1 + vault 5 + HSM 5 + card 5 + fraud 50 + hold 20 + reply 10 = 106 ms, about 100 ms. The 300 ms is a target with room for slow calls and retries inside a site, not a sum.',
        },
      ],
      fails: 'If the gateway in one site dies, the network sends on its connections to the other. Requests in flight are lost; the network retries or stands in, and the advice tells us what it decided. The gateway also owns a deadline: past it, it stops waiting and answers decline, so a slow core never leaves the network guessing.',
      alternatives: [
        {
          name: 'Own gateway, live in both data centres', chosen: true, good: 'Either site can answer any request, so losing one costs only what was in flight.', cost: 'Two sites of network equipment, and every request must be safe to process in either.',
          what: 'A small service in each data centre holds TCP connections to Mastercard, parses each 0100, swaps the card number for a token, has the HSM check the cryptogram and stamps a deadline. The network sends to both sites, so either can answer.',
          pros: [
            'Losing one site costs only the requests in flight there.',
            'Protocol, card numbers and clock sit in one small service, so PCI scope stays small.',
            'It owns the deadline: past it, it answers decline rather than leave the network guessing.',
          ],
          cons: [
            'Network equipment and circuits in two sites.',
            "Every request must be safe to process in either site, so the key is the network's identifiers, never anything local.",
            'An ISO 8583 dialect to parse, test and certify.',
          ],
        },
        {
          name: 'An issuer processor\'s webhook', good: 'No ISO 8583, no scheme connection, no PCI zone of our own.', cost: 'A 2-second budget set by someone else, and HTTP between us and the network.',
          what: 'A processor holds the network link and sends us an HTTPS request for each authorisation. We answer the webhook, and the processor builds the reply to the network.',
          pros: [
            'No ISO 8583, no scheme connection, no PCI zone of our own.',
            'Fewer moving parts to run day and night.',
          ],
          cons: [
            'A budget of about 2 seconds, set by someone else.',
            "HTTP between us and the network, and the processor's outage is ours.",
            'At about 1.2 million cards the page chooses a direct link.',
          ],
        },
        {
          name: 'One live gateway with a warm standby', good: 'Simpler to reason about: one place holds the connections.', cost: 'Failover takes seconds, and every purchase in those seconds goes to stand-in.',
          what: 'One site holds the live connections and answers everything. The other is kept ready and takes over when the first fails.',
          pros: [
            'Simpler to reason about: one place holds the connections.',
            'No question of which site answered a request while both are healthy.',
          ],
          cons: [
            'Failover takes seconds, and every purchase in those seconds goes to stand-in.',
            'The standby is not proved by live traffic until it is needed.',
            'The network already sends to both sites, so a standby wastes that.',
          ],
        },
        {
          name: 'A bought payment switch',
          good: 'The network dialect and connection handling come ready-made.',
          cost: 'A vendor inside the PCI zone, and our deadline and idempotency rules still need fitting to it.',
          what: "Run a vendor's switch software in our own sites in place of our gateway code. It speaks the network's dialect and hands each request to the authoriser over an internal interface.",
          pros: [
            'The ISO 8583 dialect and connection handling come ready-made.',
            "The vendor follows the network's message changes for us.",
          ],
          cons: [
            'A licence and a vendor to depend on, inside the PCI zone.',
            'The deadline, tokenising and idempotency rules still have to fit our design.',
            'The gateway is meant to be small, so owning it is not a large build.',
          ],
        },
      ],
      say: 'The gateway owns the clock. Each request gets a deadline when it arrives, and every call behind it gets only what is left.',
      see: [
        { id: 'tcp', label: 'TCP' },
        { id: 'serialization', label: 'Serialisation' },
        { id: 'load-balancing', label: 'Load balancing' },
      ],
    },
    {
      id: 'vault',
      name: 'Card vault',
      tech: 'PAN to token',
      x: 335, y: 96, w: 140, h: 70, kind: 'store',
      what: 'The only place card numbers are kept, encrypted, each mapped to a random token. Everything outside the PCI zone, from the authoriser and the ledger to events and the app, knows a card only by its token.',
      why: 'PCI DSS applies to every system that stores, processes or transmits card data, and to anything that can affect their security. A vault and tokens shrink that to three parts: the gateway, the vault and the HSM.',
      built: [
        { name: "PAN (primary account number)", what: "The long number on the card. It is what a thief needs, so the card industry's security standard, PCI DSS, governs every system that stores, processes or transmits it.", why: "The vault is the only place it is stored, encrypted under keys held in the HSM. That keeps PCI scope to three parts: the gateway, the vault and the HSM." },
        { name: "Random tokens", what: "A token is a random string, such as tok_8f3a91e2, that stands in for a card number. It is not worked out from the number, so it cannot be turned back into it without the vault's table.", why: "Logs, events, the ledger and the app can carry tokens without coming into PCI scope. A plain hash of the number was passed over: card numbers are short and partly predictable, so a hash can be reversed by trying them. At about 1.2 million cards the table is a few hundred megabytes, small enough to cache on every gateway and meet the 5 ms target." },
      ],
      numbers: [
        {
          text: 'About 1.2 million cards (assumption): at most a few hundred megabytes, small enough to cache on every gateway.',
          from: '1.2 million cards from "Numbers to have ready" (about 900,000 UK members, some with several cards). If an entry is about 200 bytes (an encrypted card number, its token and a key reference; an assumption), 1.2 million × 200 bytes = 240 MB.',
        },
        {
          text: 'Lookup in under 5 ms (design target).',
          from: 'Design target: the vault\'s 5 ms share of the 106 ms latency budget in "Numbers to have ready". Most lookups hit the gateway\'s own cache and take far less.',
        },
      ],
      tables: [
        {
          title: 'vault: card number to token',
          lang: 'sql',
          code: `-- Inside the PCI zone. Shown in PostgreSQL syntax; the page
-- names no product. Replicated to both sites.
CREATE TABLE vault (
  card_token text  PRIMARY KEY,     -- 'tok_8f3a91e2', random
  pan_hmac   bytea NOT NULL UNIQUE, -- keyed hash: the lookup key
  pan_enc    bytea NOT NULL,        -- the card number, encrypted
  key_ref    text  NOT NULL,        -- which HSM key encrypted it
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Key rotation walks the rows still under an old key.
CREATE INDEX vault_by_key ON vault (key_ref, card_token);`,
          note: 'Encryption is randomised, so pan_enc cannot be searched. The lookup key is a hash keyed with an HSM key: unlike the plain hash the page passed over, trying every card number gets nowhere without that key.',
        },
        {
          title: "Each gateway's cache",
          lang: 'text',
          code: `In each gateway's memory, inside the PCI zone:
  card number -> card_token     up to about 1.2 million entries
A token never changes, so an entry is never cleared. A miss
reads the vault and adds the entry.`,
          note: 'The cache holds card numbers, so it is protected like the vault.',
        },
      ],
      queries: [
        {
          title: 'Tokenise on a cache miss',
          lang: 'sql',
          code: `-- The HSM makes the keyed hash of 5xxx ... 1234 (shortened).
SELECT card_token FROM vault
 WHERE pan_hmac = '\\x9c41e07b';
-- -> tok_8f3a91e2`,
          note: 'On a gateway cache miss, and for each card number in a clearing file. One row by the unique index, well inside 5 ms.',
        },
        {
          title: 'A new card is issued',
          lang: 'sql',
          code: `INSERT INTO vault (card_token, pan_hmac, pan_enc, key_ref)
VALUES ('tok_8f3a91e2', '\\x9c41e07b', '\\x5e11a0c3',
        'pan-key-2026')
ON CONFLICT (pan_hmac) DO NOTHING
RETURNING card_token;
-- No row: the number is already here. Read its token instead.`,
          note: 'The UNIQUE on pan_hmac means one card number never gets two tokens. Byte values are shortened.',
        },
        {
          title: 'Key rotation, a batch at a time',
          lang: 'sql',
          code: `SELECT card_token, pan_enc FROM vault
 WHERE key_ref = 'pan-key-2025'
 ORDER BY card_token LIMIT 1000;
-- The HSM decrypts and re-encrypts each under the new key.
UPDATE vault SET pan_enc = '\\x77b2c9d1',
       key_ref = 'pan-key-2026'
 WHERE card_token = 'tok_8f3a91e2'
   AND key_ref = 'pan-key-2025';`,
          note: 'A background job on vault_by_key. Card numbers stay inside the HSM in the clear; the job sees only ciphertext.',
        },
      ],
      fails: 'It is read on every authorisation, so it is replicated to both sites and cached on each gateway. If it cannot be read the card cannot be found: decline, and let stand-in carry the load if it lasts.',
      alternatives: [
        {
          name: 'Own vault, random tokens, keys held in the HSM', chosen: true, good: 'The smallest PCI scope we control, and no outside call on the hot path.', cost: 'We run it to PCI standard and rotate its keys.',
          what: 'A small store inside the PCI zone maps each card number, encrypted under keys held in the HSM, to a random token. The gateway asks it on every 0100, usually from its own cache, and nothing past the gateway sees the number.',
          pros: [
            'PCI scope shrinks to three parts: gateway, vault and HSM.',
            'No outside call on the hot path; a lookup fits inside 5 ms.',
            'Random tokens mean nothing outside the vault, so logs, events and the ledger can carry them freely.',
          ],
          cons: [
            'We run it to PCI standard and rotate its keys.',
            'Read on every authorisation, so it must be replicated to both sites.',
            'If it cannot be read, the card cannot be found and the answer is decline.',
          ],
        },
        {
          name: 'A vault run by a provider', good: 'Card numbers never touch our systems.', cost: 'A network hop and an outside dependency on every purchase.',
          what: 'A specialist provider stores the card numbers and hands back tokens. Our systems would keep only tokens, and the gateway would ask the provider over HTTPS.',
          pros: [
            'No card numbers stored in our systems.',
            'The provider runs the vault to PCI standard and rotates its keys.',
          ],
          cons: [
            'A network hop and an outside dependency on every purchase, against a 5 ms target.',
            "The provider's outage stops every authorisation.",
            'A gateway on a direct network link still receives each card number before it can ask.',
          ],
        },
        {
          name: 'Encrypt the card number in each service', good: 'No extra service.', cost: 'Every service, log and backup that touches it is in PCI scope.',
          what: 'No vault: each service that needs the card keeps the number encrypted, with keys from the HSM. The authoriser, the ledger and events would carry the encrypted number in place of a token.',
          pros: [
            'No extra service and no extra hop.',
            'A service can decrypt when it truly needs the number.',
          ],
          cons: [
            'Every service, log and backup that touches it is in PCI scope.',
            'Many more systems need keys, and every key rotation touches all of them.',
            'Gives up the rule this page is built on: card numbers stop at the gateway.',
          ],
        },
      ],
      say: 'Card numbers stop at the gateway. Past it a card is a token, so logs, events and the ledger are out of PCI scope.',
      see: [{ id: 'hash-table', label: 'Hash table' }],
    },
    {
      id: 'hsm',
      name: 'Hardware security module',
      short: 'HSM',
      tech: 'PIN, CVV, ARQC',
      x: 335, y: 350, w: 150, h: 56, kind: 'shared',
      what: 'Tamper-resistant devices that hold the issuer\'s keys and do the cryptography: check the chip\'s authorisation request cryptogram (ARQC), produce the response cryptogram (ARPC), check PINs and card security codes, and protect the vault\'s keys. Keys never leave them in the clear.',
      why: 'Checking the cryptogram is what makes a chip or phone payment hard to copy: each purchase carries a fresh code that only the real card or device could compute. The check needs the issuer\'s keys, and those must never sit in application memory.',
      built: [
        { name: "Hardware security module (HSM)", what: "A tamper-resistant device that holds secret keys and does cryptography for other systems. Keys never leave it in the clear. A payment HSM, such as the Thales payShield cited on this page, has commands for card checks.", why: "Checking cryptograms needs the issuer's keys, and those must never sit in application memory, where anyone who can read memory or a backup could take them. At least two per site, because cryptography must not cross sites on the hot path. A cloud service was passed over as another hop against the 5 ms target." },
        { name: "PIN", what: "The personal identification number a cardholder types at a terminal. It travels encrypted, as a PIN block, and is checked inside the HSM.", why: "The tap in the tour needs no PIN, but chip-and-PIN purchases do. Checking it inside the HSM means no service ever sees a customer's PIN in the clear." },
        { name: "CVV (card security code)", what: "The three digits printed on the card, typed in for purchases where the card is not present, such as online. They are worked out from the card's details with the issuer's keys, so the HSM checks them by working them out again.", why: "Only the HSM holds the keys to check them. They prove only that someone has seen the card, which is weaker than a chip cryptogram, so online purchases lean more on 3-D Secure and the fraud score." },
        { name: "ARQC and ARPC", what: "The authorisation request cryptogram is a code the chip or phone computes for one purchase from its details (amount, country, date, the terminal's random number, the chip's counter) with a secret key. The authorisation response cryptogram is the issuer's reply code, which the card or phone can check.", why: "A fresh ARQC on every purchase is what makes a chip or phone payment hard to copy. Verifying it needs our keys, so the gateway asks the HSM: one or two commands a purchase, at most about 270 a second at the yearly peak." },
      ],
      numbers: [
        {
          text: 'One or two operations per authorisation, a few milliseconds each (design target).',
          from: 'Verify the ARQC and produce the ARPC, or check a PIN or security code: one or two commands. "A few milliseconds" is the HSM\'s 5 ms share of the latency budget in "Numbers to have ready". At the yearly peak of about 135 messages a second, 135 × 2 = 270 commands a second at most.',
        },
        {
          text: 'At least two per site, so one can fail or be patched.',
          from: 'A design choice, not a sum. One module per site is a single point of failure, and cryptography must not cross sites on the hot path, so each site needs its own spare.',
        },
      ],
      fails: 'Without it the gateway cannot verify the chip, so it declines. Keep a pool in each site and never send cryptography across sites on the hot path.',
      alternatives: [
        {
          name: 'HSMs in each data centre', chosen: true, good: 'Lowest latency, and keys stay in hardware we control.', cost: 'Hardware to buy, certify and run.',
          what: 'Each data centre has its own pool of payment HSMs. The gateway sends a command to verify the ARQC (or PIN block, or security code) and gets back pass or fail and the ARPC. A second module in the site steps in if needed.',
          pros: [
            'Lowest latency: a call inside the site, within the 5 ms target.',
            'Keys stay in tamper-resistant hardware we control.',
            "Each site verifies on its own, so one site's trouble does not spread.",
          ],
          cons: [
            'Hardware to buy, certify and run: at least two per site.',
            'Key ceremonies and key management by a few trusted people.',
            "If a site's whole pool is down, that site cannot verify chips and is taken out of service.",
          ],
        },
        {
          name: 'A cloud HSM service', good: 'No hardware to manage.', cost: 'Another hop and another provider in every authorisation.',
          what: "A cloud provider's payment cryptography service holds the keys and verifies the ARQC through an API. AWS Payment Cryptography, cited on this page, is one. The gateway would call it in place of local modules.",
          pros: [
            'No hardware to buy, rack or patch.',
            'Capacity and replication come as a service.',
          ],
          cons: [
            'Another hop and another provider in every authorisation.',
            'The 5 ms target is harder to keep across a network.',
            'Our own data centres would depend on a cloud region for every purchase.',
          ],
        },
        {
          name: 'Keys in software', good: 'Easy to build.', cost: 'Not acceptable for issuer keys.',
          what: 'Hold the issuer keys in application memory or a software key store, and compute the cryptograms in code.',
          pros: [
            'Easy to build and to test.',
            'No hardware and no extra hop.',
          ],
          cons: [
            'Not acceptable for issuer keys: anyone who can read memory or a backup can take them.',
            'With copied keys, someone could make the cryptograms only a real card should, which defeats the chip.',
          ],
        },
        {
          name: 'Let the network verify on our behalf',
          good: 'No cryptography call of our own for the purchases it covers.',
          cost: 'The network must hold our keys, and we still need HSMs for the rest.',
          what: 'Where the network offers it, it checks the cryptogram before passing the request on and puts the result in the 0100. The gateway would read that result in place of calling the HSM.',
          pros: [
            'One less call on the hot path for the purchases it covers.',
            'Less hardware to size for the peak.',
          ],
          cons: [
            'The network must hold our keys to do it.',
            "We still need HSMs for whatever it does not cover, and for the vault's keys.",
            'Depends on what the network offers; this page has not checked the details.',
          ],
        },
      ],
      say: 'The chip proves the card is real with a cryptogram on every purchase. The HSM checks it with keys no engineer can read.',
    },
    {
      id: 'authz',
      name: 'Authorisation engine',
      short: 'Authoriser',
      tech: 'checks in order',
      x: 585, y: 226, w: 150, h: 72, kind: 'node',
      what: 'Runs the checks in a fixed order and stops at the first that fails: card active, not frozen, not expired; the cryptogram, PIN or 3-D Secure result from the gateway; the owner\'s controls (blocked merchant categories, contactless limit, per-purchase limit, countries); the fraud score; then funds. It approves by asking the ledger to place a hold, and answers approve or decline with a reason code.',
      why: 'Cheap, certain checks go first, so most declines cost almost nothing. Funds go last because the hold is the only step that changes anything, and nothing after it may fail without undoing it.',
      built: [
        { name: "Ordered checks", what: "A technique, not a product: run the checks in a fixed order and stop at the first that fails. Here the order is card state, the gateway's verification results, the owner's controls, the fraud score, then funds.", why: "Cheap, certain checks go first, so most declines cost almost nothing. Funds go last because placing the hold is the only step that changes anything. Running the checks in parallel would save only a few milliseconds, against about 106 ms in a target of under a second." },
        { name: "Stateless service", what: "A service that keeps nothing between requests: everything it needs arrives in the request or is read from the stores behind it.", why: "Any copy in either data centre can serve any request, which is what lets both sites be live. A retry that lands in the other site is still caught, because the decision is stored under the network's identifiers." },
      ],
      numbers: [
        {
          text: 'Reason codes: 00 approved, 05 do not honour, 51 not sufficient funds (ISO 8583).',
          from: 'Not a sum. Taken from a source cited on the page: the ISO 8583 response codes (Wikipedia: ISO 8583). Each network adds its own codes to these.',
        },
        {
          text: 'Budget: card read 5 ms, fraud score 50 ms, ledger hold 20 ms (design targets).',
          from: 'Design targets: three of the eight shares in the latency budget in "Numbers to have ready", which sum to 106 ms. The fraud score gets the largest share because a model call takes longest; the card read is one row by key, and the hold a few small writes and a commit.',
        },
        {
          text: 'Since 19 March 2026 UK firms set their own contactless limits; most large banks said they would keep £100 for now (FStech).',
          from: 'Not a sum. Taken from a source cited on the page: FStech, a trade news report, not the FCA itself.',
        },
      ],
      fails: 'It keeps no state, so any instance in either site can serve any request. If the fraud service is late it decides on rules alone. If the ledger cannot answer it declines rather than approve without a hold.',
      alternatives: [
        {
          name: 'Ordered checks in one service, with a deadline on every call', chosen: true, good: 'Predictable latency, and the order is explicit and testable.', cost: 'Changing a rule is a deploy, unless limits live in data.',
          what: "One stateless service runs the checks in a fixed order: card state, the gateway's verification results, the owner's controls, the fraud score, then funds. Each call carries the time left on the deadline, and the first failure ends it with a reason code.",
          pros: [
            'Predictable latency: each call has its share of the 106 ms budget.',
            'The order is explicit and testable, and most declines cost almost nothing.',
            'Stateless, so any instance in either site can serve any request.',
          ],
          cons: [
            'Changing a rule is a deploy, unless limits live in data.',
            'The risk team needs engineers to change the order or add a check.',
          ],
        },
        {
          name: 'A rules engine run by the risk team', good: 'Risk can change controls without engineers.', cost: 'Harder to test, and the order and timing still need code.',
          what: 'Controls and fraud rules live in a rules engine that the risk team edits, and the authoriser asks it for a verdict. The funds check and the hold stay in code.',
          pros: [
            'Risk can change controls without engineers or a deploy.',
            'Rule changes can be reviewed and rolled back as data.',
          ],
          cons: [
            'Harder to test: a rule change can alter outcomes with no code review.',
            'The order and timing still need code.',
            "Another call inside the budget, unless the engine runs in the authoriser's process.",
          ],
        },
        {
          name: 'Run every check in parallel', good: 'Lower latency for approvals.', cost: 'More work for requests a cheap check would have declined, and the hold still has to come last.',
          what: 'Start the card read and the fraud score at once and combine the answers. The hold still comes last, once the others agree.',
          pros: [
            'Lower latency for approvals: the 5 ms card read overlaps the 50 ms score.',
            'The slowest call sets the time, not the sum.',
          ],
          cons: [
            'More work for requests a cheap check would have declined, such as fraud calls for frozen cards.',
            'The hold still has to come last, so the saving is a few milliseconds.',
            'At about 106 ms against a target of under a second, latency is not the problem to solve.',
          ],
        },
      ],
      say: 'Cheap checks first, the fraud score inside a fixed budget, and the hold last, because the hold is the only step that changes anything.',
      see: [{ id: 'token-bucket', label: 'Token bucket (velocity limits)' }],
    },
    {
      id: 'cards',
      name: 'Card store',
      tech: 'status, controls',
      x: 585, y: 96, w: 160, h: 70, kind: 'store',
      what: 'Each card\'s state by token: status (active, frozen, lost), expiry, the account it draws on, and the controls the business owner set: limits, blocked categories, contactless on or off.',
      why: 'Read on every authorisation and written when someone freezes a card in the app. A freeze must work on the very next tap, so reads go to the primary or to a cache cleared on every write, never to a lagging replica.',
      built: [
        { name: "Card status", what: "Each card's state, by token: active, frozen or lost, with its expiry and the account it draws on.", why: "A freeze must work on the very next tap, so status is read from the primary database or from a cache cleared on every write, never from a copy that may lag." },
        { name: "Controls", what: "Limits and switches the business owner sets in the app for each card: blocked merchant categories, a contactless limit, a per-purchase limit, foreign purchases and contactless on or off.", why: "They are rows in the card store, not code, so the owner's changes take effect without a deploy." },
        { name: "Relational database with a synchronous replica", what: "A database of tables queried with SQL, here about 1.2 million card rows keyed by token. The synchronous replica is a copy in the other data centre that must have each write before it is confirmed.", why: "At about 600 MB the whole table fits in memory, so scale is not the problem; freshness is. A key-value store such as DynamoDB or Cassandra would scale further, but a read from a lagging copy could miss a freeze. Waiting for the replica means a failover cannot lose a freeze." },
      ],
      numbers: [
        {
          text: 'About 1.2 million cards (assumption): small enough to cache in full.',
          from: '1.2 million cards from "Numbers to have ready". If a card record is about 500 bytes (status, expiry, account and a handful of controls; an assumption), 1.2 million × 500 bytes = 600 MB, which fits in memory on one machine.',
        },
        {
          text: 'Reads in under 5 ms (design target).',
          from: 'Design target: the card read\'s 5 ms share of the 106 ms latency budget in "Numbers to have ready".',
        },
      ],
      tables: [
        {
          title: 'cards: state and controls by token',
          lang: 'sql',
          code: `CREATE TABLE cards (
  card_token     text PRIMARY KEY,     -- 'tok_8f3a91e2'
  account_id     text NOT NULL,        -- 'acc_7731'
  status         text NOT NULL
    CHECK (status IN ('active', 'frozen', 'lost')),
  expires        char(7) NOT NULL,     -- '2029-08'
  blocked_mccs   text[] NOT NULL DEFAULT '{}',  -- {7995}
  contactless_on boolean NOT NULL DEFAULT true,
  foreign_on     boolean NOT NULL DEFAULT true,
  per_purchase_limit_pence bigint,     -- 50000 = £500
  updated_at     timestamptz NOT NULL DEFAULT now()
);
-- The app lists a business's cards.
CREATE INDEX cards_by_account ON cards (account_id);`,
          note: 'One row per card, about 1.2 million, about 600 MB: it fits in memory. The primary has a synchronous replica in the other site.',
        },
      ],
      queries: [
        {
          title: 'Read on every authorisation',
          lang: 'sql',
          code: `SELECT status, expires, account_id, blocked_mccs,
       contactless_on, foreign_on, per_purchase_limit_pence
  FROM cards
 WHERE card_token = 'tok_8f3a91e2';`,
          note: 'About 135 a second at the yearly peak, by primary key, from the primary or a cache cleared on write: 5 ms target.',
        },
        {
          title: 'Freeze, from the app',
          lang: 'sql',
          code: `UPDATE cards SET status = 'frozen', updated_at = now()
 WHERE card_token = 'tok_8f3a91e2' AND status = 'active';
-- COMMIT returns once the other site has the row.
-- Then delete the cache entry for tok_8f3a91e2, and only then
-- tell the app "frozen".`,
          note: 'Rare, so the cross-site round trip costs nothing that matters. The next tap reads frozen and is declined.',
        },
        {
          title: 'Block a merchant category',
          lang: 'sql',
          code: `UPDATE cards
   SET blocked_mccs = array_append(blocked_mccs, '7995'),
       updated_at = now()
 WHERE card_token = 'tok_8f3a91e2'
   AND NOT ('7995' = ANY (blocked_mccs));
-- and clear the cache entry, as for a freeze`,
          note: 'Controls are data, so the owner\'s change needs no deploy.',
        },
        {
          title: "A business's cards, for the app",
          lang: 'sql',
          code: `SELECT card_token, status, expires
  FROM cards
 WHERE account_id = 'acc_7731'
 ORDER BY card_token;`,
          note: 'Uses cards_by_account. Off the authorisation path.',
        },
      ],
      fails: 'The primary fails over to its replica in the other site. A freeze is acknowledged only once it is on both, so a failover cannot lose it.',
      alternatives: [
        {
          name: 'Relational database, synchronous replica, cache cleared on write', chosen: true, good: 'Exact and simple at a million rows.', cost: 'Failover is a step to rehearse.',
          what: 'A table of about 1.2 million cards keyed by token, with a synchronous replica in the other site. Reads go to the primary or to a cache cleared on every write, so a freeze works on the next tap.',
          pros: [
            'Exact and simple at a million rows.',
            'A freeze is acknowledged only once it is on both sites, so a failover cannot lose it.',
            "Controls are rows, so the owner's changes need no deploy.",
          ],
          cons: [
            'Failover is a step to rehearse.',
            'Synchronous replication adds a cross-site round trip to each write, though writes are rare.',
            'The cache must be cleared on every write, or a freeze can be missed.',
          ],
        },
        {
          name: 'A key-value store (DynamoDB, Cassandra)', good: 'Scales without thought.', cost: 'Scale is not the problem here, and freshness on read needs care.',
          what: 'Store each card as one item keyed by token. The authoriser reads it by key, and nothing here needs a join.',
          pros: [
            'Scales without thought, far past 1.2 million cards.',
            'Reads by key are fast, and copies across sites are part of the product.',
          ],
          cons: [
            'Scale is not the problem here: the whole table fits in memory.',
            'Freshness on read needs care: a read from a lagging copy can miss a freeze.',
            "Another kind of database to run beside the ledger's.",
          ],
        },
        {
          name: 'Card state inside the ledger database', good: 'One transaction can read the card and place the hold.', cost: 'Ties a product feature to the money store.',
          what: 'Keep the card table in the same database as the ledger. The hold transaction could then read the card and place the hold in one go.',
          pros: [
            'One transaction can read the card and place the hold.',
            'One less database to run and fail over.',
          ],
          cons: [
            'Ties a product feature to the money store: app changes share its load and its schema changes.',
            'Card reads land on the one database the authoriser cannot do without.',
            'The card check comes before the fraud score, so one transaction would not cover the checks between anyway.',
          ],
        },
      ],
      say: 'A frozen card must decline on the next tap, so card state is read from the primary or from a cache that is cleared on write.',
      see: [
        { id: 'cache-strategies', label: 'Cache strategies' },
        { id: 'leader-replication', label: 'Leader replication' },
      ],
    },
    {
      id: 'fraud',
      name: 'Fraud scoring',
      tech: 'model, 50 ms',
      x: 585, y: 350, w: 150, h: 56, kind: 'shared',
      what: 'Scores each authorisation against the card\'s recent history: how fast it is being used, a new merchant or country, the amount against normal, the channel. Returns a score and its reasons inside a fixed budget.',
      why: 'A decline at authorisation stops the money leaving. After approval the best you can do is alert and dispute. A score that arrives late is worth nothing, so keeping the budget matters more than squeezing the model.',
      built: [
        { name: "Scoring model", what: "A model trained on past purchases that turns a purchase and the card's recent history into a risk score with its reasons. It runs as its own service.", why: "Card state and controls cannot tell a thief from the owner; a model catches patterns that fixed rules miss. Scoring before the hold stops fraud before the money leaves, where scoring after approval could only alert and dispute." },
        { name: "50 ms hard timeout", what: "A fixed limit on how long the authoriser waits for the score, after which it stops waiting whatever happens.", why: "Fraud has 50 of the 106 ms typical budget, the largest share, because a model call takes longest. A late score is worth nothing, so past 50 ms the authoriser decides on rules alone and records that the model did not answer." },
        { name: "Features from the event stream", what: "The card's recent counts and amounts, such as purchases in the last hour or a new country, kept up to date by a reader of the card events log.", why: "Nothing is worked out from history while the purchase waits, so scoring is a lookup and a model call, which is what makes 50 ms reachable." },
      ],
      numbers: [
        {
          text: '50 ms at the 99th percentile, of about 300 ms for the whole answer (design targets).',
          from: 'Design targets from "Numbers to have ready": fraud has 50 of the 106 ms typical budget, and the whole answer has 300 ms at the 99th percentile. The 50 ms is also the hard timeout, so the score can never take more.',
        },
        {
          text: 'Features are kept up to date from the event stream, so scoring is a lookup and a model call.',
          from: 'A design choice, not a sum. A consumer of the card events log keeps each card\'s recent counts and amounts, so nothing is computed from history at scoring time. The 12 ms answer in the tour is an example.',
        },
      ],
      tables: [
        {
          title: 'Feature store: key layout',
          lang: 'text',
          code: `Shown as Redis; the page names no product. Keyed by card.

f:tok_8f3a91e2:buys       sorted set
  member  event id, e.g. evt_01JC9W3K2T
  score   time of the purchase, Unix ms
  -> purchases_last_hour

f:tok_8f3a91e2:countries  set of country codes: GB, FR
  -> new_country, used_abroad_before

f:tok_8f3a91e2:profile    hash
  median_pence  3310      (illustrative, from a nightly job)
  -> amount_vs_card_median = 3640 / 3310 = 1.1`,
          note: 'Written by a reader of the card events log; read by fraud scoring. Members are event ids, so a repeated event changes nothing.',
        },
      ],
      queries: [
        {
          title: 'Read features while scoring',
          lang: 'text',
          code: `# One pipelined round trip. 12:41:07 less one hour:
ZCOUNT    f:tok_8f3a91e2:buys 1794483667000 +inf
SISMEMBER f:tok_8f3a91e2:countries IE
SCARD     f:tok_8f3a91e2:countries
HGET      f:tok_8f3a91e2:profile median_pence`,
          note: 'Inside the 50 ms budget: a few key lookups, then the model call. IE not in the set gives new_country true; GB and FR give used_abroad_before.',
        },
        {
          title: 'Update from a card event',
          lang: 'text',
          code: `# On "authorised" evt_01JC9W3K2T, 2026-11-12T12:41:07Z
ZADD  f:tok_8f3a91e2:buys 1794487267000 evt_01JC9W3K2T
SADD  f:tok_8f3a91e2:countries IE
# keep one day of purchases
ZREMRANGEBYSCORE f:tok_8f3a91e2:buys -inf 1794400867000`,
          note: 'At-least-once delivery is safe: ZADD and SADD of a member already there change nothing.',
        },
        {
          title: 'Nightly profile',
          lang: 'text',
          code: `HSET f:tok_8f3a91e2:profile median_pence 3310`,
          note: 'A batch job works out each card\'s median from history; nothing is computed from history while a purchase waits.',
        },
      ],
      fails: 'Slow or down: the authoriser stops waiting at 50 ms and decides on rules alone (velocity, amount, country), and records that it did. The model never blocks the authorisation path.',
      alternatives: [
        {
          name: 'Score inline with a hard timeout and a rules fallback', chosen: true, good: 'Stops fraud before money is committed.', cost: 'A model that must answer in tens of milliseconds.',
          what: "The authoriser sends the purchase and the card's recent features to a model and waits at most 50 ms. If it is late or down, the authoriser decides on rules alone (velocity, amount, country) and records that the model did not answer.",
          pros: [
            'Stops fraud before money is committed.',
            'The rules fallback means the model never blocks an authorisation.',
            'Each score is logged with the decision, so the model can be judged later.',
          ],
          cons: [
            'A model that must answer in tens of milliseconds, which limits how big it can be.',
            'Features must be kept up to date from the event stream ahead of time.',
            'Decisions made without a score need watching: alert on their share.',
          ],
        },
        {
          name: 'Score after approval only', good: 'Nothing added to the hot path.', cost: 'Fraud is found after the money has gone.',
          what: 'Approve on controls and funds alone, then score each purchase from the card events log. A high score alerts the owner and can freeze the card for next time.',
          pros: [
            'Nothing added to the hot path.',
            'The model can be as large and slow as it needs.',
            'Reads the same log the alerts consumer already reads.',
          ],
          cons: [
            'Fraud is found after the money has gone.',
            'The best left is an alert and a dispute.',
            'A decline at authorisation is the cheapest place to stop fraud, so this design scores inline.',
          ],
        },
        {
          name: 'A vendor\'s score', good: 'Quick to start, trained on more data than ours.', cost: 'An outside call inside a 50 ms budget.',
          what: 'Send each purchase to an outside scoring service and use its score in the authoriser, with the same 50 ms timeout and rules fallback.',
          pros: [
            'Quick to start, trained on more data than ours.',
            'Can see patterns across many issuers that we cannot.',
          ],
          cons: [
            'An outside call inside a 50 ms budget.',
            'Purchase data leaves our systems on every authorisation.',
            "We cannot change the model, and may not see all of its reasons.",
          ],
        },
        {
          name: 'Rules only, no model',
          good: 'Fast, explainable, and nothing to train.',
          cost: 'Misses patterns a model would catch, and the rules need constant tuning.',
          what: 'Velocity, amount and country rules in the authoriser, with no model at all. It is what this design falls back to when the model is late.',
          pros: [
            'Fast and explainable; nothing to train or serve.',
            'No extra call: the rules read features the authoriser already has.',
          ],
          cons: [
            'Misses patterns a model would catch.',
            'Rules need constant tuning, and tight rules decline good customers.',
          ],
        },
      ],
      say: 'Fraud gets 50 milliseconds. If it is late I decide on rules and record that the model did not answer.',
    },
    {
      id: 'ledger',
      name: 'Ledger',
      tech: 'holds, postings',
      x: 810, y: 226, w: 140, h: 72, kind: 'store',
      what: 'The double-entry record of money. An approval writes a pending entry, the hold, which lowers the available balance. Clearing writes the posted entry and releases the hold. Available balance is the posted balance less open holds. For a credit card it is the credit limit less what is posted and held. The Ledger service design on this site goes inside it.',
      why: 'The hold must be exact under concurrency: two taps at once against the last £10 must not both succeed. So the funds check and the hold are one transaction on the account, keyed by the network\'s identifiers so a retry finds the first result. Daily limits are checked against the same account\'s totals in that transaction.',
      built: [
        { name: "Holds", what: "A hold is a pending ledger entry that lowers the available balance without moving money. It ends when clearing posts the purchase, a reversal cancels it, or it lapses at the end of the network's window.", why: "The approval must reserve the money at once, or two taps could spend the same pounds. The funds check and the hold are one transaction on the account, keyed by the network's identifiers, so a retry finds the first hold." },
        { name: "Postings", what: "A posting is a final ledger entry, written by clearing with the amount the network actually charges. Statements, interest and reconciliation are worked out from postings.", why: "Kept apart from holds because the final amount can differ (£36.55 against £36.40 in the tour), and some purchases arrive with no hold at all." },
        { name: "Double-entry", what: "A book-keeping method: every movement is recorded as equal debits and credits across accounts, so the entries always sum to zero.", why: "Money cannot appear or vanish, which makes the ledger easy to audit and gives reconciliation a sound record to check. The posting in the tour debits acc_7731 and credits the Mastercard settlement account." },
        { name: "Relational database, partitioned by account", what: "A database of tables queried with SQL, with transactions and row locks; the examples use PostgreSQL syntax. Data is split by account, and the primary copies each commit to a replica in the other data centre before confirming it.", why: "A lock on the account row makes the funds check exact: two taps on the last £10 cannot both pass. At about 100 holds a second at the yearly peak, one primary is plenty. Distributed SQL such as Spanner or CockroachDB would remove the failover step, but a majority needs three locations and this design has two sites." },
      ],
      numbers: [
        {
          text: 'About 1.2 million holds and 1.2 million postings a day (assumption); holds peak near 100 a second, postings come in bursts.',
          from: '1.2 million purchases a day from "Numbers to have ready". One hold per approval and one posting per clearing record gives about 1.2 million of each (counting every authorisation as approved, a slight overcount). Peak: 10 per cent of 1.2 million in the busiest hour is 120,000 ÷ 3,600 = about 33 a second; three times that on the busiest day of the year is about 100. Postings arrive a file at a time.',
        },
        {
          text: 'An unused hold lapses after the network\'s window: 7 days is typical (Lithic); card present on Mastercard, 2 days (Stripe).',
          from: 'Not a sum. Taken from sources cited on the page: Lithic\'s transaction flow (7 days typical) and Stripe\'s guide to placing a hold (2 days, card present, Mastercard).',
        },
        {
          text: 'Credit cards: a statement closes each month, and the minimum payment and interest are worked out from posted entries, never from holds.',
          from: 'Not a sum: how a credit account works. A hold can still be reversed, lapse or clear at another amount, so only posted entries are final enough to charge interest on.',
        },
      ],
      tables: [
        {
          title: 'accounts: balance and holds on one row',
          lang: 'sql',
          code: `-- PostgreSQL. Amounts in pence. One partition shown: accounts
-- are split across databases by account_id, and a card's account
-- picks the database, so a retry reaches the same one.
CREATE TABLE accounts (
  account_id        text PRIMARY KEY,  -- 'acc_7731'
  balance_pence     bigint NOT NULL,   -- posted
  held_pence        bigint NOT NULL DEFAULT 0,  -- open holds
  spent_today_pence bigint NOT NULL DEFAULT 0,
  daily_limit_pence bigint             -- NULL: no daily limit
);
-- Available = balance_pence - held_pence.`,
          note: 'The row every hold and posting locks. mastercard_settlement is an account too, but nothing locks it: its total is summed from postings, so it is never a hot row.',
        },
        {
          title: 'holds: one per authorisation',
          lang: 'sql',
          code: `CREATE TABLE holds (
  hold_id          text PRIMARY KEY,     -- 'hold_5521907'
  auth_key         text NOT NULL UNIQUE, -- token|date|STAN|RRN
  account_id       text NOT NULL,        -- 'acc_7731'
  card_token       text NOT NULL,
  amount_pence     bigint NOT NULL,      -- 3640
  txn_amount_minor bigint NOT NULL,      -- 4200
  txn_currency     char(3) NOT NULL,     -- 'EUR'
  auth_code        text NOT NULL,        -- 'K7Q2M9'
  merchant_id      text NOT NULL,        -- 'M-IE-30417'
  status           text NOT NULL DEFAULT 'open' CHECK (status IN
                     ('open', 'released', 'reversed', 'lapsed')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- the network's window: 2 days, card present on Mastercard
  expires_at       timestamptz NOT NULL
                     DEFAULT now() + interval '2 days'
);`,
          note: 'UNIQUE (auth_key) is what makes a retry or a repeated advice write nothing.',
        },
        {
          title: 'holds: the indexes the queries use',
          lang: 'sql',
          code: `-- Clearing's match: auth code and card, then the rest.
CREATE INDEX holds_match ON holds (auth_code, card_token)
  WHERE status = 'open';
-- The app's pending list.
CREATE INDEX holds_pending ON holds (account_id, created_at)
  WHERE status = 'open';
-- The lapse sweep.
CREATE INDEX holds_expiry ON holds (expires_at)
  WHERE status = 'open';`,
          note: 'Partial indexes cover open holds only, so they stay small however many old holds the table keeps.',
        },
        {
          title: 'postings: one per clearing record',
          lang: 'sql',
          code: `CREATE TABLE postings (
  posting_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  file_id         text NOT NULL,      -- 'clr-2026-11-13-02'
  record_no       integer NOT NULL,   -- 118442
  hold_id         text,               -- NULL: no hold matched
  debit_account   text NOT NULL,      -- 'acc_7731'
  credit_account  text NOT NULL,      -- 'mastercard_settlement'
  amount_pence    bigint NOT NULL CHECK (amount_pence > 0),
  currency        char(3) NOT NULL,   -- 'GBP'
  settlement_date date NOT NULL,      -- '2026-11-13'
  UNIQUE (file_id, record_no)         -- a rerun posts nothing
);
CREATE INDEX postings_by_debit
  ON postings (debit_account, posting_id);
CREATE INDEX postings_by_credit
  ON postings (credit_account, posting_id);
CREATE INDEX postings_by_day ON postings (settlement_date);`,
          note: 'Double entry in one row: a debit account, a credit account and one positive amount, so every row sums to zero. A refund swaps the two accounts.',
        },
        {
          title: 'outbox: events waiting for the relay',
          lang: 'sql',
          code: `CREATE TABLE outbox (
  seq        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id   text NOT NULL UNIQUE,  -- 'evt_01JC9W3K2T'
  card_token text NOT NULL,         -- the log's key
  type       text NOT NULL,         -- 'authorised', 'cleared'
  payload    jsonb NOT NULL,
  sent_at    timestamptz            -- NULL until the log acks
);
CREATE INDEX outbox_unsent ON outbox (seq)
  WHERE sent_at IS NULL;`,
          note: 'Written in the same transaction as each hold and posting. The relay reads it through outbox_unsent.',
        },
      ],
      queries: [
        {
          title: 'The two writes that matter most',
          lang: 'text',
          code: `The hold:  one transaction, on the "hold" connection.
  lock accounts row, look up auth_key, check funds and the
  daily limit, insert holds and outbox, update accounts.
Clearing:  one transaction per record, on "post, release".
  lock accounts row, insert postings ON CONFLICT (file_id,
  record_no) DO NOTHING, release the hold, insert outbox.`,
          note: 'Both lock the account row first, so they queue on it rather than deadlock. Hold target 20 ms, near 100 a second at the yearly peak.',
        },
        {
          title: 'Reversal (0400): release the hold once',
          lang: 'sql',
          code: `BEGIN;
SELECT held_pence FROM accounts
 WHERE account_id = 'acc_7731' FOR UPDATE;
UPDATE holds SET status = 'reversed'
 WHERE auth_key = 'tok_8f3a91e2|2026-11-12|004217|631612004217'
   AND status = 'open'
RETURNING hold_id, amount_pence;
-- No row: already reversed, cleared or lapsed. COMMIT, done.
UPDATE accounts SET held_pence = held_pence - 3640
 WHERE account_id = 'acc_7731';
INSERT INTO outbox (event_id, card_token, type, payload)
VALUES ('evt_01JCA2M8RX', 'tok_8f3a91e2', 'reversed',
  '{"hold_id": "hold_5521907", "amount_pence": 3640}');
COMMIT;`,
          note: 'Illustrative: the tour\'s lunch was not reversed. AND status = \'open\' makes a repeated 0400 write nothing. Giving back spent_today_pence is left out.',
        },
        {
          title: 'Stand-in advice (0120): apply it once',
          lang: 'sql',
          code: `BEGIN;
SELECT held_pence FROM accounts
 WHERE account_id = 'acc_7731' FOR UPDATE;
-- No funds check: the network has decided, we apply it.
INSERT INTO holds (hold_id, auth_key, account_id, card_token,
  amount_pence, txn_amount_minor, txn_currency, auth_code,
  merchant_id)
VALUES ('hold_5523310',
  'tok_8f3a91e2|2026-11-12|004391|631613004391', 'acc_7731',
  'tok_8f3a91e2', 1250, 1250, 'GBP', 'S41X7P', 'M-GB-20118')
ON CONFLICT (auth_key) DO NOTHING
RETURNING hold_id;
-- No row: already applied. COMMIT, done.
UPDATE accounts SET held_pence = held_pence + 1250,
       spent_today_pence = spent_today_pence + 1250
 WHERE account_id = 'acc_7731';
-- and an outbox row, as for any hold
COMMIT;`,
          note: 'STAN, RRN and amount from the page\'s advice; hold id, auth code and merchant are illustrative. If our own late approval already holds under this key, the insert does nothing and that hold stays.',
        },
        {
          title: 'Lapse sweep',
          lang: 'sql',
          code: `SELECT hold_id, account_id, amount_pence
  FROM holds
 WHERE status = 'open' AND expires_at < now()
 ORDER BY expires_at
 LIMIT 1000;
-- Each is released like a reversal, in its own transaction,
-- with status 'lapsed' and the same AND status = 'open'.`,
          note: 'Every few minutes, on holds_expiry. A clearing record that comes after the lapse finds no open hold and is posted anyway, as unmatched.',
        },
        {
          title: 'The app opens',
          lang: 'sql',
          code: `SELECT balance_pence - held_pence AS available_pence
  FROM accounts WHERE account_id = 'acc_7731';

SELECT hold_id, amount_pence, merchant_id, created_at
  FROM holds
 WHERE account_id = 'acc_7731' AND status = 'open'
 ORDER BY created_at DESC LIMIT 50;      -- holds_pending

SELECT posting_id, amount_pence, settlement_date
  FROM postings
 WHERE debit_account = 'acc_7731'
 ORDER BY posting_id DESC LIMIT 50;      -- postings_by_debit`,
          note: 'Pending from holds, final from postings. Refunds credit the account, so the feed also reads postings_by_credit and merges the two.',
        },
      ],
      fails: 'The one dependency the authoriser cannot do without. If it cannot answer, decline and let stand-in carry the load, because an approval with no hold breaks the balance. The primary replicates synchronously to the other site.',
      alternatives: [
        {
          name: 'Relational database, one transaction per hold, partitioned by account', chosen: true, good: 'A lock on the account row makes the funds check exact, and it is easy to audit.', cost: 'A busy business with many cards queues on one row.',
          what: "A relational database partitioned by account, with a synchronous replica in the other site. Each hold is one transaction: lock the account row, check available funds and the daily limit, insert the hold and the outbox event, keyed by the network's identifiers.",
          pros: [
            'A lock on the account row makes the funds check exact: two taps on the last £10 cannot both succeed.',
            'Easy to audit: double-entry rows, each with its key.',
            'At about 100 holds a second at the yearly peak, one primary is plenty.',
          ],
          cons: [
            'A busy business with many cards queues on one row.',
            'A primary failover stalls holds for seconds, and stand-in carries those purchases.',
            'Synchronous replication to the other site adds a round trip to every commit.',
          ],
        },
        {
          name: 'Distributed SQL (Spanner, CockroachDB) across both sites', good: 'No failover step.', cost: 'Consensus adds a cross-site round trip to every hold.',
          what: 'A distributed SQL database spread over both sites, replicating each write by consensus. The hold is still one transaction, and replicas take over by themselves when a node fails.',
          pros: [
            'No failover step to run by hand.',
            'Strong consistency across sites without our own replication set-up.',
            'Splits data by key as it grows.',
          ],
          cons: [
            'Consensus adds a cross-site round trip to every hold, as the synchronous replica does, and more when the leader for an account sits in the other site.',
            'A majority needs three locations: with only two sites, losing one can stop writes.',
            'One busy account is still serialised, so the hot-row queue remains.',
          ],
        },
        {
          name: 'Event-sourced ledger', good: 'Complete history and replay.', cost: 'The available balance must still be derived exactly and fast.',
          what: 'Store only the events (hold placed, posted, released) and derive balances by replaying them. The funds check would read a projection of the available balance.',
          pros: [
            'Complete history and replay.',
            'A natural fit with the card events log and with audit.',
          ],
          cons: [
            'The available balance must still be derived exactly and fast, inside 20 ms.',
            'The funds check still needs a lock or a version check on the account, so the hard part moves rather than goes.',
            'A wrong event is fixed by another event, not an update.',
          ],
        },
        {
          name: 'Holds in a fast cache, written to the ledger later',
          good: 'Faster holds, and less load on the ledger at peak.',
          cost: 'Can approve money that is not there, and a crash loses holds.',
          what: "Place the hold in an in-memory store that keeps each account's available balance, and write it to the ledger afterwards. The authoriser would check funds against the cache.",
          pros: [
            'Faster than a database transaction.',
            'Takes load off the ledger at peak.',
          ],
          cons: [
            'Can approve money that is not there: the cache and the ledger can disagree.',
            'A crash between the cache and the ledger write loses holds.',
            "Saves little: the ledger's 20 ms is well inside the budget, as the page's decision says.",
          ],
        },
      ],
      say: 'Strongly consistent where money is decided: the funds check and the hold are one transaction. Notifications, rewards and analytics can be eventually consistent.',
      see: [
        { id: 'two-phase-locking', label: 'Two-phase locking' },
        { id: 'mvcc', label: 'MVCC' },
        { id: 'leader-replication', label: 'Leader replication' },
        { id: 'b-plus-tree', label: 'B+ tree' },
      ],
    },
    {
      id: 'clearing',
      name: 'Clearing',
      tech: 'match, post',
      x: 810, y: 350, w: 140, h: 56, kind: 'node',
      what: 'Reads the network\'s clearing files several times a day. For each record it finds the hold it belongs to, posts the final amount (which may differ), releases the hold, and applies fees and currency conversion as the record states. Records with no hold, such as offline taps, forced posts and refunds, are posted anyway. A dispute is a later event on the same purchase: raised through the network, with the money moving back through clearing and settlement.',
      why: 'Clearing, not authorisation, moves the money. The issuer must honour clearing records: the network does not stop forced posts, and the remedy for a wrong one is a dispute.',
      built: [
        { name: "Clearing files", what: "Batches of final purchase records that Mastercard delivers several times a day: one record per purchase or refund, with the final amount, conversion and fees. Each file has an id and record counts.", why: "Clearing, not authorisation, moves the money, and the issuer must honour every record. Taking each file as one job lets it be checked against its own counts and run again safely." },
        { name: "Matching", what: "Finding the hold a clearing record belongs to. With no single linking field, it uses the authorisation code (field 38), card, merchant and original amount.", why: "The amount in pounds can change between hold and bill, so the original currency amount is used. Records that match nothing are still posted and go to a queue for people." },
        { name: "Idempotent per record", what: "A technique: each posting is unique on its file id and record number, so handling a record a second time writes nothing.", why: "A file delivered twice, or a job rerun after a failure, must post nothing twice. With 200,000 to 300,000 records a file, a safe rerun is the simplest recovery." },
      ],
      numbers: [
        {
          text: 'No single field links a clearing record to its authorisation: match on authorisation code (field 38), card, merchant and amount (Paymentology).',
          from: 'Not a sum. Taken from a source cited on the page: Paymentology\'s guide to clearing, settlement and reconciliation.',
        },
        {
          text: 'Marqeta says it matches about 99 per cent, against an industry norm of about 88 per cent.',
          from: 'Not a sum. Taken from a source cited on the page: Marqeta\'s blog on clearing and settlement. Both figures are Marqeta\'s own claims.',
        },
        {
          text: 'About 1.2 million records a day (assumption) in four to six files.',
          from: 'One record per purchase: 1.2 million purchases a day from "Numbers to have ready", leaving out refunds and offline taps. Mastercard runs six cycles a day and issuers usually take four or five (Paymentology), so four to six files. 1.2 million ÷ 6 = 200,000 and ÷ 4 = 300,000 records a file.',
        },
      ],
      tables: [
        {
          title: 'clearing_files: one row per file',
          lang: 'sql',
          code: `CREATE TABLE clearing_files (
  file_id         text PRIMARY KEY,   -- 'clr-2026-11-13-02'
  settlement_date date NOT NULL,      -- '2026-11-13'
  record_count    integer NOT NULL,   -- 241806, from the header
  net_pence       bigint,             -- the file's own total
  status          text NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'checked', 'posted',
                      'set_aside')),
  received_at     timestamptz NOT NULL DEFAULT now()
);`,
          note: 'Clearing\'s own tables, read by reconciliation. Shown in PostgreSQL syntax.',
        },
        {
          title: 'clearing_records: one row per record',
          lang: 'sql',
          code: `CREATE TABLE clearing_records (
  file_id          text NOT NULL REFERENCES clearing_files,
  record_no        integer NOT NULL,   -- 118442
  settlement_date  date NOT NULL,
  type             text NOT NULL,      -- 'purchase', 'refund'
  auth_code        text,               -- 'K7Q2M9'; NULL offline
  card_token       text NOT NULL,      -- from the vault
  merchant_id      text NOT NULL,      -- 'M-IE-30417'
  txn_amount_minor bigint NOT NULL,    -- 4200
  txn_currency     char(3) NOT NULL,   -- 'EUR'
  billing_pence    bigint NOT NULL,    -- 3655
  status           text NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'posted', 'unmatched')),
  hold_id          text,               -- 'hold_5521907'
  reason           text,               -- why unmatched
  PRIMARY KEY (file_id, record_no)
);
CREATE INDEX records_unmatched ON clearing_records
  (settlement_date) WHERE status = 'unmatched';`,
          note: 'unmatched means posted with no hold and waiting for a person. The card number in the file is swapped for its token at the vault as each record is parsed.',
        },
      ],
      queries: [
        {
          title: 'A file arrives, perhaps twice',
          lang: 'sql',
          code: `INSERT INTO clearing_files
  (file_id, settlement_date, record_count)
VALUES ('clr-2026-11-13-02', '2026-11-13', 241806)
ON CONFLICT (file_id) DO NOTHING
RETURNING file_id;
-- No row: seen before. Carry on from records not yet posted.`,
          note: 'Four to six files a day, 200,000 to 300,000 records each.',
        },
        {
          title: 'Check the file against its header',
          lang: 'sql',
          code: `SELECT f.record_count, COUNT(r.record_no) AS parsed
  FROM clearing_files f
  LEFT JOIN clearing_records r USING (file_id)
 WHERE f.file_id = 'clr-2026-11-13-02'
 GROUP BY f.record_count;
-- 241806 and 241806, or the file is set aside and run again.`,
          note: 'Once per file, after parsing and before any posting.',
        },
        {
          title: 'Next records to post',
          lang: 'sql',
          code: `SELECT record_no, auth_code, card_token, merchant_id,
       txn_amount_minor, txn_currency, billing_pence
  FROM clearing_records
 WHERE file_id = 'clr-2026-11-13-02' AND status = 'new'
 ORDER BY record_no LIMIT 500;`,
          note: 'Each is matched to its hold and posted on the "post, release" connection, then marked below. A rerun picks up where it stopped.',
        },
        {
          title: 'Mark a record posted',
          lang: 'sql',
          code: `UPDATE clearing_records
   SET status = 'posted', hold_id = 'hold_5521907'
 WHERE file_id = 'clr-2026-11-13-02' AND record_no = 118442;`,
          note: 'After the ledger commits. If this is lost in a crash, the rerun meets the ledger\'s UNIQUE (file_id, record_no) and posts nothing twice.',
        },
      ],
      fails: 'A file processed twice must post nothing twice: every record is keyed by file and record number. A bad file is set aside and run again. Unmatched records go to a queue for people, and holds that are never cleared lapse when their window ends.',
      alternatives: [
        {
          name: 'Batch per file, idempotent per record', chosen: true, good: 'Simple to rerun, and each file reconciles to its own totals.', cost: 'Posting lags the file by minutes.',
          what: 'Each clearing file is one job: parse it, check its counts, match each record to its hold on authorisation code, card, merchant and amount, and post it in one transaction. Records are keyed by file and record number, so a rerun posts nothing twice.',
          pros: [
            'Simple to rerun after a failure or a bad file.',
            'Each file reconciles to its own totals and record counts.',
            'Unmatched records from each file go to one queue for people.',
          ],
          cons: [
            'Posting lags the file by minutes.',
            'A file of 200,000 to 300,000 records arrives at once, so postings come in bursts.',
            'With no single linking field, some records will always need people.',
          ],
        },
        {
          name: 'Stream records as they are parsed', good: 'Posted a little sooner.', cost: 'Files still arrive in batches, so little is gained.',
          what: 'Parse each file into records on a log and let a consumer match and post each one as it arrives. The key stays the same: file and record number.',
          pros: [
            'Posted a little sooner.',
            'Spreads the posting load rather than one burst per file.',
            'Uses the same log as card events.',
          ],
          cons: [
            'Files still arrive in batches, so little is gained.',
            'Checking a whole file against its totals becomes a separate step.',
            'More moving parts for a job that runs four to six times a day.',
          ],
        },
        {
          name: 'Leave clearing to an issuer processor', good: 'No file formats to learn.', cost: 'Their matching rate becomes yours.',
          what: 'An issuer processor takes the clearing files, matches each record and sends it to us, often as a webhook. We post what it sends and reconcile against its reports.',
          pros: [
            'No file formats to learn.',
            'One less job to run every day.',
          ],
          cons: [
            'Their matching rate becomes yours: Marqeta claims about 99 per cent against an industry norm of about 88.',
            'We still post forced posts and handle what they cannot match.',
            'Fits only if the processor also holds the network link, which this design does not use.',
          ],
        },
      ],
      say: 'Authorisation is a promise. Clearing is the bill. I match each record to its hold, post the final amount, release the hold, and never assume the two are equal.',
      see: [{ id: 'hash-table', label: 'Hash table' }],
    },
    {
      id: 'recon',
      name: 'Reconciliation',
      short: 'Reconcile',
      tech: 'three-way, daily',
      x: 820, y: 474, w: 150, h: 64, kind: 'shared',
      what: 'Each day compares three records: our ledger postings, the totals in the clearing files, and the money that actually moved in the settlement account. Every difference is a break that someone must explain.',
      why: 'Each system can be right by its own lights and still disagree with the others. Reconciliation is the last line of defence, and it catches the bugs tests miss.',
      built: [
        { name: "Three-way reconciliation", what: "Comparing three records that should agree: our ledger postings, the clearing file totals and the settlement bank's statement. Each difference is a break with an owner.", why: "Each system can be right by its own lights and still disagree with the others. A two-way check of ledger against files would miss money that moved but was never in a file." },
        { name: "Daily batch", what: "A job that runs once a day over a complete day's data. It reads the ledger from a replica, so it adds no load to the primary.", why: "Settlement happens once a working day, so a daily comparison lines up with it. Monzo, cited on the page, runs daily reconciliation plus checks on each payment's state, as this design does. If the job stops nothing fails at once, so it has its own alert when a day is not reconciled by a fixed hour." },
      ],
      numbers: [
        {
          text: 'Monzo compares ledger and settlement account daily; each break alerts an engineer, who must record evidence to close it.',
          from: 'Not a sum. Taken from a source cited on the page: Monzo\'s 2022 blog, Processing payments safely at scale. Quoted as one bank\'s practice, not a rule.',
        },
      ],
      tables: [
        {
          title: 'statement_lines: what the bank says moved',
          lang: 'sql',
          code: `CREATE TABLE statement_lines (
  sequence    integer PRIMARY KEY,  -- 318; 317 came before
  line_date   date NOT NULL,        -- '2026-11-13'
  debit_pence bigint NOT NULL,      -- 2983893474
  reference   text NOT NULL         -- 'Mastercard settlement ...'
);`,
          note: 'Loaded from the settlement bank\'s daily statement. Simplified to one line per statement.',
        },
        {
          title: 'recon_days and breaks',
          lang: 'sql',
          code: `CREATE TABLE recon_days (
  day           date NOT NULL,
  currency      char(3) NOT NULL,
  ledger_pence  bigint NOT NULL,      -- 2983892974
  files_pence   bigint NOT NULL,      -- 2983892974
  settled_pence bigint NOT NULL,      -- 2983893474
  PRIMARY KEY (day, currency)
);
CREATE TABLE breaks (
  break_id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  day          date NOT NULL,
  currency     char(3) NOT NULL,
  between_what text NOT NULL,  -- 'files v settlement account'
  amount_pence bigint NOT NULL,       -- 500
  owner        text,
  evidence     text,
  closed_at    timestamptz,
  CHECK (closed_at IS NULL OR evidence IS NOT NULL),
  FOREIGN KEY (day, currency) REFERENCES recon_days
);`,
          note: 'The CHECK means a break cannot be closed without evidence.',
        },
      ],
      queries: [
        {
          title: 'A gap in the statement sequence',
          lang: 'sql',
          code: `SELECT s.sequence + 1 AS missing
  FROM statement_lines s
 WHERE NOT EXISTS (SELECT 1 FROM statement_lines n
                    WHERE n.sequence = s.sequence + 1)
   AND s.sequence < (SELECT max(sequence)
                       FROM statement_lines);`,
          note: 'Each day, after loading. Any row is a missing statement.',
        },
        {
          title: 'Record the day and open a break',
          lang: 'sql',
          code: `INSERT INTO recon_days (day, currency, ledger_pence,
  files_pence, settled_pence)
VALUES ('2026-11-13', 'GBP', 2983892974, 2983892974,
        2983893474);
INSERT INTO breaks (day, currency, between_what, amount_pence)
VALUES ('2026-11-13', 'GBP', 'files v settlement account', 500);`,
          note: 'The page\'s drill: £5 too much settled. The three totals come from the ledger replica, clearing\'s tables and the statement.',
        },
        {
          title: 'Alert: not reconciled by the cut-off',
          lang: 'sql',
          code: `SELECT NOT EXISTS (SELECT 1 FROM recon_days
                    WHERE day = '2026-11-13'
                      AND currency = 'GBP') AS alert;`,
          note: 'Run at a fixed hour each working day, so a stopped job is noticed.',
        },
        {
          title: 'Close a break, with evidence',
          lang: 'sql',
          code: `UPDATE breaks
   SET evidence = 'bank fee taken with the debit; ref 0318',
       closed_at = now()
 WHERE break_id = 1 AND closed_at IS NULL;`,
          note: 'Illustrative evidence. Without it the CHECK rejects the update.',
        },
      ],
      fails: 'If it stops running nothing fails at once, and errors build up unseen. Alert when a day is not reconciled by a fixed hour.',
      alternatives: [
        {
          name: 'Daily three-way batch, plus checks on each payment\'s state', chosen: true, good: 'The batch catches everything; the per-payment checks catch most things sooner. Monzo runs both.', cost: 'Two systems to keep in step with the rules.',
          what: "Once a day compare our postings by currency and settlement date, the clearing files' totals, and the settlement bank's statement. Each difference is a break with an owner. Checks on each payment's state catch most problems sooner.",
          pros: [
            'The batch catches everything, including money that moved but was never in a file.',
            'Per-payment checks catch most things sooner. Monzo runs both.',
            'Each break has an owner and evidence that an auditor can follow.',
          ],
          cons: [
            'Two systems to keep in step with the rules.',
            'If it stops, nothing fails at once, so it needs its own alert: a day not reconciled by a fixed hour.',
            'Breaks need people to explain them.',
          ],
        },
        {
          name: 'Two-way only: ledger against clearing', good: 'Simpler.', cost: 'Misses the case where the money that moved is not what the files said.',
          what: 'Compare ledger postings with the clearing file totals only, and trust that settlement matched the files.',
          pros: [
            'Simpler: two internal records, no bank statement to load.',
            'Still catches matching and posting bugs in clearing.',
          ],
          cons: [
            'Misses the case where the money that moved is not what the files said.',
            'A settlement error shows up only when the account runs short.',
          ],
        },
        {
          name: 'Spreadsheets in finance', good: 'Nothing to build at first.', cost: 'Does not scale, and leaves no audit trail.',
          what: 'Finance downloads the reports each day and compares them by hand.',
          pros: [
            'Nothing to build at first.',
            'Flexible while volumes are small and the rules still change.',
          ],
          cons: [
            'Does not scale to about 1.2 million postings a day.',
            'Leaves no audit trail of who checked what.',
            'Slow, so errors build up between checks.',
          ],
        },
      ],
      say: 'I reconcile three ways every day: our ledger, the network\'s files and the bank statement. Each break gets an owner and evidence.',
      see: [{ id: 'stream-joins', label: 'Joins on a key' }],
    },
    {
      id: 'bank',
      name: 'Settlement account',
      short: 'Settlement',
      tech: 'bank account',
      x: 575, y: 474, w: 150, h: 64, kind: 'outside',
      what: 'Our account at a settlement bank. Once a working day the network collects our net position from it: what our cardholders spent, less refunds, less the interchange owed to us.',
      why: 'Settlement is one net movement a day per currency, not one per purchase. The account must hold enough on each settlement day, so it is forecast from open holds and cleared totals.',
      built: [
        { name: "Settlement account", what: "Our account in pounds at a settlement bank. Once a working day Mastercard collects our net position from it: what our cards spent, less refunds, less the interchange owed to us.", why: "Settlement is one net movement a day per currency, not one per purchase. One account at one UK bank gives one figure to forecast and reconcile; the cost is that foreign purchases are converted by the network at its rate." },
      ],
      numbers: [
        {
          text: 'Settlement is typically one to three days after the purchase (Marqeta).',
          from: 'Not a sum. Taken from a source cited on the page: Marqeta\'s blog on clearing and settlement.',
        },
        {
          text: 'Settlement runs Monday to Friday; Saturday\'s clearing is netted into Monday (Paymentology).',
          from: 'Not a sum. Taken from a source cited on the page: Paymentology\'s guide to clearing, settlement and reconciliation.',
        },
      ],
      fails: 'Short of funds on a settlement day breaks scheme rules. Forecast each day\'s position and alert well before the cut-off.',
      alternatives: [
        {
          name: 'Settle in pounds through one UK settlement bank', chosen: true, good: 'One account to forecast and reconcile.', cost: 'Foreign purchases are converted by the network at its rate.',
          what: 'One account in pounds at one UK settlement bank. Once a working day the network collects our net position from it, and we forecast that amount from open holds and cleared totals.',
          pros: [
            'One account to forecast and reconcile.',
            'One net movement a day, not one per purchase.',
            'Matches a ledger kept in pounds.',
          ],
          cons: [
            'Foreign purchases are converted by the network at its rate, as with the €42.00 lunch.',
            "One bank's outage or cut-off is a single point of failure for settlement.",
            'The account must hold enough on each settlement day, so forecasting is a job of its own.',
          ],
        },
        {
          name: 'Accounts in several currencies', good: 'Hold euros and dollars to settle without conversion.', cost: 'More accounts to fund and reconcile.',
          what: 'Hold euro and dollar accounts too, and settle each currency from its own account.',
          pros: [
            'Settle without conversion.',
            'Ready if we later offer cards in other currencies.',
          ],
          cons: [
            'More accounts to fund and reconcile.',
            'Our cardholders\' accounts are in pounds, so we would still convert, only at another point.',
            "Outside this page's simplification of one currency.",
          ],
        },
        {
          name: 'A sponsor bank settles for us', good: 'Needed when we are not a direct scheme member.', cost: 'Their cut-offs and fees.',
          what: 'A bank that is a direct scheme member settles with the network for us, and we settle with that bank.',
          pros: [
            'Needed when we are not a direct scheme member.',
            "The sponsor deals with the network's settlement.",
          ],
          cons: [
            'Their cut-offs and fees.',
            'One more party to reconcile against.',
            'This page assumes we settle with the network ourselves, through one settlement bank.',
          ],
        },
      ],
      say: 'Money moves once a day, net. The ledger moves per purchase. Reconciliation is what makes the two agree.',
    },
    {
      id: 'events',
      name: 'Card events',
      tech: 'Kafka, outbox',
      x: 1060, y: 226, w: 130, h: 64, kind: 'queue',
      what: 'Every change in a card transaction (authorised, declined, reversed, cleared, refunded, disputed) as an event, keyed by card. Each is written to an outbox table in the same transaction as the ledger change, then relayed to the log.',
      why: 'The money and the event must never disagree. Writing both in one database transaction, then relaying, gives at-least-once delivery without a distributed transaction.',
      built: [
        { name: "Kafka", what: "An open-source distributed log: services append messages to named topics, and many readers can each read them in order, at their own pace, and read them again. Order is kept within a partition, and one key always goes to the same partition.", why: "Several services need every event, must not slow an authorisation, and must be able to replay after a bug. Keying by card token keeps each card's events in order. A queue per consumer was passed over because it removes a message once handled, so there is no replay." },
        { name: "Transactional outbox", what: "A technique: write the event to an outbox table in the same database transaction as the change it describes, then let a separate relay publish it to the log.", why: "The money and the event must never disagree. Publishing after the commit can lose an event in a crash, and one distributed transaction over database and log would let a log outage stop authorisations. The cost is an extra insert in every hold and a relay to run." },
      ],
      numbers: [
        {
          text: 'About four events per purchase (assumption), so about 5 million a day.',
          from: 'Four is an assumption: authorised and cleared on every purchase, plus reversals, advices, refunds and disputes on some, rounded up. 1.2 million purchases a day ("Numbers to have ready") × 4 = 4.8 million, about 5 million.',
        },
      ],
      tables: [
        {
          title: 'Topic card-events',
          lang: 'text',
          code: `topic       card-events
key         card_token, e.g. tok_8f3a91e2
value       one event as JSON (see the outbox connection)
partitions  12 (assumption): under 60 events a second needs
            few; more lets more consumers in a group share it
retention   7 days, Kafka's default (assumption): the window
            in which a consumer can replay after a bug
source      the ledger's outbox table is the record; the log
            is the copy that readers read`,
          note: 'About 5 million events a day. Order holds per card, because one key always goes to one partition.',
        },
      ],
      queries: [
        {
          title: 'Lag per consumer group',
          lang: 'text',
          code: `kafka-consumer-groups.sh --bootstrap-server kafka:9092 \\
  --describe --group notifications`,
          note: 'What to alert on: a group that falls behind sends late notifications.',
        },
        {
          title: 'Replay a group from a time',
          lang: 'text',
          code: `# Stop the group's consumers first.
kafka-consumer-groups.sh --bootstrap-server kafka:9092 \\
  --group rewards --topic card-events --reset-offsets \\
  --to-datetime 2026-11-12T00:00:00.000 --execute`,
          note: 'After fixing a bug in rewards. Only works inside the retention window.',
        },
        {
          title: 'Read the topic by hand',
          lang: 'text',
          code: `kafka-console-consumer.sh --bootstrap-server kafka:9092 \\
  --topic card-events --from-beginning \\
  --property print.key=true`,
          note: 'For debugging. With no --group it joins a throwaway group, so no real group\'s offset moves.',
        },
      ],
      fails: 'If the log is down, events wait in the outbox and the authorisation path carries on. Consumers drop repeats by event id.',
      alternatives: [
        {
          name: 'Transactional outbox and a relay', chosen: true, good: 'Event and ledger change commit together.', cost: 'An extra table and a relay to run.',
          what: 'The hold transaction also inserts a row in an outbox table. A relay reads new rows, publishes them to the card events log keyed by card, and marks them sent once the log acknowledges.',
          pros: [
            'Event and ledger change commit together, so they never disagree.',
            'If the log is down, events wait in the table and authorisations carry on.',
            'Keyed by card, so each card\'s events stay in order.',
          ],
          cons: [
            'An extra table and a relay to run.',
            'At-least-once: the relay can publish a row twice, so consumers drop repeats by event id.',
            'An extra insert in every hold transaction.',
          ],
        },
        {
          name: 'Change data capture from the database log', good: 'No extra write in the transaction.', cost: 'Events shaped by table rows, and tied to database internals.',
          what: "A connector reads the ledger database's own change log and turns each committed row change into an event. Nothing extra is written in the hold transaction.",
          pros: [
            'No extra write in the transaction.',
            'Every committed change is captured, even ones made by hand.',
          ],
          cons: [
            'Events shaped by table rows, and tied to database internals.',
            'A schema change can break consumers.',
            'Another component to keep in step through database failovers.',
          ],
        },
        {
          name: 'Publish after commit', good: 'Simplest code.', cost: 'A crash between commit and publish loses the event.',
          what: 'Commit the hold, then publish the event from the same code.',
          pros: [
            'Simplest code.',
            'No extra table or relay.',
          ],
          cons: [
            'A crash between commit and publish loses the event.',
            'A slow log slows the authorisation, unless the publish is dropped.',
            'Money and events can disagree, which this design forbids.',
          ],
        },
        {
          name: 'One distributed transaction over database and log',
          good: 'Both commit or neither does.',
          cost: 'Slow and fragile, and a log outage would stop holds.',
          what: 'Make the ledger write and the log write one atomic transaction across both systems, run by a coordinator.',
          pros: [
            'Both commit or neither does.',
            'No relay and no rows waiting to be sent.',
          ],
          cons: [
            'Slow and fragile: coordinator round trips inside the 20 ms hold.',
            'The ledger cannot commit while the log is down, so a log outage stops authorisations.',
          ],
        },
      ],
      say: 'I never write to the database and the log as two steps. The event goes in an outbox in the same transaction, and a relay publishes it.',
      see: [
        { id: 'append-log', label: 'Append-only log' },
        { id: 'queue', label: 'Queue' },
      ],
    },
    {
      id: 'consumers',
      name: 'Event consumers',
      short: 'Consumers',
      tech: 'alerts, rewards',
      x: 1060, y: 474, w: 150, h: 64, kind: 'shared',
      what: 'Independent readers of card events: push notifications and receipts, the suspicious-transaction alerts service (the Suspicious transaction alerts design on this site), cashback and rewards, accounting integrations, analytics.',
      why: 'None of them may slow an authorisation, and each reads at its own pace and can replay. A notification a second late is fine. A purchase a second late is a decline.',
      built: [
        { name: "Consumer groups", what: "Kafka's way of letting several services read one topic independently. Each group keeps its own offset, its place in the log.", why: "Notifications, alerts, rewards, accounting and analytics each read at their own pace, and each scales or fails alone. About 5 million events a day is under 60 a second on average, so load is light; independence is the point." },
        { name: "Alerts", what: "The suspicious-transaction alerts service, a design of its own on this site. It reads every card event to look for suspicious patterns.", why: "It needs every purchase but must never delay one, so it reads the log rather than being called by the authoriser." },
        { name: "Rewards", what: "Cashback and rewards worked out from card purchases.", why: "A cashback a second late costs nothing; a purchase a second late is a decline. Reading the log keeps it off the authorisation path." },
      ],
      numbers: [
        {
          text: 'Monzo (then Mondo) showed a notification in under 3 seconds in 2015.',
          from: 'Not a sum. Taken from a source cited on the page: Monzo\'s 2015 blog, 3 Second Sandwich. An example of what is possible, not a target this page sets.',
        },
      ],
      tables: [
        {
          title: 'seen_events, in each consumer\'s database',
          lang: 'sql',
          code: `CREATE TABLE seen_events (
  event_id text PRIMARY KEY,         -- 'evt_01JC9W3K2T'
  seen_at  timestamptz NOT NULL DEFAULT now()
);`,
          note: 'Each consumer also keeps its own data (rewards balances, notification history); not shown.',
        },
      ],
      queries: [
        {
          title: 'Drop a repeat',
          lang: 'sql',
          code: `INSERT INTO seen_events (event_id)
VALUES ('evt_01JC9W3K2T')
ON CONFLICT (event_id) DO NOTHING;
-- 0 rows: a repeat. Skip it and commit the offset.`,
          note: 'In the same transaction as the consumer\'s own work, for every event: under 60 a second on average.',
        },
        {
          title: 'Trim old ids',
          lang: 'sql',
          code: `DELETE FROM seen_events
 WHERE seen_at < now() - interval '8 days';`,
          note: 'Kept a day longer than the log\'s 7-day retention (assumed). A replay meant to redo work must first delete the ids it covers, or each event is skipped as a repeat.',
        },
      ],
      fails: 'A consumer that falls behind sends late notifications. It never touches money.',
      alternatives: [
        {
          name: 'Consumer groups on the log', chosen: true, good: 'Decoupled, replayable, each scales alone.', cost: 'Lag to watch on each.',
          what: 'Notifications, alerts, rewards, accounting and analytics each read the card events log in their own group and keep their own offset. About 5 million events a day is under 60 a second on average.',
          pros: [
            'Decoupled: none of them can slow an authorisation.',
            'Replayable: a consumer can read again after a bug.',
            'Each scales and fails alone.',
          ],
          cons: [
            'Lag to watch on each.',
            'At-least-once, so each must drop repeats by event id.',
            'Order holds only per card, not across cards.',
          ],
        },
        {
          name: 'Call them from the authoriser', good: 'Simple to follow.', cost: 'Every one of them adds latency and a way to fail.',
          what: 'After deciding, the authoriser calls the notification, alerts and rewards services itself.',
          pros: [
            'Simple to follow: one place shows everything that happens.',
            'No log to run.',
          ],
          cons: [
            'Every one of them adds latency and a way to fail.',
            'A slow rewards service could turn a purchase into a decline.',
            'No replay: a missed call is lost.',
          ],
        },
        {
          name: 'Webhooks to outside systems', good: 'Right for accounting partners.', cost: 'Retries and signing to build, fed from the log anyway.',
          what: 'Send events to outside systems, such as accounting partners, as signed HTTPS calls. A consumer of the log does the sending.',
          pros: [
            'Right for accounting partners outside our network.',
            'Partners need no access to our log.',
          ],
          cons: [
            'Retries and signing to build.',
            'Fed from the log anyway, so it adds to the log rather than replacing it.',
          ],
        },
        {
          name: 'A queue per consumer',
          good: 'Each consumer gets its own copy, with acknowledgement and retries per message.',
          cost: 'A message is gone once handled, so there is no replay.',
          what: 'Copy each event into a separate queue for each consumer, which removes a message once it is handled.',
          pros: [
            'Acknowledgement and retries per message come built in.',
            'One slow message need not hold up the rest, where order does not matter.',
          ],
          cons: [
            'A message is gone once handled, so a consumer cannot replay after a bug.',
            'A new consumer starts with no history.',
            'Keeping order per card is harder.',
          ],
        },
      ],
      say: 'Everything after the decision reads the log. The only thing on the authorisation path is what decides it.',
      see: [{ id: 'realtime-push', label: 'Real-time push' }],
    },
    {
      id: 'app',
      name: 'Cardholder app',
      short: 'App',
      tech: 'phone',
      x: 1200, y: 96, w: 120, h: 64, kind: 'outside',
      what: 'The business owner\'s phone. Shows the notification and the pending purchase, and is where cards are frozen and limits set.',
      why: 'A pending purchase is shown from the hold, with the merchant name from the authorisation. The final amount replaces it when clearing posts.',
      built: [
        { name: "Cardholder app on a phone", what: "The business owner's mobile app. It shows each purchase, pending from the hold and then final after clearing, and is where cards are frozen and limits set.", why: "It reads the ledger when opened, so the balance shown never depends on a notification arriving." },
        { name: "Push through Apple and Google (APNs, FCM)", what: "Apple Push Notification service and Firebase Cloud Messaging: Apple's and Google's services for delivering a message to an app on a phone. Our notification service sends to them, and they deliver it.", why: "Free and within seconds, which helps an owner spot a purchase they did not make. Delivery is best effort, so the notification is a prompt, never the record. SMS was passed over: it costs per message at about 1.2 million purchases a day and can be spoofed." },
      ],
      fails: 'Push is best effort. The app reads the ledger when opened, so a lost notification never means a wrong balance.',
      alternatives: [
        {
          name: 'Push through Apple and Google', chosen: true, good: 'Seconds, and free.', cost: 'No delivery guarantee.',
          what: "The notification consumer sends each event to Apple's and Google's push services, which deliver it to the owner's phone. The app reads the ledger when opened, so a lost push never means a wrong balance.",
          pros: [
            'Seconds, and free to send.',
            'Carries the amount, the merchant and the card used.',
            'The app can open straight onto the purchase.',
          ],
          cons: [
            'No delivery guarantee.',
            'Reaches only phones with the app installed and notifications on.',
            'Two outside services in the path.',
          ],
        },
        {
          name: 'SMS', good: 'Reaches phones without the app.', cost: 'Costs per message and can be spoofed.',
          what: 'Send a text message for each purchase through an SMS provider.',
          pros: [
            'Reaches phones without the app.',
            'Works with no data connection.',
          ],
          cons: [
            'Costs per message, at about 1.2 million purchases a day.',
            'Can be spoofed, which helps fraudsters pose as the bank.',
            'Plain text only.',
          ],
        },
        {
          name: 'Email', good: 'A record the owner can file.', cost: 'Too slow to stop fraud.',
          what: 'Email a receipt for each purchase to the business owner.',
          pros: [
            'A record the owner can file.',
            'Useful for accounts and expense receipts.',
          ],
          cons: [
            'Too slow to stop fraud.',
            'Easily lost in a busy inbox.',
          ],
        },
        {
          name: 'In-app feed only',
          good: 'Nothing to send and nothing to lose.',
          cost: 'No alert, so fraud goes unseen until the app is opened.',
          what: "Show purchases only in the app's feed, read from the ledger, with no notification.",
          pros: [
            'Nothing to send, and nothing that can be lost.',
            'The feed already reads from the ledger.',
          ],
          cons: [
            'No alert, so a fraudulent purchase goes unseen until the owner opens the app.',
            'The owner cannot freeze a card in the moment after a purchase they did not make.',
          ],
        },
      ],
      say: 'The phone hears within seconds, but it is told, not asked. The ledger stays the truth.',
    },
  ],

  flows: [
    {
      id: 'tap', from: 'merchant', to: 'network', d: 'M70,128 V194', label: 'tap',
      mode: 'external', via: 'acquirer', chip: 0.5,
      how: 'The terminal sends the purchase, with the chip\'s cryptogram, to the acquirer, which adds the merchant details and sends an authorisation request to the network.',
      delivery: 'Someone else\'s systems. Terminals retry, and send a reversal when they lose the answer.',
      alts: ['An online checkout, which arrives with a 3-D Secure result.', 'A wallet payment, which carries a network token in place of the card number.'],
      examples: [
        {
          title: 'What the till and the acquirer send',
          lang: 'text',
          code: `At the till (we never see this leg)
  amount       €42.00
  card         5xxx xxxx xxxx 1234 (masked here)
  entry        contactless, phone
  cryptogram   ARQC 1A2B3C4D5E6F7081, made for this purchase only
The acquirer adds
  merchant     Restaurant, Dublin, IE (id M-IE-30417)
  category     5812, restaurants
and sends it to Mastercard, which routes it to us as an 0100.`,
          note: 'Illustrative fields, not one message format: the till and the acquirer speak their own protocols.',
        },
        {
          title: 'Back to the till',
          lang: 'text',
          code: `  answer       approved (field 39: 00)
  auth code    K7Q2M9 (field 38)
  cryptogram   ARPC 9F8E7D6C5B4A3928, for the phone to check

If the till never gets the answer:
  the terminal sends an 0400 reversal, which releases the hold,
  or nothing comes and the £36.40 hold lapses at its window's end.`,
          note: 'The ARPC lets the phone check that the answer came from us.',
        },
      ],
      ways: [
        {
          name: 'Through the acquirer', chosen: true,
          what: "The terminal sends the purchase and the chip's cryptogram to the merchant's acquirer, which adds the merchant details and sends an authorisation request to Mastercard. We never see this leg, only the 0100 it produces.",
          pros: ['The standard four-party path: each bank connects once, to the network.', 'The acquirer handles terminals, their retries and their reversals.'],
          cons: ["Someone else's systems, with no guarantees to us.", 'If the answer never reaches the till, our hold stays until a reversal arrives or it lapses.'],
        },
        {
          name: 'Online checkout with 3-D Secure',
          what: "The cardholder pays on a website, and the merchant's provider first runs 3-D Secure with us. The 0100 then arrives carrying the result.",
          pros: ['The authoriser gets a strong authentication result.', 'The merchant is protected from fraud liability when it is used.'],
          cons: ['An extra step for the cardholder, and an authentication request for us to answer.', 'No chip cryptogram: the card is not present.'],
        },
        {
          name: 'Wallet payment with a network token',
          what: 'Apple Pay or Google Pay sends a network token in place of the card number, with a one-time cryptogram for the purchase. The merchant never sees the real number.',
          pros: ['The card number never reaches the merchant.', 'A cryptogram on every purchase, as with the chip.'],
          cons: ['The issuer decides whether each wallet token is created: another request to answer.', 'Another identifier to map to the card.'],
        },
      ],
      reply: {
        id: 'tapreply', label: 'approved',
        how: 'The answer goes back the same way, with the issuer\'s response cryptogram for the chip.',
        delivery: 'If it never reaches the till, the terminal reverses or the hold simply lapses.',
      },
    },
    {
      id: 'auth', from: 'network', to: 'gateway', d: 'M132,226 H265', label: '0100',
      mode: 'call', via: 'ISO 8583', chip: 0.5,
      how: 'An 0100 authorisation request on a long-lived TCP connection, length-prefixed. It carries the card number, amount and currency, merchant category, entry mode, chip data, and the trace and reference numbers that identify it.',
      delivery: 'The network waits a few seconds, then answers for us by stand-in. A retry carries the same identifiers, so the gateway returns the first answer.',
      alts: ['An HTTPS webhook from an issuer processor, with 2 to 3 seconds to answer.', 'ISO 20022, which the UK\'s CHAPS adopted in 2023; card networks still use ISO 8583.'],
      examples: [
        {
          title: 'MTI 0100, authorisation request',
          lang: 'text',
          code: `length prefix, then:
MTI 0100
bitmap        which numbered fields follow
card number   5xxx xxxx xxxx 1234 (masked here)
amount        42.00 EUR
field 11      STAN 004217
field 18      MCC 5812 (restaurants)
field 37      RRN 631612004217
entry mode    contactless
chip data     ARQC 1A2B3C4D5E6F7081 and the data it covers
merchant      Restaurant, Dublin, IE

idempotency key = card token + date + STAN + RRN
  tok_8f3a91e2|2026-11-12|004217|631612004217`,
          note: 'Fields without a number are described in words only. A retry carries the same 11 and 37, so it makes the same key.',
        },
        {
          title: 'MTI 0110, the answer',
          lang: 'text',
          code: `MTI 0110
field 11      STAN 004217          (as in the request)
field 37      RRN 631612004217     (the network matches on this)
field 38      auth code K7Q2M9
field 39      response code 00, approved
chip data     ARPC 9F8E7D6C5B4A3928

Other codes: 05 do not honour, 51 not sufficient funds.`,
          note: 'It may go back on any live connection: field 37 ties it to its request.',
        },
        {
          title: 'MTI 0120, an advice after stand-in',
          lang: 'text',
          code: `A later purchase on the same card, while our ledger failed over
(illustrative amount):
MTI 0120
amount        12.50 GBP
field 11      STAN 004391
field 37      RRN 631613004391
field 38      auth code from stand-in
field 39      00, approved by stand-in on our parameters

We post it as a hold, keyed the same way. We never decide again.`,
          note: 'An advice reports a decision already made: we apply it, once.',
        },
      ],
      ways: [
        {
          name: 'ISO 8583', chosen: true,
          what: 'An 0100 on a long-lived TCP connection, each message length-prefixed. The 0110 answer may go back on any live connection and is matched by its reference number.',
          pros: ["The network's own protocol: no translation and no extra hop.", 'Connections to both sites, so either can answer.', 'A retry carries the same identifiers, which make the idempotency key.'],
          cons: ['A binary dialect with bitmaps to parse, test and certify.', 'The network waits only a few seconds, then stands in.'],
        },
        {
          name: 'HTTPS webhook from an issuer processor',
          what: 'An issuer processor holds the ISO 8583 link and sends us each request as an HTTPS call. We have 2 to 3 seconds to answer (6 at Lithic).',
          pros: ['Plain HTTPS: easy to build, test and log.', 'No scheme certification of our own.'],
          cons: ['A budget set by someone else, inside theirs.', "The processor's outage is ours.", 'At this size the page connects directly.'],
        },
        {
          name: 'ISO 20022',
          what: 'A newer, richer message standard; CHAPS moved to it in June 2023. Card networks still authorise in ISO 8583, so it is not an option on this link today.',
          pros: ['Richer, structured data.', 'One standard shared with account-to-account payments.'],
          cons: ['ISO 20022 for cards is discussed, not done.', 'We would still have to speak ISO 8583 to Mastercard.'],
        },
      ],
      reply: {
        id: 'authreply', label: '0110',
        how: 'An 0110 response with a two-digit reason code (00 approved) and an authorisation code.',
        delivery: 'Sent on any live connection and matched by its reference number. A late one is ignored, and the network sends an advice of what it decided.',
      },
    },
    {
      id: 'vault', from: 'gateway', to: 'vault', d: 'M335,190 V131', label: 'PAN',
      mode: 'call', via: 'gRPC', chip: 0.5,
      how: 'Inside the PCI zone: the gateway looks up the token for the card number, usually from its own cache.',
      delivery: 'A read, safe to repeat, with a 5 ms deadline.',
      alts: ['A provider\'s vault over HTTPS.', 'A hash of the card number as the key, which still leaves the number in every system.'],
      examples: [
        {
          title: 'Service definition',
          lang: 'proto',
          code: `syntax = "proto3";

service Vault {
  rpc Tokenise(TokeniseRequest) returns (TokeniseReply);
}

message TokeniseRequest {
  bytes pan = 1;          // the card number: inside the PCI zone only
}

message TokeniseReply {
  string card_token = 1;  // random, meaningless outside the vault
}`,
        },
        {
          title: 'Example call',
          lang: 'text',
          code: `deadline 5 ms (most lookups hit the gateway's cache first)
-> Tokenise { pan: 5xxx xxxx xxxx 1234 (masked here) }
<- TokeniseReply { card_token: "tok_8f3a91e2" }`,
          note: 'From here on the card is tok_8f3a91e2 everywhere: authoriser, ledger, events and app.',
        },
      ],
      ways: [
        {
          name: 'gRPC', chosen: true,
          what: "Inside the PCI zone the gateway asks the vault for a card number's token, with a 5 ms deadline. It usually finds it in its own cache first, since a card's token never changes.",
          pros: ['A typed internal call with a deadline on it.', 'A read, safe to repeat.', 'The cache makes most lookups local.'],
          cons: ['The vault must be up and replicated to both sites.', 'The cache holds card numbers, so it must be protected like the vault.'],
        },
        {
          name: "A provider's vault over HTTPS",
          what: 'Send the card number over HTTPS to a provider that stores it and returns a token.',
          pros: ['No vault of our own to run.', 'The provider handles key rotation.'],
          cons: ['An outside hop against a 5 ms target.', "The provider's outage stops every authorisation."],
        },
        {
          name: 'A hash of the card number as the key',
          what: 'Use a hash of the card number as its identity everywhere, with no vault. The gateway computes it on each request.',
          pros: ['No lookup at all.', 'The same card always gives the same key.'],
          cons: ['Anything that needs the number itself still keeps it, so those systems stay in scope.', 'Card numbers are short and partly predictable, so a plain hash can be reversed by trying them.'],
        },
      ],
      reply: {
        id: 'token', label: 'token',
        how: 'The card\'s token, the only identity the rest of the system sees.',
        delivery: 'Cached on the gateway; a card\'s token never changes.',
      },
    },
    {
      id: 'hsm', from: 'gateway', to: 'hsm', d: 'M335,262 V322', label: 'ARQC',
      mode: 'call', via: 'HSM API', chip: 0.5,
      how: 'A command to verify the chip\'s ARQC (or the PIN block, or the card security code) and to produce the ARPC for the answer.',
      delivery: 'Stateless and safe to repeat; tried on a second module in the same site if the first does not answer.',
      alts: ['A cloud HSM.', 'Have the network verify on our behalf, where it offers that.'],
      examples: [
        {
          title: 'Command and reply',
          lang: 'text',
          code: `-> verify ARQC, produce ARPC
   key      the issuer key, named by reference, never in the clear
   card     5xxx xxxx xxxx 1234 (masked here)
   arqc     1A2B3C4D5E6F7081
   data     what the chip signed: amount 42.00 EUR, country,
            date, the terminal's random number, the chip's counter
<- result   pass
   arpc     9F8E7D6C5B4A3928`,
          note: 'A generic command, not any vendor\'s command set: the key is named, never sent, and a fail is a decline.',
        },
      ],
      ways: [
        {
          name: 'HSM API', chosen: true,
          what: "The gateway sends a command to a module in its own site: verify the ARQC (or PIN block, or security code) and produce the ARPC. If the first module does not answer, it tries a second in the same site.",
          pros: ['Keys never leave the hardware.', 'Stateless and safe to repeat.', 'Stays inside the site, within the 5 ms target.'],
          cons: ["A vendor's command set to code against.", 'A site whose pool is down cannot verify chips and is taken out of service.'],
        },
        {
          name: 'A cloud HSM',
          what: "Call a cloud provider's payment cryptography service with the same commands, over the network.",
          pros: ['No hardware to run.', 'Capacity comes as a service.'],
          cons: ['Another hop and another provider in every authorisation.', 'Harder to keep within 5 ms.'],
        },
        {
          name: 'The network verifies on our behalf',
          what: 'Where the network offers it, it checks the cryptogram before passing the request on, and the 0100 carries the result.',
          pros: ['No HSM call for those purchases.', 'Less hardware to size.'],
          cons: ['The network must hold our keys.', 'Depends on what the network offers; this page has not checked the details.'],
        },
      ],
      reply: {
        id: 'verified', label: 'valid',
        how: 'Pass or fail, and the response cryptogram.',
        delivery: 'A failure is a decline, never a retry.',
      },
    },
    {
      id: 'decide', from: 'gateway', to: 'authz', d: 'M405,226 H510', label: 'request',
      mode: 'call', via: 'gRPC', chip: 0.5,
      how: 'The parsed request, with the token in place of the card number, the verification results, and the time left on its deadline.',
      delivery: 'Idempotent: keyed by the network\'s identifiers, so a repeat returns the stored decision.',
      alts: ['A queue between them, which adds latency to a path that must answer in milliseconds.', 'One process doing both, which pulls the authoriser into PCI scope.'],
      examples: [
        {
          title: 'Service definition',
          lang: 'proto',
          code: `service Authoriser {
  rpc Authorise(AuthoriseRequest) returns (Decision);
}

message AuthoriseRequest {
  string auth_key = 1;      // card token|date|STAN|RRN
  string card_token = 2;    // never the card number
  int64 amount_minor = 3;   // 4200
  string currency = 4;      // EUR
  int64 billing_pence = 5;  // 3640: €42.00 at 0.8667
  string mcc = 6;
  string merchant_id = 7;
  string country = 8;
  string entry_mode = 9;
  bool cryptogram_ok = 10;  // the HSM's result
}

message Decision {
  bool approved = 1;
  string response_code = 2; // field 39: 00, 05, 51
  int64 approved_pence = 3; // may be less than asked
  string auth_code = 4;     // field 38
  string hold_id = 5;
}`,
        },
        {
          title: 'Example call',
          lang: 'text',
          code: `deadline: about 980 ms left (1 s from arrival, less 21 ms
          for link, parse, vault and HSM)
-> Authorise {
     auth_key: "tok_8f3a91e2|2026-11-12|004217|631612004217",
     card_token: "tok_8f3a91e2", amount_minor: 4200,
     currency: "EUR", billing_pence: 3640, mcc: "5812",
     merchant_id: "M-IE-30417", country: "IE",
     entry_mode: "contactless", cryptogram_ok: true }
<- Decision { approved: true, response_code: "00",
     approved_pence: 3640, auth_code: "K7Q2M9",
     hold_id: "hold_5521907" }

The retry: same auth_key, so the stored Decision comes back.`,
          note: 'The decision is stored under auth_key before it is returned, so a repeat gets the same answer.',
        },
      ],
      ways: [
        {
          name: 'gRPC', chosen: true,
          what: "The gateway sends the parsed request with the token, the verification results and the time left on its deadline. The authoriser stores its decision under the network's identifiers before replying, so a repeat gets the same answer.",
          pros: ['A typed call that carries the time left on the deadline.', 'Keeps the authoriser out of PCI scope: it sees only tokens.', 'Any authoriser in either site can serve it.'],
          cons: ['A network hop inside the budget.', 'The authoriser must honour the deadline it is given, or the gateway answers decline without it.'],
        },
        {
          name: 'A queue between them',
          what: 'The gateway puts each request on a queue, and the authoriser reads it and replies on another.',
          pros: ['Absorbs bursts.', 'Either side can be deployed or restarted alone.'],
          cons: ['Adds latency to a path that must answer in milliseconds.', 'The gateway still waits for the answer, so it is a call in disguise.'],
        },
        {
          name: 'One process doing both',
          what: 'Run the gateway and the authoriser in one process, calling each other in memory.',
          pros: ['No hop and no serialisation.', 'One thing to deploy.'],
          cons: ['Pulls the authoriser into PCI scope.', 'Protocol code and business rules must be released together.'],
        },
      ],
      reply: {
        id: 'decision', label: 'decision',
        how: 'Approve or decline, the reason code, and the amount approved, which may be less than asked.',
        delivery: 'Stored with its key before it is returned, so a retry gets the same answer.',
      },
    },
    {
      id: 'cards', from: 'authz', to: 'cards', d: 'M585,190 V131', label: 'card',
      mode: 'call', via: 'read', chip: 0.5,
      how: 'Read the card by token: status, expiry, account and controls.',
      delivery: 'From the primary or a cache cleared on write, with a 5 ms deadline.',
      alts: ['Card state carried in the request from the gateway.', 'A replica read, which can miss a freeze made a moment ago.'],
      examples: [
        {
          title: 'Statement',
          lang: 'sql',
          code: `-- On the primary, or from a cache cleared on every write.
SELECT status, expires, account_id, blocked_mccs,
       contactless_on, foreign_on, per_purchase_limit_pence
  FROM cards
 WHERE card_token = 'tok_8f3a91e2';`,
        },
        {
          title: 'Row returned',
          lang: 'text',
          code: `status                    active
expires                   2029-08
account_id                acc_7731
blocked_mccs              {7995}  (gambling)
contactless_on            true
foreign_on                true
per_purchase_limit_pence  50000   (£500)`,
          note: 'Active, not expired, and 5812 is not blocked, so the checks pass on to fraud.',
        },
      ],
      ways: [
        {
          name: 'Read from the primary or a cleared cache', chosen: true,
          what: 'The authoriser reads the card by token: status, expiry, account and controls. It reads from the primary or from a cache cleared on every write, with a 5 ms deadline.',
          pros: ['A freeze works on the very next tap.', 'At 1.2 million cards the whole table can be cached.'],
          cons: ['A cache miss reads the primary, which may be in the other site.', 'Clearing the cache on write must never be skipped.'],
        },
        {
          name: 'Card state carried in the request',
          what: 'The gateway reads the card and puts its state in the request it sends to the authoriser.',
          pros: ['One less call for the authoriser.', 'The card is read once, early.'],
          cons: ['The gateway, in the PCI zone, takes on business data and logic.', 'Still a read; it has only moved.'],
        },
        {
          name: 'A replica read',
          what: 'Read the card from a replica, possibly the one in the local site.',
          pros: ['Takes load off the primary.', 'A local read in either site.'],
          cons: ['Can miss a freeze made a moment ago.', 'The page requires a freeze to work on the next tap.'],
        },
      ],
      reply: {
        id: 'cardinfo', label: 'controls',
        how: 'The card record.',
        delivery: 'Read only.',
      },
    },
    {
      id: 'fraud', from: 'authz', to: 'fraud', d: 'M585,262 V322', label: 'features',
      mode: 'call', via: '50 ms', chip: 0.5,
      how: 'The purchase and the card\'s recent features, scored by a model.',
      delivery: 'A hard timeout of 50 ms. Late means rules only.',
      alts: ['Scoring after approval, from the log.', 'A vendor\'s scoring service.'],
      examples: [
        {
          title: 'Request (timeout 50 ms)',
          lang: 'json',
          code: `{
  "auth_key": "tok_8f3a91e2|2026-11-12|004217|631612004217",
  "card_token": "tok_8f3a91e2",
  "billing_pence": 3640,
  "mcc": "5812",
  "country": "IE",
  "channel": "contactless",
  "features": {
    "purchases_last_hour": 1,
    "new_country": true,
    "amount_vs_card_median": 1.1,
    "used_abroad_before": true
  }
}`,
          note: 'The features are kept up to date from the card events log, so scoring is a lookup and a model call.',
        },
        {
          title: 'Response',
          lang: 'json',
          code: `{
  "score": 0.04,
  "band": "low",
  "reasons": ["new country", "normal amount and time",
              "card used abroad before"],
  "model_ms": 12
}`,
          note: 'Had nothing come back by 50 ms, the authoriser would decide on rules and record that the model did not answer.',
        },
      ],
      ways: [
        {
          name: '50 ms hard timeout', chosen: true,
          what: "The authoriser sends the purchase and the card's recent features, and waits at most 50 ms. Late means rules only, and the decision records that.",
          pros: ['Bounded: never more than 50 ms of the budget.', 'Fraud is stopped before money is held.'],
          cons: ['The model must answer in tens of milliseconds.', 'Some decisions are made without a score; watch their share.'],
        },
        {
          name: 'Scoring after approval, from the log',
          what: 'The scoring service reads the card events log and scores each purchase after the answer has gone.',
          pros: ['Nothing on the hot path.', 'Bigger models are possible.'],
          cons: ['The money has gone by the time it scores.', 'It can only alert, freeze the card and dispute.'],
        },
        {
          name: "A vendor's scoring service",
          what: 'Call an outside scoring service, with the same 50 ms timeout and rules fallback.',
          pros: ['Quick to start.', 'Trained on more data than ours.'],
          cons: ['An outside call inside 50 ms.', 'Purchase data leaves our systems.'],
        },
      ],
      reply: {
        id: 'score', label: 'score',
        how: 'A risk score and the reasons behind it.',
        delivery: 'Logged with the decision so the model can be judged later.',
      },
    },
    {
      id: 'hold', from: 'authz', to: 'ledger', d: 'M660,226 H740', label: 'hold',
      mode: 'write', via: 'txn', chip: 0.5,
      how: 'One database transaction: lock the account, check available funds and the daily limit, insert the hold, insert the outbox event. The key is the network\'s identifiers for this authorisation.',
      delivery: 'A repeat finds the key and returns the first result. Nothing is written twice.',
      alts: ['A reservation in a cache, written to the ledger later, which can approve money that is not there.', 'A distributed transaction across services, which is slow and fragile.'],
      examples: [
        {
          title: 'One transaction',
          lang: 'sql',
          code: `-- PostgreSQL syntax. Amounts in pence. holds.auth_key is UNIQUE.
BEGIN;
SELECT balance_pence, held_pence, spent_today_pence,
       daily_limit_pence
  FROM accounts WHERE account_id = 'acc_7731' FOR UPDATE;
-- A retry finds its key here: return that hold, write nothing.
SELECT hold_id FROM holds
 WHERE auth_key = 'tok_8f3a91e2|2026-11-12|004217|631612004217';
-- In code: balance - held >= 3640 and spent_today + 3640 <= limit,
-- else ROLLBACK and answer 51.
INSERT INTO holds (hold_id, auth_key, account_id, card_token,
  amount_pence, txn_amount_minor, txn_currency, auth_code,
  merchant_id, status)
VALUES ('hold_5521907',
  'tok_8f3a91e2|2026-11-12|004217|631612004217', 'acc_7731',
  'tok_8f3a91e2', 3640, 4200, 'EUR', 'K7Q2M9', 'M-IE-30417', 'open');
UPDATE accounts SET held_pence = held_pence + 3640,
       spent_today_pence = spent_today_pence + 3640
 WHERE account_id = 'acc_7731';
INSERT INTO outbox (event_id, card_token, type, payload)
VALUES ('evt_01JC9W3K2T', 'tok_8f3a91e2', 'authorised',
  '{"hold_id": "hold_5521907", "amount_pence": 3640}');
COMMIT;`,
          note: 'The row lock on the account makes two taps queue, and the key is checked after the lock, so two copies of one request cannot both pass.',
        },
        {
          title: 'Reply',
          lang: 'text',
          code: `held      hold_5521907
available £4,812.20 before, £4,775.80 after (illustrative)

or, if balance - held < 3640:
not sufficient funds -> the authoriser answers 51`,
          note: 'Available balance is the posted balance less open holds.',
        },
      ],
      ways: [
        {
          name: 'One ledger transaction', chosen: true,
          what: "One transaction locks the account, checks available funds and the daily limit, and inserts the hold and the outbox event. It is keyed by the network's identifiers, so a repeat returns the first result.",
          pros: ['Exact under concurrency.', 'Safe to retry: nothing is written twice.', 'The event and the hold commit together.'],
          cons: ['A busy account queues on its row.', 'Takes 20 ms of the budget, and the authoriser cannot work without it.'],
        },
        {
          name: 'A reservation in a cache',
          what: 'Reserve the amount in a fast cache and write the hold to the ledger later.',
          pros: ['Faster than a database transaction.', 'Spares the ledger at peak.'],
          cons: ['Can approve money that is not there.', 'A crash loses reservations.'],
        },
        {
          name: 'A distributed transaction across services',
          what: 'The hold, the event and any other service writes as one transaction across services, run by a coordinator.',
          pros: ['All or nothing across services.', 'No outbox needed.'],
          cons: ['Slow and fragile.', 'A coordinator that fails at the wrong moment can leave locks held.'],
        },
        {
          name: 'Optimistic: check a version, retry on conflict',
          what: 'Read the balance with its version, write the hold only if the version has not changed, and retry on a conflict. Still one transaction, with no lock held while checking.',
          pros: ['No lock held during the check.', 'Fine when an account rarely sees two purchases at once.'],
          cons: ['A busy business with many cards retries often, and retries eat the 20 ms.', 'The saving over a row lock is small at about 100 holds a second.'],
        },
      ],
      reply: {
        id: 'held', label: 'held',
        how: 'The hold id and the new available balance, or not sufficient funds.',
        delivery: 'Committed before the answer leaves.',
      },
    },
    {
      id: 'outbox', from: 'ledger', to: 'events', d: 'M880,226 H995', label: 'event',
      mode: 'async', via: 'outbox', chip: 0.5,
      how: 'A relay reads new rows from the outbox table and publishes them to the card events log, keyed by card.',
      delivery: 'At-least-once and in order per card. The relay marks rows sent only after the log acknowledges them.',
      alts: ['Change data capture from the database log.', 'Publishing straight after the commit, which can lose events.'],
      examples: [
        {
          title: 'The relay',
          lang: 'sql',
          code: `SELECT seq, event_id, card_token, type, payload
  FROM outbox
 WHERE sent_at IS NULL
 ORDER BY seq
 LIMIT 500;
-- Publish each to card-events, key = card_token, and wait for
-- the log's acknowledgement. Only then:
UPDATE outbox SET sent_at = now()
 WHERE seq IN (88123401, 88123402);`,
          note: 'A relay that stops between publishing and the UPDATE sends those rows again: at-least-once.',
        },
        {
          title: 'Topic and key',
          lang: 'text',
          code: `topic   card-events
key     card_token, here tok_8f3a91e2
        Kafka keeps order within a partition, and one key always
        goes to one partition, so each card's events stay in order.`,
        },
        {
          title: 'Message value',
          lang: 'json',
          code: `{
  "event_id": "evt_01JC9W3K2T",
  "type": "authorised",
  "card_token": "tok_8f3a91e2",
  "account_id": "acc_7731",
  "hold_id": "hold_5521907",
  "amount_pence": 3640,
  "original": { "amount_minor": 4200, "currency": "EUR" },
  "merchant": { "name": "Restaurant", "city": "Dublin",
                "mcc": "5812" },
  "card_last4": "1234",
  "occurred_at": "2026-11-12T12:41:07Z"
}`,
          note: 'event_id is what every consumer uses to drop a repeat.',
        },
      ],
      ways: [
        {
          name: 'Outbox relay', chosen: true,
          what: 'A relay reads new rows from the outbox table and publishes them to the card events log, keyed by card. It marks a row sent only after the log acknowledges it.',
          pros: ['At-least-once, and in order per card.', 'A log outage does not touch authorisations.'],
          cons: ['A row can be sent twice if the relay stops after publishing but before marking it.', 'A relay to run and watch.'],
        },
        {
          name: 'Change data capture from the database log',
          what: "A connector reads the database's change log and publishes the changes as events. It can read the outbox table itself, so the events keep our shape.",
          pros: ['No polling of a table.', 'Every committed change is seen.'],
          cons: ['Tied to database internals and to failover.', 'Another component to run.'],
        },
        {
          name: 'Publish straight after the commit',
          what: 'The code that committed the hold publishes the event itself.',
          pros: ['Simplest code.', 'No relay.'],
          cons: ['A crash between commit and publish loses the event.', 'A slow log slows the authorisation.'],
        },
      ],
    },
    {
      id: 'consume', from: 'events', to: 'consumers', d: 'M1060,258 V442', label: 'events',
      mode: 'async', via: 'Kafka', chip: 0.5,
      how: 'Each consumer reads the log in its own group and keeps its own offset.',
      delivery: 'At-least-once. Consumers drop repeats by event id.',
      alts: ['A queue per consumer.', 'Direct calls, which put them on the hot path.'],
      examples: [
        {
          title: 'Consumer groups on card-events',
          lang: 'text',
          code: `group           what it does with evt_01JC9W3K2T
notifications   pushes "£36.40 at Restaurant" to the owner
alerts          the suspicious-transaction alerts service
rewards         cashback
accounting      partner integrations
analytics       reporting

Each group keeps its own offset and reads at its own pace.`,
        },
        {
          title: 'Dropping a repeat',
          lang: 'sql',
          code: `-- In the consumer's own database, in the same transaction
-- as its own work.
INSERT INTO seen_events (event_id)
VALUES ('evt_01JC9W3K2T')
ON CONFLICT (event_id) DO NOTHING;
-- 0 rows inserted: a repeat. Skip it and commit the offset.`,
          note: 'At-least-once delivery plus this check gives each consumer the effect of once.',
        },
      ],
      ways: [
        {
          name: 'Kafka consumer groups', chosen: true,
          what: "Each consumer reads the card events log in its own group and keeps its own offset. Events are keyed by card, and Kafka keeps order within a partition, so each card's events arrive in order.",
          pros: ['Replay after a bug.', 'Each consumer reads at its own pace.', 'Order per card.'],
          cons: ['At-least-once: drop repeats by event id.', 'Lag to watch on each group.'],
        },
        {
          name: 'A queue per consumer',
          what: 'Copy each event into a queue for each consumer, which removes it once handled.',
          pros: ['Acknowledgement and retries per message.', 'Simple for one consumer.'],
          cons: ['No replay once handled.', 'Order per card is harder to keep.'],
        },
        {
          name: 'Direct calls',
          what: 'The ledger side calls each consumer in turn after the commit.',
          pros: ['Simple to trace.', 'No log to run.'],
          cons: ['Puts them on the hot path.', 'A missed call is lost.'],
        },
      ],
    },
    {
      id: 'push', from: 'consumers', to: 'app', d: 'M1135,474 H1160 Q1170,474 1170,464 V128', label: 'notification',
      mode: 'external', via: 'APNs, FCM', chip: 0.543,
      how: 'A push notification through Apple\'s and Google\'s services: amount, merchant and the card used.',
      delivery: 'Best effort. The app reads the ledger when it opens.',
      alts: ['SMS.', 'An in-app feed only.'],
      examples: [
        {
          title: 'To Apple (APNs)',
          lang: 'http',
          code: `POST /3/device/<device token>
apns-push-type: alert
apns-topic: <the app's bundle id>

{
  "aps": {
    "alert": {
      "title": "£36.40 at Restaurant",
      "body": "Card ending 1234. Pending: €42.00 in Dublin."
    }
  },
  "hold_id": "hold_5521907"
}`,
        },
        {
          title: 'To Google (FCM)',
          lang: 'http',
          code: `POST /v1/projects/<project>/messages:send

{
  "message": {
    "token": "<device token>",
    "notification": {
      "title": "£36.40 at Restaurant",
      "body": "Card ending 1234. Pending: €42.00 in Dublin."
    },
    "data": { "hold_id": "hold_5521907" }
  }
}`,
          note: 'Only the last four digits travel. hold_id lets the app open on the purchase, and the app reads the ledger for the balance.',
        },
      ],
      ways: [
        {
          name: 'APNs and FCM', chosen: true,
          what: "The notification consumer sends a push through Apple's and Google's services: amount, merchant and the card used. The app reads the ledger when it opens.",
          pros: ['Within seconds, and free.', 'The owner need not have the app open.'],
          cons: ['Best effort, with no delivery guarantee.', 'Two outside services in the path.'],
        },
        {
          name: 'SMS',
          what: 'Send a text for each purchase through an SMS provider.',
          pros: ['Reaches phones without the app.', 'Works with no data connection.'],
          cons: ['Costs per message.', 'Can be spoofed.'],
        },
        {
          name: 'An in-app feed only',
          what: "Show purchases in the app's feed, with no notification.",
          pros: ['Nothing to send or lose.', 'The feed already reads from the ledger.'],
          cons: ['Fraud goes unseen until the app is opened.', 'No prompt to freeze a card at once.'],
        },
      ],
    },
    {
      id: 'files', from: 'network', to: 'clearing', d: 'M110,258 V410 Q110,420 120,420 H700 Q710,420 710,410 V360 Q710,350 720,350 H740', label: 'clearing file',
      mode: 'async', via: 'files', chip: 0.563,
      how: 'The network delivers clearing files in cycles through the day: one record per purchase with the final amount, the currency conversion and fees, and records for refunds.',
      delivery: 'Each file has an id and record counts. Processing is idempotent per record, so a file can be run again.',
      alts: ['An issuer processor\'s clearing webhooks, one per record.', 'A single-message network, where the authorisation itself moves the money.'],
      examples: [
        {
          title: 'File header',
          lang: 'text',
          code: `file id          clr-2026-11-13-02 (the second cycle we take)
settlement date  2026-11-13
records          241,806
total            as the file states, checked against the records`,
          note: 'The file id and record counts make a rerun safe and a short file visible.',
        },
        {
          title: 'One record',
          lang: 'text',
          code: `record no         118,442
type              purchase
field 38          auth code K7Q2M9
card              5xxx xxxx xxxx 1234 (masked here)
merchant          Restaurant, Dublin, IE (M-IE-30417)
field 18          MCC 5812
amount            42.00 EUR
cardholder amount 36.55 GBP at 0.8702
fees              interchange as the record states (not shown)`,
          note: 'Generic fields, not the network\'s file layout. The final amount is £36.55, not the £36.40 held.',
        },
      ],
      ways: [
        {
          name: 'Clearing files', chosen: true,
          what: 'The network delivers clearing files in cycles through the day, and we take four to six. Each file has an id and record counts, and processing is idempotent per record.',
          pros: ['Safe to run again.', 'Totals per file to reconcile against.'],
          cons: ['Postings lag the purchase, by a day in the tour.', 'Bursts of 200,000 to 300,000 records a file.'],
        },
        {
          name: "An issuer processor's clearing webhooks",
          what: 'An issuer processor takes the files and sends each record to us as a webhook, one per record.',
          pros: ['No file formats to learn.', 'Records arrive spread out.'],
          cons: ['Their matching becomes ours.', 'Only with a processor, which this design does not use.'],
        },
        {
          name: 'A single-message network',
          what: 'The authorisation itself moves the money, so there is no separate clearing record.',
          pros: ['Nothing to match.', 'The final amount is known at once.'],
          cons: ['No gap in which to adjust the amount.', "Not how the tour's purchase works: it clears a day later."],
        },
      ],
    },
    {
      id: 'post', from: 'clearing', to: 'ledger', d: 'M810,322 V262', label: 'post, release',
      mode: 'write', via: 'txn', chip: 0.5,
      how: 'One transaction per record: post the final amount, release the matched hold, write the outbox event.',
      delivery: 'Keyed by file and record number, so a rerun posts nothing twice.',
      alts: ['Post and release as two writes, which can leave money both held and posted.'],
      examples: [
        {
          title: 'Match the record to its hold',
          lang: 'sql',
          code: `-- No single linking field: auth code, card, merchant, amount.
-- The amount matched is the original €42.00, which did not move.
SELECT hold_id, account_id, amount_pence
  FROM holds
 WHERE auth_code = 'K7Q2M9'
   AND card_token = 'tok_8f3a91e2'
   AND merchant_id = 'M-IE-30417'
   AND txn_amount_minor = 4200 AND txn_currency = 'EUR'
   AND status = 'open';
-- -> hold_5521907, acc_7731, 3640`,
          note: 'No row means no hold: an offline tap or a forced post, posted all the same and sent for review.',
        },
        {
          title: 'Post and release, one transaction',
          lang: 'sql',
          code: `BEGIN;
SELECT balance_pence, held_pence FROM accounts
 WHERE account_id = 'acc_7731' FOR UPDATE;
-- UNIQUE (file_id, record_no): a rerun inserts nothing.
INSERT INTO postings (file_id, record_no, hold_id,
  debit_account, credit_account, amount_pence, currency,
  settlement_date)
VALUES ('clr-2026-11-13-02', 118442, 'hold_5521907',
  'acc_7731', 'mastercard_settlement', 3655, 'GBP', '2026-11-13')
ON CONFLICT (file_id, record_no) DO NOTHING
RETURNING posting_id;
-- No row returned: ROLLBACK, already posted.
UPDATE holds SET status = 'released'
 WHERE hold_id = 'hold_5521907' AND status = 'open';
UPDATE accounts SET balance_pence = balance_pence - 3655,
       held_pence = held_pence - 3640
 WHERE account_id = 'acc_7731';
INSERT INTO outbox (event_id, card_token, type, payload)
VALUES ('evt_01JCB7Q5ZD', 'tok_8f3a91e2', 'cleared',
  '{"hold_id": "hold_5521907", "amount_pence": 3655}');
COMMIT;`,
          note: 'The £36.40 hold comes off and £36.55 goes on in one commit, so the money is never both held and posted.',
        },
      ],
      ways: [
        {
          name: 'One transaction per record', chosen: true,
          what: 'Post the final amount, release the matched hold and write the outbox event in one transaction. It is keyed by file and record number, so a rerun posts nothing twice.',
          pros: ['Money is never both held and posted.', 'Safe to rerun.'],
          cons: ['A transaction per record: about 1.2 million a day, in bursts.', 'Matching must finish before posting.'],
        },
        {
          name: 'Post and release as two writes',
          what: 'Post the final amount, then release the hold in a separate write.',
          pros: ['Simpler code for each step.', 'Each write is smaller.'],
          cons: ['A crash between them leaves money both held and posted.', 'Needs a repair job to find and fix those.'],
        },
        {
          name: 'One transaction per file',
          what: 'Post every record in a file in one large transaction.',
          pros: ['All or nothing per file.', 'The file total and the postings agree at once.'],
          cons: ['Locks on many accounts at once, while holds are being placed on them.', 'One bad record blocks the whole file.'],
        },
      ],
    },
    {
      id: 'settle', from: 'network', to: 'bank', d: 'M60,258 V464 Q60,474 70,474 H500', label: 'settlement',
      mode: 'external', via: 'net debit', chip: 0.693,
      how: 'Once a working day the network collects our net position from the settlement account and sends an advisement of the amounts.',
      delivery: 'The network\'s own process. We forecast it and check it the next day.',
      alts: ['A sponsor bank settling on our behalf.'],
      examples: [
        {
          title: 'Settlement advisement',
          lang: 'text',
          code: `settlement date     2026-11-13 (Friday)
currency            GBP
spent by our cards  £30,512,840.15  (includes the £36.55 lunch)
less refunds          -£412,006.30
less interchange      -£261,904.11  (owed to us)
net debit           £29,838,929.74  from the settlement account`,
          note: 'Illustrative figures, generic layout: one net movement for the day, not one per purchase.',
        },
      ],
      ways: [
        {
          name: 'Net debit by the network', chosen: true,
          what: 'Once a working day the network collects our net position from the settlement account and sends an advisement of the amounts. We forecast it and check it the next day.',
          pros: ['One movement a day per currency.', 'The network does the netting.'],
          cons: ['The account must be funded by the cut-off.', "The network's process: we can only forecast and check it."],
        },
        {
          name: 'A sponsor bank settling on our behalf',
          what: 'A bank that is a direct scheme member settles with the network, and we settle with that bank.',
          pros: ['Needed when we are not a direct member.', 'The sponsor handles the network side.'],
          cons: ['Their cut-offs and fees.', 'One more party to reconcile against.'],
        },
      ],
    },
    {
      id: 'readledger', from: 'ledger', to: 'recon', d: 'M880,252 H918 Q928,252 928,262 V464 Q928,474 918,474 H895', label: 'postings',
      mode: 'call', via: 'SQL', chip: 0.5, cold: true,
      how: 'Off the hot path. Once a day reconciliation reads the day\'s postings, totalled by currency and settlement date.',
      delivery: 'Read only, from a replica.',
      alts: ['A daily export to the data warehouse.'],
      examples: [
        {
          title: 'Statement',
          lang: 'sql',
          code: `-- On a replica, once the day is complete there.
SELECT currency, settlement_date,
       COUNT(*) AS postings,
       -- owed to the network counts plus; refunds and fees minus
       SUM(CASE WHEN credit_account = 'mastercard_settlement'
                THEN amount_pence ELSE -amount_pence END) AS net_pence
  FROM postings
 WHERE settlement_date = '2026-11-13'
 GROUP BY currency, settlement_date;`,
        },
        {
          title: 'Result',
          lang: 'text',
          code: `currency  settlement_date  postings   net_pence
GBP       2026-11-13       1,204,118  2,983,892,974`,
          note: 'Illustrative totals; the lunch\'s 3655 is one of those postings.',
        },
      ],
      ways: [
        {
          name: 'SQL on a replica', chosen: true,
          what: "Once a day reconciliation reads the day's postings from a replica, totalled by currency and settlement date.",
          pros: ['No load on the primary.', 'Totals straight from the ledger itself.'],
          cons: ['A replica lags a little, so wait until the day is complete on it.', "Tied to the ledger's schema."],
        },
        {
          name: 'A daily export to the data warehouse',
          what: "Export the day's postings to the data warehouse and reconcile there.",
          pros: ['No load on the ledger at all.', 'Easy to join with other data.'],
          cons: ['Another copy that can itself be wrong.', 'Ready later.'],
        },
        {
          name: 'Totals from the card events log',
          what: 'Build the totals by reading posted events from the log.',
          pros: ['No database access.', 'The same events every consumer sees.'],
          cons: ['Checks the events, not the ledger, which is the record that must be right.', 'Repeats must be dropped exactly.'],
        },
      ],
    },
    {
      id: 'readclearing', from: 'clearing', to: 'recon', d: 'M810,378 V442', label: 'file totals',
      mode: 'call', via: 'SQL', chip: 0.5, cold: true,
      how: 'Off the hot path. The totals and record counts of each clearing file, and the records still unmatched.',
      delivery: 'Read only.',
      alts: ['Read the raw files again.'],
      examples: [
        {
          title: 'Statements',
          lang: 'sql',
          code: `SELECT file_id, record_count, net_pence
  FROM clearing_files
 WHERE settlement_date = '2026-11-13';

SELECT file_id, record_no, reason
  FROM clearing_records
 WHERE settlement_date = '2026-11-13'
   AND status = 'unmatched';`,
        },
        {
          title: 'Result',
          lang: 'text',
          code: `file_id            record_count  net_pence
clr-2026-11-13-01  287,310       ...
clr-2026-11-13-02  241,806       ...
(four files; together 2,983,892,974)

unmatched: posted with no hold, each waiting for a person`,
          note: 'Illustrative figures: the files\' total must equal the ledger\'s net for the same day.',
        },
      ],
      ways: [
        {
          name: 'SQL', chosen: true,
          what: "Read the totals and record counts of each processed file, and the records still unmatched, from clearing's tables.",
          pros: ['Already parsed and counted.', 'The unmatched list is ready.'],
          cons: ["Trusts clearing's own parsing.", "Tied to clearing's schema."],
        },
        {
          name: 'Read the raw files again',
          what: 'Parse the raw clearing files a second time for their totals.',
          pros: ["An independent check on clearing's parser.", "No dependency on clearing's tables."],
          cons: ['Two parsers to keep in step.', 'More work every day.'],
        },
      ],
    },
    {
      id: 'statement', from: 'bank', to: 'recon', d: 'M650,474 H745', label: 'statement',
      mode: 'call', via: 'batch', chip: 0.5, cold: true,
      how: 'Off the hot path. The settlement bank\'s statement of what actually moved, and the network\'s settlement advisement.',
      delivery: 'Daily, and checked for gaps in its sequence.',
      alts: ['A banking API polled through the day.'],
      examples: [
        {
          title: 'Statement line',
          lang: 'text',
          code: `settlement account statement, sequence 0318 (0317 came before)
date        2026-11-13
debit       £29,838,934.74
reference   Mastercard settlement 2026-11-13`,
          note: 'Generic layout. A gap in the sequence numbers means a missing statement.',
        },
        {
          title: 'The three-way check',
          lang: 'text',
          code: `2026-11-13, GBP                    net
ledger postings (replica)     £29,838,929.74
clearing file totals          £29,838,929.74
settlement account            £29,838,934.74
break                                £5.00  -> an owner and evidence`,
          note: 'Illustrative: the drill "£5 too much settled". Each source can be right by its own lights and still disagree.',
        },
      ],
      ways: [
        {
          name: 'Daily batch', chosen: true,
          what: "The settlement bank's daily statement and the network's settlement advisement, loaded once a day and checked for gaps in their sequence.",
          pros: ['Complete for the day.', 'Fits the daily reconciliation.'],
          cons: ['A day behind.', "A missing statement holds up the day's reconciliation."],
        },
        {
          name: 'A banking API polled through the day',
          what: "Poll the bank's API for movements on the settlement account through the day.",
          pros: ['See settlement soon after it lands.', 'Earlier warning of a shortfall.'],
          cons: ['Data within the day can change, so the final statement is still needed.', 'Another integration to run.'],
        },
      ],
    },
  ],

  tour: [
    {
      title: 'A tap at the till',
      text: "The owner of a small design studio taps the company card, held in a phone, to pay for a client lunch in Dublin: €42.00. The phone makes a one-time code for this purchase only (a cryptogram). The restaurant's bank (the acquirer) asks Mastercard whether the card's bank will pay: an authorisation request. Mastercard reads the card number's range and sends the question to the bank that issued the card: us.",
      story: {
        context: "Nothing has happened in our systems yet. A cardholder is at a restaurant till in Dublin with a phone that holds one of our business cards, and the bill is €42.00.",
        problem: "We do not run the till, the restaurant's bank or Mastercard, yet we must decide whether to pay. The till and the acquirer have their own habits: they time out, retry, and send cancellations (reversals) when they lose the link.",
        consequence: "If we treated each request as coming from one reliable caller, a retry could hold the money twice, and a lost answer could leave money held for a purchase that never went through.",
        fix: "The design takes each request as Mastercard delivers it, treats every one as possibly repeated, and relies on the one-time cryptogram to prove the card is real. The cost is that we must answer every request in time, from either of our two data centres, at any hour.",
      },
      explain: [
        { q: "Who are the four parties?", a: "The cardholder; the merchant and its bank, the acquirer; the card network, here Mastercard; and the issuer, the bank that gave out the card. We are the issuer. The network routes messages and money between banks; it does not hold anyone's account." },
        { q: "What is the cryptogram?", a: "A short code the chip or phone computes for this one purchase from its details, such as the amount, the date and a random number from the terminal, using a secret key inside the card. Here it is ARQC 1A2B3C4D5E6F7081. A copied card number cannot make it, which is what makes a tap hard to fake." },
        { q: "What is an authorisation?", a: "The real-time question \"will you pay this?\". An approval places a hold on the money, but no money moves yet. The money moves later, through clearing and settlement (steps 10 to 12)." },
        { q: "How does Mastercard know the request is for us?", a: "Card numbers are issued in ranges, and each range belongs to one issuer. Mastercard looks at the start of the card number and sends the request to the bank that owns that range." },
        { q: "Why is the amount in euros?", a: "The restaurant is in Ireland and charges in euros. The owner's account is in pounds, so the hold will be for the amount in pounds (step 4)." },
      ],
      focus: ['merchant', 'network'],
      path: ['tap'],
      labels: ['€42.00'],
    },
    {
      title: 'The request reaches our gateway',
      text: "Mastercard sends the request as a message of type 0100 over a connection it keeps open to each of our two data centres. Our network gateway, the one service that speaks the network's message format, receives it. Mastercard waits only a few seconds and then answers on our behalf, so the gateway stamps a deadline on the request as it arrives. Every step behind it gets only the time that is left.",
      story: {
        context: "Mastercard has the restaurant's request for €42.00 and has routed it to us. It reaches the network gateway in one of our two data centres.",
        problem: "Mastercard will not wait for ever. If we have not answered within a few seconds it decides for us (stand-in processing), on limits we set in advance. The terminal at the till may wait 25 seconds or more, but the limit that matters is Mastercard's.",
        consequence: "A slow answer is as bad as none: the network decides without us, and our late approval is ignored. Each slow step behind the gateway would eat into a budget nobody was watching.",
        fix: "The gateway stamps a deadline on the request the moment it arrives: never later than about 1 second, against our targets of about 100 ms typically and 300 ms at the 99th percentile. Every call behind it is given only what is left, and past the deadline the gateway answers decline itself. The cost is that every service must honour the time it is given.",
      },
      explain: [
        { q: "What is an 0100?", a: "A message in ISO 8583, the standard format for card authorisations. Its four-digit type says what it is: 0100 a request, 0110 the answer, 0120 an advice, 0400 a reversal. Numbered fields follow, such as field 11 (the trace number) and field 37 (the reference number)." },
        { q: "What is the network gateway?", a: "Our small service at the edge, running in both data centres. It holds the connections to Mastercard, reads and checks each message, catches repeats, and turns each into a plain internal request for the services behind it." },
        { q: "What does a connection kept open mean?", a: "Mastercard and the gateway use long-lived TCP connections rather than opening a new one per purchase. Each message starts with its length, so the receiver knows where it ends. An answer may go back on any live connection and is matched to its request by field 37." },
        { q: "What happens if we do not answer in time?", a: "Mastercard answers for us, by stand-in processing, on limits we set in advance, and tells us afterwards with an advice message. Step 13 shows it." },
        { q: "What is the deadline, and who checks it?", a: "A time by which the answer must leave, stamped by the gateway when the request arrives. Each call behind the gateway carries the time left, so a slow call cannot take more than its share, and the gateway declines rather than miss it." },
        { q: "Why two data centres?", a: "Mastercard sends to both, and either can answer any request. If one site fails, only the requests in flight there are lost; the network retries them or stands in." },
      ],
      focus: ['network', 'gateway'],
      path: ['auth'],
      labels: ['0100 €42.00'],
    },
    {
      title: 'Card number out, token in; check the cryptogram',
      text: "The gateway is in the PCI zone: the few systems allowed to see card numbers. It asks the card vault for the card's token, a random stand-in, so nothing behind it ever sees the number. Then it asks the HSM, locked hardware that holds our secret keys, to check the cryptogram. The keys never leave it, and only the real card or phone could have made that code. A failed check is a decline.",
      story: {
        context: "The gateway holds the 0100 for €42.00, with the full card number and the code the phone made for this purchase (ARQC 1A2B3C4D5E6F7081). Nothing else has seen the request yet.",
        problem: "The card industry's security standard, PCI DSS, covers every system that stores, processes or transmits card numbers, and anything that can affect them. If the number travelled on, the authoriser, the ledger, the event log and the app would all fall under it. Separately, a request could come from a copied card number rather than the real card.",
        consequence: "Every service, log and backup holding a card number would need PCI controls and audits, and a leak from any of them would expose cards. Without the cryptogram check, a stolen card number could make purchases that look genuine.",
        fix: "The gateway looks up the token at the vault, usually in its own cache, within 5 ms: from here on the card is tok_8f3a91e2. It sends the HSM a command to verify the ARQC and make a reply code (the ARPC), within another 5 ms. PCI scope shrinks to three parts, gateway, vault and HSM, at the cost of running them to PCI standard with at least two HSMs per site.",
      },
      explain: [
        { q: "What is the PCI zone?", a: "The small set of systems allowed to handle full card numbers, kept to the card industry's security standard, PCI DSS. Here it is three parts: the gateway, the card vault and the HSM. Everything else sees only tokens." },
        { q: "What is a token, and where is the card number kept?", a: "A random string, here tok_8f3a91e2, that stands in for the card number and means nothing on its own. The card vault is the only place the number is stored, encrypted, next to its token. The gateway caches the pairs, because a card's token never changes." },
        { q: "What is an HSM?", a: "A hardware security module: a tamper-resistant device that holds secret keys and does cryptography for other systems. Keys never leave it in the clear, so not even our engineers can read them. Each data centre has at least two." },
        { q: "What does checking the cryptogram prove?", a: "The phone computed ARQC 1A2B3C4D5E6F7081 from this purchase's details with a secret key the issuer put on the card. The HSM recomputes it with our keys. A match proves the request came from the real card or phone, for this purchase." },
        { q: "What is the ARPC?", a: "The issuer's response cryptogram, here 9F8E7D6C5B4A3928, made by the HSM to go back with the answer. The phone uses it to check that the answer really came from us." },
        { q: "What if the check fails?", a: "The gateway declines. A failed cryptogram is never retried, because a mismatch means the request did not come from the real card." },
      ],
      focus: ['gateway', 'vault', 'hsm'],
      path: ['vault', 'token', 'hsm', 'verified'],
      labels: ['card number', 'token', 'ARQC', 'valid'],
    },
    {
      title: 'Card status and controls',
      text: "The gateway passes the request, with the token in place of the card number, to the authorisation engine. It runs the cheap checks first, so most declines cost almost nothing. It reads the card store: the card is active, not frozen, not expired. The owner's controls allow restaurants, foreign purchases and contactless. The request also carries the amount in pounds: at an example rate of 0.8667, €42.00 is £36.40.",
      story: {
        context: "The cryptogram is valid, and the card is now known only as tok_8f3a91e2. The gateway sends the request to the authoriser with about 980 ms left on the deadline.",
        problem: "The authoriser must run several checks: card state, the gateway's verification results, the owner's controls, a fraud score and finally the funds. Most are cheap reads, one is slow, and only the last changes money. The owner may also have frozen the card in the app a moment ago.",
        consequence: "Running the expensive checks first would waste time and fraud calls on cards a cheap check would have declined. Reading card state from a lagging copy could miss a freeze, so a card the owner had reported lost would still work.",
        fix: "The checks run in a fixed order and stop at the first failure, with the hold last because it is the only step that changes anything. The card is read by token from the primary database, or from a cache cleared on every write, within 5 ms. The cost is that changing the order or a rule is a deploy; limits the owner sets are data, so they are not.",
      },
      explain: [
        { q: "What is the authorisation engine?", a: "The service that decides approve or decline. It keeps no state of its own, so any copy in either data centre can serve any request. It answers with a two-digit reason code: 00 approved, 05 do not honour, 51 not sufficient funds." },
        { q: "What is in the card store?", a: "One row per card, keyed by token: status (active, frozen or lost), expiry, the account it draws on, and the owner's controls. Here: active, expires 2029-08, account acc_7731, gambling blocked, a per-purchase limit of £500." },
        { q: "What are the owner's controls?", a: "Rules the business owner sets in the app for each card: blocked kinds of merchant, a contactless limit, a per-purchase limit, foreign purchases on or off. Restaurants are not blocked, so the check passes on to fraud scoring." },
        { q: "What is a merchant category code?", a: "Four digits, carried in field 18, that say what kind of business the merchant is: 5812 is restaurants, 7995 gambling. Controls block categories by this code." },
        { q: "Why must a freeze work on the very next tap?", a: "A freeze is how the owner stops a lost or stolen card. So the card is read from the primary database, or from a cache cleared on every write, never from a copy that may lag. The app confirms a freeze only once both data centres have it." },
        { q: "Where does £36.40 come from?", a: "The purchase is in euros and the account in pounds. The request the gateway sends the authoriser carries both: 4,200 euro cents and 3,640 pence, at an example rate of 0.8667. The hold will be for the amount in pounds." },
      ],
      focus: ['gateway', 'authz', 'cards'],
      path: ['decide', 'cards', 'cardinfo'],
      labels: ['£36.40', 'card?', 'active'],
    },
    {
      title: 'A fraud score inside 50 ms',
      text: "The authoriser asks fraud scoring how risky the purchase looks, because a decline now stops the money leaving. It compares it with the card's recent use: a new country, but a normal amount at a normal time, and the card has been used abroad before. The model answers in 12 ms: low risk. Had it taken more than 50 ms, the authoriser would have stopped waiting and decided on rules alone.",
      story: {
        context: "The card is active and its controls allow the purchase. The authoriser has the purchase details and most of its deadline still left.",
        problem: "Card state and controls cannot tell a thief from the owner. A trained model can, by comparing the purchase with the card's recent history, but a model call is the slowest step on the path, and the model may be slow or down.",
        consequence: "Without a score, fraud is found only after approval, when the money has gone and the best left is an alert and a dispute. With a score but no time limit, a slow model would push the answer past Mastercard's limit and turn purchases into stand-in decisions or declines.",
        fix: "The authoriser sends the purchase and the card's features, kept up to date from the card events log so scoring is only a lookup and a model call. It waits at most 50 ms of the 106 ms typical budget. If the score is late it decides on rules alone (velocity, amount, country) and records that the model did not answer. The cost is a model small enough to answer in tens of milliseconds.",
      },
      explain: [
        { q: "What is the fraud score?", a: "A number from a trained model saying how likely the purchase is to be fraud, with its reasons. Here it is 0.04, band low, because of a new country but a normal amount and time on a card used abroad before." },
        { q: "What are the features?", a: "Facts about the card's recent use that the model reads: one purchase in the last hour, a new country, an amount 1.1 times the card's usual, used abroad before. A reader of the card events log keeps them up to date, so nothing is worked out from history while the purchase waits." },
        { q: "What does a 50 ms hard timeout mean?", a: "The authoriser stops waiting after 50 milliseconds whatever happens. A late score is worth nothing, because a late answer to Mastercard is a decline." },
        { q: "What are rules alone?", a: "Simple checks the authoriser runs itself: how often and how much the card has spent recently (velocity), the amount and the country. They are the fallback when the model is slow or down. Each such decision records that it had no score, so the team can watch how often that happens." },
        { q: "Why score before approving rather than after?", a: "A decline here stops the money leaving. Once a purchase is approved, the best left is an alert to the owner and a dispute through the network." },
      ],
      focus: ['authz', 'fraud'],
      path: ['fraud', 'score'],
      labels: ['features', 'low risk'],
    },
    {
      title: 'The hold, once',
      text: "Every check has passed, so the authoriser asks the ledger to reserve the money. One database transaction, all or nothing, locks the account, checks the available balance and the daily limit, and writes a hold of £36.40 and an outbox event (a note for other services, step 8). Its key is the network's identifiers for this purchase, so a retry can never place a second hold.",
      story: {
        context: "The cryptogram, card state, controls and fraud score all say yes. Only the money is left: does account acc_7731 have £36.40 available, within today's limit?",
        problem: "A business can have many cards on one account, and two of them can tap at the same moment against the last £10. The network can also send the same request twice. And the hold and the message telling other services about it are two writes that could come apart.",
        consequence: "Two checks that both read the old balance would both approve, spending money that is not there. A retry treated as new would hold £36.40 twice. A hold with no event, or an event with no hold, would hide a real purchase from the owner or show one that never happened.",
        fix: "One transaction locks the account row, so a second tap waits. It looks for the key (card token, date, trace and reference numbers) and returns the first hold if it is there. It checks balance less holds against £36.40 and today's spending against the daily limit, inserts hold_5521907 and the outbox event, and commits. It takes 20 ms of the budget, and a busy account queues on its one row.",
      },
      explain: [
        { q: "What is a hold?", a: "A pending entry in the ledger that lowers the available balance without moving money. It ends when clearing posts the purchase, a reversal cancels it, or it lapses at the end of the network's window. Here it is hold_5521907 for £36.40." },
        { q: "What is the available balance?", a: "What the owner can still spend: the posted balance less open holds. In the example it falls from £4,812.20 to £4,775.80 (illustrative figures)." },
        { q: "What is a transaction, and what does locking the account do?", a: "A database transaction is a group of writes that all happen or none do. Locking the account's row makes any other transaction on that account wait until this one commits, so two taps against the last £10 cannot both pass." },
        { q: "What is the key, and where does it come from?", a: "Mastercard puts a trace number (field 11, STAN 004217) and a reference number (field 37, RRN 631612004217) on each authorisation, and a retry carries the same ones. With the card token and the date they make tok_8f3a91e2|2026-11-12|004217|631612004217, stored on the hold. A second request with that key finds the first hold and writes nothing." },
        { q: "What is the outbox event?", a: "A row in an outbox table, written in the same transaction as the hold, saying the card was authorised for £36.40. Because they commit together, the hold and the event can never disagree. Step 8 shows how it leaves the database." },
        { q: "What if there is not enough money?", a: "The transaction is rolled back, nothing is written, and the authoriser answers code 51, not sufficient funds." },
      ],
      focus: ['authz', 'ledger'],
      path: ['hold', 'held'],
      labels: ['hold £36.40', 'held'],
    },
    {
      title: 'Approve, well inside the limit',
      text: "The authoriser stores its decision under the purchase's key before replying, so a repeat of the request gets the same answer. The gateway sends Mastercard an 0110 answer: code 00, approved, with the response cryptogram the phone uses to check it came from us. About 100 ms have passed since the request arrived, well inside Mastercard's limit. Mastercard passes it to the acquirer, and the till shows approved.",
      story: {
        context: "The hold of £36.40 is committed in the ledger. The authoriser has its decision: approve, for the full amount.",
        problem: "The answer must reach Mastercard before its timer runs out, and the decision must survive the answer being lost on the way. If the till never hears back, the same request may come again.",
        consequence: "If the decision were not stored, a repeat would be decided afresh and could get a different answer from the first. A late answer is ignored, and the network decides by stand-in.",
        fix: "The authoriser writes the decision under the key, then returns it to the gateway. The gateway builds the 0110 with response code 00 (field 39), authorisation code K7Q2M9 (field 38) and the ARPC from the HSM, and sends it on any live connection; field 37 ties it to the request. The whole answer takes about 106 ms against a target of under a second, which leaves room for a retry.",
      },
      explain: [
        { q: "Who receives the answer, and how?", a: "The gateway sends the 0110 to Mastercard, which passes it to the acquirer, which passes it to the till. It may go back on any live connection; Mastercard matches it to its request by field 37, the reference number." },
        { q: "What do code 00 and K7Q2M9 mean?", a: "Field 39 is the response code: 00 means approved, where 05 would be do not honour and 51 not sufficient funds. Field 38, K7Q2M9, is the authorisation code. Clearing uses it the next day to find this hold." },
        { q: "What does the phone do with the response cryptogram?", a: "The ARPC, 9F8E7D6C5B4A3928, was made with our keys in the HSM. The phone checks it to confirm the answer came from the real issuer." },
        { q: "Where is the decision stored, and why first?", a: "The authoriser stores it under the purchase's key before returning it. If the request comes again, the stored decision is returned rather than a new one being made (step 9)." },
        { q: "What if the answer never reaches the till?", a: "The terminal sends a reversal, an 0400, which releases the hold at once. If nothing comes at all, the hold lapses at the end of the network's window: 2 days for a card-present purchase on Mastercard, by Stripe's published windows." },
        { q: "Where does about 100 ms come from?", a: "It is our design target, not a network rule: link 10, parse 1, vault 5, HSM 5, card 5, fraud 50, hold 20 and reply 10 ms add up to 106 ms. The page aims for 300 ms at the 99th percentile and never more than about 1 second." },
      ],
      focus: ['authz', 'gateway', 'network', 'merchant'],
      path: ['decision', 'authreply', 'tapreply'],
      labels: ['approve', '0110 00', 'approved'],
    },
    {
      title: 'Tell the owner, off the hot path',
      text: "The answer has gone, so nothing here can slow a purchase. A relay copies the outbox event to the card events log (Kafka), a shared record many services read. The notification service reads it and pushes \"£36.40 at Restaurant\" to the owner's phone through Apple's and Google's push services, within seconds. The alerts, rewards and analytics services read the same event at their own pace.",
      story: {
        context: "The till shows approved. In the ledger, next to the hold, sits an outbox row saying the card was authorised for £36.40, written in the same transaction.",
        problem: "Many services want to know about the purchase: the push notification, the suspicious-transaction alerts service, cashback, accounting integrations and analytics. Calling each of them during the authorisation would add their delays and failures to a path that must answer in about 100 ms.",
        consequence: "A slow rewards service could turn a purchase into a decline. And if the event were published straight after the commit, a crash between the two would lose it, so the owner would never be told.",
        fix: "A relay reads unsent outbox rows, publishes each to the card-events topic keyed by card, and marks it sent only after Kafka acknowledges it. Each reader keeps its own place in the log and drops repeats by event id, because the relay can send a row twice. The cost is a relay to run and watch, and lag to watch on each reader.",
      },
      explain: [
        { q: "What is the relay?", a: "A small process that reads new rows from the ledger's outbox table, publishes them to the log, then marks them sent. If it stops after publishing but before marking, it sends those rows again: delivery is at least once, never lost." },
        { q: "What is the card events log?", a: "A Kafka topic called card-events: an ordered, durable record of every change to a card transaction, kept so many services can read it. Events are keyed by card token, so each card's events stay in order." },
        { q: "Who reads it?", a: "Independent services, each at its own pace: notifications, the suspicious-transaction alerts service, rewards, accounting integrations and analytics. Each remembers how far it has read (its offset), so it can catch up, or read again after a bug." },
        { q: "How does a reader avoid acting twice?", a: "Every event has an id, here evt_01JC9W3K2T. A reader records the ids it has handled in its own database, in the same transaction as its own work, and skips any it has seen." },
        { q: "What does off the hot path mean?", a: "The hot path is everything between the request arriving and the answer leaving. The notification happens after the answer has gone, so if it is slow or lost, no purchase is affected." },
        { q: "What if the push is lost?", a: "Push is best effort, with no delivery guarantee. The app reads the ledger when it opens, so a lost notification never means a wrong balance." },
      ],
      focus: ['ledger', 'events', 'consumers', 'app'],
      path: ['outbox', 'consume', 'push'],
      labels: ['authorised', 'event', '£36.40'],
    },
    {
      title: 'The network asks again',
      text: "The same 0100 arrives a second time: a retry after a connection dropped, which Lithic, an issuer processor, warns can happen. It carries the same trace and reference numbers, so the authoriser builds the same key, finds the decision it stored and returns it. No second hold, no second notification. Retries are normal; treating one as a new purchase would hold the owner's money twice.",
      story: {
        context: "We approved the lunch about 100 ms after the request arrived, and the till showed approved. Then a connection between Mastercard and us dropped, and the request arrives again.",
        problem: "The network cannot tell whether we got the first copy or whether our answer was lost, so it sends the same request again. To our gateway it is a new message.",
        consequence: "If each message were treated as a new purchase, the owner would see a second hold of £36.40, a second notification, and an available balance £36.40 too low until the extra hold lapsed.",
        fix: "The key is built from the network's identifiers, never from anything we assign when a message arrives, so the retry makes the same key: tok_8f3a91e2|2026-11-12|004217|631612004217. The authoriser finds the stored decision and returns it, and the gateway sends the same 0110. Nothing is written, so there is no new hold and no new event. Even a copy that reached the ledger would find hold_5521907 under that key and write nothing.",
      },
      explain: [
        { q: "Why would the network send the same request twice?", a: "Connections drop and answers get lost. When a sender cannot tell whether the first copy arrived, it sends it again. Lithic's documentation warns that the same request can arrive twice." },
        { q: "How do we know it is the same purchase?", a: "Mastercard's trace number (STAN 004217) and reference number (RRN 631612004217) are the same on a retry. With the card token and the date they make the same key as before." },
        { q: "Why not use our own id for each message?", a: "A retry is a new message with the same identity. An id we gave each message on arrival would differ, so the retry would look like a new purchase." },
        { q: "What does idempotent mean?", a: "Doing an operation twice has the same effect as doing it once. The stored decision and the hold are both keyed, so repeating them changes nothing." },
        { q: "What if the retry lands in the other data centre?", a: "Either site can serve any request, and the key depends only on the network's identifiers, so it is the same in both. The stored keys catch the repeat there too." },
      ],
      focus: ['network', 'gateway', 'authz'],
      path: ['auth', 'decide', 'decision', 'authreply'],
      labels: ['0100 again', 'same key', 'stored', 'same 0110'],
    },
    {
      title: 'Next day: the clearing file',
      text: "Next day. The restaurant's bank has sent the purchase for payment, and Mastercard's clearing file, a batch of final purchase records it delivers several times a day, carries it with the final amount: £36.55, at a rate of 0.8702 on the day it cleared. The authorisation was a promise; this is the bill, and it may differ from the £36.40 held. Clearing, not authorisation, is what moves money.",
      story: {
        context: "Yesterday's hold of £36.40 is still open on account acc_7731. The restaurant's bank has now presented the purchase, and Mastercard delivers file clr-2026-11-13-02 with 241,806 records, one of them our lunch.",
        problem: "The final amount can differ from the hold: a tip, or, as here, a different exchange rate on the day it cleared. Some records have no authorisation at all, such as offline taps and forced posts, and refunds arrive here too. Files come in batches of 200,000 to 300,000 records, and one could arrive twice.",
        consequence: "Posting the held amount instead of the bill would leave this account 15p wrong, and errors like it across about 1.2 million purchases a day. Processing a file twice would charge every purchase in it twice.",
        fix: "Clearing takes four to six of Mastercard's six daily files and treats each as one job: check its record counts, then handle each record on its own. Every record is keyed by file id and record number, so a rerun posts nothing twice. The cost is that posting lags the purchase, by a day in this tour.",
      },
      explain: [
        { q: "What is clearing?", a: "The batch step, often a day later, where the acquirer presents the final amount and the issuer posts it. Authorisation placed a hold; clearing makes the purchase final." },
        { q: "What does presenting the purchase mean?", a: "The acquirer sending the purchase for payment, with its final amount, through the network. It is also called presentment." },
        { q: "Why is the amount £36.55 and not £36.40?", a: "The bill in euros did not change: €42.00. The rate on the day it cleared, 0.8702, differed from the example rate at authorisation, 0.8667, so the amount in pounds rose by 15p." },
        { q: "What is in a clearing file?", a: "A header with the file id, settlement date and record count, then one record per purchase or refund: authorisation code, card, merchant, amount, the amount in pounds and the fees. The examples show generic fields, not Mastercard's layout." },
        { q: "How often do the files come?", a: "Mastercard runs clearing six times a day; issuers may take all six, but four or five are usually enough, by Paymentology's guide. At about 1.2 million records a day, that is 200,000 to 300,000 records a file." },
      ],
      focus: ['network', 'clearing'],
      path: ['files'],
      labels: ['£36.55'],
    },
    {
      title: 'Match, post, release',
      text: "Clearing must find yesterday's hold, but no single field links the record to its authorisation. So it matches on the authorisation code (K7Q2M9), card, merchant and original amount. One transaction then posts £36.55 to the account and releases the £36.40 hold, so the money is never counted twice. A record with no hold, such as a tap the chip approved offline, is posted all the same.",
      story: {
        context: "Clearing has record 118,442 of file clr-2026-11-13-02: authorisation code K7Q2M9, the card, Restaurant in Dublin, €42.00, £36.55. In the ledger, hold_5521907 for £36.40 is still open.",
        problem: "No single field ties the record to its hold, so it must be matched on several. Posting the bill and releasing the hold are two changes to the same account. And the issuer must honour a record even when there is no hold to match.",
        consequence: "If the post and the release were separate writes, a crash between them would leave the money both held and posted: £72.95 gone for one lunch. A record left unposted because it had no hold would leave the ledger short of what the network will collect.",
        fix: "Clearing looks up the open hold by authorisation code, card token, merchant and €42.00. One transaction then locks the account, inserts the posting keyed by file and record number, marks the hold released, takes 3,655 pence off the balance and 3,640 off the held total, and writes a 'cleared' outbox event. Records with no hold are posted anyway and sent to people for review.",
      },
      explain: [
        { q: "What is posting?", a: "Writing the final entry to the ledger: here a debit of £36.55 from acc_7731, credited to the Mastercard settlement account. Posted entries are final; statements and interest are worked out from them, never from holds." },
        { q: "What does releasing the hold do?", a: "It marks hold_5521907 released and takes its £36.40 off the account's held total. The available balance now reflects the posting alone." },
        { q: "Why match on the euro amount?", a: "The amount in pounds changed between authorisation and clearing, from £36.40 to £36.55, so it cannot be used to match. The original €42.00 did not move." },
        { q: "What if no hold matches?", a: "The purchase may have been approved offline by the chip, or be a forced post. It is posted anyway, even into a negative balance, and sent for review. The remedy for a wrong one is a dispute through the network." },
        { q: "How often does matching fail?", a: "Marqeta says it matches about 99 per cent of records, against an industry norm of about 88 per cent; both are Marqeta's own claims. Unmatched records go to a queue for people." },
        { q: "What stops a file being posted twice?", a: "Each posting is unique on its file id and record number. A rerun tries to insert the same pair, inserts nothing, and rolls back." },
      ],
      focus: ['clearing', 'ledger'],
      path: ['post'],
      labels: ['post, release'],
    },
    {
      title: 'Settle, then reconcile',
      text: "Money between banks moves once a day, not per purchase. Mastercard nets every bank's position (adds up what each owes and is owed) and takes ours from our settlement account once that working day. Reconciliation then compares three records that should agree: our ledger postings, the clearing file totals and the settlement account's statement. Every difference is a break that someone owns and must explain.",
      story: {
        context: "The lunch is posted at £36.55 for settlement on Friday 13 November 2026. It is one of about 1.2 million postings that day.",
        problem: "Our ledger, Mastercard's files and the money that really left our settlement account are three records kept by different systems. Each can be right by its own lights and still disagree with the others. And the account must hold enough by the cut-off on every settlement day.",
        consequence: "A bug that posts slightly wrong amounts, a file processed short, or a settlement error would go unseen and build up day after day. Being short of funds on a settlement day breaks scheme rules.",
        fix: "Mastercard debits one net amount, £29,838,929.74 in the illustrative advisement: what our cards spent, less refunds, less the interchange owed to us. Each day reconciliation totals our postings, the files and the bank statement by currency and date. In the example the statement shows £5.00 more than the other two: a break, with an owner and evidence. The cost is breaks that need people to explain them.",
      },
      explain: [
        { q: "What is settlement?", a: "The movement of money between banks: net, once a working day per currency, worked out by the network from clearing. It runs Monday to Friday, and Saturday's clearing is netted into Monday, by Paymentology's guide." },
        { q: "What does netting mean?", a: "Instead of moving money for every purchase, Mastercard adds up everything our cards spent, less refunds, less the interchange owed to us, and moves one amount. In the example that is £29,838,929.74 from our account." },
        { q: "What is the settlement account?", a: "Our account in pounds at a settlement bank, which Mastercard debits with the net amount. It must hold enough by the cut-off on each settlement day, so we forecast the amount from open holds and cleared totals." },
        { q: "What is interchange?", a: "A fee the acquirer pays the issuer on each purchase, set by the network. UK caps on it apply to consumer cards, not to commercial cards like these, which matters to a business-card issuer's income." },
        { q: "What is a break, and who deals with it?", a: "A difference between the three records. Each one gets an owner, who traces it to the clearing record and the posting, fixes the cause and records the evidence. Monzo alerts an engineer for each break: one bank's practice, not a rule." },
        { q: "Why three records, not two?", a: "Comparing only our ledger with the files misses the case where the money that actually moved is not what the files said. The bank statement is the only record of that." },
      ],
      focus: ['bank', 'recon', 'clearing', 'ledger'],
      path: ['settle', 'statement'],
      labels: ['net debit', 'statement'],
    },
    {
      title: 'When we are too slow',
      text: "Later, another purchase on the same card. The ledger's database is switching to its copy in the other data centre (a failover), so no hold can be placed. Mastercard's timer runs out and it answers for us (stand-in) on limits we set in advance: approved up to a per-card limit, gambling refused. When we recover it sends an 0120 advice, which we post as a hold. We never decide again; we apply what was decided.",
      story: {
        context: "A later purchase on the same card, £12.50 in the example advice, arrives while the ledger's primary database is failing over to its replica in the other data centre.",
        problem: "The authoriser cannot place a hold, and it must not approve without one. Meanwhile Mastercard's timer is running, and it will not wait for the failover to finish.",
        consequence: "Approving without a hold would break the balance: the same money could be spent twice. Declining every purchase during every failover would turn good customers away at the till.",
        fix: "Mastercard's stand-in decides on parameters we set in advance: limits per card and per day, and categories to refuse such as gambling. When we are back it sends an 0120 advice with STAN 004391 and RRN 631613004391, and we post it as a hold, keyed the same way as any authorisation, exactly once. The cost: the parameters are product decisions to make and review before an outage, and stand-in approves less (Visa Research: 67 per cent against 93 when issuers answer).",
      },
      explain: [
        { q: "What is a failover?", a: "The ledger's main database (the primary) copies every commit to a replica in the other data centre. When the primary fails, the replica takes over. For the seconds that takes, no holds can be placed." },
        { q: "What is stand-in processing?", a: "The network deciding for the issuer when the issuer is down or too slow, using limits and rules the issuer set in advance. It tells the issuer afterwards with advice messages." },
        { q: "Who sets the stand-in parameters, and when?", a: "We do, as the issuer, before any outage: limits per card and per day, and kinds of merchant to refuse. They are product decisions, made and reviewed in advance, not chosen in the moment." },
        { q: "What is an 0120 advice?", a: "A message telling us what has already been decided, here a stand-in approval of £12.50. We apply it once; we do not decide again, even if our own checks would now say no." },
        { q: "Why is it posted as a hold?", a: "Stand-in only authorised the purchase, like our own approvals. The final amount still comes through clearing, so the advice places a hold, keyed by the network's identifiers so it is applied only once." },
        { q: "What if our own approval reaches Mastercard after its timer?", a: "Mastercard has already answered by stand-in and ignores ours. Its advice, not our record, is the truth: if it declined, we release our hold; if it approved, we keep it." },
      ],
      focus: ['network', 'gateway', 'merchant'],
      path: ['auth', 'tapreply', 'auth'],
      labels: ['no answer', 'approved', '0120 advice'],
    },
  ],

  brief: [
    {
      heading: 'Ask first',
      points: [
        'Which party are we? The issuer (the network asks us to approve), or the acquirer or payment provider (a merchant asks us to charge)? This page is the issuer; the framings cover the other side.',
        'Debit, credit or both? Debit draws on the account balance; credit on a limit, with statements and interest.',
        'Direct to the network, or through an issuer processor that gives us a webhook?',
        'How many cards, how many purchases a day, what peak?',
        'What is out of scope? Card production and delivery, 3-D Secure screens, disputes handling by people, credit decisions.',
      ],
    },
    {
      heading: 'What it must do',
      points: [
        'Approve or decline each authorisation inside the network\'s time limit, with the right reason code.',
        'Never approve beyond available funds or credit, even under retries and concurrent purchases.',
        'Handle the whole life of a purchase: reversals, partial and incremental approvals, expiry, clearing at a different amount, clearing with no authorisation, refunds and disputes.',
        'Post every cleared purchase exactly once, settle daily with the network, and reconcile ledger, clearing and settlement.',
        'Tell the cardholder within seconds, and let them freeze a card and set limits with immediate effect.',
      ],
    },
    {
      heading: 'The life of one purchase',
      points: [
        'Authorised: a hold is placed. It can grow (an incremental authorisation at a hotel or fuel pump), shrink (a partial reversal) or go (a full reversal, or expiry after the network\'s window).',
        'Declined: nothing is held, but the decision is stored so a retry gets the same answer.',
        'Cleared: the final amount is posted and the hold released. The amount may differ: a tip, or a different exchange rate on the day it cleared.',
        'Posted with no authorisation: an offline purchase or a forced post. It still has to be honoured.',
        'Later: a refund (a credit in clearing) or a dispute (raised through the network, money back through clearing and settlement).',
      ],
    },
    {
      heading: 'How well',
      points: [
        'Our targets: about 100 ms typically, 300 ms at the 99th percentile, never later than about 1 second, well inside the network\'s limit.',
        'Available whenever cards are used: two live data centres, and stand-in parameters for the rest.',
        'Strongly consistent for funds and holds; eventually consistent for notifications, rewards and analytics.',
        'Card numbers only inside a small PCI zone; nothing else stores or logs them.',
        'Every penny explained: daily reconciliation with no unexplained breaks.',
      ],
    },
    {
      heading: 'Simplified here',
      points: [
        'One network (Mastercard), one currency of account (pounds) and one settlement bank.',
        'Card production, PIN delivery, 3-D Secure screens and the people who work disputes are left out.',
        'Figures marked as design targets or assumptions are this page\'s own; everything else names its source.',
      ],
    },
  ],

  numbers: [
    { what: 'Cards', assumption: 'about 900,000 UK members (Tide, May 2026); some hold several cards', result: 'about 1.2 million cards (assumption)' },
    { what: 'Purchases', assumption: 'one card purchase per card a day on average (assumption)', result: 'about 1.2 million authorisations a day, 14 a second on average' },
    { what: 'Messages', assumption: 'about 1.3 network messages per purchase: retries, reversals, advices', result: 'about 1.6 million a day, 18 a second on average' },
    { what: 'Peak', assumption: '10 per cent of a day in the busiest hour, three times that on the busiest day of the year', result: 'about 45 messages a second on a normal peak, about 135 at the yearly peak; build for 1,000' },
    { what: 'Ledger writes', assumption: 'a hold per approval and a posting per clearing record', result: 'about 2.4 million a day; holds peak near 100 a second, postings in bursts' },
    { what: 'Ledger size', assumption: 'four entries per purchase at about 300 bytes', result: 'about 1.4 GB a day, about 0.5 TB a year' },
    { what: 'Latency budget', assumption: 'our targets: network link 10, parse 1, vault 5, HSM 5, card 5, fraud 50, hold 20, reply 10 ms', result: 'about 106 ms; 300 ms at the 99th percentile; hard stop at 1 s (targets)' },
    { what: 'Time limits', assumption: 'what platforms give the decision: Stripe and Adyen 2 s, Checkout.com 2 s (up to 2.5), Marqeta 3 s, Lithic 6 s (3 advised)', result: 'our target: under a second, so a retry still fits' },
    { what: 'Clearing', assumption: '1.2 million records in four to six files a day (assumption)', result: 'a few hundred thousand records a file, minutes to process' },
  ],

  framings: [
    {
      name: 'Issuer for a UK business bank (this diagram)',
      scale: 'about 1.2 million cards, about 135 messages a second at peak (assumption)',
      shape: 'A gateway on the network link, an authoriser with ordered checks, holds in a strongly consistent ledger, clearing files matched to holds, daily settlement and three-way reconciliation. The hard parts are the time budget, idempotency and keeping the money right, not throughput.',
    },
    {
      name: 'Acquirer or payment provider (Stripe, Adyen)',
      scale: 'thousands of merchants; Hello Interview designs for 10,000 transactions a second',
      shape: 'Turn it round. A merchant calls your API with an idempotency key; you create a payment, tokenise the card, run 3-D Secure, send it to the network and wait. The hard part is not knowing: on a timeout you must not charge twice, so you record the attempt before calling, query or reverse when unsure, and reconcile against the network\'s settlement files. Webhooks tell the merchant. Capture, refunds and payouts are your later life-cycle steps, and disputes arrive as debits.',
    },
    {
      name: 'Issuing on a processor platform (Marqeta, Lithic, Stripe Issuing)',
      scale: 'a start-up card programme',
      shape: 'The processor holds the network link, the PCI zone and clearing. You get a webhook for each authorisation with 2 to 3 seconds to answer (6 at Lithic), and choose what happens on a timeout. Your design shrinks to the authoriser, the ledger and events, plus reconciliation against their reports.',
    },
    {
      name: 'Network or very large issuer',
      scale: 'VisaNet: over 65,000 messages a second of capacity',
      shape: 'Partition everything by card range, run active-active across regions, keep the authorisation decision on in-memory state, and model stand-in on each issuer\'s past decisions. Clearing becomes a pipeline of many parallel batches.',
    },
  ],

  decisions: [
    { choice: 'Where the hold lives', a: 'In the ledger, in the same transaction as the funds check.', b: 'In a fast cache, written to the ledger later.', call: 'The ledger. It is 20 ms well spent, and a cache can approve money that is not there.' },
    { choice: 'When the ledger is down', a: 'Decline, or let stand-in decide on our limits.', b: 'Approve and post the hold later.', call: 'Decline or stand-in. An approval without a hold breaks the balance.' },
    { choice: 'When fraud scoring is slow', a: 'Wait for the score.', b: 'Stop at 50 ms and decide on rules.', call: 'Rules. A late score is worth nothing, and a late answer is a decline.' },
    { choice: 'Idempotency key', a: 'The network\'s identifiers for the authorisation.', b: 'Our own id per message received.', call: 'The network\'s. A retry is a new message with the same identity.' },
    { choice: 'Connection to the network', a: 'Direct: own gateway and PCI zone.', b: 'An issuer processor\'s webhook.', call: 'Direct at this size; a processor to launch fast or when small.' },
    { choice: 'Two data centres', a: 'Both live, either answers any request.', b: 'One live, one on standby.', call: 'Both live. The network already sends to both, and a standby turns every failover into stand-in.' },
    { choice: 'Events', a: 'Outbox in the ledger transaction, relayed to a log.', b: 'Publish after commit.', call: 'Outbox. Money and events must agree.' },
  ],

  drills: [
    { name: 'The ledger database fails over', what: 'Holds cannot be placed for the seconds it takes. The authoriser declines or lets the network time out into stand-in. Advices for what stand-in approved arrive afterwards and are posted as holds.' },
    { name: 'Fraud scoring is slow', what: 'Every call stops at 50 ms and the authoriser decides on rules alone. Alert on the share of decisions made without a score.' },
    { name: 'A whole data centre is lost', what: 'The network sends everything on its connections to the other site. Requests in flight time out and are retried there, and the stored keys catch any that had been decided. The databases fail over.' },
    { name: 'The network retries a request we already approved', what: 'Same identifiers, so the stored decision is returned. No second hold, no second event.' },
    { name: 'We approved, but the answer never reached the till', what: 'The terminal sends a reversal, which releases the hold. If nothing comes, the hold lapses at the end of its window.' },
    { name: 'Our approval reached the network after its timer', what: 'The network has already answered by stand-in and ignores ours. Its advice says what it decided: if it declined, release our hold; if it approved, keep it. The advice, not our own record, is the truth.' },
    { name: 'A clearing record with no authorisation', what: 'An offline tap or a forced post. Post it anyway, even into a negative balance, and send it for review. The remedy for a wrong one is a dispute.' },
    { name: 'A clearing file arrives twice', what: 'Records are keyed by file and record number, so the second run posts nothing.' },
    { name: 'Kafka is down', what: 'Events wait in the outbox table. Authorisations carry on; notifications are late.' },
    { name: 'The HSM pool in one site is down', what: 'That site cannot verify chips, so it is taken out of service and the network uses the other site.' },
    { name: 'Reconciliation finds £5 too much settled', what: 'A break with an owner. Trace it to the clearing record and the posting, fix the cause, and record the evidence.' },
  ],

  interview: [
    'Minutes 0 to 5: say which party you are. "I will design the issuer: the network sends us an authorisation and we must answer in time. I can turn it round to the acquirer side later." Draw the four parties and the three phases: authorise, clear, settle.',
    'Minutes 5 to 10: requirements and sums. On my assumptions, 1.2 million cards is about 135 network messages a second at the yearly peak, so this is not a throughput problem. It is latency, correctness and availability.',
    'Minutes 10 to 20: draw the authorisation path left to right (network, gateway, authoriser, ledger) and put the time budget on it hop by hop. Name the checks in order.',
    'Minutes 20 to 30: go deep on the hold. One transaction for the funds check and the hold, keyed by the network\'s identifiers. Walk through a retry, a reversal, a late answer and a partial approval. Say what must be strongly consistent and what need not be, and how the outbox joins them.',
    'Minutes 30 to 38: clearing and money. Amounts differ, records arrive with no authorisation, files arrive twice. Then net settlement and three-way reconciliation.',
    'Minutes 38 to 45: availability and security. Two live sites, a degraded mode for each dependency, stand-in as a product setting. PCI scope, tokens and the HSM, raised before you are asked. End with what you would build first.',
  ],

  sources: [
    { label: 'Hello Interview: Design a Payment System', href: 'https://www.hellointerview.com/learn/system-design/problem-breakdowns/payment-system', note: 'The payment provider framing: a merchant initiates a charge, 10,000 transactions a second at peak. Most of the breakdown is behind a paywall.' },
    { label: 'Stripe: Issuing real-time authorizations', href: 'https://docs.stripe.com/issuing/controls/real-time-authorizations', note: '2 seconds to answer; timeout settings and Autopilot as a fallback; controllable hold amounts.' },
    { label: 'Adyen: Relayed authorisation', href: 'https://docs.adyen.com/issuing/authorisation/relayed-authorisation', note: '2,000 ms to reply, with a chosen default on timeout or error.' },
    { label: 'Checkout.com: Relay authorization requests', href: 'https://www.checkout.com/docs/card-issuing/manage-issuing-transactions/relay-authorization-requests', note: '2,000 ms default, 2,500 ms maximum; declined on timeout; stand-in mode.' },
    { label: 'Marqeta: Managing timeouts', href: 'https://www.marqeta.com/docs/developer-guides/managing-timeouts', note: 'A just-in-time funding gateway must answer within 3 seconds, or the purchase is declined.' },
    { label: 'Lithic: Auth Stream Access and Transaction Flow', href: 'https://docs.lithic.com/docs/auth-stream-access-asa', note: '6 seconds hard, 3 recommended; retries mean the same request can arrive twice.' },
    { label: 'Lithic: Transaction flow', href: 'https://docs.lithic.com/docs/transaction-flow', note: 'The life cycle of authorisation, advice, clearing and expiry; network stand-in on timeout; a typical 7-day authorisation window.' },
    { label: 'Visa: Smarter Stand-In Processing', href: 'https://www.visa.co.cr/dam/VCOM/regional/na/us/about-visa/research/documents/smarter-stip.pdf', note: 'Visa Research: what stand-in is, issuer parameters, a 67 per cent stand-in approval rate against 93 per cent from issuers.' },
    { label: 'Mastercard: Stand-In Authorisation', href: 'https://www.mastercard.com/au/en/business/cybersecurity-fraud-prevention/payment-resiliency/mastercard-stand-in-authorization.html', note: 'Mastercard decides for the issuer when its systems are down, on parameters and card-level limits the issuer sets.' },
    { label: 'Paymentology: STIP advices', href: 'https://developer.paymentology.com/docs/stip-advices', note: 'Stand-in decisions reach the issuer as 0120 authorisation advices, to be accepted and booked once.' },
    { label: 'Visa patent US12118555: dynamic authorization response timeout', href: 'https://patents.google.com/patent/US12118555', note: 'Background: issuer timeouts typically 5 to 10 seconds; terminals wait 25 seconds or more; stand-in after the timeout. Visa and Mastercard publish no figure.' },
    { label: 'Monzo: Processing payments in Monzo Stand-in', href: 'https://monzo.com/blog/processing-payments-in-monzo-stand-in', note: 'April 2025: Monzo\'s own backup platform, separate from Mastercard\'s stand-in; scheme links from its data centres; advices synced back; shadow testing.' },
    { label: 'Monzo: 3 Second Sandwich', href: 'https://monzo.com/blog/2015/12/02/3-second-sandwich/', note: '2015: the authorisation path in a second or two, a notification in under 3 seconds, presentment about 48 hours later, offline purchases.' },
    { label: 'Monzo: Processing payments safely at scale', href: 'https://monzo.com/blog/2022/02/08/processing-payments-safely-at-scale', note: 'Coherence checks and daily reconciliation of ledger against settlement account.' },
    { label: 'Finextra: Monzo to move card processing in-house', href: 'https://finextra.com/newsarticle/30226/monzo-to-move-card-processing-inhouse-following-outage', note: 'The 2017 outage at GPS, Monzo\'s processor, and its direct Mastercard connection.' },
    { label: 'Increase: Visa redundancy', href: 'https://www.increase.com/articles/visa-redundancy', note: 'Two live Visa data centres, redundant circuits, persistent TCP sessions, answers matched by field 37.' },
    { label: 'Increase: ISO 8583, the language of credit cards', href: 'https://increase.com/articles/iso-8583-the-language-of-credit-cards', note: 'Message types, bitmaps and length-prefixed framing over TCP.' },
    { label: 'Wikipedia: ISO 8583', href: 'https://en.wikipedia.org/wiki/ISO_8583', note: 'Message type indicators (0100, 0110, 0120, 0400), data elements and response codes.' },
    { label: 'Paymentology: Clearing, settlement and reconciliation', href: 'https://developer.paymentology.com/docs/txn-clearing-settlement-reconciliation', note: 'Six Mastercard clearing cycles a day, matching fields (no single linking field), net settlement Monday to Friday.' },
    { label: 'Marqeta: Card program clearing and settlement', href: 'https://www.marqeta.com/blog/card-program-clearing-and-settlement-how-issuer-processors-manage-fund-flow', note: 'Matching rates, forced posts, settlement in one to three days.' },
    { label: 'Stripe: Place a hold on a payment method', href: 'https://docs.stripe.com/payments/place-a-hold-on-a-payment-method', note: 'Authorisation validity windows by network, partial capture.' },
    { label: 'Stripe: How disputes work', href: 'https://docs.stripe.com/disputes/how-disputes-work', note: '120-day dispute window, response deadlines, funds held during the dispute.' },
    { label: 'Payment Systems Regulator: the Interchange Fee Regulation', href: 'https://www.psr.org.uk/our-work/card-payments/the-ifr/', note: 'Interchange caps of 0.2 and 0.3 per cent on consumer cards.' },
    { label: 'Interchange Fee Regulation (EU) 2015/751, Article 1', href: 'https://www.legislation.gov.uk/eur/2015/751/article/1', note: 'Article 1(3)(a): the caps in Chapter II do not apply to transactions with commercial cards.' },
    { label: 'PCI SSC: PCI DSS v4.0 highlights', href: 'https://www.pcisecuritystandards.org/1-3-pci-dss-v4-0-highlights_approved_5-26/', note: 'Who the standard applies to: anyone who stores, processes or transmits card data, or could affect its security.' },
    { label: 'PCI SSC: Just published, PCI DSS v4.0.1', href: 'https://blog.pcisecuritystandards.org/just-published-pci-dss-v4-0-1', note: 'v4.0.1 published June 2024; v4.0 retired on 31 December 2024.' },
    { label: 'Mastercard: What is tokenization', href: 'https://newsroom.mastercard.com/news/perspectives/2024/what-is-tokenization/', note: 'Tokens in wallets and on file, a cryptogram per transaction, the issuer deciding on wallet tokens.' },
    { label: 'AWS Payment Cryptography: verify an EMV ARQC and generate an ARPC', href: 'https://docs.aws.amazon.com/payment-cryptography/latest/userguide/use-cases-issuers.generalfunctions.arqc.html', note: 'What the ARQC is, how the issuer checks it with derived keys, and the ARPC in the answer.' },
    { label: 'Thales payShield 10K data sheet', href: 'https://cpl.thalesgroup.com/sites/default/files/content/data_sheets/payshield-10k-ds.pdf', note: 'A payment HSM: PIN and card verification, EMV cryptogram validation, tamper-responsive.' },
    { label: 'Visa fact sheet (July 2019)', href: 'https://www.visa.de/dam/VCOM/global/about-visa/documents/visa-fact-sheet-july-2019.pdf', note: '65,000+ transaction messages a second of capacity. A 2025 Visa article says up to 83,000.' },
    { label: 'Bank of England: CHAPS moves to ISO 20022', href: 'https://www.bankofengland.co.uk/news/2023/june/chaps-transitions-to-latest-global-financial-messaging-standard', note: 'CHAPS migrated to ISO 20022 on 19 June 2023.' },
    { label: 'Stripe: ISO 8583, the standard behind card authorisations', href: 'https://stripe.com/gb/resources/more/iso-8583', note: 'Still used across major card networks; ISO 20022 for cards is discussed, not done.' },
    { label: 'FStech: FCA contactless limit removal takes effect', href: 'https://www.fstech.co.uk/fst/FCA_Contactless_Limit_Removal_Takes_Effect.php', note: 'From 19 March 2026 UK firms set their own contactless limits; most large banks keep £100 for now. A trade news report, not the FCA itself.' },
    { label: 'Alex Xu and Sahn Lam: Designing a payment system (The Pragmatic Engineer)', href: 'https://newsletter.pragmaticengineer.com/p/designing-a-payment-system', note: 'Double entry, idempotency keys, retries and reconciliation from the payment provider side.' },
    { label: 'City AM: Tide crosses 2 million members', href: 'https://www.cityam.com/tide-crosses-2-million-members-worldwide-big-step-forward-in-mission-to-support-and-grow-small-businesses/', note: 'May 2026: 900,000 UK members, the basis of the card estimate.' },
  ],

  glossary: [
    { term: 'Four-party model', also: ['issuer', 'acquirer', 'cardholder', 'merchant'], where: 'network', text: 'Cardholder, merchant, acquirer (the merchant\'s bank) and issuer (the cardholder\'s bank), joined by a card network. The network routes messages and money between banks; it does not hold the accounts.' },
    { term: 'Authorisation', also: ['auth', '0100'], where: 'authz', text: 'The real-time question "will you pay this?". An approval places a hold on funds; no money moves yet.' },
    { term: 'Clearing', also: ['presentment', 'capture'], where: 'clearing', text: 'The batch step, often a day later, where the acquirer presents the final amount and the issuer posts it. The amount can differ from the authorisation.' },
    { term: 'Settlement', where: 'bank', text: 'The movement of money between banks, net, once a working day per currency, worked out by the network from clearing.' },
    { term: 'Interchange', also: ['scheme fee', 'IFR'], where: 'bank', text: 'A fee the acquirer pays the issuer on each purchase, set by the network; the network charges both sides scheme fees too. In the UK consumer cards are capped at 0.2 per cent for debit and 0.3 for credit. The IFR excludes commercial cards from the caps, which matters to a business-card issuer\'s income.' },
    { term: 'ISO 8583', also: ['MTI', 'message type'], where: 'gateway', text: 'The message standard for card authorisations. A four-digit type says what a message is: 0100 request, 0110 response, 0120 advice, 0400 reversal. A bitmap says which numbered fields follow. Each network speaks its own dialect.' },
    { term: 'ISO 20022', where: 'gateway', text: 'A newer, richer message standard used for account-to-account payments; CHAPS moved to it in June 2023. Card authorisations still mostly use ISO 8583.' },
    { term: 'Advice', also: ['0120'], where: 'network', text: 'A message telling the issuer what has already been decided, such as a stand-in approval. The issuer applies it; it does not decide again.' },
    { term: 'Reversal', also: ['0400', 'void'], where: 'merchant', text: 'Cancels all or part of an authorisation, often because the terminal never got the answer. Releases the hold.' },
    { term: 'Stand-in processing', also: ['STIP'], where: 'network', text: 'The network deciding on the issuer\'s behalf when the issuer is down or too slow, using limits and rules the issuer set in advance. Advices follow.' },
    { term: 'Response code', also: ['reason code', 'field 39'], where: 'authz', text: 'Two characters in the answer: 00 approved, 05 do not honour, 51 not sufficient funds, 91 issuer or switch inoperative.' },
    { term: 'STAN and RRN', also: ['field 11', 'field 37', 'trace number', 'retrieval reference'], where: 'gateway', text: 'Identifiers the network puts on each authorisation. A retry carries the same ones, so with the card and date they make the idempotency key.' },
    { term: 'Idempotency key', see: { id: 'idempotency-keys', label: 'Idempotency keys' }, where: 'ledger', text: 'An identity for a request so that doing it twice has the effect of doing it once. Here the network\'s identifiers key the stored decision and the hold.' },
    { term: 'Hold', also: ['pending transaction', 'authorisation hold'], where: 'ledger', text: 'A pending ledger entry that lowers the available balance until clearing posts the purchase, a reversal cancels it, or it lapses.' },
    { term: 'Available balance', also: ['ledger balance', 'posted balance'], where: 'ledger', text: 'What the owner can spend: the posted (ledger) balance less open holds. For a credit card, the credit limit less posted and held amounts.' },
    { term: 'Double-entry', see: { id: 'two-phase-locking', label: 'Two-phase locking' }, where: 'ledger', text: 'Every movement is recorded as equal debits and credits across accounts, so the entries always sum to zero and money cannot appear or vanish.' },
    { term: 'Partial approval', where: 'authz', text: 'Approving less than asked, up to what is available, when the terminal says it can accept that. The rest is paid another way.' },
    { term: 'Incremental authorisation', also: ['authorisation advice', 'fuel', 'hotel'], where: 'authz', text: 'A later request that raises an existing hold, as at a hotel or a fuel pump. The hold grows; it is still one purchase.' },
    { term: 'Pre-authorisation', also: ['validity window', 'expiry'], where: 'ledger', text: 'A hold placed before the final amount is known. It lapses at the end of the network\'s window: about 7 days online, 2 days card present on Mastercard.' },
    { term: 'Forced post', also: ['offline purchase', 'force capture'], where: 'clearing', text: 'A clearing record with no matching authorisation. The issuer must post it; the remedy for a wrong one is a dispute.' },
    { term: 'Chargeback', also: ['dispute'], where: 'clearing', text: 'The issuer reclaiming a purchase from the acquirer for a cardholder. Usually raised within 120 days; Stripe gives merchants 7 to 21 days to respond, and the cycle can take two to three months.' },
    { term: 'Refund', also: ['return', 'credit'], where: 'clearing', text: 'A credit from the merchant that arrives in clearing, sometimes with its own authorisation. Credits are rarely declined.' },
    { term: 'Reconciliation', see: { id: 'stream-joins', label: 'Joins on a key' }, also: ['recon', 'break'], where: 'recon', text: 'Comparing records that should agree, here ledger, clearing files and settlement account. A difference is a break to be explained.' },
    { term: 'PCI DSS', also: ['cardholder data environment', 'CDE'], where: 'vault', text: 'The card industry\'s security standard. It applies to every system that stores, processes or transmits card data, and to anything that can affect them; tokens keep most systems out.' },
    { term: 'Token', also: ['tokenisation'], where: 'vault', text: 'A random stand-in for a card number, meaningless outside the vault. Logs, events and the ledger use it.' },
    { term: 'Network token', also: ['Apple Pay', 'Google Pay', 'wallet'], where: 'merchant', text: 'A card number issued by the network for one wallet or merchant, used with a one-time cryptogram per purchase. The issuer decides whether a wallet token is created.' },
    { term: 'HSM', also: ['hardware security module'], where: 'hsm', text: 'Tamper-resistant hardware that holds keys and does cryptography for others. Keys never leave it in the clear.' },
    { term: 'ARQC and ARPC', also: ['EMV cryptogram', 'chip'], where: 'hsm', text: 'The chip\'s authorisation request cryptogram, a code only the real card can compute for this purchase with its secret key, and the issuer\'s response cryptogram that proves the answer came from the issuer.' },
    { term: '3-D Secure', also: ['3DS', 'SCA', 'strong customer authentication'], where: 'merchant', text: 'A protocol for authenticating the cardholder in online purchases, by app, code or biometrics. In the UK and EEA strong customer authentication rules can require it.' },
    { term: 'Contactless limit', where: 'cards', text: 'The most a tap can spend without a PIN. Since 19 March 2026 UK firms set their own; most large banks said they would keep £100.' },
    { term: 'Merchant category code', also: ['MCC', 'field 18'], where: 'cards', text: 'Four digits saying what kind of business the merchant is. Controls block categories by it, such as gambling.' },
    { term: 'Transactional outbox', see: { id: 'outbox', label: 'Transactional outbox' }, also: ['outbox'], where: 'events', text: 'Writing an event to a table in the same transaction as the change it describes, then relaying it to a log. The two can never disagree.' },
    { term: 'Active-active', see: { id: 'load-balancing', label: 'Load balancing' }, where: 'gateway', text: 'Two sites both serving live traffic, so losing one loses only what was in flight there.' },
    { term: 'Just-in-time funding', also: ['JIT', 'relayed authorisation', 'webhook'], where: 'authz', text: 'An issuer processor asking your system to approve each purchase, with 2 to 3 seconds to answer (6 at Lithic), in place of you holding the network link.' },
    { term: 'Issuer processor', where: 'network', text: 'A company that runs the network connection, PCI zone and clearing for card programmes, such as Marqeta, Lithic or Stripe Issuing.' },
    { term: 'Settlement account', where: 'bank', text: 'The bank account the network debits or credits with the net position each working day.' },
    { term: 'Velocity limit', see: { id: 'token-bucket', label: 'Token bucket' }, where: 'fraud', text: 'A cap on how often or how much a card spends in a window. A burst of small purchases is a classic fraud pattern.' },
  ],
};
