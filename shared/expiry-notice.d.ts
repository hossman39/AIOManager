export const EXPIRY_NOTICE_ADDON_ID: 'org.aiomanager.membership'
export type ExpiryNoticeSettings = {
  enabled: boolean
  baseUrl: string
  message: string
  renewalUrl: string
}
export const defaultExpiryNotice: Readonly<ExpiryNoticeSettings>
export function isExpiryNotice(addon: { manifest?: { id?: string } }): boolean
