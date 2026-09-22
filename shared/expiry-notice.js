export const EXPIRY_NOTICE_ADDON_ID = 'org.aiomanager.membership'
export const defaultExpiryNotice = Object.freeze({
  enabled: false,
  baseUrl: '',
  message: 'Your box has expired. Please reach out to your contact to renew.',
  renewalUrl: '',
})
export const isExpiryNotice = (addon) => addon?.manifest?.id === EXPIRY_NOTICE_ADDON_ID
