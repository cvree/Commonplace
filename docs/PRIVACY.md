# Keeping your messages private

## What Commonplace already does

- **Owner only.** Commands from anyone but `DISCORD_OWNER_ID` are refused, and messages from any server other than `DISCORD_GUILD_ID` are ignored.
- **Allow-list.** A channel is not read, stored or searchable until you allow it with `/archive scope`. Scope is rechecked on every search, so excluding a channel hides it immediately.
- **Private replies.** Slash-command replies are ephemeral: only you see them.
- **Sensitive channels.** Channels marked sensitive never appear in public (@mention) replies unless you ask inside that channel.
- **Deletions are honoured.** Delete a message in Discord and the stored text, its earlier versions and its attachment records are wiped. `/archive forget` removes a whole channel from the index.
- **No pings.** The bot cannot mention anyone, even when quoting text that contains `@everyone`.
- **Saved text is data.** Nothing in a stored message can make the bot act; only your commands do.
- **No cloud AI.** No message text is sent to any AI service in this version. When AI is added it will be off until you turn it on, and sensitive channels will stay local unless you opt in separately.
- **Minimal permissions.** The bot cannot edit or delete your messages, manage channels, or see channels you have not shown it.

## What you need to do

1. **Keep the server private.** Be the only member (plus the bot), and delete any invite links: Server Settings → Invites.
2. **Turn "Public Bot" off** in the Developer Portal so nobody else can add your bot to another server.
3. **Protect the token.** It lives only in `.env`. Never paste it into Discord, a chat, or a screenshot. If it leaks, press Reset Token in the Developer Portal and update `.env`.
4. **Protect the machine the bot runs on.** The database holds a readable copy of everything indexed. Use full-disk encryption (BitLocker, FileVault, LUKS) and a login password. On a rented server, use SSH keys and keep it updated. The provided Docker setup does not expose the database to the network; keep it that way.
5. **Protect backups.** Backup files are plain text. Store them on an encrypted disk or encrypt them before uploading anywhere.
6. **Keep sensitive channels out, or marked.** If you would rather the bot never held something, do not allow that channel at all.

## Limits worth knowing

- **Discord itself is not end-to-end encrypted.** Your messages are stored on Discord's servers and are accessible to Discord. Commonplace does not change that; it adds one more copy, on a machine you control.
- **Link previews** in your messages are fetched by Discord, not by the bot.
- **Hosting for other people** means you can read their archive. Until per-user authorization exists, friends should run their own copy.
