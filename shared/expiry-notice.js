export const EXPIRY_NOTICE_ADDON_ID = 'org.aiomanager.membership'
export const defaultExpiryNotice = Object.freeze({
  enabled: false,
  baseUrl: '',
  message: 'Your box has expired. Please reach out to your contact to renew.',
  renewalUrl: '',
})
export const isExpiryNotice = (addon) => addon?.manifest?.id === EXPIRY_NOTICE_ADDON_ID

// Only public Telegram profile links identify a username. Invite and business links
// can still be opened as supplied, but their tokens are not contact names.
export function expiryNoticePresentation({ message, renewalUrl }) {
  const match =
    /^https?:\/\/(?:www\.)?(?:t\.me|telegram\.me)\/([a-z][a-z0-9_]{0,31})\/?(?:\?(?:text|profile)(?:=[^&#]*)?)?$/i.exec(
      renewalUrl.trim()
    )
  const handle = match ? `@${match[1]}` : ''
  const contact = handle ? `Telegram ${handle}` : ''
  const includesHandle = handle && new RegExp(`${handle}(?![a-z0-9_])`, 'i').test(message)
  return {
    handle,
    contact,
    description: contact && !includesHandle ? `${message}\n${contact}` : message,
  }
}
