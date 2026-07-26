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
 * Active visible product name and isolated user-data directory.
 */
export const EVE_PRODUCT_NAME = 'Eve' as const;
export const EVE_USER_DATA_DIRECTORY_NAME = 'Eve' as const;
