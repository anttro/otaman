# OTAMan — SIM OTA toolkit: PWA + local card server

OTAMan is an offline HTML/JS PWA for building APDU commands (SIM, USIM, GlobalPlatform RAM), assembling SCP80 secured packets per ETSI TS 102 225, and constructing Expanded Remote Application data format APDU per ETSI TS 102 226. A bundled [`pysim-otaman-server`](pysim_otaman_server/) exposes a local HTTP API over pySim for live card operations: file manager, raw APDU, SIM Toolkit menu browsing, and OTA (SCP80) delivery.

**Demo:** [otaman.atroshin.ru](https://otaman.atroshin.ru) — the PWA alone, for experimenting. Install the server (below) for card-reader functions.

## Quick start

**PWA only (client-side tools):** open `frontend/index.html` in any browser, or serve `frontend/` with any static server. No Python required.

**Full (PWA + card server):**

```sh
git clone https://github.com/anttro/otaman.git
cd otaman
./setup.sh     # or setup.bat on Windows — creates .venv, installs pysim + server
./start.sh     # or start.bat — starts the server (it serves the PWA too)
```

Then open http://127.0.0.1:8080 — the UI and API share one origin, so no CORS or browser-permission setup is needed.

## Build

Tailwind CSS is used for styling. After cloning, rebuild the CSS:

```sh
cd frontend
npm install
npm run build
```

## Interface

Four top-level tabs: **C-APDU**, **SCP80**, **Response parser**, **Card reader**. The C-APDU and SCP80 tabs each have sub-tabs.

---

## C-APDU tab

Builds command APDUs (C-APDUs). Five sub-tabs cover different card generations and command sets.

### SIM RFM

CLA = `A0` (GSM 11.11 / ISO 7816-4).

#### Commands

| Command | INS | Description |
|---|---|---|
| SELECT | A4 | Select EF/DF by FID, path, dfname, or chain |
| UPDATE RECORD | DC | Update a record in a record-oriented EF |
| UPDATE BINARY | D6 | Update binary content at an offset |
| READ RECORD | B2 | Read a record |
| READ BINARY | B0 | Read binary content |
| ERASE BINARY | 0E | Erase binary at an offset |
| ACTIVATE FILE | 44 | Activate a file |
| DEACTIVATE FILE | 04 | Deactivate a file |
| VERIFY PIN | 20 | Verify PIN1 or PIN2 |
| CHANGE PIN | 24 | Change PIN1 or PIN2 |

#### SELECT methods

| Method | P1 | P2 | Input |
|---|---|---|---|
| By FID | 00 | 00 | 2-byte FID (4 hex) |
| By full path from MF | 08 | 00 | Full path hex from MF |
| By DF name / AID | 04 | 00 | AID (application ID) |
| ADF RFM chain | 00 | 00 | Comma-separated FIDs, each selected in turn |

#### Options

- **Start with SELECT** — checkbox to prepend a SELECT command before the operation. When unchecked, the operation is sent standalone with CLA.
- **Selection mode (P2)** — for record commands: Absolute (04), Next (06), Previous (02).
- **Record size** — pad/truncate data to the specified byte count.
- **Allow P1/P2 editing** — checkbox to enable manual override of P1/P2 bytes.

#### References

- ISO/IEC 7816-4: Organization, security and commands for interchange
- ETSI TS 102 226: Remote APDU structure for UICC based applications
- GSM 11.11: SIM-ME Interface

### USIM RFM

CLA = `00` (ETSI TS 102 221). Same commands as SIM, but SELECT uses P1=09, P2=0C (by FID from current directory).

#### References

- ETSI TS 102 221: UICC-Terminal Interface; Physical and Logical Characteristics
- ETSI TS 102 226: Remote APDU structure for UICC based applications

### Expanded Script

Builds Expanded Remote Application data format per ETSI TS 102 226 §5.2.1.

#### Format

Two encoding variants:
- **Definite (AA)**: `AA` + length + Command TLVs
- **Indefinite (AE)**: `AE` + `80` + Command TLVs + `00 00`

#### Command TLVs

| Type | Tag | Description |
|---|---|---|
| C-APDU | 22 | Raw APDU hex |
| Immediate Action | 81 | Proactive command or action indicator |
| Error Action | 82 | Proactive command on error |
| Script Chaining | 83 | Chaining data for multi-packet scripts |

#### Immediate Action builder

When the type is set to Immediate Action, the tool provides a structured builder for:

- **Action indicator**: `81` (Proactive session indication) / `82` (Early response)
- **Proactive command**: REFRESH, DISPLAY TEXT, or PLAY TONE — with auto-generated COMPREHENSION-TLV data objects (command details, device identities, text string, tone, etc.)
- **Custom hex**: freeform input for manual TLV construction

Error Action supports the same builder (DISPLAY TEXT, PLAY TONE).

#### References

- ETSI TS 102 226 V13.0.0 §5.2.1: Expanded Remote Application data format
- ETSI TS 102 223: Card Application Toolkit (CAT) — proactive command structure
- ETSI TS 101 220: BER-TLV tag assignments

### RAM/GP

CLA = `80` (GlobalPlatform Card Specification v2.3.1). Remote Application Management commands for card content management.

#### GP Commands Reference

| Command | INS | P1 | Description |
|---|---|---|---|
| INSTALL [for load] | E6 | 02 | Register a load file for loading |
| INSTALL [for install] | E6 | 0C | Install an application or SD |
| INSTALL [for make selectable] | E6 | 10 | Make an application selectable |
| INSTALL [for registry update] | E6 | 01 | Update registry entries |
| INSTALL [for extradition] | E6 | 04 | Extradition (move between SDs) |
| LOAD | E8 | 00 | Load executable code blocks |
| DELETE | E4 | 00/80 | Delete application or SD |
| GET STATUS | F2 | 80/40/20/10 | Get card status |
| GET DATA | CA | tag | Read card data objects |
| STORE DATA | E2 | 00/40/80/C0 | Store data (key, certificate, etc.) |
| SET STATUS | F0 | 80/40/60 | Lifecycle state management |
| EXTERNAL AUTHENTICATE | 82 | 00 | SCP host authentication |
| INTERNAL AUTHENTICATE | 88 | 00 | Card challenge-response |

#### INSTALL [for install] — Privilege Builder

Tag `C7` in the INSTALL data field. Built from 3 privilege bytes (GP spec Tables 11-7, 11-8, 11-9):

**Byte 1** (bits):
| Bit | Privilege |
|---|---|
| b8 | Security Domain |
| b7 | DAP Verification |
| b6 | Delegated Management |
| b5 | Card Lock |
| b4 | Card Terminate |
| b3 | Card Reset |
| b2 | CVM Management |

**Byte 2** (bits):
| Bit | Privilege |
|---|---|
| b8 | Trusted Path |
| b7 | Authorized Management |
| b6 | Token Verification |
| b5 | Global Delete |
| b4 | Global Lock |
| b3 | Global Registry |
| b2 | Final Application |

**Byte 3** (bits):
| Bit | Privilege |
|---|---|
| b8 | Receipt Generation |

#### INSTALL [for install] — SIM/UICC Toolkit Parameters

Optional TLV objects appended to the INSTALL data field:

- **Tag `CA`** (SIM Toolkit): Priority, Timers, Text Length, Menu Entries, Menu Positions, Channels, MSL, TAR, Access Domain
- **Tag `80`** (UICC Toolkit, inside `EA`): Same fields minus Access Domain

**MSL (Minimum Security Level)** — SPI1 byte per TS 102 225:
| Value | Meaning |
|---|---|
| 00 | No check |
| 11 | RC/CC/DS |
| 12 | RC/DS/CC |
| 15 | RC/DS/CC + MAC |
| 16 | RC/DS/CC + MAC + Cipher |
| 19 | RC/DS/CC + MAC + Cipher + DS |

#### GET STATUS P1 values

| Value | Meaning |
|---|---|
| 80 | Issuer Security Domain (ISD) |
| 40 | Applications and Supplementary Security Domains |
| 20 | Executable Load Files |
| 10 | ELF and their Executable Modules |

#### GET STATUS P2 values

| Value | Meaning |
|---|---|
| 40 | First/all occurrences, GP TLV format (default) |
| 42 | Next occurrence, GP TLV format |
| 00 | First/all, old format (deprecated) |
| 02 | Next, old format (deprecated) |

#### GET DATA tag values

| Tag | Data Object |
|---|---|
| 42 | Issuer Identification Number (IIN) |
| 45 | Card Image Number (CIN) |
| 66 | Card Data / SD Management Data |
| 67 | Card Capability Information |
| E0 | Key Information Template |
| D3 | Current Security Level |
| 2F00 | List of Applications (ISO 7816-4) |
| FF21 | Extended Card Resources Info |
| 5F50 | SD Manager URL |
| C1 | Sequence Counter (SCP02/03) |
| C2 | Confirmation Counter |
| 7F21 | Certificate (SD public key) |
| 5031 | Certificate info (EF.OD) |

#### DELETE P1 values

| Value | Meaning |
|---|---|
| 00 | By AID |
| 80 | Delete associated objects |

#### STORE DATA P1 values

| Value | Meaning |
|---|---|
| 00 | Last block, no encryption |
| 40 | More blocks, no encryption |
| 80 | Last block, encrypted |
| C0 | More blocks, encrypted |

#### SET STATUS parameters

**P1 (Status Type)**:
| Value | Target |
|---|---|
| 80 | Issuer Security Domain |
| 40 | Application or Supplementary Security Domain |
| 60 | Security Domain and its associated Applications |

**P2 (State)**:
| Value | Action |
|---|---|
| 00 | Unlock (return to previous state) |
| 80 | Lock (LOCKED state) |

#### References

- GlobalPlatform Card Specification v2.3.1 (GPC_Spec_v2.3.1): Commands, Privileges, TLV structures
- ETSI TS 102 226 V13.0.0 §8.2.1.3.2: SIM/UICC Toolkit parameters, MSL, TAR, Access Domain

### Conversion (SIM/USIM sidebars)

Value encoding conversions embedded in the SIM RFM and USIM RFM tabs.

#### IMSI → EF.IMSI

Per TS 31.102 §4.2.3. Encodes a 15-digit IMSI into the 9-byte EF.IMSI format:
- Byte 0: number of subsequent bytes (8)
- Odd/even indicator nibble in the last byte
- BCD digits, swapped nibble pairs per identity

Input: 15 decimal digits. Output: 18 hex characters.

#### MSISDN → BCD

Strips leading `+`, pads odd length with `f`, swaps nibble pairs.

#### ICCID → hex

Swaps nibble pairs of the ICCID string.

#### Provider Name → SPN

Per 3GPP TS 31.102 §4.2.5 (EF_SPN). Three encoding paths:

1. **GSM 7-bit packed** (all chars in GSM 7-bit default alphabet): prefix `01`, DCS byte (spare bits), packed septets, 0xFF padding to 16 bytes.
2. **UCS2 non-BMP** (emoji / chars > U+FFFF): prefix `00`, DCS `80`, UTF-16BE, 0xFF padding to 16 bytes.
3. **UCS2 BMP non-GSM7** (Cyrillic, etc.): prefix `00`, DCS `81`, base byte, per-char offsets, 0xFF padding to 16 bytes.

GSM 7-bit alphabet per 3GPP TS 23.038. Full extension table supported.

#### PLMN → EF_PLMNsel / PLMNwAcT

Per TS 31.102 §4.2.3. 3-byte BCD encoding for PLMN, plus optional 2-byte Access Technology selector.

#### Nibble swap

Swaps nibble pairs of an even-length hex string.

#### References

- 3GPP TS 31.102: Characteristics of the USIM Application
- 3GPP TS 23.038: Alphabets and language information
- ETSI TS 102 225: Secured packet structure for (U)SIM toolkit
- pySim: enc_imsi() implementation

---

## SCP80 tab

The **SCP80** top-level tab groups SCP80-related views, switched by three pills: **Secured Packet**, **Cards**, and **RAM**. Assembles secured packets per ETSI TS 102 225.

### Secured Packet

Builds SCP80 secured packets per ETSI TS 102 225.

#### Packet structure

| Field | Size | Description |
|---|---|---|
| CPI | 1 | Command Packet Identifier (`02`) |
| CPL | 1 | Command Packet Length |
| CHI | 1 | Command Header Identifier (`01`) |
| CHL | 1 | Command Header Length |
| SPI | 2 | Security Parameter Indicator |
| KIc | 1 | Key Identifier for ciphering |
| KID | 1 | Key Identifier for MAC |
| TAR | 3 | Toolkit Application Reference |
| CNTR | 5 | Replay counter |
| PCNTR | 1 | Padding counter |
| RC/CC/DS | 8 | Cryptographic Checksum / MAC |
| Secured Data | variable | Padded APDU (encrypted if required) |

#### SPI1 (Security Level)

SPI1 bit layout (TS 102 225 §5.1.1): `b8–b6` padding, `b5–b4` counter, `b3` ciphering, `b2–b1` RC/CC/DS.

| Value | Security | Ciphering | Counter (b5 b4) |
|---|---|---|---|
| 00 | None | No | 00 none |
| 01 | RC | No | 00 none |
| 02 | CC/MAC | No | 00 none |
| 06 | CC/MAC | Yes | 00 none |
| 0A | CC/MAC | No | 01 available |
| 0E | CC/MAC | Yes | 01 available |
| 12 | CC/MAC | No | 10 higher |
| 16 | CC/MAC | Yes | 10 higher |
| 1A | CC/MAC | No | 11 +1 |
| 1E | CC/MAC | Yes | 11 +1 |

> **AES requires `b5 b4 = 10` (higher) or `11` (+1)** per TS 102 225 §5.1.2 and §5.1.3.1.
> The 3DES values `00/01/02/06` (no counter) remain valid for 3DES only.

#### SPI2 (PoR settings)

| Value | Mode | Security | Cipher |
|---|---|---|---|
| 00 | No PoR | — | No |
| 01 | PoR required | None | No |
| 05 | PoR required | RC | No |
| 09 | PoR required | CC | No |
| 0D | PoR required | DS | No |
| 11 | PoR required | None | Yes |
| 02 | PoR on error | None | No |
| 06 | PoR on error | RC | No |

#### Crypto

- **3DES-CBC** encryption (zero ICV), supporting 8, 16, and 24 byte keys — deprecated since Rel-18, still supported for backwards compatibility
- **AES-CBC** encryption (zero ICV, zero-padded to 16), supporting 16, 24, and 32 byte keys (TS 102 225 §5.1.2, KIc `x2`)
- **Retail MAC** (ISO 9797-1 MAC algorithm 3) for the DES/3DES cryptographic checksum
- **AES-CMAC** (NIST SP 800-38B, truncated to 8 octets) for the AES cryptographic checksum (TS 102 225 §5.1.3.1, KID `x2`)
- Padding byte configurable (`00` per TS 102 225 default, or `FF`)

#### PoR (Proof of Reception)

PoR confirms the card received and executed the secured packet. Two modes:

| SPI2 (bit 5) | Mode | Description |
|---|---|---|
| `0x00` | Delivery PoR | PoR is returned in the ENVELOPE response SW+data |
| `0x20` | Submit PoR | PoR is sent back as an SMS-SUBMIT via a proactive FETCH command |

Delivery PoR (SPI2 `01`) is simpler — the card returns the PoR directly in the ENVELOPE response. Submit PoR (SPI2 `21`) is used when the card cannot respond inline (e.g. during ELF operations where the ENVELOPE response space is limited).

#### References

- ETSI TS 102 225 V18.1.0: Secured packet structure for UICC based applications
- ETSI TS 102 226: Remote APDU structure for UICC based applications
- ISO 9797-1: MAC algorithms
- NIST SP 800-38B: CMAC

### Cards

Stores saved card configurations (presets). Each preset stores the cryptographic keys, SPI settings, TAR, and replay counter needed for SCP80 operations.

| Field | Description |
|---|---|
| SPI1 / SPI2 | Security level and PoR settings |
| KIc / KID key | Encryption and MAC key hex |
| KIc / KID index | Key version number |
| TAR | Toolkit Application Reference (3 bytes) |
| Counter (CNTR) | 10-digit hex replay counter, auto-incremented after each successful SCP80 send |

**Add a card:** fill in the name, SPI1/SPI2, KIc/KID keys and indices, TAR, and click **Add**. The card appears in the list and becomes available in the RAM tab's **Card preset** dropdown.

**Edit a card:** click a card in the list, modify fields, click **Save**.

**Delete a card:** select a card, click **Delete**. Removes the preset from `localStorage`.

**Counter:** the 10-digit hex counter (CNTR) is auto-incremented after each successful SCP80 send (both manual Secured Packet sends and RAM operations). The updated counter is saved back to the preset automatically.

### RAM

All RAM operations are delivered as SCP80 secured packets (ETSI TS 102 225) via SMS-PP-DOWNLOAD ENVELOPE. The card must support SCP03 (AES or 3DES) for secure transport.

Select a saved card configuration from the **Card preset** dropdown. If no preset is selected, the RAM tab warns and refuses to execute.

The RAM subtab offers two operations selected from the **Operation** dropdown:

| Operation | Description |
|---|---|
| **Explore Card (all GP data)** | Queries GET STATUS for ISD, Applications, ELFs, and ELF Modules, plus GET DATA FF21 for memory info. Results appear in an explorer view with per-item **Delete** buttons. |
| **Install Package (.cap file)** | Sends a `.cap` file to the card via the server: INSTALL\[for load\] → LOAD ×N → INSTALL\[for install (+make selectable)\]. |

#### Explorer View

After "Explore Card" runs, the explorer view displays:

- **ISD** — AID, lifecycle, privileges (no delete; the ISD cannot be removed)
- **Applications** — AID, lifecycle, privileges, associated ELF/SD. Each has a **Delete** button (GP `DELETE` by AID).
- **Executable Load Files** — AID, lifecycle, version, module AIDs. Each has **Delete** (ELF only) and **Delete All** (cascade: ELF + modules + installed Applications, P2=0x80) buttons.

Delete confirms via a browser prompt before sending the GP `DELETE` command via SCP80. The explorer auto-refreshes after a successful deletion.

---

## Response parser tab

Decodes a raw command response: pick the command that was sent, enter the SW (e.g. `9000`) and the response data hex, then press **Decode**.

- **Command** — SIM/USIM group (SELECT, STATUS, READ/UPDATE, PIN ops, CAT commands like TERMINAL PROFILE/ENVELOPE/FETCH/TERMINAL RESPONSE, MANAGE CHANNEL, ...) or RAM/GP group (INSTALL, LOAD, DELETE, GET/STORE DATA, auth, SCP commands).
- **SW decode** — status words resolved against generic, UICC (TS 102 221), and GlobalPlatform maps, with context auto-detected.
- **Privilege decode** — GET DATA / INSTALL response payloads decode the privilege bytes into human-readable flags.
- **Response data** — raw hex rendered and interpreted per command (e.g. SELECT FCP templates).

---

## Card Reader (pySim integration)

Connects to the bundled [`pysim-otaman-server`](pysim_otaman_server/) for live card operations.

> **Browser restriction:** when the PWA is served from a public HTTPS host, reaching the local server (`http://127.0.0.1:8080`) requires two things: the server must send `Access-Control-Allow-Private-Network: true` (pysim-otaman-server ≥ 1.6.1 does this automatically), and the browser must be allowed to access the local network — in Chrome/Edge/Vivaldi: Site settings → Local network access → allow the site (or accept the permission prompt). Without the browser permission, the request to `127.0.0.1` is blocked before any preflight is sent.

### File Browser

Browse the UICC filesystem in a tree view. Files are shown with names, FIDs, and AIDs (for ADFs). Click to read contents.

- **Read** — reads the selected file (auto-detects transparent vs record files)
- **Edit** — switch to edit mode, modify hex data, click **Save** to write back
- **Raw / Decoded** — toggle between hex dump and pysim-decoded JSON view

### Custom Files

Files not in pysim's model can be added manually:

1. Switch to the **Custom files** sub-tab
2. Enter the file path (e.g., `3F00/6F46`) and an alias (e.g., `EF.SPN`)
3. Click **Add** — the file appears in the tree in italics (unverified)
4. Click the file to verify existence — on success, it behaves like a model file

Custom files persist in `localStorage` across sessions. Export/import as JSON for sharing.

### Proactive UICC Pill

The **Proactive UICC** sub-tab in the Card Reader provides real-time CAT session interaction:

**Subscribed Events** — the card's SET UP EVENT LIST is displayed with per-event **Send** buttons. Clicking opens a form specific to the event type:

- **No-data events** (User Activity, Idle Screen, etc.) — single-click confirmation
- **Location Status** — dropdown for Normal / Limited / No service
- **Access Technology Change** — dropdown for all 13 RAT types
- **Card Reader Status, Language, UICC Access** — appropriate inputs
- **Network Rejection** — full adaptive form with registration type dropdown
  (LU / GPRS / EPS / 5GS), location fields (MCC, MNC, LAC, RAC, TAC), access
  technology selection, and 53-cause unified rejection cause code dropdown
  covering EMM, GMM, 5GMM, and LU causes

**Proactive Command Log** — chronological list of proactive commands encountered (seconds elapsed, type code, name, byte count). Covers SET UP MENU, SET UP EVENT LIST, POLL INTERVAL, DISPLAY TEXT, SELECT ITEM, and PROVIDE LOCAL INFORMATION.

**PLI Data Dictionary** — editable per-qualifier hex values for all 22 PROVIDE LOCAL INFORMATION qualifiers (TS 102 223 + TS 131 111). 10 qualifiers have inline decode/encode forms (toggle):

| Code | Decoded fields |
|------|--------------|
| 00 | MCC, MNC, LAC/TAC |
| 01 | IMEI (15 digits) |
| 03 | Date, Time, TZ offset |
| 04 | Language (2-char code) |
| 05 | ME Status, Timing Advance |
| 06 | Access Technology (dropdown) |
| 08 | IMEISV (16 digits) |
| 09 | Search Mode (Auto/Manual) |
| 0A | Battery charge (%) |
| 0E | Multiple Access Technologies (comma-list) |

Values persist on the server until restart. Apply → hex updates; Save → POSTs to server. The server will use these values to populate TERMINAL RESPONSE data for future PLI proactive commands.

### Command Hints

Type a command name in the **pySim command line** input. Usage hints appear as a tooltip after 300ms. Command autocomplete suggestions appear above the input.

---

## PWA

OTAMan is a Progressive Web App and can be installed for offline use. Use the **INSTALL PWA** button in the header, or use the browser's install prompt.

- Service worker pre-caches all assets on first visit
- App icons at 192×192 and 512×512

## Server (pysim-otaman-server)

The bundled Python server wraps [pySim](https://osmocom.org/projects/pysim/wiki) and serves both the OTAMan PWA (from `frontend/`) and a JSON API under `/api/*`.

### Prerequisites

- **Python 3.8+** with `pip`, and **Git**
- **Smart card reader** (PC/SC or serial/FTDI) — PC/SC is preferable (`pcsc-lite` + `ccid` on Linux)
- **Windows** — use Python 3.10–3.13 (3.13 recommended): `pyscard` ships precompiled wheels for these versions. On 3.9 / 3.14 it builds from source (needs MSVC C++ Build Tools). The SMPP bridge (`smpp.twisted3`) is intentionally skipped on Windows.

### Scripts

| Script | What it does |
|--------|-------------|
| `setup.sh` / `setup.bat` | Creates `.venv/`, installs pysim and the server. Run once after cloning. |
| `start.sh` / `start.bat` | Starts the server from the venv (serves the PWA + API on `:8080`). |

`start.sh` auto-detects the reader (PC/SC if `pcscd` is running, else `/dev/ttyUSB0`); `start.bat` always uses `-p 0` (PC/SC is built into Windows). If no reader is found the server still starts ("Reader: none") — initialize the card later via the **Equip** button.

### Manual installation

```sh
python3 -m venv .venv
source .venv/bin/activate          # Linux/macOS   (Windows: .venv\Scripts\activate)
pip install git+https://github.com/osmocom/pysim.git
pip install -e .                   # editable — serves frontend/ from the source tree
pysim-otaman-server --http-port 8080
```

### CLI options

| Option | Description |
|--------|-------------|
| `--http-host` | Bind address (default: `127.0.0.1`) |
| `--http-port` | TCP port (default: `8080`) |
| `--web-dir` | Directory with PWA static files (default: `<repo>/frontend`) |
| `-p` / `--pcsc-device` | PC/SC reader slot number |
| `-d` / `--device` | Serial device path |
| `--no-card-init` | Skip card init to preserve the CAT session (no file manager) |
| `--apdu-trace` | Log APDU-level traces to stderr |
| `--log-requests` | Log request/response payloads to stderr |
| `--sms-oa` / `--sms-sm-sc` | SMS-DELIVER originating address / SM-SC for PoR-in-submit |
| `--terminal-profile` | TERMINAL PROFILE payload hex (default 10-byte GSM profile) |
| `--poll-interval` | Idle interval before automatic STATUS polling (default 30s) |

### Troubleshooting

- **"Failed to establish context: Access denied"** — `pcscd` isn't running or the user lacks permission: `sudo systemctl enable --now pcscd && sudo usermod -a -G pcscd $USER`.
- **"device file /dev/ttyUSB0 does not exist"** — no serial reader; connect a USB reader or pass `-d` explicitly. The server still starts without a reader.

### API reference

See [docs/api.md](docs/api.md) for the full endpoint reference.

## Theme

Dark theme is supported. The app follows the OS preference on first visit, and a manual toggle button (🌙/☀️) at the top-right corner persists the choice in `localStorage`.

## Localisation

The UI is in English with Russian language support. Language is detected from the browser's `navigator.language` preference. A manual toggle button (EN/RU) in the header persists the choice in `localStorage`.

## Version compatibility

| PWA (OTAMan) | Server | Status |
|-------------|--------|--------|
| 1.x.x | 1.x.x | ✅ Compatible |
| 1.x.x | 0.x.x | ❌ Outdated — update server |
| 1.x.x | 2.x.x+ | ⚠️ Server newer — update PWA |

The PWA checks the server version on connect via `GET /api/version` and warns if versions are incompatible.
