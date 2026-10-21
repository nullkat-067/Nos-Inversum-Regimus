# Nos-Inversum-Regimus

A NullKat Development WhatsApp group administration sentinel built around the Claude-provided working `index.js` implementation.

## Features

- Pairing-code authentication through Baileys.
- Colored tactical terminal interface.
- Group target registration with `!add target`, `!remove target`, `!list targets`, and `!target info`.
- Group administration audit and membership reporting.
- Group rename and lock/unlock workflows with confirmation.
- Administrator audit and combined operation menu.
- Optional group profile-picture update from `data/pp.jpg`.
- Controlled messaging and group lock/unlock workflows.
- Atomic target storage and audit logging.
- Session recovery and connection status reporting.

## Requirements

- Node.js 20 or newer.
- A WhatsApp account that can link a companion device.
- Linux or Termux with network access.

## Installation

```bash
git clone https://github.com/<your-account>/Nos-Inversum-Regimus.git
cd Nos-Inversum-Regimus
npm install
npm run check
npm start
```

## Pairing code

Choose menu option `7` and enter the full international phone number using digits only. For example:

```text
6285706912983
```

When the pairing code appears, open WhatsApp and select:

```text
Settings → Linked Devices → Link a Device → Link with phone number instead
```

Enter the displayed code. The application considers authentication complete only after it receives the `open` connection event.

If a previous session is broken, stop the application and remove only the local session files:

```bash
rm -rf sessions/*
npm start
```

Never commit or share the `sessions/` directory.

## Group target registration

The bot must be a group administrator. A group administrator can send:

```text
!add target
!remove target
!list targets
!target info
```

Only registered groups appear in the terminal target selector.

## Menu

```text
[1] GROUP ADMIN AUDIT
[2] MEMBER MANAGEMENT
[3] SWITCH GROUP NAME
[4] LOCK / UNLOCK GROUP
[5] ADMIN MANAGEMENT AUDIT
[6] FULL SECURITY AUDIT
[7] PAIRING CODE
[8] CREDITS
[9] DEMOTE ALL ADMINS
[10] SPAM LOCK / UNLOCK GROUP
[11] COMBINE OPERATIONS
[12] SET GROUP PROFILE PICTURE
[13] SPAM MESSAGE
[0] EXIT
```

Use destructive operations only on groups you own or administer. The application requires explicit confirmation for sensitive actions and records relevant outcomes in `data/audit.log`.

## Project layout

```text
Nos-Inversum-Regimus/
├── index.js
├── package.json
├── package-lock.json
├── README.md
├── .gitignore
├── config/
│   ├── config.json
│   └── permissions.json
├── data/
│   └── targets.json
└── sessions/
    └── .gitkeep
```

## Notes

Baileys is an unofficial WhatsApp Web integration library. WhatsApp protocol changes, account limits, device-linking restrictions, or rate limits can affect pairing and group operations. The bot reports API failures instead of claiming success.
