# pysim-otaman-server — HTTP API reference

The server exposes a JSON HTTP API under `/api/*`. All responses carry
`Access-Control-Allow-Origin: *` (plus `Access-Control-Allow-Private-Network: true`
on the preflight), so the API is reachable from a separately-hosted PWA.

## Version compatibility

| Server | PWA (OTAMan) | Status |
|--------|-------------|--------|
| 1.x.x | 1.x.x | ✅ Compatible |
| 0.x.x | 1.x.x | ❌ Outdated — update server |
| 2.x.x+ | 1.x.x | ⚠️ Server newer — update PWA |

The server reports its version via `GET /api/version`. The PWA checks this on
connect and warns if versions are incompatible.

## Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/version` | GET | Server version string |
| `/api/status` | GET | Card reader + card info + current selection |
| `/api/command` | POST | pySim command (equip, status, tree, etc.) |
| `/api/commands` | GET | List available pySim commands |
| `/api/tree` | POST | File tree browser for given FID/name |
| `/api/select` | POST | Select a file by name or FID |
| `/api/read` | POST | Read file content |
| `/api/write` | POST | Write raw hex data to a file |
| `/api/apdu` | POST | Raw APDU send |
| `/api/help` | POST | pySim help for a given command |
| `/api/send-ota` | POST | SCP80 OTA secured packet delivery |
| `/api/sp-verify` | POST | Verify secured packet against pySim reference |
| `/api/menu` | GET | Current STK menu (title + items + active) |
| `/api/menu-select` | POST | ENVELOPE(Menu Selection) with item_id |
| `/api/menu-respond` | POST | TERMINAL RESPONSE for paused STK command |
| `/api/stk-status` | GET | STK session state (active/pending/type) |
| `/api/events` | GET | Event list from SET UP EVENT LIST |
| `/api/event-send` | POST | Send ENVELOPE(Event Download) |
| `/api/proactive-log` | GET | Last 50 proactive commands |
| `/api/status-poll` | POST | Manual STATUS poll + FETCH if 91XX |
| `/api/rescue` | POST | Re-send TERMINAL PROFILE to recover CAT session |
| `/api/poll-status` | GET | Background STATUS polling state |
| `/api/poll-toggle` | POST | Enable/disable background polling |
| `/api/pli-qualifiers` | GET | List of qualifier codes with descriptions |
| `/api/pli-dict` | GET | Current dictionary (hex values per qualifier) |
| `/api/pli-dict` | POST | Update dictionary entries |

## Endpoint details

### `GET /api/version`

Returns server version for compatibility checking.

**Example response:**
```json
{"version": "1.8.1"}
```

### `GET /api/status`

Card reader, card type, current selection, and card state.

### `GET /api/commands`

List all available shell commands for the current card profile.

### `POST /api/command`

Execute any pysim-shell command.

```json
{"cmd": "select MF"}
```

Returns:

```json
{"output": "..."}
```

### `POST /api/apdu`

Send a raw APDU to the card.

```json
{"apdu": "00A4040000..."}
```

Returns:

```json
{"response": "...", "sw": "9000"}
```

### `POST /api/help`

Get structured help for a shell command.

```json
{"cmd": "apdu"}
```

Returns:
```json
{"usage": "apdu [-h] [--expect-sw EXPECT_SW] [--raw] APDU", "description": "...", "args": [{"name": "APDU", "type": "positional", "help": "..."}]}
```

### `POST /api/send-ota`

Send an OTA command (SCP80) to the card via SMS-PP-DOWNLOAD ENVELOPE.
The secured packet is delivered in an SMS-DELIVER TPDU wrapped in an ENVELOPE command.

**Request body:**
```json
{
  "sp": "00201516011515b00000...",
  "spi1": "16",
  "spi2": "01",
  "kic": "15",
  "kid": "15",
  "tar": "b00000",
  "cntr": "0000000001",
  "kicKey": "D6FCC023...",
  "kidKey": "1B07E7E0..."
}
```

