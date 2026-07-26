export interface ApplicationIdentity {
  readonly productName: string;
  readonly appId: string;
  readonly userDataDirectoryName: string;
  readonly nsisGuid: string;
}

/**
 * Published Murmur compatibility identity. The explicit installer GUID and
 * AppUserModelID remain active through the visible Eve-name bridge release.
 */
export const MURMUR_IDENTITY = {
  productName: 'Murmur',
  appId: 'com.murmur.app',
  userDataDirectoryName: 'murmur',
  nsisGuid: '0204d005-75b3-5b31-b1f6-ef2831e2b204',
} as const satisfies ApplicationIdentity;

/**
 * Active Eve process and data identity. The installer GUID remains frozen to
 * preserve the published Murmur upgrade and uninstall chain.
 */
export const EVE_IDENTITY = {
  productName: 'Eve',
  appId: 'io.github.burntcookiedough.eve',
  userDataDirectoryName: 'Eve',
  nsisGuid: MURMUR_IDENTITY.nsisGuid,
} as const satisfies ApplicationIdentity;

export const EVE_PRODUCT_NAME = EVE_IDENTITY.productName;
export const EVE_USER_DATA_DIRECTORY_NAME = EVE_IDENTITY.userDataDirectoryName;
