# OTAMan — APDU Helper & Secured Packet Builder, SIM OTA в PWA

Автономный offline-инструмент на HTML/JS для создания APDU-команд для SIM, USIM и GlobalPlatform RAM, сборки защищённых пакетов по ETSI TS 102 225 и построения BER-TLV скриптов по ETSI TS 102 226.

Откройте `index.html` в любом современном браузере. Сервер не требуется.

**Демо:** [otaman.atroshin.ru](https://otaman.atroshin.ru)

## Сборка

Для стилей используется Tailwind CSS. После клонирования пересоберите CSS:

```sh
npm install
npm run build
```

## Интерфейс

Шесть вкладок, каждая с формой и кнопкой «Generate APDU».

---

## Вкладка SIM RFM

CLA = `A0` (GSM 11.11 / ISO 7816-4).

### Команды

| Команда | INS | Описание |
|---|---|---|
| SELECT | A4 | Выбор EF/DF по FID, пути, dfname или цепочке |
| UPDATE RECORD | DC | Обновление записи |
| UPDATE BINARY | D6 | Обновление бинарных данных |
| READ RECORD | B2 | Чтение записи |
| READ BINARY | B0 | Чтение бинарных данных |
| ERASE BINARY | 0E | Стирание бинарных данных |
| ACTIVATE FILE | 44 | Активация файла |
| DEACTIVATE FILE | 04 | Деактивация файла |
| VERIFY PIN | 20 | Проверка PIN1 или PIN2 |
| CHANGE PIN | 24 | Смена PIN1 или PIN2 |

### Методы SELECT

| Метод | P1 | P2 | Ввод |
|---|---|---|---|
| By FID | 00 | 00 | FID (4 hex) |
| By full path from MF | 08 | 00 | Полный путь от MF |
| By DF name / AID | 04 | 00 | AID |
| ADF RFM chain | 00 | 00 | FID через запятую |

### Опции

- **Start with SELECT** — добавить SELECT перед командой.
- **Selection mode (P2)** — для record-команд: Absolute (04), Next (06), Previous (02).
- **Record size** — дополнить/обрезать данные до указанного размера.
- **Allow P1/P2 editing** — ручное редактирование P1/P2.

### Боковая панель конвертации

Поддерживает IMSI, MSISDN, ICCID, SPN, PLMN, Nibble swap.

### Ссылки

- ISO/IEC 7816-4: Organization, security and commands for interchange
- ETSI TS 102 226: Remote APDU structure for UICC based applications
- GSM 11.11: SIM-ME Interface

---

## Вкладка USIM RFM

CLA = `00` (ETSI TS 102 221). Те же команды, что и SIM, но SELECT использует P1=09, P2=0C.

### Ссылки

- ETSI TS 102 221: UICC-Terminal Interface
- ETSI TS 102 226: Remote APDU structure

---

## Вкладка BER-TLV

Построение Expanded Remote Application data format по ETSI TS 102 226 §5.2.1.

### Формат

- **Definite (AA)**: `AA` + длина + Command TLV
- **Indefinite (AE)**: `AE` + `80` + Command TLV + `00 00`

### Command TLV

| Тип | Тег | Описание |
|---|---|---|
| C-APDU | 22 | APDU |
| Immediate Action | 81 | Proactive-команда или action indicator |
| Error Action | 82 | Proactive-команда при ошибке |
| Script Chaining | 83 | Данные для многопакетных скриптов |

### Сборщик Immediate Action

- **Action indicator**: `81` / `82`
- **Proactive command**: REFRESH, DISPLAY TEXT, PLAY TONE
- **Custom hex**: ручной ввод

### Ссылки

- ETSI TS 102 226 §5.2.1
- ETSI TS 102 223: Card Application Toolkit
- ETSI TS 101 220: BER-TLV tag assignments

---

## Вкладка RAM

CLA = `80` (GlobalPlatform v2.3.1). Команды удалённого управления приложениями.

### Команды

| Команда | INS | P1 | Описание |
|---|---|---|---|
| INSTALL [for load] | E6 | 02 | Регистрация загружаемого файла |
| INSTALL [for install] | E6 | 0C | Установка приложения или SD |
| INSTALL [for make selectable] | E6 | 10 | Сделать приложение выбираемым |
| INSTALL [for registry update] | E6 | 01 | Обновление реестра |
| INSTALL [for extradition] | E6 | 04 | Перемещение между SD |
| LOAD | E8 | 00 | Загрузка кода |
| DELETE | E4 | 00/80 | Удаление приложения или SD |
| GET STATUS | F2 | 80/40/20/10 | Статус карты |
| GET DATA | CA | tag | Чтение объектов данных |
| STORE DATA | E2 | 00/40/80/C0 | Запись данных |
| SET STATUS | F0 | 80/40/60 | Управление жизненным циклом |
| EXTERNAL AUTHENTICATE | 82 | 00 | Аутентификация SCP |
| INTERNAL AUTHENTICATE | 88 | 00 | Challenge-response |

### Привилегии (INSTALL)

Три байта привилегий по GP Spec Tables 11-7, 11-8, 11-9.

**Байт 1:**
| Бит | Привилегия |
|---|---|
| b8 | Security Domain |
| b7 | DAP Verification |
| b6 | Delegated Management |
| b5 | Card Lock |
| b4 | Card Terminate |
| b3 | Card Reset |
| b2 | CVM Management |

**Байт 2:**
| Бит | Привилегия |
|---|---|
| b8 | Trusted Path |
| b7 | Authorized Management |
| b6 | Token Verification |
| b5 | Global Delete |
| b4 | Global Lock |
| b3 | Global Registry |
| b2 | Final Application |

**Байт 3:**
| Бит | Привилегия |
|---|---|
| b8 | Receipt Generation |

### Параметры SIM/UICC Toolkit

- **Tag `CA`** (SIM Toolkit): Priority, Timers, Text Length, Menu Entries, Positions, Channels, MSL, TAR, Access Domain
- **Tag `80`** (UICC Toolkit, внутри `EA`): те же поля без Access Domain

**MSL (Minimum Security Level):**
| Значение | Описание |
|---|---|
| 00 | Нет проверки |
| 11 | RC/CC/DS |
| 12 | RC/DS/CC |
| 15 | RC/DS/CC + MAC |
| 16 | RC/DS/CC + MAC + Cipher |
| 19 | RC/DS/CC + MAC + Cipher + DS |

### GET STATUS P1

| Значение | Описание |
|---|---|
| 80 | Issuer Security Domain (ISD) |
| 40 | Applications и SSD |
| 20 | Executable Load Files |
| 10 | ELF и модули |

### GET STATUS P2

| Значение | Описание |
|---|---|
| 40 | Первые/все, GP TLV (по умолчанию) |
| 42 | Следующие, GP TLV |
| 00 | Первые/все, старый формат (deprecated) |
| 02 | Следующие, старый формат (deprecated) |

### GET DATA теги

| Тег | Объект данных |
|---|---|
| 42 | Issuer Identification Number (IIN) |
| 45 | Card Image Number (CIN) |
| 66 | Card Data / SD Management Data |
| 67 | Card Capability Information |
| E0 | Key Information Template |
| D3 | Current Security Level |
| 2F00 | List of Applications |
| FF21 | Extended Card Resources Info |
| 5F50 | SD Manager URL |
| C1 | Sequence Counter (SCP02/03) |
| C2 | Confirmation Counter |
| 7F21 | Certificate (SD public key) |
| 5031 | Certificate info (EF.OD) |

### DELETE P1

| Значение | Описание |
|---|---|
| 00 | Только AID |
| 80 | AID и связанные объекты |

### STORE DATA P1

| Значение | Описание |
|---|---|
| 00 | Последний блок, без шифрования |
| 40 | Ещё блоки, без шифрования |
| 80 | Последний блок, с шифрованием |
| C0 | Ещё блоки, с шифрованием |

### SET STATUS

**P1:** 80 = ISD, 40 = Приложение или SSD, 60 = SD и его приложения

**P2:** 00 = Разблокировать, 80 = Заблокировать (LOCKED)

### Ссылки

- GlobalPlatform Card Specification v2.3.1
- ETSI TS 102 226 §8.2.1.3.2: Параметры SIM/UICC Toolkit

---

## Вкладка Secured Packet

Сборка защищённых пакетов по ETSI TS 102 225.

### Структура пакета

| Поле | Размер | Описание |
|---|---|---|
| CPI | 1 | Command Packet Identifier (`02`) |
| CPL | 1 | Command Packet Length |
| CHI | 1 | Command Header Identifier (`01`) |
| CHL | 1 | Command Header Length |
| SPI | 2 | Security Parameter Indicator |
| KIc | 1 | Key Identifier для шифрования |
| KID | 1 | Key Identifier для MAC |
| TAR | 3 | Toolkit Application Reference |
| CNTR | 5 | Счётчик повторов |
| PCNTR | 1 | Padding counter |
| RC/CC/DS | 8 | Контрольная сумма / MAC |
| Secured Data | переменная | APDU (с шифрованием при необходимости) |

### SPI1 (Уровень безопасности)

Битовое поле SPI1 (TS 102 225 §5.1.1): `b8–b6` — паддинг, `b5–b4` — счётчик, `b3` — шифрование, `b2–b1` — RC/CC/DS.

| Значение | Безопасность | Шифрование | Счётчик (b5 b4) |
|---|---|---|---|
| 00 | Нет | Нет | 00 нет |
| 01 | RC | Нет | 00 нет |
| 02 | CC/MAC | Нет | 00 нет |
| 06 | CC/MAC | Да | 00 нет |
| 0A | CC/MAC | Нет | 01 available |
| 0E | CC/MAC | Да | 01 available |
| 12 | CC/MAC | Нет | 10 higher |
| 16 | CC/MAC | Да | 10 higher |
| 1A | CC/MAC | Нет | 11 +1 |
| 1E | CC/MAC | Да | 11 +1 |

> **AES требует `b5 b4 = 10` (higher) или `11` (+1)** согласно TS 102 225 §5.1.2 и §5.1.3.1.
> Значения `00/01/02/06` (без счётчика) допустимы только для 3DES.

### SPI2 (PoR)

| Значение | Режим |
|---|---|
| 00 | No PoR |
| 01 | PoR required, no security |
| 05 | PoR required, RC |
| 09 | PoR required, CC |
| 0D | PoR required, DS |
| 11 | PoR required, ciphered |
| 02 | PoR on error, no security |
| 06 | PoR on error, RC |

### Крипто

- **3DES-CBC** шифрование, ключи 8/16/24 байт — устарело с Rel-18, но поддерживается для обратной совместимости
- **AES-CBC** шифрование (нулевой ICV, дополнение нулями до 16), ключи 16/24/32 байта (TS 102 225 §5.1.2, KIc `x2`)
- **Retail MAC** (ISO 9797-1 MAC algorithm 3) для DES/3DES
- **AES-CMAC** (NIST SP 800-38B, усечённый до 8 октетов) для AES (TS 102 225 §5.1.3.1, KID `x2`)
- Padding byte: `00` (по умолчанию) или `FF`

### Ссылки

- ETSI TS 102 225 V18.1.0
- ETSI TS 102 226
- ISO 9797-1
- NIST SP 800-38B (CMAC)

---

## Конвертация (боковые панели SIM/USIM)

### IMSI → EF.IMSI

15-значный IMSI → 9 байт EF.IMSI.

### MSISDN → BCD

Удаление `+`, добавление `f`, обмен полубайтов.

### ICCID → hex

Обмен полубайтов строки ICCID.

### Provider Name → SPN

По 3GPP TS 31.102 §4.2.5. Три варианта кодирования:
1. GSM 7-bit packed
2. UCS2 non-BMP
3. UCS2 BMP non-GSM7

### PLMN → EF_PLMNsel / PLMNwAcT

3-байтное BCD-кодирование + опциональный Access Technology.

### Nibble swap

Обмен полубайтов hex-строки.

### Ссылки

- 3GPP TS 31.102
- 3GPP TS 23.038
- ETSI TS 102 225
- pySim: enc_imsi()

---

## PWA

OTAMan — Progressive Web App. Можно установить для offline-использования через кнопку **INSTALL PWA** или через браузер.

- Service worker кеширует все ресурсы при первом посещении
- Иконки 192×192 и 512×512

## Тема

Тёмная тема поддерживается. Следует системной теме, переключается вручную кнопкой (🌙/☀️). Выбор сохраняется в `localStorage`.

## Локализация

Интерфейс на английском с поддержкой русского языка. Язык определяется из `navigator.language`. Кнопка переключения (EN/RU) в заголовке сохраняет выбор в `localStorage`.

## Совместимость версий

| PWA (OTAMan) | Сервер | Статус |
|---|---|---|
| 1.x.x | 1.x.x | ✅ Совместимы |
| 1.x.x | 0.x.x | ❌ Сервер устарел |
| 1.x.x | 2.x.x+ | ⚠️ Сервер новее — обновите PWA |

PWA проверяет версию сервера при подключении через `GET /api/version`.

---

## Card Reader (интеграция с pySim)

Подключение к локальному [pysim-otaman-server](https://github.com/anttro/pysim-otaman-server) для работы с картой.

### Файловый менеджер

Дерево файлов UICC. Отображаются имена, FID и AID (для ADF). Клик для чтения содержимого.

- **Read** — чтение файла (автоопределение transparent/record)
- **Edit** — режим редактирования, измените hex-данные и нажмите **Save** для записи
- **Raw / Decoded** — переключение между hex-дампом и декодированным JSON

### Пользовательские файлы

Файлы, отсутствующие в модели pysim, можно добавить вручную:

1. Перейдите на вкладку **Custom files**
2. Введите путь (например, `3F00/6F46`) и псевдоним (например, `EF.SPN`)
3. Нажмите **Add** — файл появится в дереве курсивом (непроверенный)
4. Кликните для проверки существования — при успехе работает как обычный файл

Пользовательские файлы сохраняются в `localStorage`. Экспорт/импорт в JSON для обмена.

### Подсказки команд

Введите имя команды в **pySim command line**. Подсказки по использованию появляются через 300 мс. Автодополнение команд — над полем ввода.