**Response (delivery PoR):**
```json
{"success": true, "sw": "9000", "response_data": "027100000e0a...",
 "por": {"response_status": "por_ok", "tar": "B00000", "pcntr": 0,
         "decoded": {"number_of_commands": 1, "last_status_word": "6e00",
                      "last_response_data": ""}}}
```

**Response (submit PoR):** PoR is extracted from the SMS-SUBMIT TPDU
fetched via a proactive command (FETCH). The response contains the
same `por` structure if decoding succeeds.

The SPI2 `por_in_submit` bit (0x20) selects submit-mode PoR.

### `POST /api/sp-verify`

Cross-check a secured packet against pySim's `OtaDialectSms.encode_cmd`
reference. Returns the JS-generated packet, pySim reference, a match flag,
and the decoded SPI fields.

```json
{"spi1": "16", "spi2": "01", "kic": "15", "kid": "15", "tar": "b00000",
 "cntr": "0000000001", "apdu": "00a40000023f00",
 "kicKey": "D6FCC023...", "kidKey": "1B07E7E0..."}
```

**Response:**
```json
{"js_sp": "...", "py_sp": "...", "match": true,
 "diffs": [], "spi": {"counter": "counter_must_be_higher", ...}}
```

### `GET /api/menu`

Returns the SIM Toolkit SETUP MENU captured from the card's TERMINAL PROFILE
response at startup. Empty `{"items": []}` if the card didn't send a menu.

**Response:**
```json
{"command_number": 1, "items": [{"id": 128, "text": "Настройки/Settings"}],
 "title": "Alfa Mobile", "active": false}
```

### `POST /api/menu-select`

Sends an `ENVELOPE(MENU SELECTION)` with the selected item ID, then handles
the card's proactive response (DISPLAY TEXT or SELECT ITEM).

```json
{"item_id": 128}
```

**Response:**
```json
{"type": "display_text", "text": "Hello", "sw": "9122"}
```
or
```json
{"type": "select_item", "items": [{"id": 1, "text": "Sub-menu"}], "sw": "9122"}
```

### `POST /api/menu-respond`

Sends `TERMINAL RESPONSE` to the current proactive command with the given result
code. Continues the proactive chain if the card responds with `91XX`.

```json
{"result": "ok", "item_id": 1}
```

| `result` | TERMINAL RESPONSE code | Meaning |
|---|---|---|
| `ok` | `0x00` | Command performed successfully |
| `back` | `0x12` | Backward move requested |
| `cancel` | `0x10` | Proactive session terminated |
| `timeout` | `0x11` | No response from user |

### `GET /api/stk-status`

Returns the current STK session state.
```json
{"active": true, "pending": true, "pending_type": "select_item"}
```

### `POST /api/read`

Read file content. Auto-detects transparent vs record files.

```json
{"name": "EF.ICCID", "fid": "2FE2", "parent_sel": "3F00", "mode": "raw"}
```

Returns:
```json
{"success": true, "sw": "9000", "file_type": "transparent", "data": "..."}
```

### `POST /api/write`

Write raw hex data to a file.

```json
{"name": "EF.ICCID", "fid": "2FE2", "data": "A0A1A2...", "parent_sel": "3F00"}
```

For record files:
```json
{"name": "EF.ADN", "fid": "6F3A", "data": "A0A1...", "record_nr": 1, "parent_sel": "7F10"}
```

Returns:
```json
{"success": true, "sw": "9000"}
```

### `POST /api/select`

Select a file by name or FID, with optional parent selection.

```json
{"name": "EF.ICCID", "fid": "2FE2", "parent_sel": "3F00"}
```

Returns:
```json
{"name": "EF.ICCID", "fid": "2FE2", "file_type": "transparent", "exists": true}
```

### `POST /api/tree`

Get directory listing with typed children.

```json
{"name": "MF", "fid": "3F00"}
```

Returns:
```json
{"exists": true, "name": "MF", "fid": "3F00", "file_type": "df", "children": [{"name": "EF.ICCID", "fid": "2fe2", "isDir": false}]}
```
