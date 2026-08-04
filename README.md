# Otaman — APDU Helper

Standalone offline HTML/JS tool for building APDU commands for SIM, USIM, and GlobalPlatform RAM, plus encoding conversions.

Open `index.html` in any modern browser. No server required.

## Interface

Four tabs, each with a form and a "Сгенерировать" button. The output textarea contains the bare APDU hex string (no SPI/KIC/KID/TAR header).

---

## SIM Tab

CLA = `A0` (GSM 11.11 / ISO 7816-4).

### Commands

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

### SELECT methods

| Method | P1 | P2 | Input |
|---|---|---|---|
| По FID | 00 | 00 | 2-byte FID (4 hex) |
| По полному пути от MF | 08 | 00 | Full path hex from MF |
| По DF name / AID | 04 | 00 | AID (application ID) |
| ADF RFM цепочка | 00 | 00 | Comma-separated FIDs, each selected in turn |

### Options

- **Начать с SELECT** — checkbox to prepend a SELECT command before the operation. When unchecked, the operation is sent standalone with CLA.
- **Режим выборки (P2)** — for record commands: Absolute (04), Next (06), Previous (02).
- **Размер записи** — pad/truncate data to the specified byte count.
- **Переопределить P1/P2** — checkbox to enable manual override of P1/P2 bytes.

### References

- ISO/IEC 7816-4: Organization, security and commands for interchange
- ETSI TS 102 226: Remote APDU structure for UICC based applications
- GSM 11.11: SIM-ME Interface

---

## USIM Tab

CLA = `00` (ETSI TS 102 221). Same commands as SIM, but SELECT uses P1=09, P2=0C (by FID from current directory).

### References

- ETSI TS 102 221: UICC-Terminal Interface; Physical and Logical Characteristics
- ETSI TS 102 226: Remote APDU structure for UICC based applications

---

## RAM Tab

CLA = `80` (GlobalPlatform Card Specification v2.3.1). Remote Application Management commands for card content management.

### Commands

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

### INSTALL [for install] — Privilege Builder

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

### INSTALL [for install] — SIM/UICC Toolkit Parameters

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

### GET STATUS P1 values

| Value | Meaning |
|---|---|
| 80 | Issuer Security Domain (ISD) |
| 40 | Applications and Supplementary Security Domains |
| 20 | Executable Load Files |
| 10 | ELF and their Executable Modules |

### DELETE P1 values

| Value | Meaning |
|---|---|
| 00 | By AID |
| 80 | Delete associated objects |

### STORE DATA P1 values

| Value | Meaning |
|---|---|
| 00 | Last block, no encryption |
| 40 | More blocks, no encryption |
| 80 | Last block, encrypted |
| C0 | More blocks, encrypted |

### SET STATUS parameters

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

### References

- GlobalPlatform Card Specification v2.3.1 (GPC_Spec_v2.3.1): Commands, Privileges, TLV structures
- ETSI TS 102 226 V13.0.0 §8.2.1.3.2: SIM/UICC Toolkit parameters, MSL, TAR, Access Domain

---

## Конвертация Tab

Value encoding conversions.

### IMSI → EF.IMSI

Per TS 31.102 §4.2.3. Encodes a 15-digit IMSI into the 9-byte EF.IMSI format:
- Byte 0: number of subsequent bytes (8)
- Odd/even indicator nibble in the last byte
- BCD digits, swapped nibble pairs per identity

Input: 15 decimal digits. Output: 18 hex characters.

### MSISDN → BCD

Strips leading `+`, pads odd length with `f`, swaps nibble pairs.

### ICCID → hex

Swaps nibble pairs of the ICCID string.

### Provider Name → SPN

Per 3GPP TS 31.102 §4.2.5 (EF_SPN). Three encoding paths:

1. **GSM 7-bit packed** (all chars in GSM 7-bit default alphabet): prefix `01`, DCS byte (spare bits), packed septets, 0xFF padding to 16 bytes.
2. **UCS2 non-BMP** (emoji / chars > U+FFFF): prefix `00`, DCS `80`, UTF-16BE, 0xFF padding to 16 bytes.
3. **UCS2 BMP non-GSM7** (Cyrillic, etc.): prefix `00`, DCS `81`, base byte, per-char offsets, 0xFF padding to 16 bytes.

GSM 7-bit alphabet per 3GPP TS 23.038. Full extension table supported.

### PLMN → EF_PLMNsel

Per TS 31.102 §4.2.3 (EF_PLMNsel). 3-byte BCD encoding:
- Byte 1: MCC digit 2 | MCC digit 1
- Byte 2: MNC digit 3 | MCC digit 3
- Byte 3: MNC digit 2 | MNC digit 1

Input: MCC (3 digits), MNC (2-3 digits). Output: 6 hex characters.

### PLMNwAcT → EF_PLMNwAcT

Per TS 31.102. Same 3-byte PLMN + 2-byte Access Technology selector.

**AcT values**:
| Value | Technologies |
|---|---|
| 8000 | GSM |
| 4000 | UTRAN |
| 2000 | E-UTRAN |
| 1000 | NGRAN |
| C000 | GSM + UTRAN |
| 6000 | UTRAN + E-UTRAN |
| E000 | GSM + UTRAN + E-UTRAN |
| F000 | All |

### References

- 3GPP TS 31.102: Characteristics of the USIM Application
- 3GPP TS 23.038: Alphabets and language information
- ETSI TS 102 225: Secured packet structure for (U)SIM toolkit
- pySim: enc_imsi() implementation