export const EXPIRY_NOTICE_ADDON_ID = 'org.aiomanager.membership'
export const defaultExpiryNotice = Object.freeze({
  enabled: false,
  baseUrl: '',
  message: 'Your membership has expired. Contact your account manager to renew.',
  renewalUrl: '',
})
export const isExpiryNotice = (addon) => addon?.manifest?.id === EXPIRY_NOTICE_ADDON_ID
